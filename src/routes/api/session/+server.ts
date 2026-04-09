import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSessionId, setSessionId } from '$lib/server/runtime-state';
import { STATE_FILE } from '$lib/server/document-files';
import { writeFileSync } from 'fs';

export const GET: RequestHandler = async () => {
	return json({ sessionId: getSessionId() });
};

export const DELETE: RequestHandler = async () => {
	// Clear the session ID so the next render starts a fresh session
	writeFileSync(STATE_FILE, JSON.stringify({}, null, 2));
	return json({ ok: true });
};
