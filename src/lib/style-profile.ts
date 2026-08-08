export const STYLE_PROFILE_SCHEMA_VERSION = 2;
export const STYLE_ANALYZER_VERSION = '2.0.0';

export const STYLE_FAMILIES = [
	'lexical',
	'grammatical',
	'figures',
	'cohesion-context'
] as const;

export type StyleFamily = (typeof STYLE_FAMILIES)[number];

/** Translate profiles compiled by the first author-style implementation. */
export function normalizeStyleFamily(value: unknown): StyleFamily | null {
	if (STYLE_FAMILIES.includes(value as StyleFamily)) return value as StyleFamily;
	if (value === 'vocabulary-register') return 'lexical';
	if (['sentence-rhythm', 'grammar-voice', 'punctuation'].includes(String(value))) return 'grammatical';
	if (value === 'rhetorical-structure') return 'figures';
	if (value === 'evidence-citations') return 'cohesion-context';
	// The old organization families were layout guidance. Old imported
	// propositions remain readable, but new runs measure them as conventions.
	if (['document-organization', 'section-structure', 'paragraph-structure', 'formatting'].includes(String(value))) {
		return 'grammatical';
	}
	return null;
}
export type StyleReferenceRole = 'authored' | 'inspiration';
export type MaterializationStatus = 'pending' | 'ready' | 'stale' | 'error';
export type StyleProfileStatus =
	| 'empty'
	| 'ready-to-analyze'
	| 'analyzing'
	| 'needs-calibration'
	| 'active'
	| 'stale'
	| 'error';

export interface SourceSpan {
	id: string;
	sourceId: string;
	start: number;
	end: number;
	text: string;
	kind: string;
}

export interface NormalizedToken extends SourceSpan {
	kind: 'word' | 'number' | 'punctuation';
	normalized: string;
}

export interface NormalizedClause extends SourceSpan {
	kind: 'clause';
	wordCount: number;
	boundary?: string;
}

export interface NormalizedSentence extends SourceSpan {
	kind: 'sentence';
	wordCount: number;
	clauseIds: string[];
}

export interface NormalizedParagraph extends SourceSpan {
	kind: 'paragraph';
	wordCount: number;
	sentenceIds: string[];
}

export interface NormalizedBlock extends SourceSpan {
	kind: 'heading' | 'paragraph' | 'list-item' | 'blockquote' | 'code' | 'table';
	level?: number;
}

export interface NormalizedSection extends SourceSpan {
	kind: 'section';
	level: number;
	heading?: string;
	blockIds: string[];
}

export interface NormalizedDocument {
	sourceId: string;
	role: StyleReferenceRole;
	format: string;
	contentHash: string;
	text: string;
	blocks: NormalizedBlock[];
	sections: NormalizedSection[];
	paragraphs: NormalizedParagraph[];
	sentences: NormalizedSentence[];
	clauses: NormalizedClause[];
	tokens: NormalizedToken[];
}

export interface FeatureOccurrence {
	id: string;
	metricId: string;
	family: StyleFamily;
	sourceId: string;
	start: number;
	end: number;
	text: string;
	value?: number | string | boolean;
	context?: Record<string, string | number | boolean | null>;
}

export interface FeatureMeasurement {
	id: string;
	family: StyleFamily;
	label: string;
	unit: 'count' | 'ratio' | 'per-1000-words' | 'words' | 'sentences' | 'score';
	value: number;
	count: number;
	sourceCount: number;
	roleValues: Partial<Record<StyleReferenceRole, number>>;
	distribution?: {
		min: number;
		p10: number;
		median: number;
		p90: number;
		max: number;
		mean: number;
		mad: number;
	};
	reliability: number;
	occurrenceIds: string[];
}

export interface ConventionMeasurement extends Omit<FeatureMeasurement, 'family'> {
	family: 'conventions';
}

export interface StyleAnalysisReport {
	schemaVersion: number;
	analyzerVersion: string;
	createdAt: number;
	sourceSnapshotHash: string;
	documents: Array<{
		sourceId: string;
		role: StyleReferenceRole;
		format: string;
		contentHash: string;
		wordCount: number;
	}>;
	measurements: FeatureMeasurement[];
	/** Layout/venue measurements retained for the compiled skill, never sent to specialists. */
	conventions: ConventionMeasurement[];
	occurrences: FeatureOccurrence[];
	examples: SourceSpan[];
}

export type PropositionStatus =
	| 'active'
	| 'pending'
	| 'confirmed'
	| 'not-actionable'
	| 'skipped'
	| 'disabled';

export interface StyleProposition {
	id: string;
	family: StyleFamily;
	/** Leech & Short checklist section or a narrower allowed registry type. */
	propositionType?: string;
	/** The habit in plain language, as you'd tell a ghostwriter out loud. */
	statement: string;
	/** What to do when writing, as a plain imperative. */
	instruction: string;
	/** Passages from the author's writing showing this proposition in action. */
	examples: string[];
	/** Per example, the sentence inside it the proposition is about. */
	focus?: string[];
	/**
	 * The pair the author judges during calibration: one of their own passages
	 * and the same passage rewritten without this habit. Written by the
	 * specialist that read the sources, so it is grounded in text that actually
	 * shows the habit. Absent on profiles created before this existed.
	 */
	contrast?: { passage: string; rewritten: string };
	confidence: number;
	status: PropositionStatus;
	createdAt: number;
	updatedAt: number;
}

/**
 * Confidence at or above this skips calibration and lands in the skill as
 * `active`. Below it, the writer judges an A/B card first.
 */
export const STYLE_AUTO_ACTIVE_CONFIDENCE = 0.9;

/**
 * Whether a proposition is part of the skill the writing agent follows. This is
 * the central question of the feature, so it has one definition rather than a
 * status list spelled out at each of its dozen call sites.
 */
export function isActiveProposition(proposition: { status: PropositionStatus }): boolean {
	return proposition.status === 'active' || proposition.status === 'confirmed';
}

/** Profile status from the current proposition set (pending beats active). */
export function deriveStyleProfileStatus(
	propositions: Array<{ status: PropositionStatus }>
): Exclude<StyleProfileStatus, 'empty' | 'analyzing' | 'stale' | 'error'> {
	if (propositions.some((proposition) => proposition.status === 'pending')) {
		return 'needs-calibration';
	}
	if (propositions.some(isActiveProposition)) return 'active';
	return 'ready-to-analyze';
}

export type CalibrationChoice = 'a' | 'b' | 'same' | 'neither' | 'skip';

export interface CalibrationTrial {
	id: string;
	propositionId: string;
	status: 'pending' | 'generated' | 'answered' | 'skipped' | 'error';
	candidateA?: string;
	candidateB?: string;
	targetCandidate?: 'a' | 'b';
	choice?: CalibrationChoice;
	editedText?: string;
	generatedAt?: number;
	answeredAt?: number;
	error?: string;
}

export interface SpecialistRunState {
	id: 'lexis' | 'grammar' | 'discourse' | 'synthesis';
	status: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
	families: StyleFamily[];
	error?: string;
	startedAt?: number;
	completedAt?: number;
}

export interface StyleAnalysisRun {
	id: string;
	status: 'queued' | 'running' | 'completed' | 'error' | 'cancelled';
	provider: string;
	model?: string;
	phase: string;
	progress: number;
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	error?: string;
	specialists: SpecialistRunState[];
}

export interface StyleProfile {
	schemaVersion: number;
	analyzerVersion: string;
	status: StyleProfileStatus;
	createdAt: number;
	updatedAt: number;
	sourceSnapshotHash: string;
	skillId?: string;
	skillPath?: string;
	propositions: StyleProposition[];
	calibrations: CalibrationTrial[];
	lastRun?: StyleAnalysisRun;
}

export interface StyleProfileSummary {
	status: StyleProfileStatus;
	referenceCount: number;
	activeCount: number;
	unresolvedCount: number;
	stale: boolean;
	profile: StyleProfile | null;
}
