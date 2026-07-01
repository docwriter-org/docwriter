import { getDb } from '$lib/server/db';
import { getEffectiveRoot } from '$lib/server/document-files';

type AgentInputItem = Record<string, any>;
type SessionHistoryMutation = {
	type: string;
	callId?: string;
	replacement?: AgentInputItem;
};

type Row = {
	id: number;
	entry_json: string;
};

const PROVIDER = 'openai';
const SUBPATH = '';

function cloneItem(item: AgentInputItem): AgentInputItem {
	return structuredClone(item);
}

function parseItem(row: Row): AgentInputItem {
	return JSON.parse(row.entry_json) as AgentInputItem;
}

function callIdForItem(item: AgentInputItem): string | null {
	const topLevel = item.call_id ?? item.callId;
	if (typeof topLevel === 'string' && topLevel) return topLevel;
	const providerData = item.providerData;
	if (providerData && typeof providerData === 'object') {
		const nested = providerData.call_id ?? providerData.callId;
		if (typeof nested === 'string' && nested) return nested;
	}
	return null;
}

export class DocWriterOpenAISession {
	private readonly sessionId: string;
	private readonly projectKey: string;

	constructor(sessionId: string) {
		this.sessionId = sessionId;
		this.projectKey = getEffectiveRoot();
	}

	private withContext<T>(fn: () => T): T {
		return fn();
	}

	async getSessionId(): Promise<string> {
		return this.sessionId;
	}

	async getItems(limit?: number): Promise<AgentInputItem[]> {
		return this.withContext(() => {
			const db = getDb();
			const rows =
				limit === undefined
					? db.prepare(`
						SELECT id, entry_json
						FROM provider_session_entries
						WHERE provider = ? AND project_key = ? AND session_id = ? AND subpath = ?
						ORDER BY id ASC
					`).all(PROVIDER, this.projectKey, this.sessionId, SUBPATH) as Row[]
					: db.prepare(`
						SELECT id, entry_json
						FROM provider_session_entries
						WHERE provider = ? AND project_key = ? AND session_id = ? AND subpath = ?
						ORDER BY id DESC
						LIMIT ?
					`).all(PROVIDER, this.projectKey, this.sessionId, SUBPATH, Math.max(limit, 0)) as Row[];

			const orderedRows = limit === undefined ? rows : [...rows].reverse();
			return orderedRows.map((row) => cloneItem(parseItem(row)));
		});
	}

	async addItems(items: AgentInputItem[]): Promise<void> {
		if (items.length === 0) return;
		this.withContext(() => {
			const db = getDb();
			const insert = db.prepare(`
				INSERT INTO provider_session_entries
					(provider, project_key, session_id, subpath, entry_json, created)
				VALUES (?, ?, ?, ?, ?, ?)
			`);
			const now = Date.now();
			db.transaction(() => {
				for (const item of items) {
					insert.run(
						PROVIDER,
						this.projectKey,
						this.sessionId,
						SUBPATH,
						JSON.stringify(cloneItem(item)),
						now
					);
				}
			})();
		});
	}

	async popItem(): Promise<AgentInputItem | undefined> {
		return this.withContext(() => {
			const db = getDb();
			const row = db.prepare(`
				SELECT id, entry_json
				FROM provider_session_entries
				WHERE provider = ? AND project_key = ? AND session_id = ? AND subpath = ?
				ORDER BY id DESC
				LIMIT 1
			`).get(PROVIDER, this.projectKey, this.sessionId, SUBPATH) as Row | undefined;
			if (!row) return undefined;
			db.prepare('DELETE FROM provider_session_entries WHERE id = ?').run(row.id);
			return cloneItem(parseItem(row));
		});
	}

	async clearSession(): Promise<void> {
		this.withContext(() => {
			getDb().prepare(`
				DELETE FROM provider_session_entries
				WHERE provider = ? AND project_key = ? AND session_id = ?
			`).run(PROVIDER, this.projectKey, this.sessionId);
		});
	}

	async applyHistoryMutations(args: { mutations: SessionHistoryMutation[] }): Promise<void> {
		if (args.mutations.length === 0) return;
		this.withContext(() => {
			const db = getDb();
			const rows = db.prepare(`
				SELECT id, entry_json
				FROM provider_session_entries
				WHERE provider = ? AND project_key = ? AND session_id = ? AND subpath = ?
				ORDER BY id ASC
			`).all(PROVIDER, this.projectKey, this.sessionId, SUBPATH) as Row[];

			const updates: Array<{ id: number; item: AgentInputItem }> = [];
			for (const mutation of args.mutations) {
				if (
					mutation.type !== 'replace_function_call' ||
					!mutation.callId ||
					!mutation.replacement
				) {
					continue;
				}
				for (const row of rows) {
					const item = parseItem(row);
					if (item.type === 'function_call' && callIdForItem(item) === mutation.callId) {
						updates.push({ id: row.id, item: cloneItem(mutation.replacement) });
						break;
					}
				}
			}

			if (updates.length === 0) return;
			const update = db.prepare(`
				UPDATE provider_session_entries
				SET entry_json = ?, created = ?
				WHERE id = ?
			`);
			const now = Date.now();
			db.transaction(() => {
				for (const row of updates) update.run(JSON.stringify(row.item), now, row.id);
			})();
		});
	}
}
