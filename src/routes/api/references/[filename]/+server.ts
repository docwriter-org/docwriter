import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFileSync } from 'fs';
import { join } from 'path';
import { normalizeAtomzFile } from '$lib/atomz';

const EXAMPLES_DIR = join(process.cwd(), '.claude/skills/atomz-style/examples');

export const GET: RequestHandler = async ({ params }) => {
	try {
		const content = readFileSync(join(EXAMPLES_DIR, params.filename), 'utf-8');
		return json(normalizeAtomzFile(content));
	} catch {
		return json({ error: 'Not found' }, { status: 404 });
	}
};
