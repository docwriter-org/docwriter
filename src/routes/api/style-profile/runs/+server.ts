import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startStyleAnalysisRun } from '$lib/server/style/pipeline';
import type { ProviderId } from '$lib/server/providers/types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const provider = typeof body.provider === 'string' ? (body.provider as ProviderId) : undefined;
	const model = typeof body.model === 'string' ? body.model : undefined;
	const useHeuristicsOnly = body.useHeuristicsOnly === true || !provider;
	const referenceIds = Array.isArray(body.referenceIds)
		? body.referenceIds.filter((x: unknown) => typeof x === 'string')
		: undefined;

	try {
		const { runId } = await startStyleAnalysisRun({
			provider,
			model,
			useHeuristicsOnly,
			referenceIds
		});
		return json({ runId });
	} catch (err) {
		throw error(400, (err as Error).message);
	}
};
