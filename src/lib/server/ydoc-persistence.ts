/**
 * SQLite ↔ Y.Doc bridge: persist Yjs updates into the `yjs_updates` table
 * and replay them back into a fresh Y.Doc on load.
 *
 * Phase 2 scaffolding. The `yjs_updates` column is literally named `update`
 * (a SQLite reserved word), so every SELECT/INSERT must quote it as
 * `"update"`. Schema lives in `db-schema.ts`.
 */
import * as Y from 'yjs';
import { getDb } from './db';

/** Load a Y.Doc by replaying all its updates from `yjs_updates` in seq order.
 *
 * Preserves `origin` via `ydoc.transact(() => applyUpdate(...), origin)` so
 * that a freshly-constructed UndoManager (which watches by origin) observes
 * each replayed transaction with its original tag. Phase 7 relies on this
 * for undo-after-restart semantics. */
export function loadYDoc(tabId: string): Y.Doc {
	const ydoc = new Y.Doc();
	const rows = getDb()
		.prepare(
			`SELECT "update", origin FROM yjs_updates WHERE tab_id = ? ORDER BY seq`
		)
		.all(tabId) as Array<{ update: Buffer; origin: string }>;
	for (const row of rows) {
		ydoc.transact(
			() => Y.applyUpdate(ydoc, new Uint8Array(row.update)),
			row.origin
		);
	}
	return ydoc;
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
