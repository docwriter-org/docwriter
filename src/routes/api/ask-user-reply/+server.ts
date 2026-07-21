import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolvePendingAskUser, type AskUserAnswers } from '$lib/server/ask-user-state';

/**
 * POST /api/ask-user-reply
 *   body: { id: string, answers: Record<string, string> }
 *
 * The client calls this when the user answers an AskUserQuestion card.
 * `answers` is keyed by question text (multi-select labels comma-joined)
 * — the exact shape the SDK's AskUserQuestion schema expects. Resolves
 * the pending promise held by canUseTool in /api/render so the SDK's
 * paused tool call can complete with the user's selections. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const id = typeof body.id === 'string' ? body.id : '';
	const answers: AskUserAnswers = {};
	if (body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)) {
		for (const [question, answer] of Object.entries(body.answers as Record<string, unknown>)) {
			answers[question] = String(answer);
		}
	}
	if (!id) throw error(400, 'id required');
	const ok = resolvePendingAskUser(id, answers);
	if (!ok) throw error(404, `Question ${id} not pending (timed out or already answered)`);
	return json({ ok: true });
};
