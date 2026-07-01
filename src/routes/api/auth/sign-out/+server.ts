import { json } from '@sveltejs/kit';
import { getClerkClient } from '$lib/server/clerk-auth';

export async function POST({ locals }) {
	const clerkClient = getClerkClient();
	const sessionId = locals.auth?.sessionId;
	if (clerkClient && sessionId) {
		try {
			await clerkClient.sessions.revokeSession(sessionId);
		} catch {
			/* session may already be invalid */
		}
	}
	return json({ ok: true });
}
