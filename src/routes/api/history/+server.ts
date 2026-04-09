import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { getSessionId } from '$lib/server/runtime-state';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const sessionId = url.searchParams.get('sessionId') || getSessionId();

		if (!sessionId) {
			return json({ messages: [], sessionId: null });
		}

		const messages = await getSessionMessages(sessionId);
		return json({ messages, sessionId });
	} catch (error) {
		return json({ error: String(error), messages: [] }, { status: 500 });
	}
};
