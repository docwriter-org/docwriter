import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	deleteStyleReference,
	listStyleReferences,
	updateStyleReference
} from '$lib/server/references';
import { updateMaterializedReferenceText } from '$lib/server/style-analysis/materialize';

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

export const PATCH: RequestHandler = async ({ params, request }) => {
	const id = decodeId(params.id);
	const body = await request.json();
	if (body?.role !== undefined && body.role !== 'authored' && body.role !== 'inspiration') {
		throw error(400, 'Invalid reference role');
	}
	try {
		if (typeof body?.text === 'string') {
			const materialized = updateMaterializedReferenceText(id, body.text);
			if (body.role) updateStyleReference(id, { role: body.role });
			return json({ reference: listStyleReferences().find((reference) => reference.id === id), materialized: { text: materialized.text } });
		}
		const reference = updateStyleReference(id, {
			...(body.role ? { role: body.role } : {}),
			...(typeof body.selected === 'boolean' ? { selected: body.selected } : {}),
			...(typeof body.label === 'string' && body.label.trim() ? { label: body.label.trim() } : {})
		});
		return json({ reference });
	} catch (cause) {
		throw error(400, cause instanceof Error ? cause.message : String(cause));
	}
};
