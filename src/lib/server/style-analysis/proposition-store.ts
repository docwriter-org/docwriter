import { getDb } from '$lib/server/db';

export type StylePropositionStage =
	| 'specialist'
	| 'synthesis'
	| 'revision'
	| 'profile'
	| 'published';

export interface StoredStylePropositionSnapshot {
	runId: string;
	stage: StylePropositionStage;
	agentId: string;
	position: number;
	propositionId: string;
	proposition: unknown;
	createdAt: number;
	updatedAt: number;
}

function propositionId(value: unknown, stage: string, agentId: string, position: number): string {
	if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
		return (value as { id: string }).id;
	}
	return `${stage}:${agentId}:${position}`;
}

function replaceRowsInDb(
	db: ReturnType<typeof getDb>,
	runId: string,
	stage: StylePropositionStage,
	agentId: string,
	propositions: unknown[],
	now = Date.now()
) {
	const remove = db.prepare(
		'DELETE FROM style_proposition_snapshots WHERE run_id = ? AND stage = ? AND agent_id = ?'
	);
	const insert = db.prepare(`
		INSERT INTO style_proposition_snapshots
			(run_id, stage, agent_id, position, proposition_id, proposition_json, created, updated)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);
	remove.run(runId, stage, agentId);
	propositions.forEach((proposition, position) => {
		insert.run(
			runId,
			stage,
			agentId,
			position,
			propositionId(proposition, stage, agentId, position),
			JSON.stringify(proposition),
			now,
			now
		);
	});
}

function replaceRows(
	runId: string,
	stage: StylePropositionStage,
	agentId: string,
	propositions: unknown[],
	now = Date.now()
) {
	const db = getDb();
	db.transaction(() => replaceRowsInDb(db, runId, stage, agentId, propositions, now))();
}

/** Save one agent's complete structured submission as soon as its tool call
 * finishes. A retry replaces that agent's stage without touching other stages. */
export function replaceStyleAgentPropositions(
	runId: string,
	stage: Exclude<StylePropositionStage, 'profile' | 'published'>,
	agentId: string,
	propositions: unknown[]
) {
	replaceRows(runId, stage, agentId, propositions);
}

/** SQLite is the source of truth for the working profile. The full JSON keeps
 * schema migration simple, while proposition rows make every agent submission
 * recoverable and inspectable on its own. */
export function writePersistedStyleProfile(profile: {
	lastRun?: { id?: string };
	propositions?: unknown[];
}) {
	const db = getDb();
	const now = Date.now();
	const runId = profile.lastRun?.id || 'profile';
	db.transaction(() => {
		db.prepare(`
			INSERT INTO style_profile_state (id, profile_json, updated)
			VALUES (1, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				profile_json = excluded.profile_json,
				updated = excluded.updated
		`).run(JSON.stringify(profile), now);
		replaceRowsInDb(db, runId, 'profile', 'profile', profile.propositions ?? [], now);
	})();
}

export function readPersistedStyleProfile(): unknown | null {
	const row = getDb()
		.prepare('SELECT profile_json FROM style_profile_state WHERE id = 1')
		.get() as { profile_json: string } | undefined;
	if (!row) return null;
	try {
		return JSON.parse(row.profile_json);
	} catch {
		return null;
	}
}

export function replacePublishedStylePropositions(runId: string, propositions: unknown[]) {
	replaceRows(runId, 'published', 'finalize', propositions);
}

export function readStylePropositionSnapshots(runId: string): StoredStylePropositionSnapshot[] {
	const rows = getDb().prepare(`
		SELECT run_id, stage, agent_id, position, proposition_id, proposition_json, created, updated
		FROM style_proposition_snapshots
		WHERE run_id = ?
		ORDER BY id
	`).all(runId) as Array<{
		run_id: string;
		stage: StylePropositionStage;
		agent_id: string;
		position: number;
		proposition_id: string;
		proposition_json: string;
		created: number;
		updated: number;
	}>;
	return rows.flatMap((row) => {
		try {
			return [{
				runId: row.run_id,
				stage: row.stage,
				agentId: row.agent_id,
				position: row.position,
				propositionId: row.proposition_id,
				proposition: JSON.parse(row.proposition_json),
				createdAt: row.created,
				updatedAt: row.updated
			}];
		} catch {
			return [];
		}
	});
}

export function clearPersistedStyleProfile() {
	const db = getDb();
	db.transaction(() => {
		db.prepare('DELETE FROM style_profile_state').run();
		db.prepare('DELETE FROM style_proposition_snapshots').run();
	})();
}
