import type { ProviderId } from '$lib/server/providers/types';
import { getDb } from './db';

export type ProviderSessionKey = {
	projectKey: string;
	sessionId: string;
	subpath?: string;
};

export type ProviderSessionEntry = {
	type: string;
	uuid?: string;
	timestamp?: string;
	[k: string]: unknown;
};

export type ProviderSessionStore = {
	append(key: ProviderSessionKey, entries: ProviderSessionEntry[]): Promise<void>;
	load(key: ProviderSessionKey): Promise<ProviderSessionEntry[] | null>;
	listSessions?(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>;
	delete?(key: ProviderSessionKey): Promise<void>;
	listSubkeys?(key: { projectKey: string; sessionId: string }): Promise<string[]>;
};

type Row = { entry_json: string };

function normalizeSubpath(subpath?: string): string {
	return subpath ?? '';
}

function parseEntry(row: Row): ProviderSessionEntry {
	return JSON.parse(row.entry_json) as ProviderSessionEntry;
}

/** Opaque, provider-native session entry storage.
 *
 * `conversation_events` is the normalized DocWriter transcript for the UI.
 * This table is for SDKs that expose their own resumable transcript format.
 * Claude currently uses it through its SessionStore API; other providers can
 * attach adapters here if their SDKs expose equivalent durable session hooks.
 */
export function createProviderSessionStore(provider: ProviderId): ProviderSessionStore {
	return {
		async append(key: ProviderSessionKey, entries: ProviderSessionEntry[]) {
			if (entries.length === 0) return;
			const db = getDb();
			const insert = db.prepare(`
				INSERT INTO provider_session_entries
					(provider, project_key, session_id, subpath, entry_json, created)
				VALUES (?, ?, ?, ?, ?, ?)
			`);
			const subpath = normalizeSubpath(key.subpath);
			const now = Date.now();
			db.transaction(() => {
				for (const entry of entries) {
					insert.run(
						provider,
						key.projectKey,
						key.sessionId,
						subpath,
						JSON.stringify(entry),
						now
					);
				}
			})();
		},

		async load(key: ProviderSessionKey) {
			// Deliberately not filtered by project key. That key is derived from
			// the working directory, so it changes when the directory does and a
			// session recorded under the old one becomes unresumable ("No
			// conversation found with session ID"). This database belongs to one
			// workspace and session ids are unique within it, so the id alone
			// identifies the conversation. The column is kept as provenance, and
			// loadProviderSessionEntries/hasProviderSessionEntries already read
			// this way.
			const rows = getDb()
				.prepare(`
					SELECT entry_json
					FROM provider_session_entries
					WHERE provider = ? AND session_id = ? AND subpath = ?
					ORDER BY id ASC
				`)
				.all(provider, key.sessionId, normalizeSubpath(key.subpath)) as Row[];
			if (rows.length === 0) return null;
			return rows.map(parseEntry);
		},

		async listSessions(projectKey: string) {
			return getDb()
				.prepare(`
					SELECT session_id AS sessionId, MAX(created) AS mtime
					FROM provider_session_entries
					WHERE provider = ? AND project_key = ? AND subpath = ''
					GROUP BY session_id
				`)
				.all(provider, projectKey) as Array<{ sessionId: string; mtime: number }>;
		},

		// Keyed by session id for the same reason as load(): a session that can
		// be resumed must also be deletable and enumerable.
		async delete(key: ProviderSessionKey) {
			if (key.subpath) {
				getDb()
					.prepare(`
						DELETE FROM provider_session_entries
						WHERE provider = ? AND session_id = ? AND subpath = ?
					`)
					.run(provider, key.sessionId, key.subpath);
			} else {
				getDb()
					.prepare('DELETE FROM provider_session_entries WHERE provider = ? AND session_id = ?')
					.run(provider, key.sessionId);
			}
		},

		async listSubkeys(key: { projectKey: string; sessionId: string }) {
			const rows = getDb()
				.prepare(`
					SELECT DISTINCT subpath
					FROM provider_session_entries
					WHERE provider = ? AND session_id = ? AND subpath <> ''
					ORDER BY subpath ASC
				`)
				.all(provider, key.sessionId) as Array<{ subpath: string }>;
			return rows.map((row) => row.subpath);
		}
	};
}

export function loadProviderSessionEntries(
	provider: ProviderId,
	sessionId: string
): ProviderSessionEntry[] {
	const rows = getDb()
		.prepare(`
			SELECT entry_json
			FROM provider_session_entries
			WHERE provider = ? AND session_id = ? AND subpath = ''
			ORDER BY id ASC
		`)
		.all(provider, sessionId) as Row[];
	return rows.map(parseEntry);
}

export function hasProviderSessionEntries(
	provider: ProviderId,
	sessionId: string
): boolean {
	const row = getDb()
		.prepare(`
			SELECT 1 AS found
			FROM provider_session_entries
			WHERE provider = ? AND session_id = ? AND subpath = ''
			LIMIT 1
		`)
		.get(provider, sessionId) as { found: number } | undefined;
	return !!row;
}
