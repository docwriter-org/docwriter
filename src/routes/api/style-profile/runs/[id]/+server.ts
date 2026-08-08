import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cancelStyleAnalysisRun, getStyleAnalysisRun } from '$lib/server/style-analysis/run-manager';

export const GET: RequestHandler = async ({ params }) => {
	const run = getStyleAnalysisRun(params.id);
	if (!run) throw error(404, 'Style analysis run not found');
	return json({ run });
};

export const DELETE: RequestHandler = async ({ params }) => {
	const run = cancelStyleAnalysisRun(params.id);
	if (!run) throw error(404, 'Style analysis run not found');
	return json({ run });
};
