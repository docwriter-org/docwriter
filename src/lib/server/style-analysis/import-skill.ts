/**
 * Restore a compiled author-style skill, so a writer can bring back a version
 * they liked (or one someone shared) without sitting through the pass again.
 *
 * A skill is the whole folder — SKILL.md, the references, the openai manifest,
 * the analyzer script — and its shape changes as we evolve it, so the entire
 * folder is installed rather than regenerated from its parts. Regenerating
 * would silently rewrite an old skill in today's format, which is the opposite
 * of restoring it.
 *
 * `references/propositions.json` is read as well, but only to rebuild the
 * profile the UI renders and the turn prompt lists. SKILL.md is prose for the
 * agent and is never parsed back into propositions.
 */
import AdmZip from 'adm-zip';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { StyleProfile, StyleProposition } from '$lib/style-profile';
import { createStyleProfile, propositionId } from './profile-store';
import { PropositionDraftSchema } from './schemas';

const PROPOSITIONS_PATH = 'references/propositions.json';

/** Statuses a restored proposition may carry. Anything mid-calibration is
 *  meaningless once detached from its trial, so it lands as active. */
const ImportedPropositionSchema = PropositionDraftSchema.extend({
	id: z.string().min(1).optional(),
	status: z.enum(['active', 'confirmed', 'disabled', 'not-actionable', 'skipped', 'pending']).optional()
});

const BundleSchema = z.object({
	propositions: z.array(ImportedPropositionSchema).min(1)
});

export class SkillImportError extends Error {}

/**
 * Resolve whatever the writer pointed at down to a skill folder on disk,
 * unzipping to a temporary directory when needed. Accepts the skill folder
 * itself or a folder containing it, since unzipping produces the latter.
 */
export function resolveSkillFolder(source: string): string {
	if (!existsSync(source)) {
		throw new SkillImportError(`Nothing found at ${source}`);
	}
	if (statSync(source).isDirectory()) {
		const candidates = [source, join(source, 'author-style')];
		const found = candidates.find((path) => existsSync(join(path, PROPOSITIONS_PATH)));
		if (!found) {
			throw new SkillImportError(
				`No ${PROPOSITIONS_PATH} under ${source}. Point at a skill folder from Download skill.`
			);
		}
		return found;
	}
	if (!source.toLowerCase().endsWith('.zip')) {
		throw new SkillImportError(`${source} is not a folder or a .zip`);
	}
	let zip: AdmZip;
	try {
		zip = new AdmZip(source);
	} catch {
		throw new SkillImportError(`Could not open ${source} as a zip`);
	}
	const entry = zip
		.getEntries()
		.find((candidate) => candidate.entryName.endsWith(PROPOSITIONS_PATH));
	if (!entry) {
		throw new SkillImportError(`No ${PROPOSITIONS_PATH} inside ${source}`);
	}
	const extracted = mkdtempSync(join(tmpdir(), 'docwriter-skill-'));
	zip.extractAllTo(extracted, true);
	// The entry path tells us how deep the skill root sits inside the archive.
	const depth = entry.entryName.split('/').length - PROPOSITIONS_PATH.split('/').length;
	const prefix = entry.entryName.split('/').slice(0, depth).join('/');
	return prefix ? join(extracted, prefix) : extracted;
}

/**
 * Build a profile from a skill folder. Does not write anything: the caller
 * decides whether to keep it, so a malformed bundle can never clobber a
 * working profile.
 */
export function profileFromSkillFolder(skillDir: string): StyleProfile {
	const propositionsPath = join(skillDir, PROPOSITIONS_PATH);
	if (!existsSync(propositionsPath)) {
		throw new SkillImportError(`No ${PROPOSITIONS_PATH} under ${skillDir}`);
	}
	const raw = readFileSync(propositionsPath, 'utf8');
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new SkillImportError(`${PROPOSITIONS_PATH} is not valid JSON`);
	}
	const result = BundleSchema.safeParse(parsed);
	if (!result.success) {
		const first = result.error.issues[0];
		throw new SkillImportError(
			`${PROPOSITIONS_PATH} does not look like a style skill: ${first.path.join('.') || 'root'} ${first.message}`
		);
	}

	const now = Date.now();
	const propositions: StyleProposition[] = result.data.propositions.map((imported, index) => ({
		id: imported.id ?? propositionId(imported.family, imported.instruction, index),
		family: imported.family,
		statement: imported.statement,
		instruction: imported.instruction,
		examples: imported.examples,
		...(imported.focus?.some(Boolean) ? { focus: imported.focus } : {}),
		...(imported.contrast ? { contrast: imported.contrast } : {}),
		confidence: imported.confidence,
		// A restored profile is one the writer already decided on, so nothing
		// goes back into calibration. Disabled entries stay disabled.
		status: imported.status === 'disabled' ? 'disabled' : 'active',
		createdAt: now,
		updatedAt: now
	}));

	return {
		...createStyleProfile(
			// Imported guidance is not tied to the current sources, so it never
			// reads as stale against them.
			`imported_${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`
		),
		status: 'active',
		propositions
	};
}
