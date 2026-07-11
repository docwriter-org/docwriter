import { json } from '@sveltejs/kit';

/** Unauthenticated liveness probe for the Fly http_service check. */
export const GET = () => json({ ok: true });
