import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readRunLogs } from '$lib/server/style-analysis/run-log-store';
import { readStylePropositionSnapshots } from '$lib/server/style-analysis/proposition-store';

/**
 * The stored working traces for a run, keyed by specialist. The events stream
 * only carries a trace while the run is live, so this is how a finished run
 * still has something to show.
 */
export const GET: RequestHandler = async ({ params }) => {
	return json({
		traces: readRunLogs(params.id),
		propositions: readStylePropositionSnapshots(params.id)
	});
};
