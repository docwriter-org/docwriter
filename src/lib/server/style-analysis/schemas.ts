import { z } from 'zod';
import { STYLE_FAMILIES } from '$lib/style-profile';

/**
 * What the writing agent actually needs: the pattern, what to do about it, and
 * passages showing it. The old ID cross-references (metricIds, evidenceIds,
 * counterevidenceIds) existed to prove grounding, but verbatim examples prove
 * it better — an example either appears in the sources or it does not.
 */
export const PropositionDraftSchema = z.object({
	family: z.enum(STYLE_FAMILIES),
	statement: z.string().trim().min(1).max(1000),
	instruction: z.string().trim().min(1).max(1000),
	examples: z.array(z.string().trim().min(1).max(2000)).min(1).max(8),
	/**
	 * Per example, the sentence inside it that shows the habit. The specialist
	 * knows which one; string-matching it back out of the passage afterwards is
	 * guesswork that gets it wrong. Optional so older profiles still load.
	 */
	focus: z.array(z.string().trim().max(2000)).max(8).optional(),
	/**
	 * The comparison the writer is asked to judge, written by the specialist
	 * that read the sources. It used to be built later by a separate agent that
	 * saw one passage and a rule and had no idea whether they were related —
	 * which is why comparisons routinely failed to build at all. Optional so
	 * profiles written before this still load.
	 */
	// Capped well below the example limit: this pair is judged side by side at a
	// glance, and a paragraph of it is more than anyone compares in one look.
	contrast: z
		.object({
			passage: z.string().trim().min(20).max(600),
			rewritten: z.string().trim().min(20).max(600)
		})
		.optional(),
	confidence: z.number().min(0).max(1)
});

export const SpecialistSubmissionSchema = z.object({
	propositions: z.array(PropositionDraftSchema).max(100),
	notes: z.string().max(4000).optional()
});

export const SynthesisSubmissionSchema = z.object({
	propositions: z.array(PropositionDraftSchema).max(250),
	summary: z.string().trim().min(1).max(6000).default('Generated author style profile')
});

export const CalibrationRevisionSchema = z.object({
	statement: z.string().trim().min(1).max(1000),
	instruction: z.string().trim().min(1).max(1000),
	scope: z.array(z.string().trim().min(1).max(160)).max(12).default([])
});

export const FeatureMeasurementSchema = z.object({
	id: z.string().min(1),
	family: z.enum(STYLE_FAMILIES),
	label: z.string().min(1),
	unit: z.enum(['count', 'ratio', 'per-1000-words', 'words', 'sentences', 'score']),
	value: z.number(),
	count: z.number().int().nonnegative(),
	sourceCount: z.number().int().nonnegative(),
	roleValues: z.object({ authored: z.number().optional(), inspiration: z.number().optional() }),
	distribution: z.object({
		min: z.number(), p10: z.number(), median: z.number(), p90: z.number(), max: z.number(), mean: z.number(), mad: z.number()
	}).optional(),
	reliability: z.number().min(0).max(1),
	occurrenceIds: z.array(z.string().min(1))
});

const SourceSpanSchema = z.object({
	id: z.string().min(1), sourceId: z.string().min(1), start: z.number().int().nonnegative(),
	end: z.number().int().nonnegative(), text: z.string(), kind: z.string().min(1)
});

const FeatureOccurrenceSchema = z.object({
	id: z.string().min(1), metricId: z.string().min(1), family: z.enum(STYLE_FAMILIES), sourceId: z.string().min(1),
	start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), text: z.string(),
	value: z.union([z.number(), z.string(), z.boolean()]).optional(),
	context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
});

export const StyleAnalysisReportSchema = z.object({
	schemaVersion: z.number().int().positive(),
	analyzerVersion: z.string().min(1),
	createdAt: z.number().int().nonnegative(),
	sourceSnapshotHash: z.string().min(1),
	documents: z.array(z.object({
		sourceId: z.string().min(1), role: z.enum(['authored', 'inspiration']), format: z.string().min(1),
		contentHash: z.string().min(1), wordCount: z.number().int().nonnegative()
	})),
	measurements: z.array(FeatureMeasurementSchema),
	occurrences: z.array(FeatureOccurrenceSchema),
	examples: z.array(SourceSpanSchema)
});

export const StylePropositionSchema = PropositionDraftSchema.extend({
	id: z.string().min(1),
	status: z.enum(['active', 'pending', 'confirmed', 'not-actionable', 'skipped', 'disabled']),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative()
});

export const CalibrationTrialSchema = z.object({
	id: z.string().min(1),
	propositionId: z.string().min(1),
	status: z.enum(['pending', 'generated', 'answered', 'skipped', 'error']),
	candidateA: z.string().optional(),
	candidateB: z.string().optional(),
	targetCandidate: z.enum(['a', 'b']).optional(),
	choice: z.enum(['a', 'b', 'same', 'neither', 'skip']).optional(),
	editedText: z.string().optional(),
	generatedAt: z.number().int().nonnegative().optional(),
	answeredAt: z.number().int().nonnegative().optional(),
	error: z.string().optional()
});

const SpecialistRunStateSchema = z.object({
	id: z.enum(['organization', 'language', 'discourse', 'synthesis']),
	status: z.enum(['pending', 'running', 'completed', 'error', 'cancelled']),
	families: z.array(z.enum(STYLE_FAMILIES)),
	error: z.string().optional(),
	startedAt: z.number().int().nonnegative().optional(),
	completedAt: z.number().int().nonnegative().optional()
});

export const StyleAnalysisRunSchema = z.object({
	id: z.string().min(1),
	status: z.enum(['queued', 'running', 'completed', 'error', 'cancelled']),
	provider: z.string().min(1),
	model: z.string().optional(),
	phase: z.string().min(1),
	progress: z.number().min(0).max(100),
	startedAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
	completedAt: z.number().int().nonnegative().optional(),
	error: z.string().optional(),
	specialists: z.array(SpecialistRunStateSchema)
});

export const StyleProfileSchema = z.object({
	schemaVersion: z.number().int().positive(),
	analyzerVersion: z.string().min(1),
	status: z.enum(['empty', 'ready-to-analyze', 'analyzing', 'needs-calibration', 'active', 'stale', 'error']),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
	sourceSnapshotHash: z.string().min(1),
	skillId: z.string().optional(),
	skillPath: z.string().optional(),
	propositions: z.array(StylePropositionSchema),
	calibrations: z.array(CalibrationTrialSchema),
	lastRun: StyleAnalysisRunSchema.optional()
});

export type PropositionDraft = z.infer<typeof PropositionDraftSchema>;
export type SpecialistSubmission = z.infer<typeof SpecialistSubmissionSchema>;
export type SynthesisSubmission = z.infer<typeof SynthesisSubmissionSchema>;
