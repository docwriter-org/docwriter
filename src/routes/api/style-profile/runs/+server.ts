import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { ProviderId } from '$lib/server/providers/types';
import { startStyleAnalysisRun } from '$lib/server/style-analysis/run-manager';

const PROVIDERS = new Set<ProviderId>(['claude', 'openai', 'codex', 'cursor', 'pi']);

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const provider = body?.provider as ProviderId;
	if (!PROVIDERS.has(provider)) throw error(400, 'Invalid provider');
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
