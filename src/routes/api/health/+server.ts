import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Liveness probe for hosted deployments: the supervisor polls this after
 * spawning a user's process to know when to start proxying. Deliberately
 * touches nothing (no DB, no workspace) so it answers as soon as the HTTP
 * server is up. */
export const GET: RequestHandler = async () => json({ ok: true });
