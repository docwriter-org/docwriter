import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { normalizeAtomzFile, projectAtomzFileToRenderDocument } from '$lib/atomz';

const EXAMPLES_DIR = join(process.cwd(), '.claude/skills/atomz-style/examples');

export const GET: RequestHandler = async () => {
	try {
		const files = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.atomz'));
		const refs = files.map((f) => {
			try {
				const content = normalizeAtomzFile(readFileSync(join(EXAMPLES_DIR, f), 'utf-8'));
				const renderDoc = projectAtomzFileToRenderDocument(content);
				return {
					filename: f,
					source: content.source || f,
					tag: content.tag || 'inspo',
					atomCount: content.atoms?.length || 0,
					preview: renderDoc.prose?.[0]?.text?.slice(0, 80) || ''
				};
			} catch {
				return { filename: f, source: f, tag: 'inspo', atomCount: 0, preview: '' };
			}
		});
		return json(refs);
	} catch {
		return json([]);
	}
};
