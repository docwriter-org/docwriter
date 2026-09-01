/**
 * SQLite schema + migrations for DocWriter's server-side persistence.
 *
 * Since v13, `documents` is the identity table: one row per document the
 * app holds CRDT state for, owning its lifecycle status (open in the tab
 * bar vs closed-but-restorable), tab-bar order, the agent's `last_seen`
 * diff baseline, and the missing-file grace stamp. `yjs_updates` — the
 * authoritative Y.Doc update log per document — carries a FOREIGN KEY to
 * `documents` with ON DELETE/UPDATE CASCADE, so an orphaned log row is
 * structurally impossible and a rename is a single UPDATE. The legacy
 * `tabs` table and the per-tab `last_seen:<id>` kv entries are gone.
 *
 * Migration tracking uses `PRAGMA user_version`. Add new migrations to
 * the `MIGRATIONS` array in order; each bumps the version by one. Entries
 * are plain SQL, or a `migrate(db)` function when the change needs data
 * inspection (v13's backfill/repair does).
 */
import type { Database } from 'better-sqlite3';
import { isKnownTextExtension } from './document-files';
import { actionIdForLabel } from '$lib/shared/stable-id';

type Migration =
	| { version: number; sql: string }
	| { version: number; migrate: (db: Database) => void };

/** Ordered list of migrations. Index + 1 = the `user_version` reached after
 * running that migration. Never reorder or delete entries — only append. */
const MIGRATIONS: Migration[] = [
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
	},
	{
		version: 9,
		// What each style specialist thought on its way to a proposition.
		// These used to exist only as SSE frames, so closing the dialog threw
		// them away and a finished run had nothing to show.
		sql: `
			CREATE TABLE IF NOT EXISTS style_run_logs (
				id            INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id        TEXT NOT NULL,
				specialist_id TEXT NOT NULL,
				kind          TEXT NOT NULL,
				text          TEXT,
				tool_name     TEXT,
				created       INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS style_run_logs_run
				ON style_run_logs(run_id, specialist_id, id);
		`
	},
	{
		version: 10,
		// Study telemetry, moved out of .docwriter/style-study/events.jsonl.
		// It is runtime state rather than an artifact anyone opens, so it belongs
		// with rules, hooks and reviewers. An existing JSONL file is imported once
		// on first read.
		//
		// No index: the log is only ever read whole, at export time. An index on
		// timestamp would cost a write on every append and be used by nothing.
		sql: `
			CREATE TABLE IF NOT EXISTS style_study_events (
				id        INTEGER PRIMARY KEY AUTOINCREMENT,
				type      TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				data      TEXT NOT NULL
			);
		`
	},
	{
		version: 11,
		// Sessions are looked up by id without the project key: the project key
		// is derived from the working directory, so it changes when that does,
		// and this database already belongs to a single workspace. Both existing
		// indexes lead with project_key, so that lookup was a full scan plus a
		// temp b-tree sort on a path the user waits for.
		sql: `
			CREATE INDEX IF NOT EXISTS provider_session_entries_session
				ON provider_session_entries(provider, session_id, subpath, id);
		`
	},
	{
		version: 12,
		// The working author style belongs in SQLite while agents and the writer
		// are still changing it. The live skill files are a published artifact and
		// are written only when the writer explicitly finalizes the draft.
		sql: `
			CREATE TABLE IF NOT EXISTS style_profile_state (
				id           INTEGER PRIMARY KEY CHECK (id = 1),
				profile_json TEXT NOT NULL,
				updated      INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS style_proposition_snapshots (
				id               INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id           TEXT NOT NULL,
				stage            TEXT NOT NULL,
				agent_id         TEXT NOT NULL,
				position         INTEGER NOT NULL,
				proposition_id   TEXT NOT NULL,
				proposition_json TEXT NOT NULL,
				created          INTEGER NOT NULL,
				updated          INTEGER NOT NULL,
				UNIQUE (run_id, stage, agent_id, position)
			);
			CREATE INDEX IF NOT EXISTS style_proposition_snapshots_run
				ON style_proposition_snapshots(run_id, stage, agent_id, position);
		`
	},
	{
		version: 13,
		// The document-identity migration. One `documents` row per document,
		// owning lifecycle status, tab-bar order, the agent's last_seen
		// baseline, and the missing-file stamp; `yjs_updates` gains a FK with
		// ON DELETE/UPDATE CASCADE so its rows can never orphan again.
		//
		// The backfill doubles as a REPAIR pass for databases damaged by the
		// pre-v13 lifecycle bugs:
		//   - tab ids present in yjs_updates but missing from `tabs` (the
		//     transient-file-absence wipe) become status='closed' documents —
		//     reopening the file restores them, threads and all.
		//   - update rows for binary tabs (PDFs seeded as UTF-8 mojibake by
		//     the render path) are garbage and are deleted outright, along
		//     with their last_seen kv entries.
		//   - last_seen:<id> kv entries move onto the documents row.
		//   - action_usage_counts keys are remapped from positional
		//     custom_<rowid> ids to stable custom_<hash(label)> ids.
		migrate(db) {
			const now = Date.now();
			db.exec(`
				CREATE TABLE documents (
					tab_id        TEXT PRIMARY KEY,
					status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
					order_index   INTEGER,
					is_active     INTEGER NOT NULL DEFAULT 0,
					last_seen     TEXT,
					missing_since INTEGER,
					created       INTEGER NOT NULL,
					last_activity INTEGER NOT NULL
				);
			`);

			// 1. Every open tab becomes an open document.
			const tabs = db
				.prepare(`SELECT tab_id, order_index, is_active FROM tabs ORDER BY order_index`)
				.all() as Array<{ tab_id: string; order_index: number; is_active: number }>;
			const insertDoc = db.prepare(
				`INSERT OR IGNORE INTO documents
				 (tab_id, status, order_index, is_active, created, last_activity)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);
			for (const t of tabs) {
				insertDoc.run(t.tab_id, 'open', t.order_index, t.is_active, now, now);
			}

			// 2. Binary tabs never belonged in the CRDT log — their rows are
			// UTF-8-decoded file bytes, not documents. Delete rows + baselines.
			const distinct = db
				.prepare(`SELECT DISTINCT tab_id FROM yjs_updates`)
				.all() as Array<{ tab_id: string }>;
			const deleteRows = db.prepare(`DELETE FROM yjs_updates WHERE tab_id = ?`);
			const deleteKv = db.prepare(`DELETE FROM kv WHERE key = ?`);
			let purgedBinary = 0;
			for (const { tab_id } of distinct) {
				if (isKnownTextExtension(tab_id)) continue;
				purgedBinary += (deleteRows.run(tab_id).changes as number) ?? 0;
				deleteKv.run(`last_seen:${tab_id}`);
			}
			if (purgedBinary > 0) {
				console.log(
					`[docwriter] migration v13: purged ${purgedBinary} update row(s) for binary tabs`
				);
			}

			// 3. Orphaned text tab ids (data without a tabs row — the wipe bug)
			// become closed documents: restorable, enumerable, no longer dangling.
			const orphans = db
				.prepare(
					`SELECT tab_id, MIN(created) AS created, MAX(created) AS last_activity
					 FROM yjs_updates GROUP BY tab_id`
				)
				.all() as Array<{ tab_id: string; created: number; last_activity: number }>;
			let healed = 0;
			for (const o of orphans) {
				const res = insertDoc.run(o.tab_id, 'closed', null, 0, o.created, o.last_activity);
				if ((res.changes as number) > 0) healed += 1;
			}
			if (healed > 0) {
				console.log(
					`[docwriter] migration v13: recovered ${healed} orphaned document(s) as closed tabs`
				);
			}

			// 4. last_seen baselines move from kv onto the documents row. A
			// baseline with no surviving document is itself an orphan — dropped.
			const lastSeenRows = db
				.prepare(`SELECT key, value FROM kv WHERE key LIKE 'last_seen:%'`)
				.all() as Array<{ key: string; value: string }>;
			const setLastSeen = db.prepare(`UPDATE documents SET last_seen = ? WHERE tab_id = ?`);
			for (const row of lastSeenRows) {
				const tabId = row.key.slice('last_seen:'.length);
				setLastSeen.run(row.value, tabId);
				deleteKv.run(row.key);
			}

			// 5. Rebuild yjs_updates with the FK, preserving seq values and the
			// AUTOINCREMENT counter (so previously issued seqs are never reused).
			const priorSeq = db
				.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'yjs_updates'`)
				.get() as { seq: number } | undefined;
			db.exec(`
				CREATE TABLE yjs_updates_v13 (
					tab_id  TEXT NOT NULL REFERENCES documents(tab_id)
					        ON DELETE CASCADE ON UPDATE CASCADE,
					seq     INTEGER PRIMARY KEY AUTOINCREMENT,
					payload BLOB NOT NULL,
					origin  TEXT NOT NULL,
					created INTEGER NOT NULL
				);
				INSERT INTO yjs_updates_v13 (tab_id, seq, payload, origin, created)
					SELECT tab_id, seq, payload, origin, created FROM yjs_updates;
				DROP TABLE yjs_updates;
				ALTER TABLE yjs_updates_v13 RENAME TO yjs_updates;
				CREATE INDEX IF NOT EXISTS yjs_updates_tab_id ON yjs_updates(tab_id);
			`);
			if (priorSeq) {
				db.prepare(
					`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'yjs_updates'`
				).run(priorSeq.seq);
			}

			// 6. Remap usage-count keys from positional rowid ids to stable
			// label-hash ids while the current rowid↔label mapping is knowable.
			const actions = db
				.prepare(`SELECT rowid, label FROM recent_actions`)
				.all() as Array<{ rowid: number; label: string }>;
			const counts = db
				.prepare(`SELECT action, count FROM action_usage_counts`)
				.all() as Array<{ action: string; count: number }>;
			if (counts.length > 0) {
				const remapped = new Map<string, number>();
				const rowidToStable = new Map(
					actions.map((a) => [`custom_${a.rowid}`, actionIdForLabel(a.label)])
				);
				for (const c of counts) {
					const key = rowidToStable.get(c.action) ?? c.action;
					remapped.set(key, (remapped.get(key) ?? 0) + c.count);
				}
				db.prepare(`DELETE FROM action_usage_counts`).run();
				const insertCount = db.prepare(
					`INSERT INTO action_usage_counts (action, count) VALUES (?, ?)`
				);
				for (const [action, count] of remapped) insertCount.run(action, count);
			}

			// 7. The tabs table is replaced by documents(status='open').
			db.exec(`DROP TABLE tabs;`);
		}
	}
];

/** Apply any pending migrations. Idempotent — safe to call on every open. */
export function runMigrations(db: Database) {
	const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
	for (const m of MIGRATIONS) {
		if (m.version <= current) continue;
		db.transaction(() => {
			if ('sql' in m) db.exec(m.sql);
			else m.migrate(db);
			// `pragma()` with a value sets it; has to be inlined because
			// user_version doesn't accept parameter binding.
			db.pragma(`user_version = ${m.version}`);
		})();
	}
}
