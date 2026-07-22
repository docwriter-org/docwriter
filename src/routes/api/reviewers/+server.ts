import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	listReviewers,
	createReviewer,
	deleteReviewer
} from '$lib/server/reviewers';
import { findReviewer } from '$lib/shared/reviewers';

export const GET: RequestHandler = async () => {
	return json({ reviewers: listReviewers() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as {
		name?: string;
		icon?: string;
		color?: string;
		prompt?: string;
	};
	const name = (body.name ?? '').trim();
	const prompt = (body.prompt ?? '').trim();
	if (!name) throw error(400, 'Reviewer name is required');
	if (!prompt) throw error(400, 'Reviewer prompt is required');
	const reviewer = createReviewer({
		name,
		prompt,
		icon: (body.icon ?? '').trim() || 'owl',
		color: (body.color ?? '').trim() || '#57534e'
	});
	return json({ reviewer });
};

export const DELETE: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id');
	if (!id) throw error(400, 'id is required');
	if (findReviewer(id)?.builtin) throw error(400, 'Built-in reviewers cannot be deleted');
	const deleted = deleteReviewer(id);
	if (!deleted) throw error(404, 'Reviewer not found');
	return json({ ok: true });
};
