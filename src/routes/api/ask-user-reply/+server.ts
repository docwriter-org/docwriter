import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolvePendingAskUser } from '$lib/server/ask-user-state';

/**
 * POST /api/ask-user-reply
 *   body: { id: string, answers: string[] }
 *
 * The client calls this when the user answers an AskUserQuestion card.
 * Resolves the pending promise held by canUseTool in /api/render so the
 * SDK's paused tool call can complete with the user's selections. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const id = typeof body.id === 'string' ? body.id : '';
	const answers = Array.isArray(body.answers) ? body.answers.map((a: unknown) => String(a)) : [];
	if (!id) throw error(400, 'id required');
	const ok = resolvePendingAskUser(id, answers);
	if (!ok) throw error(404, `Question ${id} not pending (timed out or already answered)`);
	return json({ ok: true });
};
