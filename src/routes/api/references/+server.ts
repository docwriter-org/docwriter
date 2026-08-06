import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createStoredSampleReference, listStyleReferences } from '$lib/server/references';
import type { StyleReferenceRole } from '$lib/style-profile';

function parseRole(value: unknown, fallback: StyleReferenceRole): StyleReferenceRole {
	return value === 'authored' || value === 'inspiration' ? value : fallback;
}

export const GET: RequestHandler = async () => {
	return json({ references: listStyleReferences() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

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

	throw error(400, 'Invalid reference request');
};
