import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startStyleAnalysisRun } from '$lib/server/style/pipeline';
import type { ProviderId } from '$lib/server/providers/types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const provider = typeof body.provider === 'string' ? (body.provider as ProviderId) : undefined;
	const model = typeof body.model === 'string' ? body.model : undefined;
	// Explicit escape hatch for unit/dev only — never the default product path.
	const useHeuristicsOnly = body.useHeuristicsOnly === true;
	const referenceIds = Array.isArray(body.referenceIds)
		? body.referenceIds.filter((x: unknown) => typeof x === 'string')
		: undefined;

	if (!useHeuristicsOnly && !provider) {
		throw error(400, 'Select a provider/model to run style analysis (specialist agent passes).');
	}

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
