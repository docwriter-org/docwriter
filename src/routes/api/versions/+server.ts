import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { mergeRenderDocumentIntoAtomzFile, normalizeAtomzFile, projectAtomzFileToRenderDocument } from '$lib/atomz';

const DOC_FILE = join(process.cwd(), 'document.atomz');
const HISTORY_FILE = join(process.cwd(), '.atomz-history.json');

// GET: list all version history entries
export const GET: RequestHandler = async () => {
	try {
		if (!existsSync(HISTORY_FILE)) {
			return json({ versions: [] });
		}
		const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
		return json({ versions: history });
	} catch {
		return json({ versions: [] });
	}
};

// POST: restore from a specific version (by index)
export const POST: RequestHandler = async ({ request }) => {
	try {
		const { index } = await request.json();
		const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));

		if (index < 0 || index >= history.length) {
			return json({ error: 'Invalid version index' }, { status: 400 });
		}

		const version = history[index];

		// Read current canonical document, project to render doc, replace prose history snapshot, then merge back.
		const canonical = normalizeAtomzFile(readFileSync(DOC_FILE, 'utf-8'));
		const renderDocument = projectAtomzFileToRenderDocument(canonical);
		renderDocument.prose = version.prose.map((p: any, i: number) => ({
			id: i,
			text: p.text,
			frags: p.frags,
			para: p.para
		}));
		const merged = mergeRenderDocumentIntoAtomzFile(canonical, renderDocument);
		writeFileSync(DOC_FILE, JSON.stringify(merged, null, 2));

		return json({ document: merged });
	} catch (error) {
		return json({ error: String(error) }, { status: 500 });
	}
};
