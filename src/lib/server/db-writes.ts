/**
 * SQLite persistence helpers for DocWriter runtime state.
 *
 * Every helper wraps its DB work in try/catch and logs on failure so a
 * persistence error can't take down the request path that triggered it.
 */
import { getDb } from './db';
import type { Rule, AgentSettings } from './runtime-state';
import type { Hook } from './hooks-config';

export interface ConversationSessionSummary {
	id: string;
	provider: string;
	model: string;
	created: number;
	updated: number;
	status: string;
	firstUserMessage: string | null;
	eventCount: number;
	nativeEntryCount: number;
}

function logDbError(op: string, err: unknown) {
	console.error(`[docwriter] db-write failed (${op}):`, err);
}

function modelFromEventData(data: string): string {
	try {
		const parsed = JSON.parse(data) as { model?: unknown };
		return typeof parsed.model === 'string' ? parsed.model : '';
	} catch {
		return '';
	}
}

function userTextFromEventData(data: string): string | null {
	try {
		const parsed = JSON.parse(data) as { text?: unknown };
		const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
		return text || null;
	} catch {
		return null;
	}
}

export function dbUpsertConversationSession(
	id: string,
	provider: string,
	model = '',
	status = 'active',
	timestamp = Date.now()
) {
	if (!id) return;
	try {
		getDb()
			.prepare(
				`INSERT INTO conversation_sessions (id, provider, model, created, updated, status)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					provider = excluded.provider,
					model = CASE
						WHEN excluded.model <> '' THEN excluded.model
						ELSE conversation_sessions.model
					END,
					updated = CASE
						WHEN excluded.updated > conversation_sessions.updated THEN excluded.updated
						ELSE conversation_sessions.updated
					END,
					status = excluded.status`
			)
			.run(id, provider, model, timestamp, timestamp, status);
	} catch (err) {
		logDbError('upsertConversationSession', err);
	}
}

export function dbReplaceRules(rules: Rule[]) {
	try {
		const db = getDb();
		db.transaction(() => {
			db.prepare('DELETE FROM rules').run();
			const now = Date.now();
			const insert = db.prepare(
				'INSERT INTO rules (id, text, created_at, examples) VALUES (?, ?, ?, ?)'
			);
			for (const r of rules) {
				insert.run(
					r.id,
					r.text,
					now,
					r.examples && r.examples.length > 0 ? JSON.stringify(r.examples) : null
				);
			}
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
		if (!sessionId) {
			db.transaction(() => {
				db.prepare('DELETE FROM kv WHERE key IN (?, ?, ?)').run(
					'sessionId',
					'sessionProvider',
					'sessionModel'
				);
			})();
			return;
		}
		db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
			'sessionId',
			sessionId
		);
	} catch (err) {
		logDbError('setSessionId', err);
	}
}

export function dbSetSessionOwner(provider: string, model: string) {
	try {
		const db = getDb();
		db.transaction(() => {
			const upsert = db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)');
			upsert.run('sessionProvider', provider);
			upsert.run('sessionModel', model);
		})();
	} catch (err) {
		logDbError('setSessionOwner', err);
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

export function dbSetEditorLineNumbers(enabled: boolean) {
	try {
		const db = getDb();
		db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
			'editorLineNumbers',
			String(enabled)
		);
	} catch (err) {
		logDbError('setEditorLineNumbers', err);
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
			db.prepare('DELETE FROM kv WHERE key = ?').run('sessionProvider');
			db.prepare('DELETE FROM kv WHERE key = ?').run('sessionModel');
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
			// Preserve each label's existing used_at across the rewrite — the
			// client round-trips the full list on every settings save, and
			// stamping everything with `now` flattened all history into one
			// timestamp per save.
			const existing = new Map(
				(
					db.prepare('SELECT label, used_at FROM recent_actions').all() as Array<{
						label: string;
						used_at: number;
					}>
				).map((r) => [r.label, r.used_at])
			);
			db.prepare('DELETE FROM recent_actions').run();
			if (!actions || actions.length === 0) return;
			const now = Date.now();
			const insert = db.prepare(
				'INSERT INTO recent_actions (label, used_at) VALUES (?, ?)'
			);
			for (const a of actions) insert.run(a.label, existing.get(a.label) ?? now);
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

export function kvDelete(key: string) {
	try {
		getDb().prepare('DELETE FROM kv WHERE key = ?').run(key);
	} catch (err) {
		logDbError('kvDelete:' + key, err);
	}
}

export function dbAppendConversationEvent(
	session: string,
	provider: string,
	event: string,
	data: string
) {
	try {
		const created = Date.now();
		getDb()
			.prepare(
				'INSERT INTO conversation_events (session, provider, event, data, created) VALUES (?, ?, ?, ?, ?)'
			)
			.run(session, provider, event, data, created);
		dbUpsertConversationSession(
			session,
			provider,
			modelFromEventData(data),
			event === 'error' ? 'error' : 'active',
			created
		);
	} catch (err) {
		logDbError('appendConversationEvent', err);
	}
}

function emptySessionSummary(
	id: string,
	provider: string,
	model: string,
	created: number,
	updated: number,
	status: string
): ConversationSessionSummary {
	return {
		id,
		provider,
		model,
		created,
		updated,
		status,
		firstUserMessage: null,
		eventCount: 0,
		nativeEntryCount: 0
	};
}

function collectConversationEventSummaries(
	summaries: Map<string, ConversationSessionSummary>,
	sessionFilter?: string
) {
	const rows = getDb()
		.prepare(
			`SELECT session, provider, event, data, created
			 FROM conversation_events
			 ${sessionFilter ? 'WHERE session = ?' : ''}
			 ORDER BY id ASC`
		)
		.all(...(sessionFilter ? [sessionFilter] : [])) as Array<{
			session: string;
			provider: string;
			event: string;
			data: string;
			created: number;
		}>;

	for (const row of rows) {
		let summary = summaries.get(row.session);
		if (!summary) {
			summary = emptySessionSummary(
				row.session,
				row.provider,
				'',
				row.created,
				row.created,
				row.event === 'error' ? 'error' : 'active'
			);
			summaries.set(row.session, summary);
		}
		summary.provider = row.provider || summary.provider;
		const model = modelFromEventData(row.data);
		if (model) summary.model = model;
		summary.created = Math.min(summary.created, row.created);
		summary.updated = Math.max(summary.updated, row.created);
		if (row.event === 'error') summary.status = 'error';
		summary.eventCount += 1;
		if (row.event === 'user_message' && !summary.firstUserMessage) {
			summary.firstUserMessage = userTextFromEventData(row.data);
		}
	}
}

function collectProviderNativeSummaries(
	summaries: Map<string, ConversationSessionSummary>,
	sessionFilter?: string
) {
	const rows = getDb()
		.prepare(
			`SELECT provider, session_id AS id, MIN(created) AS created, MAX(created) AS updated, COUNT(*) AS nativeEntryCount
			 FROM provider_session_entries
			 WHERE subpath = ''
			 ${sessionFilter ? 'AND session_id = ?' : ''}
			 GROUP BY provider, session_id`
		)
		.all(...(sessionFilter ? [sessionFilter] : [])) as Array<{
			provider: string;
			id: string;
			created: number;
			updated: number;
			nativeEntryCount: number;
		}>;

	for (const row of rows) {
		let summary = summaries.get(row.id);
		if (!summary) {
			summary = emptySessionSummary(
				row.id,
				row.provider,
				'',
				row.created,
				row.updated,
				'active'
			);
			summaries.set(row.id, summary);
		}
		summary.provider = summary.provider || row.provider;
		summary.created = Math.min(summary.created, row.created);
		summary.updated = Math.max(summary.updated, row.updated);
		summary.nativeEntryCount = row.nativeEntryCount;
	}
}

export function dbListConversationSessions(limit = 100): ConversationSessionSummary[] {
	try {
		const summaries = new Map<string, ConversationSessionSummary>();
		const rows = getDb()
			.prepare(
				`SELECT id, provider, model, created, updated, status
				 FROM conversation_sessions`
			)
			.all() as Array<{
				id: string;
				provider: string;
				model: string;
				created: number;
				updated: number;
				status: string;
			}>;

		for (const row of rows) {
			summaries.set(
				row.id,
				emptySessionSummary(
					row.id,
					row.provider,
					row.model,
					row.created,
					row.updated,
					row.status
				)
			);
		}

		collectConversationEventSummaries(summaries);
		collectProviderNativeSummaries(summaries);

		return [...summaries.values()]
			.sort((a, b) => b.updated - a.updated)
			.slice(0, Math.max(1, limit));
	} catch (err) {
		logDbError('listConversationSessions', err);
		return [];
	}
}

export function dbGetConversationSessionSummary(
	session: string
): ConversationSessionSummary | null {
	try {
		const summaries = new Map<string, ConversationSessionSummary>();
		const row = getDb()
			.prepare(
				`SELECT id, provider, model, created, updated, status
				 FROM conversation_sessions
				 WHERE id = ?`
			)
			.get(session) as
			| {
					id: string;
					provider: string;
					model: string;
					created: number;
					updated: number;
					status: string;
			  }
			| undefined;
		if (row) {
			summaries.set(
				row.id,
				emptySessionSummary(
					row.id,
					row.provider,
					row.model,
					row.created,
					row.updated,
					row.status
				)
			);
		}
		collectConversationEventSummaries(summaries, session);
		collectProviderNativeSummaries(summaries, session);
		return summaries.get(session) ?? null;
	} catch (err) {
		logDbError('getConversationSessionSummary', err);
		return null;
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
