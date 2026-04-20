/**
 * SQLite schema + migrations for DocWriter's server-side persistence.
 *
 * Phase 1 scaffolding: the tables below exist but are only written to (via
 * the dual-write in `runtime-state.ts` / `hooks-config.ts`) — no read paths
 * consume them yet. The JSON files under `.docwriter/` remain the source of
 * truth. Later phases will cut reads over to this DB and add Y.Doc update
 * persistence (see `yjs_updates`).
 *
 * Migration tracking uses `PRAGMA user_version`. Add new migrations to the
 * `MIGRATIONS` array in order; each bumps the version by one.
 */
import type { Database } from 'better-sqlite3';

/** Ordered list of migrations. Index + 1 = the `user_version` reached after
 * running that migration. Never reorder or delete entries — only append. */
const MIGRATIONS: Array<{ version: number; sql: string }> = [
	{
		version: 1,
		sql: `
			CREATE TABLE IF NOT EXISTS yjs_updates (
				tab_id  TEXT NOT NULL,
				seq     INTEGER PRIMARY KEY AUTOINCREMENT,
				"update" BLOB NOT NULL,
				origin  TEXT NOT NULL,
				created INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS yjs_updates_tab_id ON yjs_updates(tab_id);

			CREATE TABLE IF NOT EXISTS tabs (
				tab_id       TEXT PRIMARY KEY,
				order_index  INTEGER NOT NULL,
				is_active    INTEGER NOT NULL DEFAULT 0
			);

			CREATE TABLE IF NOT EXISTS rules (
				id         TEXT PRIMARY KEY,
				text       TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS hooks (
				id       TEXT PRIMARY KEY,
				event    TEXT NOT NULL,
				matcher  TEXT,
				command  TEXT NOT NULL,
				enabled  INTEGER NOT NULL DEFAULT 1
			);

			CREATE TABLE IF NOT EXISTS recent_actions (
				label   TEXT NOT NULL,
				used_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS action_usage_counts (
				action TEXT PRIMARY KEY,
				count  INTEGER NOT NULL DEFAULT 0
			);

			CREATE TABLE IF NOT EXISTS kv (
				key   TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`
	}
];

/** Apply any pending migrations. Idempotent — safe to call on every open. */
export function runMigrations(db: Database) {
	const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
	for (const m of MIGRATIONS) {
		if (m.version <= current) continue;
		db.transaction(() => {
			db.exec(m.sql);
			// `pragma()` with a value sets it; has to be inlined because
			// user_version doesn't accept parameter binding.
			db.pragma(`user_version = ${m.version}`);
		})();
	}
}
