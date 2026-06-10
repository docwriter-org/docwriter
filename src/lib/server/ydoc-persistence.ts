/**
 * SQLite ↔ Y.Doc bridge.
 *
 *   - `appendUpdate(tabId, update, origin)` writes one row into `yjs_updates`.
 *   - `replayUpdatesInto(ydoc, tabId)` hydrates a fresh Y.Doc from SQLite.
 *     If no rows exist and a workspace file does, seeds the Y.Doc from the
 *     file's content and persists the seed as one `system` row so subsequent
 *     loads skip the disk read.
 *   - `markTabDirty(tabId)` queues a tab for the next global flush.
 *   - `flushMarkdownNow(tabId, ydoc)` force-flushes one tab synchronously.
 *
 * Single global flush loop (500ms tick) drains a `dirtyTabs` set. Callers
 * MUST re-resolve the live Hocuspocus Document at flush time to avoid writing
 * stale content from a doc that has since been unloaded.
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import * as Y from 'yjs';
import { getDb } from './db';
import { tabFile } from './document-files';
import { serializeYDoc, seedYDoc, SYSTEM_ORIGIN } from '$lib/shared/ydoc-codec';

/** Filesystem mtime can lag our `Date.now()` row-insert by a few hundred ms
 * (and HFS+ quantizes to 1s), so we require a couple seconds of slack before
 * we treat a newer mtime as "externally edited". */
const EXTERNAL_EDIT_SKEW_MS = 2_000;

/** Hydrate a fresh Y.Doc from SQLite by replaying its update log. Each update
 * is applied with its original origin (preserved per row) so any origin-aware
 * observer sees the same origins it would live. */
export function replayUpdatesInto(ydoc: Y.Doc, tabId: string): void {
	const db = getDb();
	let rows = db
		.prepare(`SELECT payload, origin, created FROM yjs_updates WHERE tab_id = ? ORDER BY seq`)
		.all(tabId) as Array<{ payload: Buffer; origin: string; created: number }>;

	if (rows.length > 0 && diskNewerThanLog(tabId, rows)) {
		console.log(
			`[docwriter] tab "${tabId}" was edited externally since last sync; disk wins, purging stale Y.Doc log`
		);
		db.prepare(`DELETE FROM yjs_updates WHERE tab_id = ?`).run(tabId);
		rows = [];
	}

	if (rows.length > 0) {
		for (const row of rows) {
			ydoc.transact(() => Y.applyUpdate(ydoc, new Uint8Array(row.payload)), row.origin);
		}
		return;
	}

	try {
		const workspacePath = tabFile(tabId);
		if (!existsSync(workspacePath)) return;
		const content = readFileSync(workspacePath, 'utf-8');
		if (!content) return;
		ydoc.transact(() => seedYDoc(ydoc, content), SYSTEM_ORIGIN);
		const update = Y.encodeStateAsUpdate(ydoc);
		db.prepare(
			`INSERT INTO yjs_updates (tab_id, payload, origin, created) VALUES (?, ?, ?, ?)`
		).run(tabId, Buffer.from(update), SYSTEM_ORIGIN, Date.now());
	} catch (err) {
		console.error(`[docwriter] seed from disk failed for tab "${tabId}":`, err);
	}
}

function diskNewerThanLog(
	tabId: string,
	rows: Array<{ payload: Buffer; origin: string; created: number }>
): boolean {
	const workspacePath = tabFile(tabId);
	if (!existsSync(workspacePath)) return false;
	let st;
	try {
		st = statSync(workspacePath);
	} catch {
		return false;
	}
	const maxCreated = rows.reduce((max, r) => (r.created > max ? r.created : max), 0);
	if (st.mtimeMs <= maxCreated + EXTERNAL_EDIT_SKEW_MS) return false;

	let diskContent: string;
	try {
		diskContent = readFileSync(workspacePath, 'utf-8');
	} catch {
		return false;
	}
	const scratch = new Y.Doc();
	try {
		for (const row of rows) {
			scratch.transact(() => Y.applyUpdate(scratch, new Uint8Array(row.payload)), row.origin);
		}
		const logContent = serializeYDoc(scratch);
		return logContent.replace(/\n$/, '') !== diskContent.replace(/\n$/, '');
	} finally {
		scratch.destroy();
	}
}

export function appendUpdate(tabId: string, update: Uint8Array, origin: string) {
	getDb()
		.prepare(`INSERT INTO yjs_updates (tab_id, payload, origin, created) VALUES (?, ?, ?, ?)`)
		.run(tabId, Buffer.from(update), origin, Date.now());
}

export function compactTab(tabId: string) {
	const db = getDb();
	db.transaction(() => {
		const rows = db
			.prepare(`SELECT payload FROM yjs_updates WHERE tab_id = ? ORDER BY seq`)
			.all(tabId) as Array<{ payload: Buffer }>;
		if (rows.length < 2) return;
		const merged = Y.mergeUpdates(rows.map((r) => new Uint8Array(r.payload)));
		db.prepare(`DELETE FROM yjs_updates WHERE tab_id = ?`).run(tabId);
		db.prepare(
			`INSERT INTO yjs_updates (tab_id, payload, origin, created) VALUES (?, ?, ?, ?)`
		).run(tabId, Buffer.from(merged), SYSTEM_ORIGIN, Date.now());
	})();
}

// ── Flush loop ────────────────────────────────────────────────────────────
//
// One global 500ms tick drains `dirtyTabs`. The tick resolves each dirty
// tab's live Document through a caller-supplied resolver so this module
// stays independent of Hocuspocus. `ws-server.ts` wires the resolver at
// startup.

const FLUSH_TICK_MS = 500;
const dirtyTabs = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;
let resolveLiveDoc: ((tabId: string) => Y.Doc | null) | null = null;
/** Last committed markdown we wrote to each tab's file. Lets writeTabFile skip
 * a no-op rewrite: a pending review round (agent proposal) marks the tab dirty
 * but does NOT change the committed fragment, so its serialization is
 * identical. Rewriting anyway would bump the file mtime and trip the CLI
 * file-watcher → a `reload` event → a full tab remount that closes the open
 * comment thread and drops the in-doc diff reveal. Skipping identical writes
 * avoids that churn entirely. */
const lastWrittenContent = new Map<string, string>();
/** Same content, keyed by absolute file path — lets the /api/live watcher
 * endpoint ask "is this change just an echo of our own flush?" without
 * needing the file-path → tabId inverse mapping. */
const lastWrittenByPath = new Map<string, string>();

export function setLiveDocResolver(resolver: (tabId: string) => Y.Doc | null) {
	resolveLiveDoc = resolver;
}

export function markTabDirty(tabId: string) {
	dirtyTabs.add(tabId);
	if (flushTimer) return;
	flushTimer = setTimeout(runFlushTick, FLUSH_TICK_MS);
}

function runFlushTick() {
	flushTimer = null;
	const tabs = Array.from(dirtyTabs);
	dirtyTabs.clear();
	for (const tabId of tabs) {
		const ydoc = resolveLiveDoc?.(tabId);
		if (!ydoc) continue;
		try {
			writeTabFile(tabId, ydoc);
		} catch (err) {
			console.error(`[docwriter] flush failed for tab "${tabId}":`, err);
		}
	}
}

function writeTabFile(tabId: string, ydoc: Y.Doc) {
	const content = serializeYDoc(ydoc);
	// Skip no-op rewrites: a pending review round dirties the tab without
	// changing the committed text, and rewriting would bump mtime → CLI
	// watcher reload → tab remount → the open comment thread closes.
	if (lastWrittenContent.get(tabId) === content) return;
	const path = tabFile(tabId);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	lastWrittenContent.set(tabId, content);
	lastWrittenByPath.set(path, content);
}

/** True if the file at `absPath` currently holds exactly what the server
 * itself last flushed there — i.e. a file-watcher event for it is an echo of
 * our own debounced Y.Doc → markdown write, not an external edit. Typing
 * flushes every second, so without this check `--watch` reload-loops while
 * the user types. */
export function isOwnFlushEcho(absPath: string): boolean {
	const written = lastWrittenByPath.get(absPath);
	if (written === undefined) return false;
	try {
		return readFileSync(absPath, 'utf-8') === written;
	} catch {
		return false;
	}
}

/** Synchronously flush one tab. Clears its pending dirty flag. */
export function flushMarkdownNow(tabId: string, ydoc: Y.Doc) {
	dirtyTabs.delete(tabId);
	try {
		writeTabFile(tabId, ydoc);
	} catch (err) {
		console.error(`[docwriter] flush (sync) failed for tab "${tabId}":`, err);
	}
}

export function clearDirty(tabId: string) {
	dirtyTabs.delete(tabId);
}

/** Drop all persisted Yjs state for a tab. Called when the user deletes the
 * underlying file — otherwise the stale updates would replay on reopen and
 * resurrect the old content. */
export function purgeTabUpdates(tabId: string) {
	dirtyTabs.delete(tabId);
	lastWrittenContent.delete(tabId);
	lastWrittenByPath.delete(tabFile(tabId));
	getDb().prepare(`DELETE FROM yjs_updates WHERE tab_id = ?`).run(tabId);
}
