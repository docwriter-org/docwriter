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
import { tabFile, isKnownTextExtension } from './document-files';
import { ensureDocument } from './documents-store';
import { backupDocumentState } from './state-backup';
import {
	serializeYDoc,
	seedYDoc,
	normalizeTypography,
	replaceYDocTextFromExternal,
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
 * External edits (the file's mtime beats the log and its normalized content
 * differs) are folded IN as one more SYSTEM-origin update that replaces the
 * text in place — an external edit is just an edit that arrived via disk.
 * Comment threads, pending rounds and the provenance of surviving text ride
 * through untouched, and no log rows are deleted (the old behavior purged
 * the whole log — threads, rounds, provenance — and left permanent seq
 * gaps; deletion is now reserved for explicit intent and compaction).
 *
 * Keeping the log also keeps the tab's CRDT IDENTITY, which is what stops
 * the document duplicating itself: a browser can outlive an unload (a
 * sleeping laptop drops the WebSocket without restarting the server), and on
 * reconnect it still holds the pre-unload items. Against a doc that kept its
 * identity that reconnect is a no-op merge; against a freshly seeded doc —
 * same prose, brand-new item ids — Yjs cannot tell the two copies apart and
 * keeps both, appending a second copy of the document on every wake.
 *
 * Binary tabs (PDFs, images) are never materialized: seeding one used to
 * write the file's bytes into the log as UTF-8 mojibake. */
export function replayUpdatesInto(ydoc: Y.Doc, tabId: string): void {
	if (!isKnownTextExtension(tabId)) return;
	const db = getDb();
	const rows = db
		.prepare(`SELECT payload, origin, created FROM yjs_updates WHERE tab_id = ? ORDER BY seq`)
		.all(tabId) as Array<{ payload: Buffer; origin: string; created: number }>;

	if (rows.length > 0) {
		for (const row of rows) {
			ydoc.transact(() => Y.applyUpdate(ydoc, new Uint8Array(row.payload)), row.origin);
		}
		const externalContent = detectExternalEdit(tabId, rows, ydoc);
		if (externalContent !== null) {
			console.log(
				`[docwriter] tab "${tabId}" was edited externally since last sync; folding the disk content in as an update (threads and pending rounds preserved)`
			);
			backupDocumentState(tabId, 'external-edit-reseed', ydoc);
			const before = Y.encodeStateVector(ydoc);
			ydoc.transact(() => replaceYDocTextFromExternal(ydoc, externalContent), SYSTEM_ORIGIN);
			const delta = Y.encodeStateAsUpdate(ydoc, before);
			if (delta.length > 0) appendUpdate(tabId, delta, SYSTEM_ORIGIN);
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
		ensureDocument(tabId);
		db.prepare(
			`INSERT INTO yjs_updates (tab_id, payload, origin, created) VALUES (?, ?, ?, ?)`
		).run(tabId, Buffer.from(update), SYSTEM_ORIGIN, Date.now());
	} catch (err) {
		console.error(`[docwriter] seed from disk failed for tab "${tabId}":`, err);
	}
}

/** Decide whether the workspace file was genuinely edited outside DocWriter
 * since the log's last write. Returns the disk content to fold in when it
 * was, null when the log is authoritative. Both sides are compared through
 * `normalizeTypography` — the serializer normalizes on output, so an
 * external copy with raw typography (e.g. a git pull bringing back an
 * en-dash where the log serializes a hyphen) must NOT count as a
 * divergence. The un-normalized comparison used to purge whole tab logs
 * over a cosmetic dash plus an mtime blip — and it fired on the
 * content-free mtime bumps a cloud-sync client makes on wake, so a file
 * that had not changed at all still counted as an external edit. */
function detectExternalEdit(
	tabId: string,
	rows: Array<{ created: number }>,
	replayedDoc: Y.Doc
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
	const logContent = serializeYDoc(replayedDoc);
	const diskNormalized = normalizeTypography(diskContent);
	if (logContent.replace(/\n$/, '') === diskNormalized.replace(/\n$/, '')) return null;
	return diskContent;
}

export function appendUpdate(tabId: string, update: Uint8Array, origin: string) {
	ensureDocument(tabId);
	getDb()
		.prepare(`INSERT INTO yjs_updates (tab_id, payload, origin, created) VALUES (?, ?, ?, ?)`)
		.run(tabId, Buffer.from(update), origin, Date.now());
}

/** True when SQLite holds any CRDT history for this tab. The tab-open paths
 * use it to tell "brand-new file" apart from "file missing but history
 * exists" — the latter is restored from the log, never truncated. */
export function tabHasPersistedUpdates(tabId: string): boolean {
	const row = getDb()
		.prepare(`SELECT 1 AS present FROM yjs_updates WHERE tab_id = ? LIMIT 1`)
		.get(tabId) as { present: number } | undefined;
	return row !== undefined;
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
	const path = tabFile(tabId);
	// Skip no-op rewrites: a pending review round dirties the tab without
	// changing the committed text, and rewriting would bump mtime → CLI
	// watcher reload → tab remount → the open comment thread closes.
	// The existsSync guard keeps the skip from masking an external delete:
	// if something removed the file since our last flush (git checkout,
	// build tooling), the next flush must recreate it, not no-op.
	if (lastWrittenContent.get(tabId) === content && existsSync(path)) return;
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

/** Drop a tab's in-memory flush bookkeeping. Row deletion is the documents
 * table's job (`deleteDocument` — the yjs_updates FK cascades); this clears
 * only what lives in this module. */
export function clearTabCaches(tabId: string) {
	dirtyTabs.delete(tabId);
	lastWrittenContent.delete(tabId);
	lastWrittenByPath.delete(tabFile(tabId));
}

/** Re-key the in-memory flush bookkeeping after a file rename. The DB side
 * (yjs_updates rows, last_seen) moves via the documents-store rename and
 * the FK's ON UPDATE CASCADE. */
export function migrateTabCaches(oldId: string, newId: string) {
	if (oldId === newId) return;
	dirtyTabs.delete(oldId);
	const cached = lastWrittenContent.get(oldId);
	lastWrittenContent.delete(oldId);
	lastWrittenByPath.delete(tabFile(oldId));
	if (cached !== undefined) {
		lastWrittenContent.set(newId, cached);
		lastWrittenByPath.set(tabFile(newId), cached);
	}
}
