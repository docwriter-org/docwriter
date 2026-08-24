import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
	CalibrationTrial,
	StyleAnalysisReport,
	StyleProfile,
	StyleProfileSummary,
	StyleProposition
} from '$lib/style-profile';
import {
	deriveStyleProfileStatus,
	hasUnpublishedStyleChanges,
	isActiveProposition,
	publishedStylePropositions,
	STYLE_ANALYZER_VERSION,
	STYLE_AUTO_ACTIVE_CONFIDENCE,
	STYLE_PROFILE_SCHEMA_VERSION
} from '$lib/style-profile';
import { DOCWRITER_DIR, ensureDocWriterDir } from '$lib/server/document-files';
import { writeJsonAtomic } from '$lib/server/file-utils';
import { isSelected, listStyleReferences } from '$lib/server/references';
import { referenceIsStale } from './materialize';
import type { PropositionDraft } from './schemas';
import { StyleAnalysisReportSchema, StyleProfileSchema } from './schemas';
import {
	readPersistedStyleProfile,
	writePersistedStyleProfile
} from './proposition-store';

export const STYLE_PROFILE_FILE = join(DOCWRITER_DIR, 'style-profile.json');
export const STYLE_ANALYSIS_DIR = join(DOCWRITER_DIR, 'style-analysis');
export const STYLE_REPORT_FILE = join(STYLE_ANALYSIS_DIR, 'report.json');

export const GLOBAL_STYLE_SKILL_DIR = join(homedir(), '.claude', 'skills', 'my-writing-style');

function migrateStoredProfile(value: unknown): unknown {
	if (!value || typeof value !== 'object') return value;
	const profile = structuredClone(value) as Record<string, any>;
	if (profile.schemaVersion === 1) {
		profile.schemaVersion = STYLE_PROFILE_SCHEMA_VERSION;
		profile.analyzerVersion = STYLE_ANALYZER_VERSION;
	}
	if (profile.lastRun?.specialists) {
		profile.lastRun.specialists = profile.lastRun.specialists.map((specialist: Record<string, any>) => ({
			...specialist,
			id: specialist.id === 'organization' ? 'grammar' : specialist.id === 'language' ? 'lexis' : specialist.id
		}));
	}
	// Before publication was explicit, a skillPath meant these propositions
	// had already been written into the live skill.
	if (profile.skillPath && !Array.isArray(profile.publishedPropositions)) {
		profile.publishedAt = profile.updatedAt;
		profile.publishedPropositions = profile.propositions;
	}
	if (profile.skillPath && !profile.publishedSourceSnapshotHash) {
		profile.publishedSourceSnapshotHash = profile.sourceSnapshotHash;
	}
	if (profile.skillPath && !profile.publishedAnalyzerVersion) {
		profile.publishedAnalyzerVersion = profile.analyzerVersion;
	}
	return profile;
}

function ensureStyleAnalysisDir() {
	ensureDocWriterDir();
	if (!existsSync(STYLE_ANALYSIS_DIR)) mkdirSync(STYLE_ANALYSIS_DIR, { recursive: true });
}

export function readStyleProfile(): StyleProfile | null {
	try {
		const persisted = readPersistedStyleProfile();
		if (persisted === null && !existsSync(STYLE_PROFILE_FILE)) return null;
		const raw = persisted ?? JSON.parse(readFileSync(STYLE_PROFILE_FILE, 'utf8'));
		const value = StyleProfileSchema.parse(migrateStoredProfile(raw));
		if (value.schemaVersion !== STYLE_PROFILE_SCHEMA_VERSION) return null;
		// Import the old file into SQLite on its first read. Later reads use the
		// database, while the file remains a portable mirror.
		if (persisted === null) writePersistedStyleProfile(value);
		return value as StyleProfile;
	} catch {
		return null;
	}
}

export function writeStyleProfile(profile: StyleProfile): StyleProfile {
	ensureStyleAnalysisDir();
	const next = StyleProfileSchema.parse({ ...profile, updatedAt: Date.now() }) as StyleProfile;
	writePersistedStyleProfile(next);
	return next;
}

/** Strip the answer key before any calibration trial leaves the server. */
export function publicCalibrationTrial(trial: CalibrationTrial): Omit<CalibrationTrial, 'targetCandidate'> {
	const { targetCandidate: _targetCandidate, ...publicTrial } = trial;
	return publicTrial;
}

export function styleProfileForClient(profile: StyleProfile): StyleProfile {
	return {
		...profile,
		calibrations: profile.calibrations.map((trial) => publicCalibrationTrial(trial))
	};
}

/** Hash of the selected sources that feed analysis — must match analyzeDocuments. */
export function referencesSnapshotHash(
	references: Array<{ id: string; role: string; contentHash?: string }>
): string {
	return createHash('sha256')
		.update(references.map((reference) => `${reference.id}:${reference.role}:${reference.contentHash ?? ''}`).sort().join('|'))
		.digest('hex');
}

export function createStyleProfile(sourceSnapshotHash: string): StyleProfile {
	const now = Date.now();
	return {
		schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
		analyzerVersion: STYLE_ANALYZER_VERSION,
		status: 'analyzing',
		createdAt: now,
		updatedAt: now,
		sourceSnapshotHash,
		propositions: [],
		calibrations: []
	};
}

export function readStyleReport(): StyleAnalysisReport | null {
	if (!existsSync(STYLE_REPORT_FILE)) return null;
	try {
		return StyleAnalysisReportSchema.parse(JSON.parse(readFileSync(STYLE_REPORT_FILE, 'utf8'))) as StyleAnalysisReport;
	} catch {
		return null;
	}
}

export function writeStyleReport(report: StyleAnalysisReport): StyleAnalysisReport {
	ensureStyleAnalysisDir();
	const validated = StyleAnalysisReportSchema.parse(report) as StyleAnalysisReport;
	writeJsonAtomic(STYLE_REPORT_FILE, validated);
	return validated;
}

/** Quotes drift in punctuation and spacing; match on the shape of the words.
 *  Shared so the compiler locates an example the same way grounding stored it. */
export function normalizeForMatch(text: string): string {
	return text
		.toLowerCase()
		.replace(/[“”„]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/[—–]/g, '-')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Grounding, done directly: an example either appears in the author's writing
 * or it was invented. This replaced citing metric and evidence IDs, which
 * proved only that the model could copy an identifier.
 */
function isVerified(example: string, haystack: string): boolean {
	const needle = normalizeForMatch(example);
	return needle.length >= 12 && haystack.includes(needle);
}

export function verifiedExamples(examples: string[], corpus: string): string[] {
	const haystack = normalizeForMatch(corpus);
	return examples.filter((example) => isVerified(example, haystack));
}

/** Stable id for a proposition. Shared so a restored skill and a fresh
 *  analysis of the same propositions agree on ids. */
export function propositionId(family: string, instruction: string, index: number): string {
	return `style_${createHash('sha256').update(`${family}:${instruction}:${index}`).digest('hex').slice(0, 14)}`;
}

export function validateDraftGrounding(draft: PropositionDraft, corpus: string): void {
	if (!verifiedExamples(draft.examples, corpus).length) {
		throw new Error(`No example for "${draft.statement}" appears in the sources`);
	}
	if (draft.contrast) {
		// Half of the pair is the author's own writing and must be found in it;
		// the other half is a rewrite and must not be, or there is no contrast
		// to judge and the comparison shows the writer two identical passages.
		if (!verifiedExamples([draft.contrast.passage], corpus).length) {
			throw new Error(`The contrast passage for "${draft.statement}" is not from the sources`);
		}
		if (normalizeForMatch(draft.contrast.rewritten) === normalizeForMatch(draft.contrast.passage)) {
			throw new Error(`The contrast for "${draft.statement}" did not change the passage`);
		}
	}
}

export function propositionFromDraft(
	draft: PropositionDraft,
	corpus: string,
	index = 0
): StyleProposition {
	// Kept together: an unverified example is dropped, and its focus sentence
	// has to go with it or the two arrays stop lining up.
	const haystack = normalizeForMatch(corpus);
	const kept = draft.examples
		.map((example, at) => ({ example, focus: draft.focus?.[at] }))
		.filter(({ example }) => isVerified(example, haystack));
	const examples = kept.map((item) => item.example);
	if (!examples.length) {
		throw new Error(`No example for "${draft.statement}" appears in the sources`);
	}
	// A focus sentence only means anything if it is inside its own example.
	const focus = kept.map(({ example, focus: sentence }) =>
		sentence && normalizeForMatch(example).includes(normalizeForMatch(sentence)) ? sentence : ''
	);
	// A pattern shown once is a coincidence; shown three times it is a habit.
	const support = Math.min(1, examples.length / 3);
	const confidence = Math.round(Math.max(0, Math.min(1, draft.confidence * (0.6 + 0.4 * support))) * 1000) / 1000;
	const now = Date.now();
	// A contrast whose passage is not in the sources is dropped rather than
	// carried: the trial falls back to building one on demand, which is worse
	// but honest, instead of showing the writer an invented passage as theirs.
	const contrast =
		draft.contrast && verifiedExamples([draft.contrast.passage], corpus).length
			? draft.contrast
			: undefined;
	return {
		id: propositionId(draft.family, draft.instruction, index),
		family: draft.family,
		...(draft.propositionType ? { propositionType: draft.propositionType } : {}),
		statement: draft.statement,
		instruction: draft.instruction,
		examples,
		...(focus.some(Boolean) ? { focus } : {}),
		...(contrast ? { contrast } : {}),
		confidence,
		status: confidence >= STYLE_AUTO_ACTIVE_CONFIDENCE ? 'active' : 'pending',
		createdAt: now,
		updatedAt: now
	};
}

export function checkGlobalStyleSkill(): { available: boolean; path: string } {
	const available = existsSync(join(GLOBAL_STYLE_SKILL_DIR, 'references', 'propositions.json'));
	return { available, path: GLOBAL_STYLE_SKILL_DIR };
}

export function styleProfileSummary(): StyleProfileSummary {
	const references = listStyleReferences().filter(isSelected);
	const profile = readStyleProfile();
	if (!references.length) {
		return {
			status: 'empty', referenceCount: 0, activeCount: 0,
			publishedCount: publishedStylePropositions(profile).length,
			unresolvedCount: 0, hasUnpublishedChanges: hasUnpublishedStyleChanges(profile),
			stale: false, profile: profile ? styleProfileForClient(profile) : null
		};
	}
	if (!profile) {
		return {
			status: 'ready-to-analyze', referenceCount: references.length, activeCount: 0,
			publishedCount: 0, unresolvedCount: 0, hasUnpublishedChanges: false,
			stale: false, profile: null
		};
	}
	const stale = references.some(referenceIsStale)
		|| references.some((reference) => reference.materializationStatus !== 'ready')
		|| referencesSnapshotHash(references) !== profile.sourceSnapshotHash;
	const activeCount = profile.propositions.filter(isActiveProposition).length;
	const publishedCount = publishedStylePropositions(profile).length;
	const unresolvedIds = new Set([
		...profile.propositions
			.filter((proposition) => proposition.status === 'pending')
			.map((proposition) => proposition.id),
		...profile.calibrations
			.filter((trial) => ['pending', 'generated', 'error'].includes(trial.status))
			.map((trial) => trial.propositionId)
	]);
	const unresolvedCount = unresolvedIds.size;
	const status = stale && profile.status !== 'analyzing' ? 'stale' : profile.status;
	return {
		status, referenceCount: references.length, activeCount, publishedCount,
		unresolvedCount, hasUnpublishedChanges: hasUnpublishedStyleChanges(profile),
		stale, profile: styleProfileForClient({ ...profile, status })
	};
}

/** Recompute the working status and persist it. Publishing is a separate user
 * action so calibration cannot rewrite the live skill under the main agent. */
export function persistProfileAfterPropositionChange(
	profile: StyleProfile
): StyleProfile {
	profile.status = deriveStyleProfileStatus(profile.propositions);
	return writeStyleProfile(profile);
}
