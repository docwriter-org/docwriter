/**
 * SQLite persistence helpers for DocWriter runtime state.
 *
 * Every helper wraps its DB work in try/catch and logs on failure so a
 * persistence error can't take down the request path that triggered it.
 */
import { getDb } from './db';
import type { Rule, AgentSettings, TabsState } from './runtime-state';
import type { Hook } from './hooks-config';

function logDbError(op: string, err: unknown) {
	console.error(`[docwriter] db-write failed (${op}):`, err);
}

export function dbUpsertTabs(tabs: TabsState) {
	try {
		const db = getDb();
		db.transaction(() => {
			db.prepare('DELETE FROM tabs').run();
			const insert = db.prepare(
				'INSERT INTO tabs (tab_id, order_index, is_active) VALUES (?, ?, ?)'
			);
			for (let i = 0; i < tabs.order.length; i++) {
				const tabId = tabs.order[i];
				insert.run(tabId, i, tabId === tabs.active ? 1 : 0);
			}
		})();
	} catch (err) {
		logDbError('upsertTabs', err);
	}
}

export function dbReplaceRules(rules: Rule[]) {
	try {
		const db = getDb();
		db.transaction(() => {
			db.prepare('DELETE FROM rules').run();
			const now = Date.now();
			const insert = db.prepare(
				'INSERT INTO rules (id, text, created_at) VALUES (?, ?, ?)'
			);
			for (const r of rules) insert.run(r.id, r.text, now);
		})();
	} catch (err) {
		logDbError('replaceRules', err);
	}
}

export function dbSetAgentSettings(settings: AgentSettings) {
	try {
		const db = getDb();
		db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
			'agentSettings',
			JSON.stringify(settings)
		);
	} catch (err) {
		logDbError('setAgentSettings', err);
	}
}

export function dbSetSessionId(sessionId: string) {
	try {
		const db = getDb();
		db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
			'sessionId',
			sessionId
		);
	} catch (err) {
		logDbError('setSessionId', err);
	}
}

export function dbSetEditorSoftWrap(enabled: boolean) {
	try {
		const db = getDb();
		db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
			'editorSoftWrap',
			String(enabled)
		);
	} catch (err) {
		logDbError('setEditorSoftWrap', err);
	}
}

export function dbSetTheme(theme: string) {
	try {
		const db = getDb();
		db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run('theme', theme);
	} catch (err) {
		logDbError('setTheme', err);
	}
}

export function dbClearSessionState() {
	try {
		const db = getDb();
		db.transaction(() => {
			db.prepare('DELETE FROM kv WHERE key = ?').run('sessionId');
			db.prepare('DELETE FROM recent_actions').run();
			db.prepare('DELETE FROM action_usage_counts').run();
		})();
	} catch (err) {
		logDbError('clearSessionState', err);
	}
}

export function dbReplaceRecentActions(
	actions: Array<{ label: string }> | undefined
) {
	try {
		const db = getDb();
		db.transaction(() => {
			db.prepare('DELETE FROM recent_actions').run();
			if (!actions || actions.length === 0) return;
			const now = Date.now();
			const insert = db.prepare(
				'INSERT INTO recent_actions (label, used_at) VALUES (?, ?)'
			);
			for (const a of actions) insert.run(a.label, now);
		})();
	} catch (err) {
		logDbError('replaceRecentActions', err);
	}
}

export function dbReplaceActionUsageCounts(counts: Record<string, number>) {
	try {
		const db = getDb();
		db.transaction(() => {
			db.prepare('DELETE FROM action_usage_counts').run();
			const insert = db.prepare(
				'INSERT INTO action_usage_counts (action, count) VALUES (?, ?)'
			);
			for (const [action, count] of Object.entries(counts)) {
				insert.run(action, count);
			}
		})();
	} catch (err) {
		logDbError('replaceActionUsageCounts', err);
	}
}

/** Read a raw string value from the `kv` table. Returns `null` if the key
 * is absent. Callers parse / interpret the value as they see fit (e.g. the
 * render endpoint stores each tab's post-render markdown under
 * `last_seen:<tabId>` so the next render can diff against it). */
export function kvGet(key: string): string | null {
	try {
		const row = getDb()
			.prepare('SELECT value FROM kv WHERE key = ?')
			.get(key) as { value: string } | undefined;
		return row?.value ?? null;
	} catch (err) {
		logDbError('kvGet:' + key, err);
		return null;
	}
}

/** Upsert a raw string into the `kv` table. Overwrites any prior value. */
export function kvSet(key: string, value: string) {
	try {
		getDb()
			.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
			.run(key, value);
	} catch (err) {
		logDbError('kvSet:' + key, err);
	}
}

export function dbAppendConversationEvent(
	session: string,
	provider: string,
	event: string,
	data: string
) {
	try {
		getDb()
			.prepare(
				'INSERT INTO conversation_events (session, provider, event, data, created) VALUES (?, ?, ?, ?, ?)'
			)
			.run(session, provider, event, data, Date.now());
	} catch (err) {
		logDbError('appendConversationEvent', err);
	}
}

export function dbGetConversationEvents(
	session: string
): Array<{ event: string; data: string; created: number }> {
	try {
		return getDb()
			.prepare(
				'SELECT event, data, created FROM conversation_events WHERE session = ? ORDER BY id ASC'
			)
			.all(session) as Array<{ event: string; data: string; created: number }>;
	} catch (err) {
		logDbError('getConversationEvents', err);
		return [];
	}
}

export function dbClearConversationEvents(session: string) {
	try {
		getDb()
			.prepare('DELETE FROM conversation_events WHERE session = ?')
			.run(session);
	} catch (err) {
		logDbError('clearConversationEvents', err);
	}
}

export function dbReplaceHooks(hooks: Hook[]) {
	try {
		const db = getDb();
		db.transaction(() => {
			db.prepare('DELETE FROM hooks').run();
			const insert = db.prepare(
				'INSERT INTO hooks (id, event, matcher, command, enabled) VALUES (?, ?, ?, ?, ?)'
			);
			for (const h of hooks) {
				insert.run(
					h.id,
					h.event,
					h.matcher ?? null,
					h.command,
					h.enabled === false ? 0 : 1
				);
			}
		})();
	} catch (err) {
		logDbError('replaceHooks', err);
	}
}
