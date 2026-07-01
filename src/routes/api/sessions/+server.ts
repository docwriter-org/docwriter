import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSessionId, setSessionId, setSessionOwner } from '$lib/server/runtime-state';
import {
	dbGetConversationSessionSummary,
	dbListConversationSessions
} from '$lib/server/db-writes';

export const GET: RequestHandler = async ({ url }) => {
	const limitParam = Number(url.searchParams.get('limit') ?? '100');
	const limit = Number.isFinite(limitParam)
		? Math.max(1, Math.min(200, Math.floor(limitParam)))
		: 100;
	const currentSessionId = getSessionId();
	const sessions = dbListConversationSessions(limit).map((session) => ({
		...session,
		isCurrent: session.id === currentSessionId
	}));
	return json({ currentSessionId, sessions });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
	if (!sessionId) {
		return json({ ok: false, message: 'Missing sessionId' }, { status: 400 });
	}

	const session = dbGetConversationSessionSummary(sessionId);
	if (!session) {
		return json({ ok: false, message: 'Session not found' }, { status: 404 });
	}

	setSessionId(session.id);
	setSessionOwner(session.provider, session.model);
	return json({ ok: true, session });
};
