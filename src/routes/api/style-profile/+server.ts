import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStyleProfileSummary } from '$lib/server/style/pipeline';

export const GET: RequestHandler = async () => {
	return json(getStyleProfileSummary());
};
