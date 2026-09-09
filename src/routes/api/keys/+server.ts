import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setGlobalKey, PROVIDER_KEYS } from '$lib/server/api-keys';
import { getProviderAuthStatus } from '$lib/server/provider-auth';

/**
 * Report per-provider auth status: API-key presence plus CLI-login details
 * (Claude Code, Codex). Never returns a secret value.
 */
export const GET: RequestHandler = async () => {
	return json({ providers: await getProviderAuthStatus() });
};

/**
 * Set (or clear) a provider API key. Body: { envVar, value }.
 * Writes to `~/.docwriter/keys.env` and applies to the live process.
 */
export const POST: RequestHandler = async ({ request }) => {
	let body: { envVar?: string; value?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { envVar, value } = body;
	if (!envVar || typeof envVar !== 'string') {
		return json({ error: 'envVar is required' }, { status: 400 });
	}
	// Only allow setting keys we actually manage.
	if (!PROVIDER_KEYS.some((p) => p.envVar === envVar)) {
		return json({ error: `unknown key: ${envVar}` }, { status: 400 });
	}

	try {
		setGlobalKey(envVar, typeof value === 'string' ? value.trim() : '');
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 400 });
	}

	return json({ providers: await getProviderAuthStatus() });
};
