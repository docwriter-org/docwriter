import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isProviderId, type ProviderId } from '$lib/shared/providers';
import { startStyleAnalysisRun } from '$lib/server/style-analysis/run-manager';


export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const provider = body?.provider as ProviderId;
	if (!isProviderId(provider)) throw error(400, 'Invalid provider');
	try {
		return json({ run: startStyleAnalysisRun({
			provider,
			model: typeof body.model === 'string' && body.model ? body.model : undefined,
			force: body.force === true
		}) }, { status: 202 });
	} catch (cause) {
		throw error(409, cause instanceof Error ? cause.message : String(cause));
	}
};
