/**
 * SQLite schema + migrations for DocWriter's server-side persistence.
 *
 * The `yjs_updates` table is the authoritative store for every tab's
 * Y.Doc update log; replay against `yjs_updates` rebuilds a tab's full
 * CRDT state. Other tables (tabs, rules, hooks, kv, recent_actions,
 * action_usage_counts) hold session and config state. JSON files under
 * `.docwriter/` (`state.json`, `hooks.json`) are dual-written for
 * portability and human inspection but the DB is the source of truth.
 *
 * Migration tracking uses `PRAGMA user_version`. Add new migrations to
 * the `MIGRATIONS` array in order; each bumps the version by one.
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
	},
	{
		version: 2,
		// Rename the `yjs_updates."update"` column to `payload`. `update` is a
		// SQLite reserved word, so the original required quoting at every call
		// site — renaming removes the footgun entirely. Brand-new DBs still
		// run v1 first (creating the old column), then immediately v2 (rename).
		sql: `ALTER TABLE yjs_updates RENAME COLUMN "update" TO payload;`
	},
	{
		version: 3,
		sql: `
			CREATE TABLE IF NOT EXISTS conversation_events (
				id        INTEGER PRIMARY KEY AUTOINCREMENT,
				session   TEXT NOT NULL,
				provider  TEXT NOT NULL,
				event     TEXT NOT NULL,
				data      TEXT NOT NULL,
				created   INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS conv_events_session ON conversation_events(session);
		`
	},
	{
		version: 4,
		sql: `
			CREATE TABLE IF NOT EXISTS provider_session_entries (
				id          INTEGER PRIMARY KEY AUTOINCREMENT,
				provider    TEXT NOT NULL,
				project_key TEXT NOT NULL,
				session_id  TEXT NOT NULL,
				subpath     TEXT NOT NULL DEFAULT '',
				entry_json  TEXT NOT NULL,
				created     INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS provider_session_entries_lookup
				ON provider_session_entries(provider, project_key, session_id, subpath, id);
			CREATE INDEX IF NOT EXISTS provider_session_entries_project
				ON provider_session_entries(provider, project_key, session_id, created);
		`
	},
	{
		version: 5,
		// Reserved so local databases that briefly saw the old v4/v5 sequence
		// do not get confused by a reused migration number.
		sql: `SELECT 1;`
	},
	{
		version: 6,
		sql: `
			CREATE TABLE IF NOT EXISTS conversation_sessions (
				id       TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				model    TEXT NOT NULL DEFAULT '',
				created  INTEGER NOT NULL,
				updated  INTEGER NOT NULL,
				status   TEXT NOT NULL DEFAULT 'active'
			);
			CREATE INDEX IF NOT EXISTS conversation_sessions_updated
				ON conversation_sessions(updated);
		`
	},
	{
		version: 7,
		// JSON array of RuleExample ({violation, note?}) attached to a rule;
		// NULL for rules without examples.
		sql: `ALTER TABLE rules ADD COLUMN examples TEXT;`
	},
	{
		version: 8,
		// User-created reviewer agents for critique passes. Built-in
		// reviewers ship as code constants (src/lib/shared/reviewers.ts) so
		// their prompts version with the app; only custom ones live here.
		sql: `
			CREATE TABLE IF NOT EXISTS reviewers (
				id         TEXT PRIMARY KEY,
				name       TEXT NOT NULL,
				icon       TEXT NOT NULL DEFAULT 'owl',
				color      TEXT NOT NULL DEFAULT '#57534e',
				prompt     TEXT NOT NULL,
				created_at INTEGER NOT NULL
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
