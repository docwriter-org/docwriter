import { json, error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import { registerPendingAskUser } from '$lib/server/ask-user-state';

/**
 * POST /api/ask-user-pending  (dev only)
 *   body: { id?: string }
 *
 * Parks a pending AskUserQuestion resolver so `/api/ask-user-reply` can
 * be exercised without a live agent run (e.g. dismiss-via-X demos).
 * No-ops in production. */
export const POST: RequestHandler = async ({ request }) => {
	if (!dev) throw error(404, 'Not found');
	const body = await request.json().catch(() => ({}));
	const id =
		typeof body.id === 'string' && body.id
			? body.id
			: 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
	registerPendingAskUser(id, () => {}, 15 * 60_000);
	return json({ id });
};
