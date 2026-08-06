import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startStyleAnalysisRun } from '$lib/server/style/pipeline';
import type { ProviderId } from '$lib/server/providers/types';

/** Heuristics-only is a test/dev escape hatch — never open on the public product path. */
function allowHeuristicsOnly(): boolean {
	return (
		process.env.DOCWRITER_ALLOW_HEURISTICS_STYLE === '1' ||
		process.env.NODE_ENV === 'test' ||
		process.env.VITEST === 'true'
	);
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const provider = typeof body.provider === 'string' ? (body.provider as ProviderId) : undefined;
	const model = typeof body.model === 'string' ? body.model : undefined;
	const wantsHeuristics = body.useHeuristicsOnly === true;
	const useHeuristicsOnly = wantsHeuristics && allowHeuristicsOnly();
	if (wantsHeuristics && !useHeuristicsOnly) {
		throw error(400, 'Heuristics-only style analysis is disabled outside tests/dev.');
	}
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
