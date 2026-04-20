import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	deleteStyleReference,
	listStyleReferences
} from '$lib/server/references';

function decodeId(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		throw error(400, 'Invalid reference id');
	}
}

export const GET: RequestHandler = async ({ params }) => {
	const id = decodeId(params.id);
	const reference = listStyleReferences().find((ref) => ref.id === id);
	if (!reference) throw error(404, 'Reference not found');
	return json({ reference });
};

export const DELETE: RequestHandler = async ({ params }) => {
	const id = decodeId(params.id);
	deleteStyleReference(id);
	return json({ ok: true });
};
