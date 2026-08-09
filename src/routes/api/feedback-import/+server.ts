import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { FeedbackImportState, ImportedComment } from '$lib/types';
import {
	getFeedbackImport,
	saveFeedbackImport,
	clearFeedbackImport,
	updateFeedbackDisposition
} from '$lib/server/feedback-import';
import { extractDocxComments } from '$lib/server/docx-comments';

export const GET: RequestHandler = async () => {
	return json({ import: getFeedbackImport() });
};

export const POST: RequestHandler = async ({ request }) => {
	const contentType = request.headers.get('content-type') || '';
	let comments: ImportedComment[];
	let tabId: string;
	let source: 'paste' | 'docx' | 'gdocs' = 'paste';

	if (contentType.includes('multipart/form-data')) {
		const formData = await request.formData();
		tabId = formData.get('tabId') as string;
		const file = formData.get('file') as File | null;
		if (!file) {
			return json({ error: 'No file provided' }, { status: 400 });
		}
		const buffer = Buffer.from(await file.arrayBuffer());
		comments = await extractDocxComments(buffer);
		source = 'docx';
	} else {
		const body = (await request.json()) as {
			comments?: ImportedComment[];
			rawText?: string;
			tabId: string;
			source?: 'paste' | 'docx' | 'gdocs';
		};
		tabId = body.tabId;
		source = body.source ?? 'paste';
		comments = body.comments ?? [];
	}

	if (!comments.length && source === 'docx') {
		return json({ error: 'No comments found in the document' }, { status: 400 });
	}

	const state: FeedbackImportState = {
		id: 'imp_' + Math.random().toString(36).slice(2, 10),
		source,
		tabId,
		createdAt: Date.now(),
		comments,
		commentToThread: {},
		dispositions: Object.fromEntries(comments.map((c) => [c.id, 'untouched' as const]))
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
