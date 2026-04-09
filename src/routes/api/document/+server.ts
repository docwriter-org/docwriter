import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { DOC_FILE } from '$lib/server/document-files';

export const GET: RequestHandler = async () => {
	try {
		if (!existsSync(DOC_FILE)) {
			return json(null);
		}
		const content = readFileSync(DOC_FILE, 'utf-8');
		return json(JSON.parse(content));
	} catch {
		return json(null);
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		writeFileSync(DOC_FILE, JSON.stringify(body, null, 2));
		return json({ ok: true });
	} catch (e) {
		return json({ error: String(e) }, { status: 500 });
	}
};
