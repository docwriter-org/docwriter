import { json } from '@sveltejs/kit';
import { getClerkClient, revokeSession } from '$lib/server/clerk-auth';

export async function POST({ locals }) {
	const clerkClient = getClerkClient();
	if (clerkClient) {
		await revokeSession(clerkClient, locals.auth?.sessionId ?? null);
	}
	return json({ ok: true });
}
