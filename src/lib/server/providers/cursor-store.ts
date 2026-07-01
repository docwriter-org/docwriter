import { getDb } from '$lib/server/db';
import { getEffectiveRoot } from '$lib/server/document-files';

type ListResult<T> = { items: readonly T[]; nextCursor?: string };
type CursorRecord = Record<string, any>;
type Row = { id: number; subpath: string; entry_json: string; created: number };

const PROVIDER = 'cursor';

function encodeBytes(data: Uint8Array): string {
	return Buffer.from(data).toString('base64');
}

function decodeBytes(data: string): Uint8Array {
	return new Uint8Array(Buffer.from(data, 'base64'));
}

function paginate<T>(
	items: T[],
	cursor: string | undefined,
	limit: number | undefined,
	getId: (item: T) => string
): ListResult<T> {
	const start = cursor ? items.findIndex((item) => getId(item) === cursor) + 1 : 0;
	const safeStart = Math.max(start, 0);
	const safeLimit = limit && limit > 0 ? limit : items.length;
	const page = items.slice(safeStart, safeStart + safeLimit);
	const next = safeStart + safeLimit < items.length ? getId(page[page.length - 1]) : undefined;
	return next ? { items: page, nextCursor: next } : { items: page };
}

function offsetForSeq(seq: number): string {
	return String(seq);
}

function seqForOffset(offset: string | null | undefined): number {
	if (!offset) return 0;
	const n = Number(offset);
	return Number.isFinite(n) ? n : 0;
}

export class DocWriterCursorLocalAgentStore {
	private readonly projectKey: string;

	constructor() {
		this.projectKey = getEffectiveRoot();
	}

	private withContext<T>(fn: () => T): T {
		return fn();
	}

	private getLatest(subpath: string): CursorRecord | null {
		return this.withContext(() => {
			const row = getDb().prepare(`
				SELECT id, subpath, entry_json, created
				FROM provider_session_entries
				WHERE provider = ? AND project_key = ? AND session_id = ? AND subpath = ?
				ORDER BY id DESC
				LIMIT 1
			`).get(PROVIDER, this.projectKey, 'cursor', subpath) as Row | undefined;
			return row ? JSON.parse(row.entry_json) as CursorRecord : null;
		});
	}

	private putLatest(subpath: string, value: CursorRecord): void {
		this.withContext(() => {
			const db = getDb();
			db.transaction(() => {
				db.prepare(`
					DELETE FROM provider_session_entries
					WHERE provider = ? AND project_key = ? AND session_id = ? AND subpath = ?
				`).run(PROVIDER, this.projectKey, 'cursor', subpath);
				db.prepare(`
					INSERT INTO provider_session_entries
						(provider, project_key, session_id, subpath, entry_json, created)
					VALUES (?, ?, ?, ?, ?, ?)
				`).run(PROVIDER, this.projectKey, 'cursor', subpath, JSON.stringify(value), Date.now());
			})();
		});
	}

	private listLatest(prefix: string): Array<{ subpath: string; value: CursorRecord }> {
		return this.withContext(() => {
			const rows = getDb().prepare(`
				SELECT id, subpath, entry_json, created
				FROM provider_session_entries
				WHERE provider = ? AND project_key = ? AND session_id = ? AND subpath LIKE ?
				ORDER BY id ASC
			`).all(PROVIDER, this.projectKey, 'cursor', `${prefix}%`) as Row[];
			return rows.map((row) => ({
				subpath: row.subpath,
				value: JSON.parse(row.entry_json) as CursorRecord
			}));
		});
	}

	private deleteWhere(predicate: (subpath: string, value: CursorRecord) => boolean): void {
		this.withContext(() => {
			const db = getDb();
			const rows = db.prepare(`
				SELECT id, subpath, entry_json, created
				FROM provider_session_entries
				WHERE provider = ? AND project_key = ? AND session_id = ?
			`).all(PROVIDER, this.projectKey, 'cursor') as Row[];
			const ids = rows
				.filter((row) => predicate(row.subpath, JSON.parse(row.entry_json) as CursorRecord))
				.map((row) => row.id);
			if (ids.length === 0) return;
			const del = db.prepare('DELETE FROM provider_session_entries WHERE id = ?');
			db.transaction(() => {
				for (const id of ids) del.run(id);
			})();
		});
	}

	readonly agents = {
		get: async ({ agentId }: { agentId: string }) =>
			this.getLatest(`agents/${agentId}`),

		create: async ({ agent }: { agent: CursorRecord }) => {
			this.putLatest(`agents/${agent.agentId}`, agent);
			return agent;
		},

		update: async ({ agent }: { agent: CursorRecord }) => {
			this.putLatest(`agents/${agent.agentId}`, agent);
			return agent;
		},

		delete: async ({ filter }: { filter: { agentIds?: readonly string[]; cwd?: string } }) => {
			const ids = filter.agentIds && filter.agentIds.length > 0 ? new Set(filter.agentIds) : null;
			const matchingAgentIds = new Set(
				this.listLatest('agents/')
					.map((row) => row.value)
					.filter((agent) =>
						(!ids || ids.has(agent.agentId)) &&
						(!filter.cwd || agent.cwd === filter.cwd)
					)
					.map((agent) => String(agent.agentId))
			);
			const matchingRunIds = new Set(
				this.listLatest('runs/')
					.map((row) => row.value)
					.filter((run) => matchingAgentIds.has(String(run.agentId)))
					.map((run) => String(run.runId))
			);
			this.deleteWhere((subpath, value) =>
				(
					(subpath.startsWith('agents/') || subpath.startsWith('runs/') || subpath.startsWith('checkpoints/')) &&
					matchingAgentIds.has(String(value.agentId))
				) ||
				(subpath.startsWith('run-events/') && matchingRunIds.has(String(value.runId)))
			);
		},

		list: async (input?: { filter?: { cursor?: string; limit?: number; cwd?: string } }) => {
			const filter = input?.filter ?? {};
			const items = this.listLatest('agents/')
				.map((row) => row.value)
				.filter((agent) => !filter.cwd || agent.cwd === filter.cwd)
				.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || String(b.agentId).localeCompare(String(a.agentId)));
			return paginate(items, filter.cursor, filter.limit, (agent) => String(agent.agentId));
		}
	};

	readonly runs = {
		get: async ({ agentId, runId }: { agentId: string; runId: string }) =>
			this.getLatest(`runs/${agentId}/${runId}`),

		create: async ({ run }: { run: CursorRecord }) => {
			this.putLatest(`runs/${run.agentId}/${run.runId}`, run);
			return run;
		},

		update: async ({ run }: { run: CursorRecord }) => {
			this.putLatest(`runs/${run.agentId}/${run.runId}`, run);
			return run;
		},

		delete: async ({ filter }: { filter: { agentIds?: readonly string[]; runIds?: readonly string[] } }) => {
			const agentIds = filter.agentIds && filter.agentIds.length > 0 ? new Set(filter.agentIds) : null;
			const runIds = filter.runIds && filter.runIds.length > 0 ? new Set(filter.runIds) : null;
			const matchingRunIds = new Set(
				this.listLatest('runs/')
					.map((row) => row.value)
					.filter((run) =>
						(!agentIds || agentIds.has(run.agentId)) &&
						(!runIds || runIds.has(run.runId))
					)
					.map((run) => String(run.runId))
			);
			this.deleteWhere((subpath, value) =>
				(
					subpath.startsWith('runs/') &&
					(!agentIds || agentIds.has(value.agentId)) &&
					(!runIds || runIds.has(value.runId))
				) ||
				(subpath.startsWith('run-events/') && matchingRunIds.has(String(value.runId)))
			);
		},

		list: async (input?: { filter?: { agentIds?: readonly string[]; runIds?: readonly string[]; cursor?: string; limit?: number } }) => {
			const filter = input?.filter ?? {};
			const agentIds = filter.agentIds && filter.agentIds.length > 0 ? new Set(filter.agentIds) : null;
			const runIds = filter.runIds && filter.runIds.length > 0 ? new Set(filter.runIds) : null;
			const items = this.listLatest('runs/')
				.map((row) => row.value)
				.filter((run) => (!agentIds || agentIds.has(run.agentId)) && (!runIds || runIds.has(run.runId)))
				.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || String(b.runId).localeCompare(String(a.runId)));
			return paginate(items, filter.cursor, filter.limit, (run) => String(run.runId));
		}
	};

	readonly checkpoints = {
		get: async ({ agentId, blobId }: { agentId: string; blobId: string }) => {
			const row = this.getLatest(`checkpoints/${agentId}/${blobId}`);
			return typeof row?.data === 'string' ? decodeBytes(row.data) : null;
		},

		create: async ({ agentId, blobId, data }: { agentId: string; blobId: string; data: Uint8Array }) => {
			this.putLatest(`checkpoints/${agentId}/${blobId}`, { agentId, blobId, data: encodeBytes(data) });
		},

		update: async ({ agentId, blobId, data }: { agentId: string; blobId: string; data: Uint8Array }) => {
			this.putLatest(`checkpoints/${agentId}/${blobId}`, { agentId, blobId, data: encodeBytes(data) });
		},

		delete: async ({ filter }: { filter: { agentIds?: readonly string[]; blobIds?: readonly string[] } }) => {
			const agentIds = filter.agentIds && filter.agentIds.length > 0 ? new Set(filter.agentIds) : null;
			const blobIds = filter.blobIds && filter.blobIds.length > 0 ? new Set(filter.blobIds) : null;
			this.deleteWhere((subpath, value) =>
				subpath.startsWith('checkpoints/') &&
				(!agentIds || agentIds.has(value.agentId)) &&
				(!blobIds || blobIds.has(value.blobId))
			);
		},

		list: async (input?: { filter?: { agentIds?: readonly string[]; blobIds?: readonly string[]; cursor?: string; limit?: number } }) => {
			const filter = input?.filter ?? {};
			const agentIds = filter.agentIds && filter.agentIds.length > 0 ? new Set(filter.agentIds) : null;
			const blobIds = filter.blobIds && filter.blobIds.length > 0 ? new Set(filter.blobIds) : null;
			const items = this.listLatest('checkpoints/')
				.map((row) => row.value)
				.filter((blob) => (!agentIds || agentIds.has(blob.agentId)) && (!blobIds || blobIds.has(blob.blobId)))
				.map((blob) => String(blob.blobId))
				.sort();
			return paginate(items, filter.cursor, filter.limit, (blobId) => blobId);
		}
	};

	readonly runEvents = {
		append: async (input: {
			runId: string;
			eventType: string;
			payload?: unknown;
			payloadRef?: string | null;
			idempotencyKey?: string | null;
		}) => this.withContext(() => {
			const db = getDb();
			const existing =
				input.idempotencyKey
					? db.prepare(`
						SELECT id, subpath, entry_json, created
						FROM provider_session_entries
						WHERE provider = ? AND project_key = ? AND session_id = ? AND subpath = ?
						ORDER BY id ASC
					`).all(PROVIDER, this.projectKey, 'cursor', `run-events/${input.runId}`) as Row[]
					: [];
			for (const row of existing) {
				const value = JSON.parse(row.entry_json) as CursorRecord;
				if (value.idempotencyKey === input.idempotencyKey) return value;
			}

			const maxRow = db.prepare(`
				SELECT entry_json
				FROM provider_session_entries
				WHERE provider = ? AND project_key = ? AND session_id = ? AND subpath = ?
				ORDER BY id DESC
				LIMIT 1
			`).get(PROVIDER, this.projectKey, 'cursor', `run-events/${input.runId}`) as { entry_json: string } | undefined;
			const prev = maxRow ? JSON.parse(maxRow.entry_json) as CursorRecord : null;
			const seq = (typeof prev?.seq === 'number' ? prev.seq : 0) + 1;
			const doc = {
				runId: input.runId,
				seq,
				offset: offsetForSeq(seq),
				eventType: input.eventType,
				payload: input.payload,
				payloadRef: input.payloadRef ?? null,
				idempotencyKey: input.idempotencyKey ?? null,
				createdAt: Date.now()
			};
			db.prepare(`
				INSERT INTO provider_session_entries
					(provider, project_key, session_id, subpath, entry_json, created)
				VALUES (?, ?, ?, ?, ?, ?)
			`).run(PROVIDER, this.projectKey, 'cursor', `run-events/${input.runId}`, JSON.stringify(doc), doc.createdAt);
			return doc;
		}),

		list: async (input: { runId: string; afterOffset?: string | null; limit?: number }) =>
			this.withContext(() => {
				const afterSeq = seqForOffset(input.afterOffset);
				const all = getDb().prepare(`
					SELECT id, subpath, entry_json, created
					FROM provider_session_entries
					WHERE provider = ? AND project_key = ? AND session_id = ? AND subpath = ?
					ORDER BY id ASC
				`).all(PROVIDER, this.projectKey, 'cursor', `run-events/${input.runId}`) as Row[];
				const matching = all
					.map((row) => JSON.parse(row.entry_json) as CursorRecord)
					.filter((event) => (event.seq ?? 0) > afterSeq);
				const limit = input.limit && input.limit > 0 ? input.limit : matching.length;
				const items = matching.slice(0, limit);
				const nextOffset = items.length > 0 ? String(items[items.length - 1].offset) : undefined;
				return nextOffset ? { items, nextOffset } : { items };
			}),

		delete: async ({ filter }: { filter: { runIds?: readonly string[] } }) => {
			const runIds = filter.runIds && filter.runIds.length > 0 ? new Set(filter.runIds) : null;
			this.deleteWhere((subpath, value) =>
				subpath.startsWith('run-events/') && (!runIds || runIds.has(value.runId))
			);
		}
	};
}
