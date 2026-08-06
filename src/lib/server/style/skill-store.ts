/**
 * Read/write author-style skill state under `.docwriter/skills/author-style/`.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'fs';
import { join } from 'path';
import { getEffectiveDocwriterDir } from '../document-files';
import { writeJsonAtomic } from '../file-utils';
import { listSkills } from '../skills-config';
import {
	AUTHOR_STYLE_FALLBACK_ID,
	AUTHOR_STYLE_SKILL_ID,
	StyleSkillStateSchema,
	type StyleProposition,
	type StyleSkillState
} from './schemas';

export function authorStyleSkillDir(skillId = AUTHOR_STYLE_SKILL_ID): string {
	return join(getEffectiveDocwriterDir(), 'skills', skillId);
}

export function styleRunsDir(): string {
	return join(getEffectiveDocwriterDir(), 'style-runs');
}

/**
 * Pick a skill directory id that will not clobber a user-installed skill.
 * Managed `docwriter:author-style` sources are ours and may be overwritten.
 */
export function pickAuthorStyleSkillId(): string {
	const collision = listSkills().skills.find((s) => s.id === AUTHOR_STYLE_SKILL_ID);
	if (
		collision &&
		collision.origin === 'custom' &&
		collision.source &&
		!collision.source.startsWith('docwriter:')
	) {
		return AUTHOR_STYLE_FALLBACK_ID;
	}
	return AUTHOR_STYLE_SKILL_ID;
}

/** @deprecated use pickAuthorStyleSkillId */
export function resolveManagedSkillId(_existingCustomIds: string[]): string {
	return pickAuthorStyleSkillId();
}

function emptyState(skillId: string): StyleSkillState {
	return {
		schemaVersion: 1,
		skillId,
		updatedAt: Date.now(),
		propositions: [],
		calibrationTrials: [],
		sourceManifest: []
	};
}

function readOne(skillId: string): StyleSkillState | null {
	const path = join(authorStyleSkillDir(skillId), 'references', 'propositions.json');
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf-8'));
		const result = StyleSkillStateSchema.safeParse(parsed);
		if (result.success) return result.data;
		// Lenient fallback for partial files
		return {
			...emptyState(skillId),
			propositions: Array.isArray(parsed.propositions) ? parsed.propositions : [],
			sourceManifest: Array.isArray(parsed.sourceManifest) ? parsed.sourceManifest : [],
			calibrationTrials: Array.isArray(parsed.calibrationTrials) ? parsed.calibrationTrials : [],
			updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
			lastRunId: parsed.lastRunId
		};
	} catch {
		return null;
	}
}

export function readStyleSkillState(skillId?: string): StyleSkillState | null {
	if (skillId) return readOne(skillId);
	// Prefer canonical id, then collision fallback.
	return readOne(AUTHOR_STYLE_SKILL_ID) ?? readOne(AUTHOR_STYLE_FALLBACK_ID);
}

export function writeStyleSkillState(state: StyleSkillState) {
	const dir = authorStyleSkillDir(state.skillId);
	const refDir = join(dir, 'references');
	mkdirSync(refDir, { recursive: true });
	const next = { ...state, updatedAt: Date.now() };
	writeJsonAtomic(join(refDir, 'propositions.json'), next);
	return next;
}

/** Unresolved = pending calibration trials (not bare calibration props). */
export function countUnresolvedCalibration(state: StyleSkillState | null): number {
	if (!state) return 0;
	return state.calibrationTrials.filter((t) => t.status === 'pending').length;
}

export function listActivePropositions(state: StyleSkillState | null): StyleProposition[] {
	if (!state) return [];
	return state.propositions.filter((p) => p.status === 'active' && p.enabled);
}

export function isSkillStale(
	state: StyleSkillState | null,
	currentHashes: Array<{ sourceId: string; contentHash: string }>
): boolean {
	if (!state?.sourceManifest?.length) return false;
	const map = new Map(currentHashes.map((h) => [h.sourceId, h.contentHash]));
	for (const entry of state.sourceManifest) {
		const cur = map.get(entry.sourceId);
		if (!cur || cur !== entry.contentHash) return true;
	}
	if (currentHashes.length !== state.sourceManifest.length) return true;
	return false;
}

export function clearStyleRun(runId: string) {
	const dir = join(styleRunsDir(), runId);
	rmSync(dir, { recursive: true, force: true });
}

export function ensureStyleRunDir(runId: string): string {
	const dir = join(styleRunsDir(), runId);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function writeRunArtifact(runId: string, name: string, data: unknown) {
	const dir = ensureStyleRunDir(runId);
	const path = join(dir, name);
	writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
	return path;
}

export function readRunArtifact<T = unknown>(runId: string, name: string): T | null {
	const path = join(styleRunsDir(), runId, name);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf-8')) as T;
	} catch {
		return null;
	}
}
