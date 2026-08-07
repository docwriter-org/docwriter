/**
 * Version history for the compiled author-style skill.
 *
 * The skill is not one file: it is SKILL.md plus references, the openai agent
 * manifest, and the analyzer script, and it changes shape as we evolve it. So a
 * version is a copy of the whole folder, not a copy of propositions.json. That
 * way restoring an old version gives back exactly the skill that was in use,
 * including the wording of instructions we have since rewritten.
 *
 * Every compile snapshots the folder before returning, so the history is a
 * by-product of normal use rather than something the writer has to remember.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DOCWRITER_DIR } from '$lib/server/document-files';
import { writeJsonAtomic } from '$lib/server/file-utils';

export const SKILL_VERSIONS_DIR = join(DOCWRITER_DIR, 'style-skill-versions');
const META_FILE = 'version.json';

/** How many snapshots to keep. Old ones are pruned oldest-first. */
const MAX_VERSIONS = 20;

export interface SkillVersion {
	/** Monotonic, 1-based. Stable once written. */
	version: number;
	createdAt: number;
	propositionCount: number;
	/** Absolute path to the snapshot folder. */
	path: string;
}

interface VersionMeta {
	version: number;
	createdAt: number;
	propositionCount: number;
}

/** Two snapshots are the same skill if their propositions are. Everything else
 *  in the folder is either fixed or derived from them. */
function sameSkillContent(a: string, b: string): boolean {
	try {
		const read = (dir: string) => readFileSync(join(dir, 'references', 'propositions.json'), 'utf8');
		return read(a) === read(b);
	} catch {
		return false;
	}
}

function readMeta(dir: string): VersionMeta | null {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, META_FILE), 'utf8'));
		if (typeof parsed?.version !== 'number') return null;
		return {
			version: parsed.version,
			createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
			propositionCount: typeof parsed.propositionCount === 'number' ? parsed.propositionCount : 0
		};
	} catch {
		return null;
	}
}

/** Newest first. */
export function listSkillVersions(): SkillVersion[] {
	if (!existsSync(SKILL_VERSIONS_DIR)) return [];
	const versions: SkillVersion[] = [];
	// withFileTypes so one readdir replaces a statSync per entry.
	for (const entry of readdirSync(SKILL_VERSIONS_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(SKILL_VERSIONS_DIR, entry.name);
		const meta = readMeta(dir);
		if (meta) versions.push({ ...meta, path: dir });
	}
	return versions.sort((a, b) => b.version - a.version);
}

export function skillVersionDir(version: number): string | null {
	return listSkillVersions().find((candidate) => candidate.version === version)?.path ?? null;
}

/**
 * The number the next build will carry. Read before compiling so the version
 * can be written into the skill's own files: a downloaded bundle that cannot
 * say which version it is leaves you guessing when you come back to restore it.
 */
export function nextSkillVersion(): number {
	return (listSkillVersions()[0]?.version ?? 0) + 1;
}

/**
 * Copy the freshly compiled skill folder into the history. Never throws into
 * the compile path: losing a snapshot is not a reason to fail a compile.
 */
export function snapshotSkillVersion(
	skillDir: string,
	propositionCount: number,
	/** The number stamped into the skill, so the folder and the history agree.
	 *  Callers read it from nextSkillVersion() before writing the files. */
	version: number
): SkillVersion | null {
	try {
		if (!existsSync(skillDir)) return null;
		const existing = listSkillVersions();
		// Identical content back to back is a re-compile, not a new version:
		// answering ten calibration questions should not fill the history with
		// ten near-identical snapshots and push out the versions worth keeping.
		if (existing[0] && sameSkillContent(existing[0].path, skillDir)) return existing[0];
		mkdirSync(SKILL_VERSIONS_DIR, { recursive: true });
		const dir = join(SKILL_VERSIONS_DIR, `v${String(version).padStart(4, '0')}`);
		rmSync(dir, { recursive: true, force: true });
		cpSync(skillDir, dir, { recursive: true });
		const createdAt = Date.now();
		writeJsonAtomic(join(dir, META_FILE), { version, createdAt, propositionCount });

		for (const old of existing.slice(MAX_VERSIONS - 1)) {
			rmSync(old.path, { recursive: true, force: true });
		}
		return { version, createdAt, propositionCount, path: dir };
	} catch {
		return null;
	}
}
