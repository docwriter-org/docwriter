import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFileSync, existsSync } from 'fs';
import { DOC_FILE } from '$lib/server/document-files';
import { writeJsonAtomic } from '$lib/server/file-utils';

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
		writeJsonAtomic(DOC_FILE, body);
		return json({ ok: true });
	} catch (e) {
		return json({ error: String(e) }, { status: 500 });
	}
};
