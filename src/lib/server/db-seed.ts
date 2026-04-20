/**
 * One-shot seeder: on first startup (or first DB creation), copy the current
 * state from `.docwriter/state.json` and `.docwriter/hooks.json` into the
 * SQLite tables. Idempotent — tracked via the `kv` entry
 * `seeded_from_json_at`.
 *
 * Phase 1 only. The JSON files remain the source of truth; this seeder
 * primes the DB so later phases can flip reads over without a discontinuity.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DOCWRITER_DIR } from './document-files';
import { getDb } from './db';

const STATE_FILE = join(DOCWRITER_DIR, 'state.json');
const HOOKS_FILE = join(DOCWRITER_DIR, 'hooks.json');
const SEED_KEY = 'seeded_from_json_at';

interface StateJson {
	sessionId?: string;
	recentActions?: Array<{
		id: string;
		label?: string;
		icon?: string;
		pinned?: boolean;
		color?: string;
	}>;
	actionUsageCounts?: Record<string, number>;
	rules?: Array<{ id: string; text: string }>;
	agentSettings?: unknown;
	tabs?: { order?: string[]; active?: string | null };
}

interface HooksJson {
	hooks?: Array<{
		id: string;
		event: string;
		matcher?: string;
		command: string;
		enabled?: boolean;
	}>;
}

function readJsonSafe<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf-8')) as T;
	} catch {
		return null;
	}
}

/**
 * Seed the DB from the JSON files if we haven't already. Safe to call on
 * every server start — a marker row in `kv` prevents re-seeding.
 *
 * We also treat "tabs table empty AND state.json exists" as a signal to
 * seed, in case the DB was deleted out from under us while the JSON files
 * stayed put.
 */
export function seedFromJsonFilesIfNeeded() {
	const db = getDb();

	const seedMarker = db
		.prepare('SELECT value FROM kv WHERE key = ?')
		.get(SEED_KEY) as { value: string } | undefined;

	const tabCount = (
		db.prepare('SELECT COUNT(*) AS n FROM tabs').get() as { n: number }
	).n;

	const stateJsonExists = existsSync(STATE_FILE);
	const hooksJsonExists = existsSync(HOOKS_FILE);

	// Only skip if we've already seeded AND we have at least something in
	// the DB. If a user blew away the DB but kept the JSON, re-seed.
	if (seedMarker && tabCount > 0) return;
	if (!stateJsonExists && !hooksJsonExists) {
		// Nothing to seed from; still mark as seeded so we don't keep
		// re-checking every startup.
		db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
			SEED_KEY,
			String(Date.now())
		);
		return;
	}

	const state = readJsonSafe<StateJson>(STATE_FILE) ?? {};
	const hooksCfg = readJsonSafe<HooksJson>(HOOKS_FILE) ?? {};

	db.transaction(() => {
		// Tabs: order preserved via order_index; is_active flag for the active one.
		const order = state.tabs?.order ?? [];
		const active = state.tabs?.active ?? null;
		if (order.length > 0) {
			const insertTab = db.prepare(
				'INSERT OR REPLACE INTO tabs (tab_id, order_index, is_active) VALUES (?, ?, ?)'
			);
			for (let i = 0; i < order.length; i++) {
				const tabId = order[i];
				insertTab.run(tabId, i, tabId === active ? 1 : 0);
			}
		}

		// Rules: Rule JSON has no `created_at`, so synthesize one at seed
		// time. Later writes from `setRules` will use Date.now() too.
		const rules = state.rules ?? [];
		if (rules.length > 0) {
			const now = Date.now();
			const insertRule = db.prepare(
				'INSERT OR REPLACE INTO rules (id, text, created_at) VALUES (?, ?, ?)'
			);
			for (const r of rules) insertRule.run(r.id, r.text, now);
		}

		// Recent actions: the JSON stores full Action objects, but icon/color/
		// pinned are defaulted (always 'message-square', '#7c3aed', false) for
		// custom actions and `id` is a meaningless `custom_<ts>` tag. The only
		// meaningful field is `label` — the user's typed feedback text. Store
		// that. No real timestamps in JSON, so we synthesize at seed time.
		const recentActions = state.recentActions ?? [];
		if (recentActions.length > 0) {
			const now = Date.now();
			const insertAction = db.prepare(
				'INSERT INTO recent_actions (label, used_at) VALUES (?, ?)'
			);
			for (const a of recentActions) insertAction.run(a.label, now);
		}

		// Action usage counts: key → count.
		const counts = state.actionUsageCounts ?? {};
		const countEntries = Object.entries(counts);
		if (countEntries.length > 0) {
			const insertCount = db.prepare(
				'INSERT OR REPLACE INTO action_usage_counts (action, count) VALUES (?, ?)'
			);
			for (const [action, count] of countEntries) insertCount.run(action, count);
		}

		// kv: sessionId + agentSettings (stringified).
		const insertKv = db.prepare(
			'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)'
		);
		if (state.sessionId !== undefined) {
			insertKv.run('sessionId', state.sessionId);
		}
		if (state.agentSettings !== undefined) {
			insertKv.run('agentSettings', JSON.stringify(state.agentSettings));
		}

		// Hooks.
		const hooks = hooksCfg.hooks ?? [];
		if (hooks.length > 0) {
			const insertHook = db.prepare(
				'INSERT OR REPLACE INTO hooks (id, event, matcher, command, enabled) VALUES (?, ?, ?, ?, ?)'
			);
			for (const h of hooks) {
				insertHook.run(
					h.id,
					h.event,
					h.matcher ?? null,
					h.command,
					h.enabled === false ? 0 : 1
				);
			}
		}

		insertKv.run(SEED_KEY, String(Date.now()));
	})();
}
