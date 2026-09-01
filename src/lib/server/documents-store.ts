/**
 * All access to the `documents` table — the identity row that owns a
 * document's lifecycle. One row per document the app holds CRDT state for:
 *
 *   - status:        'open' (in the tab bar) or 'closed' (retained,
 *                    restorable — reopening replays text, threads, pending
 *                    rounds and provenance from the update log).
 *   - order_index /  tab-bar presentation for open documents. The tab bar
 *     is_active:     is a VIEW of this table, never a separate registry.
 *   - last_seen:     the agent's diff baseline (was kv `last_seen:<id>`).
 *   - missing_since: when the workspace file was first noticed absent.
 *                    File presence itself is the filesystem's fact; this
 *                    stamp only drives the grace-window bookkeeping.
 *
 * `yjs_updates.tab_id` carries a FOREIGN KEY to this table with
 * ON DELETE/UPDATE CASCADE (schema v13): deleting a document deletes its
 * log in the same statement, renaming re-keys it, and an orphaned log row
 * is structurally impossible.
 *
 * Writers are wrapped in try/catch (matching db-writes.ts convention) so a
 * persistence error can't take down the request path that triggered it.
 */
import { getDb } from './db';

export type DocumentStatus = 'open' | 'closed';

export interface DocumentRow {
	tabId: string;
	status: DocumentStatus;
	orderIndex: number | null;
	isActive: boolean;
	lastSeen: string | null;
	missingSince: number | null;
	created: number;
	lastActivity: number;
}

function logDbError(op: string, err: unknown) {
	console.error(`[docwriter] documents-store failed (${op}):`, err);
}

interface RawRow {
	tab_id: string;
	status: string;
	order_index: number | null;
	is_active: number;
	last_seen: string | null;
	missing_since: number | null;
	created: number;
	last_activity: number;
}

function mapRow(row: RawRow): DocumentRow {
	return {
		tabId: row.tab_id,
		status: row.status === 'open' ? 'open' : 'closed',
		orderIndex: row.order_index,
		isActive: row.is_active === 1,
		lastSeen: row.last_seen,
		missingSince: row.missing_since,
		created: row.created,
		lastActivity: row.last_activity
	};
}

const ALL_COLUMNS = `tab_id, status, order_index, is_active, last_seen, missing_since, created, last_activity`;

export function getDocument(tabId: string): DocumentRow | null {
	try {
		const row = getDb()
			.prepare(`SELECT ${ALL_COLUMNS} FROM documents WHERE tab_id = ?`)
			.get(tabId) as RawRow | undefined;
		return row ? mapRow(row) : null;
	} catch (err) {
		logDbError('getDocument', err);
		return null;
	}
}

export function listDocuments(): DocumentRow[] {
	try {
		const rows = getDb()
			.prepare(
				`SELECT ${ALL_COLUMNS} FROM documents
				 ORDER BY CASE WHEN order_index IS NULL THEN 1 ELSE 0 END, order_index, tab_id`
			)
			.all() as RawRow[];
		return rows.map(mapRow);
	} catch (err) {
		logDbError('listDocuments', err);
		return [];
	}
}

/** The tab bar: open documents in display order + the active pointer. */
export function listOpenTabs(): { order: string[]; active: string | null } {
	try {
		const rows = getDb()
			.prepare(
				`SELECT tab_id, is_active FROM documents WHERE status = 'open' ORDER BY order_index`
			)
			.all() as Array<{ tab_id: string; is_active: number }>;
		return {
			order: rows.map((r) => r.tab_id),
			active: rows.find((r) => r.is_active === 1)?.tab_id ?? null
		};
	} catch (err) {
		logDbError('listOpenTabs', err);
		return { order: [], active: null };
	}
}

/** Register a document row if absent. Safe to call from any path that is
 * about to write CRDT state — the yjs_updates FK requires the row to exist
 * first, which turns what used to be a silent orphan into a loud error. */
export function ensureDocument(tabId: string, status: DocumentStatus = 'closed') {
	try {
		const now = Date.now();
		getDb()
			.prepare(
				`INSERT OR IGNORE INTO documents (tab_id, status, order_index, is_active, created, last_activity)
				 VALUES (?, ?, NULL, 0, ?, ?)`
			)
			.run(tabId, status, now, now);
	} catch (err) {
		logDbError('ensureDocument', err);
	}
}

/** Replace the whole tab-bar state (order + active). Non-destructive: open
 * documents missing from `order` are CLOSED, never deleted — their history
 * stays restorable. This retires the old DELETE-all + INSERT pattern that
 * let one stale write permanently wipe tab registrations. */
export function setOpenTabs(state: { order: string[]; active: string | null }) {
	try {
		const db = getDb();
		const now = Date.now();
		db.transaction(() => {
			const ensure = db.prepare(
				`INSERT OR IGNORE INTO documents (tab_id, status, order_index, is_active, created, last_activity)
				 VALUES (?, 'open', NULL, 0, ?, ?)`
			);
			const position = db.prepare(
				`UPDATE documents
				 SET status = 'open', order_index = ?, is_active = ?, last_activity = ?
				 WHERE tab_id = ?`
			);
			for (let i = 0; i < state.order.length; i++) {
				const id = state.order[i];
				ensure.run(id, now, now);
				position.run(i, id === state.active ? 1 : 0, now, id);
			}
			// `NOT IN ()` is a syntax error with zero placeholders, so the
			// clause is omitted when the bar is empty.
			const keep = state.order.length
				? ` AND tab_id NOT IN (${state.order.map(() => '?').join(',')})`
				: '';
			db.prepare(
				`UPDATE documents SET status = 'closed', order_index = NULL, is_active = 0
				 WHERE status = 'open'${keep}`
			).run(...state.order);
		})();
	} catch (err) {
		logDbError('setOpenTabs', err);
	}
}

/** Open a document (registering it if new), appending it to the tab bar.
 * `activate` focuses it. Reopening a closed document restores it — its log
 * replays text, threads, pending rounds and provenance on next load. */
export function openDocument(tabId: string, opts: { activate?: boolean } = {}) {
	const activate = opts.activate !== false;
	try {
		const db = getDb();
		const now = Date.now();
		db.transaction(() => {
			db.prepare(
				`INSERT OR IGNORE INTO documents (tab_id, status, order_index, is_active, created, last_activity)
				 VALUES (?, 'open', NULL, 0, ?, ?)`
			).run(tabId, now, now);
			const maxOrder = db
				.prepare(`SELECT MAX(order_index) AS m FROM documents WHERE status = 'open'`)
				.get() as { m: number | null };
			db.prepare(
				`UPDATE documents
				 SET status = 'open',
				     order_index = COALESCE(order_index, ?),
				     missing_since = NULL,
				     last_activity = ?
				 WHERE tab_id = ?`
			).run((maxOrder.m ?? -1) + 1, now, tabId);
			if (activate) {
				db.prepare(`UPDATE documents SET is_active = 0 WHERE is_active = 1`).run();
				db.prepare(`UPDATE documents SET is_active = 1 WHERE tab_id = ?`).run(tabId);
			}
		})();
	} catch (err) {
		logDbError('openDocument', err);
	}
}

/** Focus an open document without touching order or missing-file stamps. */
export function setActiveDocument(tabId: string) {
	try {
		const db = getDb();
		db.transaction(() => {
			db.prepare(`UPDATE documents SET is_active = 0 WHERE is_active = 1`).run();
			db.prepare(`UPDATE documents SET is_active = 1 WHERE tab_id = ? AND status = 'open'`).run(
				tabId
			);
		})();
	} catch (err) {
		logDbError('setActiveDocument', err);
	}
}

/** Close a tab: status flip only. Everything is retained and restorable. */
export function closeDocument(tabId: string) {
	try {
		const db = getDb();
		db.transaction(() => {
			db.prepare(
				`UPDATE documents SET status = 'closed', order_index = NULL, is_active = 0, missing_since = NULL
				 WHERE tab_id = ?`
			).run(tabId);
			// If the closed tab was active, hand focus to the first open tab.
			const active = db
				.prepare(`SELECT tab_id FROM documents WHERE status = 'open' AND is_active = 1`)
				.get() as { tab_id: string } | undefined;
			if (!active) {
				db.prepare(
					`UPDATE documents SET is_active = 1
					 WHERE tab_id = (SELECT tab_id FROM documents WHERE status = 'open' ORDER BY order_index LIMIT 1)`
				).run();
			}
		})();
	} catch (err) {
		logDbError('closeDocument', err);
	}
}

/** Delete a document's identity row. The yjs_updates FK cascades the whole
 * log in the same statement — nothing can remain. Callers own the file
 * unlink, live-doc unload, and backup; this is just the storage half. */
export function deleteDocument(tabId: string) {
	try {
		getDb().prepare(`DELETE FROM documents WHERE tab_id = ?`).run(tabId);
	} catch (err) {
		logDbError('deleteDocument', err);
	}
}

/** Re-key a document (file rename). The FK's ON UPDATE CASCADE moves every
 * yjs_updates row in the same statement. A pre-existing row under `newId`
 * is a leftover from a previously deleted file of that name (the caller
 * verified the target file does not exist) — it is deleted first so two
 * unrelated histories never interleave. */
export function renameDocument(oldId: string, newId: string) {
	if (oldId === newId) return;
	try {
		const db = getDb();
		db.transaction(() => {
			db.prepare(`DELETE FROM documents WHERE tab_id = ?`).run(newId);
			db.prepare(`UPDATE documents SET tab_id = ?, last_activity = ? WHERE tab_id = ?`).run(
				newId,
				Date.now(),
				oldId
			);
		})();
	} catch (err) {
		logDbError('renameDocument', err);
	}
}

// ── last_seen (agent diff baseline) ───────────────────────────────────────

export function getLastSeen(tabId: string): string | null {
	try {
		const row = getDb()
			.prepare(`SELECT last_seen FROM documents WHERE tab_id = ?`)
			.get(tabId) as { last_seen: string | null } | undefined;
		return row?.last_seen ?? null;
	} catch (err) {
		logDbError('getLastSeen', err);
		return null;
	}
}

export function setLastSeen(tabId: string, value: string) {
	try {
		ensureDocument(tabId);
		getDb()
			.prepare(`UPDATE documents SET last_seen = ?, last_activity = ? WHERE tab_id = ?`)
			.run(value, Date.now(), tabId);
	} catch (err) {
		logDbError('setLastSeen', err);
	}
}

// ── missing-file grace bookkeeping ────────────────────────────────────────

/** Stamp `missing_since = now` if not already stamped. Returns the stamp in
 * effect after the call. */
export function stampMissing(tabId: string, now = Date.now()): number {
	try {
		const db = getDb();
		db.prepare(
			`UPDATE documents SET missing_since = COALESCE(missing_since, ?) WHERE tab_id = ?`
		).run(now, tabId);
		const row = db
			.prepare(`SELECT missing_since FROM documents WHERE tab_id = ?`)
			.get(tabId) as { missing_since: number | null } | undefined;
		return row?.missing_since ?? now;
	} catch (err) {
		logDbError('stampMissing', err);
		return now;
	}
}

export function clearMissing(tabId: string) {
	try {
		getDb()
			.prepare(`UPDATE documents SET missing_since = NULL WHERE tab_id = ? AND missing_since IS NOT NULL`)
			.run(tabId);
	} catch (err) {
		logDbError('clearMissing', err);
	}
}

