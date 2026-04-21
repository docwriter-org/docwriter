/**
 * SQLite ↔ Y.Doc bridge: persist Yjs updates into the `yjs_updates` table
 * and replay them back into a caller-supplied Y.Doc on load.
 *
 *   - `replayUpdatesInto(ydoc, tabId)` hydrates an existing Y.Doc from
 *     `yjs_updates`, and if that table is empty for a tab, seeds from the
 *     real workspace file on disk (so a freshly-opened tab for an existing
 *     file shows its content instead of appearing empty). The caller
 *     (`ydoc-registry.ts`) constructs the UndoManager before invoking this,
 *     so agent-origin transactions replayed from disk repopulate the undo
 *     stack — load-bearing for Reject across server restarts.
 *   - `scheduleMarkdownFlush` debounces a write of the tab's user-facing
 *     file. Called from Hocuspocus's `onChange` whenever a client or custom
 *     MCP tool mutates the Y.Doc.
 *
 * The `yjs_updates` column is literally named `update` (a SQLite reserved
 * word), so every SELECT/INSERT must quote it as `"update"`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import * as Y from 'yjs';
import { getDb } from './db';
import { tabFile } from './document-files';
import { serializeYDocToMarkdown, seedYDocFromContent } from './ydoc-markdown';

/** Replay persisted updates into an existing Y.Doc.
 *
 * Phase 7: split from the original `loadYDoc()` so the caller can construct
 * a UndoManager *before* this runs — each `ydoc.transact(..., origin)` then
 * goes through the UndoManager's observer with its original origin,
 * correctly reconstructing the undo stack across server restarts. If we
 * built the UndoManager after replay (as Phase 2 did), the stack would be
 * empty on cold start and Reject would be a no-op for any pending round
 * whose transactions only existed in `yjs_updates`.
 *
 * If no rows exist for the tab (first open of the tab in this database) AND
 * a real workspace file exists at the tab's path, seed the Y.Doc from the
 * file's content and persist that seed as a single `origin = 'system'` row
 * so subsequent loads skip the disk read. This preserves the "open an
 * existing .md file and its content shows up" UX after IndexedDB is gone. */
export function replayUpdatesInto(ydoc: Y.Doc, tabId: string): void {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT "update", origin FROM yjs_updates WHERE tab_id = ? ORDER BY seq`
		)
		.all(tabId) as Array<{ update: Buffer; origin: string }>;

	if (rows.length > 0) {
		for (const row of rows) {
			ydoc.transact(
				() => Y.applyUpdate(ydoc, new Uint8Array(row.update)),
				row.origin
			);
		}
		return;
	}

	// No persisted updates — try seeding from the workspace file so an
	// existing `document.md` on disk hydrates the server-authoritative
	// Y.Doc on first connect. Silent no-op if the file doesn't exist.
	try {
		const workspacePath = tabFile(tabId);
		if (existsSync(workspacePath)) {
			const content = readFileSync(workspacePath, 'utf-8');
			if (content) {
				// Seed inside a 'system'-origin transact so the UndoManager
				// (which only tracks AGENT_ORIGIN) ignores it, and the origin
				// matches the row we persist for next time.
				ydoc.transact(() => {
					seedYDocFromContent(ydoc, content);
				}, 'system');
				// Persist the seed as a single update row so the next
				// load replays it instead of re-reading the file.
				const update = Y.encodeStateAsUpdate(ydoc);
				db.prepare(
					`INSERT INTO yjs_updates (tab_id, "update", origin, created) VALUES (?, ?, ?, ?)`
				).run(tabId, Buffer.from(update), 'system', Date.now());
			}
		}
	} catch (err) {
		console.error(`[docwriter] seed from disk failed for tab "${tabId}":`, err);
	}
}

/** Append a single Yjs update. Called from Hocuspocus's `onChange` hook. */
export function appendUpdate(tabId: string, update: Uint8Array, origin: string) {
	getDb()
		.prepare(
			`INSERT INTO yjs_updates (tab_id, "update", origin, created) VALUES (?, ?, ?, ?)`
		)
		.run(tabId, Buffer.from(update), origin, Date.now());
}

/** Merge a tab's update log into a single compacted row. Safe to call on tab
 * close or from a background timer; do not run on the hot path.
 *
 * Phase 2 stubs this in but does not wire up a scheduler — a later phase
 * adds a timer / close hook that calls this. */
export function compactTab(tabId: string) {
	const db = getDb();
	db.transaction(() => {
		const rows = db
			.prepare(`SELECT "update" FROM yjs_updates WHERE tab_id = ? ORDER BY seq`)
			.all(tabId) as Array<{ update: Buffer }>;
		if (rows.length < 2) return;
		const merged = Y.mergeUpdates(rows.map((r) => new Uint8Array(r.update)));
		db.prepare(`DELETE FROM yjs_updates WHERE tab_id = ?`).run(tabId);
		db.prepare(
			`INSERT INTO yjs_updates (tab_id, "update", origin, created) VALUES (?, ?, ?, ?)`
		).run(tabId, Buffer.from(merged), 'system', Date.now());
	})();
}

/**
 * Debounced markdown flush — keeps the on-disk `document.md` in sync with
 * the server's authoritative Y.Doc. Called from Hocuspocus's `onChange`
 * hook, which fires on every mutation (client keystroke, custom MCP tool,
 * etc.). One timer per tab; the last call within the debounce window wins.
 *
 * The `ydoc` argument must be the live Y.Doc from the `onChange` payload —
 * Hocuspocus maintains its own authoritative Document per connection and
 * the cold-start registry Y.Doc goes stale once clients connect. Passing
 * the wrong one would flush stale content over the user's latest edits.
 */
const FLUSH_DEBOUNCE_MS = 1_000;
const flushTimers = new Map<string, NodeJS.Timeout>();

export function scheduleMarkdownFlush(tabId: string, ydoc: Y.Doc) {
	const existing = flushTimers.get(tabId);
	if (existing) clearTimeout(existing);
	flushTimers.set(
		tabId,
		setTimeout(() => {
			flushTimers.delete(tabId);
			try {
				const content = serializeYDocToMarkdown(ydoc);
				const path = tabFile(tabId);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, content);
			} catch (err) {
				console.error(`[docwriter] flush failed for tab "${tabId}":`, err);
			}
		}, FLUSH_DEBOUNCE_MS)
	);
}

/** Force a flush for one tab — clears any pending debounce and writes
 * synchronously. Used at shutdown and from the `PUT /api/document` no-op so
 * legacy callers still see their last keystroke land on disk. */
export function flushMarkdownNow(tabId: string, ydoc: Y.Doc) {
	const existing = flushTimers.get(tabId);
	if (existing) clearTimeout(existing);
	flushTimers.delete(tabId);
	try {
		const content = serializeYDocToMarkdown(ydoc);
		const path = tabFile(tabId);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	} catch (err) {
		console.error(`[docwriter] flush (sync) failed for tab "${tabId}":`, err);
	}
}
