/**
 * Clear pending reviews and/or comment threads from a tab Y.Doc.
 *
 * Recovery helper: stuck gutter cards (a loose edit with no thread, a stale
 * proposal that will not accept) live in the CRDT, not in a separate table.
 * This mutates those maps in place and leaves document text, rules, hooks,
 * and settings untouched.
 */
import * as Y from 'yjs';
import { getCommentsMap, getReviewArray, USER_ORIGIN } from './ydoc-codec';

export interface UiResetOptions {
	reviews?: boolean;
	comments?: boolean;
}

export interface UiResetResult {
	reviewsCleared: number;
	commentsCleared: number;
}

export function applyUiReset(ydoc: Y.Doc, options: UiResetOptions = {}): UiResetResult {
	const clearReviews = options.reviews !== false;
	const clearComments = options.comments !== false;
	const reviewArr = getReviewArray(ydoc);
	const commentsMap = getCommentsMap(ydoc);
	const reviewsCleared = clearReviews ? reviewArr.length : 0;
	let commentsCleared = 0;
	if (clearComments) {
		commentsMap.forEach(() => {
			commentsCleared += 1;
		});
	}
	if (reviewsCleared === 0 && commentsCleared === 0) {
		return { reviewsCleared: 0, commentsCleared: 0 };
	}
	ydoc.transact(() => {
		if (clearReviews && reviewArr.length > 0) {
			reviewArr.delete(0, reviewArr.length);
		}
		if (clearComments && commentsCleared > 0) {
			const keys: string[] = [];
			commentsMap.forEach((_value, key) => {
				keys.push(key);
			});
			for (const key of keys) commentsMap.delete(key);
		}
	}, USER_ORIGIN);
	return { reviewsCleared, commentsCleared };
}
