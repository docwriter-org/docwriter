import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
	FeatureMeasurement,
	StyleAnalysisReport,
	StyleProfile,
	StyleProfileSummary,
	StyleProposition
} from '$lib/style-profile';
import { isActiveProposition, STYLE_ANALYZER_VERSION, STYLE_PROFILE_SCHEMA_VERSION } from '$lib/style-profile';
import { DOCWRITER_DIR, ensureDocWriterDir } from '$lib/server/document-files';
import { writeJsonAtomic } from '$lib/server/file-utils';
import { listStyleReferences } from '$lib/server/references';
import { referenceIsStale } from './materialize';
import type { PropositionDraft } from './schemas';
import { propositionTypeIsAllowed } from './feature-registry';
import { StyleAnalysisReportSchema, StyleProfileSchema } from './schemas';

export const STYLE_PROFILE_FILE = join(DOCWRITER_DIR, 'style-profile.json');
export const STYLE_ANALYSIS_DIR = join(DOCWRITER_DIR, 'style-analysis');
export const STYLE_REPORT_FILE = join(STYLE_ANALYSIS_DIR, 'report.json');

function ensureStyleAnalysisDir() {
	ensureDocWriterDir();
	if (!existsSync(STYLE_ANALYSIS_DIR)) mkdirSync(STYLE_ANALYSIS_DIR, { recursive: true });
}

export function readStyleProfile(): StyleProfile | null {
	if (!existsSync(STYLE_PROFILE_FILE)) return null;
	try {
		const value = StyleProfileSchema.parse(JSON.parse(readFileSync(STYLE_PROFILE_FILE, 'utf8')));
		if (value.schemaVersion !== STYLE_PROFILE_SCHEMA_VERSION) return null;
		return value as StyleProfile;
	} catch {
		return null;
	}
}

export function writeStyleProfile(profile: StyleProfile): StyleProfile {
	ensureStyleAnalysisDir();
	const next = StyleProfileSchema.parse({ ...profile, updatedAt: Date.now() }) as StyleProfile;
	writeJsonAtomic(STYLE_PROFILE_FILE, next);
	return next;
}

export function styleProfileForClient(profile: StyleProfile): StyleProfile {
	return {
		...profile,
		calibrations: profile.calibrations.map(({ targetCandidate: _targetCandidate, ...trial }) => trial)
	};
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

function average(values: number[]): number {
	return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function agreementForMeasurement(measurement: FeatureMeasurement): number {
	const median = Math.abs(measurement.distribution?.median ?? measurement.value);
	const mad = measurement.distribution?.mad ?? 0;
	return Math.max(0, 1 - Math.min(1, mad / Math.max(0.01, median)));
}

function roleAgreement(measurement: FeatureMeasurement): number {
	const authored = measurement.roleValues.authored;
	const inspiration = measurement.roleValues.inspiration;
	if (authored === undefined || inspiration === undefined) return 1;
	return Math.max(0, 1 - Math.min(1, Math.abs(authored - inspiration) / Math.max(0.01, Math.abs(authored) + Math.abs(inspiration))));
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
		statement: draft.statement,
		instruction: draft.instruction,
		examples,
		...(focus.some(Boolean) ? { focus } : {}),
		...(contrast ? { contrast } : {}),
		confidence,
		status: confidence >= 0.75 ? 'active' : 'pending',
		createdAt: now,
		updatedAt: now
	};
}

export function styleProfileSummary(): StyleProfileSummary {
	const references = listStyleReferences();
	const profile = readStyleProfile();
	if (!references.length) {
		return { status: 'empty', referenceCount: 0, activeCount: 0, unresolvedCount: 0, stale: false, profile: profile ? styleProfileForClient(profile) : null };
	}
	if (!profile) {
		return { status: 'ready-to-analyze', referenceCount: references.length, activeCount: 0, unresolvedCount: 0, stale: false, profile: null };
	}
	const stale = references.some(referenceIsStale)
		|| references.some((reference) => reference.materializationStatus !== 'ready')
		|| createHash('sha256')
			.update(references.map((reference) => `${reference.id}:${reference.role}:${reference.contentHash ?? ''}`).sort().join('|'))
			.digest('hex') !== profile.sourceSnapshotHash;
	const activeCount = profile.propositions.filter(isActiveProposition).length;
	const unresolvedCount = profile.propositions.filter((proposition) => proposition.status === 'pending').length;
	const status = stale && profile.status !== 'analyzing' ? 'stale' : profile.status;
	return { status, referenceCount: references.length, activeCount, unresolvedCount, stale, profile: styleProfileForClient({ ...profile, status }) };
}
