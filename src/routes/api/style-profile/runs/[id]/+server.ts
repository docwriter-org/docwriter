import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cancelStyleRun, getStyleRun } from '$lib/server/style/pipeline';

export const DELETE: RequestHandler = async ({ params }) => {
	const ok = cancelStyleRun(params.id);
	if (!ok && !getStyleRun(params.id)) throw error(404, 'Run not found');
	return json({ cancelled: ok });
};
