import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readHooks, writeHooks, type Hook } from '$lib/server/hooks-config';

export const GET: RequestHandler = async () => {
	return json(readHooks());
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const hooks: Hook[] = Array.isArray(body?.hooks) ? body.hooks : [];
	writeHooks({ hooks });
	return json({ ok: true, hooks });
};
