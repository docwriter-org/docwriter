import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	addUrlReference,
	addWorkspaceFileReference,
	createStoredSampleReference,
	listStyleReferences,
	updateStyleReference,
	type StyleReferenceRole
} from '$lib/server/references';
import { isValidTabId } from '$lib/server/document-files';
import { materializeReference, writeCachedExtraction } from '$lib/server/style/materialize';

function parseRole(raw: unknown): StyleReferenceRole {
	return raw === 'inspiration' ? 'inspiration' : 'authored';
}

export const GET: RequestHandler = async () => {
	return json({ references: listStyleReferences() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const role = parseRole(body?.role);

	if (body?.mode === 'add-current-file') {
		const tabId = typeof body.tabId === 'string' ? body.tabId : '';
		if (!isValidTabId(tabId)) throw error(400, 'Invalid tab id');
		const reference = addWorkspaceFileReference(tabId, role);
		return json({ reference });
	}

	if (body?.mode === 'add-sample') {
		const name = typeof body.name === 'string' ? body.name : '';
		const content = typeof body.content === 'string' ? body.content : '';
		const reference = createStoredSampleReference(name, content, role);
		return json({ reference });
	}

	if (body?.mode === 'add-url') {
		const url = typeof body.url === 'string' ? body.url : '';
		const label = typeof body.label === 'string' ? body.label : undefined;
		const reference = addUrlReference(url, label, role);
		return json({ reference });
	}

	if (body?.mode === 'materialize') {
		const id = typeof body.id === 'string' ? body.id : '';
		const refs = listStyleReferences();
		const ref = refs.find((r) => r.id === id);
		if (!ref) throw error(404, 'Reference not found');
		const materialized = await materializeReference(ref, ref.role ?? role);
		const updated = updateStyleReference(id, {
			contentHash: materialized.contentHash || undefined,
			cachePath: materialized.cachePath,
			extractedAt: materialized.extractedAt,
			format: materialized.format as any,
			materializationStatus: materialized.error ? 'error' : 'ready',
			error: materialized.error
		});
		return json({ reference: updated, text: materialized.text, error: materialized.error });
	}

	if (body?.mode === 'save-extracted') {
		const id = typeof body.id === 'string' ? body.id : '';
		const text = typeof body.text === 'string' ? body.text : '';
		if (!text.trim()) throw error(400, 'Extracted text is required');
		const cachePath = writeCachedExtraction(text);
		const { contentHash } = await import('$lib/server/style/materialize');
		const updated = updateStyleReference(id, {
			cachePath,
			contentHash: contentHash(text),
			extractedAt: Date.now(),
			materializationStatus: 'ready',
			error: undefined
		});
		return json({ reference: updated });
	}

	if (body?.mode === 'set-role') {
		const id = typeof body.id === 'string' ? body.id : '';
		const updated = updateStyleReference(id, { role });
		return json({ reference: updated });
	}

	throw error(400, 'Invalid reference request');
};
