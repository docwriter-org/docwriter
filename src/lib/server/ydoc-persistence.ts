/**
 * SQLite ↔ Y.Doc bridge.
 *
 *   - `appendUpdate(tabId, update, origin)` writes one row into `yjs_updates`.
 *   - `replayUpdatesInto(ydoc, tabId)` hydrates a fresh Y.Doc from SQLite.
 *     If no rows exist and a workspace file does, seeds the Y.Doc from the
 *     file's content and persists the seed as one `system` row so subsequent
 *     loads skip the disk read. If the file changed behind our back, the
 *     replayed doc is rebased onto it with one more `system` update — the
 *     log is never purged, so the tab's CRDT identity is stable across
 *     unloads.
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
import {
	serializeYDoc,
	seedYDoc,
	normalizeTypography,
	replaceYDocText,
	SYSTEM_ORIGIN
} from '$lib/shared/ydoc-codec';

/** Filesystem mtime can lag our `Date.now()` row-insert by a few hundred ms
 * (and HFS+ quantizes to 1s), so we require a couple seconds of slack before
 * we treat a newer mtime as "externally edited". */
const EXTERNAL_EDIT_SKEW_MS = 2_000;

/** Hydrate a fresh Y.Doc from SQLite by replaying its update log. Each update
 * is applied with its original origin (preserved per row) so any origin-aware
 * observer sees the same origins it would live.
 *
 * If the workspace file was edited behind our back while the tab was
 * unloaded, disk wins — but the log is NOT thrown away. The external text is
 * applied as one more `system` update ON TOP of the replayed history, so the
 * tab's CRDT identity survives. That matters because a browser can outlive an
 * unload (a laptop sleeping drops the WebSocket without restarting the
 * server): when it reconnects it still holds the pre-unload items. Against a
 * doc that kept its identity, that reconnect is a no-op merge. Against a
 * freshly seeded doc — same text, brand-new item ids — Yjs has no way to know
 * the two copies are the same prose and keeps both, appending a second copy of
 * the document to itself on every wake. */
export function replayUpdatesInto(ydoc: Y.Doc, tabId: string): void {
	const db = getDb();
	const rows = db
		.prepare(`SELECT payload, origin, created FROM yjs_updates WHERE tab_id = ? ORDER BY seq`)
		.all(tabId) as Array<{ payload: Buffer; origin: string; created: number }>;

	if (rows.length > 0) {
		for (const row of rows) {
			ydoc.transact(() => Y.applyUpdate(ydoc, new Uint8Array(row.payload)), row.origin);
		}
		const external = externalEditText(tabId, rows, ydoc);
		if (external !== null) {
			console.log(
				`[docwriter] tab "${tabId}" was edited externally since last sync; disk wins, rebasing Y.Doc onto the file`
			);
			const before = Y.encodeStateVector(ydoc);
			ydoc.transact(() => replaceYDocText(ydoc, external), SYSTEM_ORIGIN);
			const update = Y.encodeStateAsUpdate(ydoc, before);
			// Persist the adoption ourselves: this may be running inside
			// Hocuspocus's `onLoadDocument`, before its own onChange listener
			// is attached. If onChange does fire too, the extra row carries
			// the same items and replays idempotently.
			if (update.length > 0) appendUpdate(tabId, update, SYSTEM_ORIGIN);
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

/** The file's text when it was edited outside docwriter since the log's last
 * write, else null. `ydoc` must already hold the replayed log.
 *
 * Both sides are compared through `normalizeTypography`, the same
 * transformation the seeder and serializer apply. Without it a file holding
 * an em dash (or a curly quote, or an ellipsis) never matches its own Y.Doc —
 * the doc canonicalizes those to ASCII, the file keeps them — so every mtime
 * bump, including the content-free ones a cloud-sync client makes on wake,
 * would read as an external edit. */
function externalEditText(
	tabId: string,
	rows: Array<{ created: number }>,
	ydoc: Y.Doc
): string | null {
	const workspacePath = tabFile(tabId);
	if (!existsSync(workspacePath)) return null;
	let st;
	try {
		st = statSync(workspacePath);
	} catch {
		return null;
	}
	const maxCreated = rows.reduce((max, r) => (r.created > max ? r.created : max), 0);
	if (st.mtimeMs <= maxCreated + EXTERNAL_EDIT_SKEW_MS) return null;

	let diskContent: string;
	try {
		diskContent = readFileSync(workspacePath, 'utf-8');
	} catch {
		return null;
	}
	const logContent = serializeYDoc(ydoc);
	const diskText = normalizeTypography(diskContent);
	if (logContent.replace(/\n$/, '') === diskText.replace(/\n$/, '')) return null;
	return diskContent;
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
