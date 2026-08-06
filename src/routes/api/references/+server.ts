import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	addUrlReference,
	addWorkspaceFileReference,
	createStoredSampleReference,
	listStyleReferences
} from '$lib/server/references';
import { isValidTabId } from '$lib/server/document-files';
import type { StyleReferenceRole } from '$lib/style-profile';

function parseRole(value: unknown, fallback: StyleReferenceRole): StyleReferenceRole {
	return value === 'authored' || value === 'inspiration' ? value : fallback;
}

export const GET: RequestHandler = async () => {
	return json({ references: listStyleReferences() });
};

// File uploads go through /api/references/ingest, which stores the bytes and
// streams the agent's interpretation of the rest of the submission.
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	if (body?.mode === 'add-current-file') {
		const tabId = typeof body.tabId === 'string' ? body.tabId : '';
		if (!isValidTabId(tabId)) throw error(400, 'Invalid tab id');
		const reference = addWorkspaceFileReference(tabId, parseRole(body.role, 'authored'));
		return json({ reference });
	}

	if (body?.mode === 'add-sample') {
		const description = typeof body.description === 'string' ? body.description.trim() : '';
		const content = typeof body.content === 'string' ? body.content : '';
		const name = typeof body.name === 'string' && body.name.trim() ? body.name : description;
		try {
			const reference = createStoredSampleReference(
				name,
				content,
				parseRole(body.role, 'authored'),
				description || undefined
			);
			return json({ reference });
		} catch (cause) {
			throw error(400, cause instanceof Error ? cause.message : String(cause));
		}
	}

	if (body?.mode === 'add-url') {
		const url = typeof body.url === 'string' ? body.url : '';
		const label = typeof body.label === 'string' ? body.label : undefined;
		const reference = addUrlReference(url, label, parseRole(body.role, 'inspiration'));
		return json({ reference });
	}

	throw error(400, 'Invalid reference request');
};
