import { kvGet, kvSet, kvDelete } from './db-writes';
import type { FeedbackImportState, FeedbackDisposition } from '$lib/types';

const KV_KEY = 'feedbackImport';

export function getFeedbackImport(): FeedbackImportState | null {
	const raw = kvGet(KV_KEY);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as FeedbackImportState;
	} catch {
		return null;
	}
}

export function saveFeedbackImport(state: FeedbackImportState): void {
	kvSet(KV_KEY, JSON.stringify(state));
}

export function clearFeedbackImport(): void {
	kvDelete(KV_KEY);
}

export function updateFeedbackDisposition(
	commentId: string,
	threadId: string,
	disposition: FeedbackDisposition
): void {
	const state = getFeedbackImport();
	if (!state) return;
	state.commentToThread[commentId] = threadId;
	state.dispositions[commentId] = disposition;
	saveFeedbackImport(state);
}

export function matchImportedComment(
	externalAuthor: string,
	messageText: string
): string | null {
	const state = getFeedbackImport();
	if (!state) return null;
	for (const c of state.comments) {
		if (state.commentToThread[c.id]) continue;
		if (c.author.toLowerCase() === externalAuthor.toLowerCase()) {
			if (messageText.includes(c.text) || c.text.includes(messageText.slice(0, 80))) {
				return c.id;
			}
		}
	}
	for (const c of state.comments) {
		if (state.commentToThread[c.id]) continue;
		if (messageText.includes(c.text.slice(0, 60))) {
			return c.id;
		}
	}
	return null;
}
