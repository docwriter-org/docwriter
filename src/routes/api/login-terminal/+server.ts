import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isLoginProvider, startLoginSession } from '$lib/server/login-terminal';

/**
 * Start an embedded login terminal. Body: { provider: 'claude' | 'codex',
 * cols?, rows? }. The command is fixed per provider on the server; the
 * request never carries an argv.
 */
export const POST: RequestHandler = async ({ request }) => {
	let body: { provider?: unknown; cols?: unknown; rows?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}
	if (!isLoginProvider(body.provider)) {
		return json({ error: 'provider must be "claude" or "codex"' }, { status: 400 });
	}
	const cols = typeof body.cols === 'number' ? body.cols : 100;
	const rows = typeof body.rows === 'number' ? body.rows : 28;
	try {
		const session = await startLoginSession(body.provider, { cols, rows });
		return json(session);
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
