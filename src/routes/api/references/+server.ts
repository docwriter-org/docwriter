import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	addUrlReference,
	addWorkspaceFileReference,
	createStoredSampleReference,
	listStyleReferences
} from '$lib/server/references';
import { isValidTabId } from '$lib/server/document-files';

export const GET: RequestHandler = async () => {
	return json({ references: listStyleReferences() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	if (body?.mode === 'add-current-file') {
		const tabId = typeof body.tabId === 'string' ? body.tabId : '';
		if (!isValidTabId(tabId)) throw error(400, 'Invalid tab id');
		const reference = addWorkspaceFileReference(tabId);
		return json({ reference });
	}

	if (body?.mode === 'add-sample') {
		const name = typeof body.name === 'string' ? body.name : '';
		const content = typeof body.content === 'string' ? body.content : '';
		const reference = createStoredSampleReference(name, content);
		return json({ reference });
	}

	if (body?.mode === 'add-url') {
		const url = typeof body.url === 'string' ? body.url : '';
		const label = typeof body.label === 'string' ? body.label : undefined;
		const reference = addUrlReference(url, label);
		return json({ reference });
	}

	throw error(400, 'Invalid reference request');
};
