import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { getSessionId } from '$lib/server/runtime-state';

/**
 * Return the agent's saved session messages so the client can rehydrate the
 * Agent History pane after a page refresh. The Claude Agent SDK persists
 * every session to a JSONL transcript on disk (~/.claude/projects/…), keyed
 * by `sessionId`, and exposes `getSessionMessages` to read it back.
 *
 * Response shape mirrors what the SDK returns; the client transforms each
 * message into a `HistoryEntry` at display time (so the render-time code and
 * the rehydration code agree on formatting).
 */
export const GET: RequestHandler = async () => {
	const sessionId = getSessionId();
	if (!sessionId) return json({ sessionId: null, messages: [] });
	try {
		const messages = await getSessionMessages(sessionId, {
			dir: process.cwd(),
			limit: 200
		});
		return json({ sessionId, messages });
	} catch (e) {
		console.error('[history] getSessionMessages failed:', e);
		return json({ sessionId, messages: [] });
	}
};
