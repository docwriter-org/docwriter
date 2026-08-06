/**
 * Zod schemas + TS types for the author-style pipeline.
 * Durable state lives inside `.docwriter/skills/author-style/`.
 */
import { z } from 'zod';

export const FEATURE_FAMILIES = [
	'document_organization',
	'section_structure',
	'paragraph_structure',
	'sentence_rhythm',
	'grammar_voice',
	'vocabulary_register',
	'punctuation',
	'rhetorical_structure',
	'evidence_citations',
	'formatting'
] as const;

export type FeatureFamily = (typeof FEATURE_FAMILIES)[number];

export const PROPOSITION_TYPES = [
	// document organization
	'overall_organization',
	'hierarchy',
	'section_balance',
	'document_progression',
	// section structure
	'heading_style',
	'section_openings',
	'section_endings',
	'transition_patterns',
	// paragraph structure
	'paragraph_size',
	'topic_sentence_placement',
	'development_pattern',
	'ending_pattern',
	// sentence / rhythm
	'sentence_range',
	'cadence',
	'variation',
	'complexity',
	'short_sentence_use',
	// grammar / voice
	'voice',
	'stance',
	'person',
	'certainty',
	'directness',
	// vocabulary / register
	'register',
	'lexical_density',
	'repetition',
	'terminology',
	'formality',
	'signature_lexicon',
	'ai_ism_avoidance',
	// punctuation
	'terminal_punctuation',
	'clause_boundary',
	'enclosure',
	'sequence_punctuation',
	'punctuation_rhythm',
	// rhetoric
	'rhetorical_move_order',
	'contrast_habit',
	'explanation_habit',
	'concession_habit',
	'example_habit',
	'summary_habit',
	// evidence
	'citation_placement',
	'evidence_integration',
	'attribution',
	'quotation_style',
	// formatting
	'formatting_conventions',
	'visual_hierarchy'
] as const;

export type PropositionType = (typeof PROPOSITION_TYPES)[number];

export const PropositionStatusSchema = z.enum([
	'active',
	'calibration',
	'inactive',
	'skipped',
	'observation'
]);

export type PropositionStatus = z.infer<typeof PropositionStatusSchema>;

export const ReferenceRoleSchema = z.enum(['authored', 'inspiration']);
export type ReferenceRole = z.infer<typeof ReferenceRoleSchema>;

export const EvidenceRefSchema = z.object({
	sourceId: z.string().min(1),
	spanId: z.string().min(1),
	quote: z.string(),
	role: ReferenceRoleSchema
});

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ConfidenceSchema = z.object({
	evidence: z.number().min(0).max(1),
	agentInterpretation: z.number().min(0).max(1),
	extractorReliability: z.number().min(0).max(1),
	final: z.number().min(0).max(1)
});

export const StylePropositionSchema = z.object({
	id: z.string().min(1),
	schemaVersion: z.literal(1),
	family: z.enum(FEATURE_FAMILIES),
	type: z.enum(PROPOSITION_TYPES),
	instruction: z.string().min(1),
	claim: z.string().optional(),
	scope: z
		.object({
			genres: z.array(z.string()).optional(),
			audiences: z.array(z.string()).optional(),
			sections: z.array(z.string()).optional(),
			appliesWhen: z.string().optional()
		})
		.default({}),
	metrics: z
		.array(
			z.object({
				metricId: z.string().min(1),
				summary: z.string(),
				value: z.union([z.number(), z.record(z.string(), z.number())]).optional()
			})
		)
		.default([]),
	evidence: z.array(EvidenceRefSchema).default([]),
	counterevidence: z.array(EvidenceRefSchema).default([]),
	examples: z
		.array(
			z.object({
				id: z.string(),
				text: z.string(),
				sourceId: z.string().optional(),
				polarity: z.literal('positive')
			})
		)
		.default([]),
	confidence: ConfidenceSchema,
	origin: z.enum(['authored', 'aspirational', 'mixed']),
	status: PropositionStatusSchema,
	enabled: z.boolean().default(true),
	calibration: z
		.object({
			trialId: z.string(),
			response: z.enum(['a', 'b', 'same', 'edited', 'skip']),
			chosenExampleId: z.string().optional()
		})
		.optional(),
	createdAt: z.number(),
	updatedAt: z.number(),
	sourceRunId: z.string()
});

export type StyleProposition = z.infer<typeof StylePropositionSchema>;

export const SpecialistSubmissionSchema = z.object({
	propositions: z.array(
		z.object({
			family: z.enum(FEATURE_FAMILIES),
			type: z.enum(PROPOSITION_TYPES),
			instruction: z.string().min(1),
			claim: z.string().optional(),
			scope: z
				.object({
					genres: z.array(z.string()).optional(),
					audiences: z.array(z.string()).optional(),
					sections: z.array(z.string()).optional(),
					appliesWhen: z.string().optional()
				})
				.optional(),
			metricIds: z.array(z.string()).min(1),
			evidence: z.array(EvidenceRefSchema).default([]),
			counterevidence: z.array(EvidenceRefSchema).default([]),
			examples: z
				.array(
					z.object({
						text: z.string(),
						sourceId: z.string().optional(),
						spanId: z.string().optional()
					})
				)
				.default([]),
			interpretationConfidence: z.number().min(0).max(1),
			actionable: z.boolean().default(true),
			origin: z.enum(['authored', 'aspirational', 'mixed']).optional()
		})
	)
});

export type SpecialistSubmission = z.infer<typeof SpecialistSubmissionSchema>;

export const CalibrationTrialSchema = z.object({
	id: z.string(),
	propositionId: z.string(),
	schemaVersion: z.literal(1),
	brief: z.string(),
	variantA: z.string(),
	variantB: z.string(),
	/** Which label currently supports the proposition (hidden from UI). */
	supportsProposition: z.enum(['a', 'b']),
	targetMetricId: z.string(),
	status: z.enum(['pending', 'resolved', 'failed']),
	createdAt: z.number(),
	updatedAt: z.number()
});

export type CalibrationTrial = z.infer<typeof CalibrationTrialSchema>;

export const SourceManifestEntrySchema = z.object({
	sourceId: z.string(),
	role: ReferenceRoleSchema,
	label: z.string(),
	type: z.string(),
	target: z.string(),
	contentHash: z.string(),
	format: z.string().optional()
});

export const StyleSkillStateSchema = z.object({
	schemaVersion: z.literal(1),
	skillId: z.string(),
	updatedAt: z.number(),
	lastRunId: z.string().optional(),
	propositions: z.array(StylePropositionSchema),
	calibrationTrials: z.array(CalibrationTrialSchema).default([]),
	sourceManifest: z.array(SourceManifestEntrySchema).default([])
});

export type StyleSkillState = z.infer<typeof StyleSkillStateSchema>;

export const SpanSchema = z.object({
	id: z.string(),
	sourceId: z.string(),
	start: z.number().int().nonnegative(),
	end: z.number().int().nonnegative(),
	text: z.string()
});

export type TextSpan = z.infer<typeof SpanSchema>;

export const NormalizedDocumentSchema = z.object({
	sourceId: z.string(),
	role: ReferenceRoleSchema,
	label: z.string().optional(),
	text: z.string(),
	blocks: z.array(SpanSchema),
	sections: z.array(
		SpanSchema.extend({
			heading: z.string().optional(),
			level: z.number().int().optional()
		})
	),
	paragraphs: z.array(SpanSchema),
	sentences: z.array(SpanSchema),
	clauses: z.array(SpanSchema),
	tokens: z.array(
		SpanSchema.extend({
			lemma: z.string().optional(),
			isStopword: z.boolean().optional()
		})
	)
});

export type NormalizedDocument = z.infer<typeof NormalizedDocumentSchema>;

export const ACTIVE_CONFIDENCE_THRESHOLD = 0.75;
export const SINGLE_SOURCE_CAP = 0.65;
export const ROLE_CONFLICT_CAP = 0.7;
export const AUTHOR_STYLE_SKILL_ID = 'author-style';
export const AUTHOR_STYLE_FALLBACK_ID = 'docwriter-author-style';
