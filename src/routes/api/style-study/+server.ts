import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { styleProfileSummary } from '$lib/server/style-analysis/profile-store';
import { appendStyleStudyEvent } from '$lib/server/style-analysis/study-log';

const StudyMetricSchema = z.object({
	type: z.enum(['condition_assigned', 'editing_completed', 'blind_preference']),
	condition: z.enum(['no-references', 'raw-references', 'compiled-author-skill']).optional(),
	participantId: z.string().trim().min(1).max(120).optional(),
	taskId: z.string().trim().min(1).max(120).optional(),
	durationMs: z.number().int().nonnegative().optional(),
	agentRounds: z.number().int().nonnegative().optional(),
	acceptedEdits: z.number().int().nonnegative().optional(),
	rejectedEdits: z.number().int().nonnegative().optional(),
	userEditDistance: z.number().int().nonnegative().optional(),
	finalCorrectionSize: z.number().int().nonnegative().optional(),
	choice: z.enum(['no-references', 'raw-references', 'compiled-author-skill', 'tie', 'none']).optional(),
	provider: z.string().trim().min(1).max(120).optional(),
	model: z.string().trim().min(1).max(160).optional(),
	schemaVersions: z.record(z.string(), z.union([z.string(), z.number()])).optional()
}).strict();

function currentCondition(): 'no-references' | 'raw-references' | 'compiled-author-skill' {
	const summary = styleProfileSummary();
	if (summary.referenceCount === 0) return 'no-references';
	if (summary.activeCount > 0) return 'compiled-author-skill';
	return 'raw-references';
}

export const GET: RequestHandler = async () => json({
	schemaVersion: 1,
	condition: currentCondition()
});

export const POST: RequestHandler = async ({ request }) => {
	const parsed = StudyMetricSchema.safeParse(await request.json());
	if (!parsed.success) throw error(400, parsed.error.issues[0]?.message ?? 'Invalid study event');
	const { type, condition, ...metrics } = parsed.data;
	appendStyleStudyEvent(type, { condition: condition ?? currentCondition(), ...metrics });
	return json({ ok: true }, { status: 202 });
};
