import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { FeedbackImportState, ImportedComment } from '$lib/types';
import {
	getFeedbackImport,
	saveFeedbackImport,
	clearFeedbackImport,
	updateFeedbackDisposition
} from '$lib/server/feedback-import';

export const GET: RequestHandler = async () => {
	return json({ import: getFeedbackImport() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as {
		comments: ImportedComment[];
		tabId: string;
		source?: 'paste' | 'docx' | 'gdocs';
	};
	if (!body.comments?.length) {
		return json({ error: 'No comments provided' }, { status: 400 });
	}
	const state: FeedbackImportState = {
		id: 'imp_' + Math.random().toString(36).slice(2, 10),
		source: body.source ?? 'paste',
		tabId: body.tabId,
		createdAt: Date.now(),
		comments: body.comments,
		commentToThread: {},
		dispositions: Object.fromEntries(body.comments.map((c) => [c.id, 'untouched' as const]))
	};
	saveFeedbackImport(state);
	return json({ import: state });
};

export const PATCH: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as {
		commentId: string;
		threadId: string;
		disposition: 'applied' | 'discussed' | 'deferred';
	};
	updateFeedbackDisposition(body.commentId, body.threadId, body.disposition);
	return json({ ok: true });
};

export const DELETE: RequestHandler = async () => {
	clearFeedbackImport();
	return json({ ok: true });
};
