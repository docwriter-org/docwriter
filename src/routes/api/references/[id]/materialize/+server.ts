import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { materializeStyleReference } from '$lib/server/style-analysis/materialize';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const result = await materializeStyleReference(params.id, false);
		return json({ reference: result.reference, text: result.text, format: result.format });
	} catch (cause) {
		throw error(400, cause instanceof Error ? cause.message : String(cause));
	}
};

export const POST: RequestHandler = async ({ params, request }) => {
	let body: { force?: boolean } = {};
	try {
		body = await request.json();
	} catch {
		// The request body is optional.
	}
	try {
		const result = await materializeStyleReference(params.id, body.force === true);
		return json({ reference: result.reference, text: result.text, format: result.format });
	} catch (cause) {
		throw error(400, cause instanceof Error ? cause.message : String(cause));
	}
};
