import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyUiReset } from './reset-ui-state';
import { getCommentsMap, getReviewArray, seedYDoc, serializeYDoc } from './ydoc-codec';
import type { CommentThread, PendingReviewRound } from '$lib/types';

function seedDoc(text: string): Y.Doc {
	const doc = new Y.Doc();
	seedYDoc(doc, text);
	return doc;
}

function editRound(id: string, threadId?: string): PendingReviewRound {
	return {
		id,
		timestamp: 1,
		operation: { type: 'edit', oldString: 'hello', newString: 'hello world' },
		...(threadId ? { feedbackThreadId: threadId } : {})
	};
}

function thread(id: string): CommentThread {
	return {
		id,
		anchor: { quote: 'hello', occurrenceIndex: 0 },
		messages: [{ id: 'msg_1', author: 'agent', text: 'nits', timestamp: 1 }],
		resolved: false,
		createdAt: 1
	};
}

describe('applyUiReset', () => {
	it('clears pending reviews and comment threads without touching document text', () => {
		const doc = seedDoc('hello\nworld');
		getReviewArray(doc).push([editRound('r1'), editRound('r2', 'thread_1')]);
		getCommentsMap(doc).set('thread_1', thread('thread_1'));

		const result = applyUiReset(doc);

		expect(result).toEqual({ reviewsCleared: 2, commentsCleared: 1 });
		expect(getReviewArray(doc).length).toBe(0);
		expect(getCommentsMap(doc).size).toBe(0);
		expect(serializeYDoc(doc)).toBe('hello\nworld');
	});

	it('can clear only reviews or only comments', () => {
		const doc = seedDoc('hello');
		getReviewArray(doc).push([editRound('r1')]);
		getCommentsMap(doc).set('thread_1', thread('thread_1'));

		expect(applyUiReset(doc, { reviews: true, comments: false })).toEqual({
			reviewsCleared: 1,
			commentsCleared: 0
		});
		expect(getReviewArray(doc).length).toBe(0);
		expect(getCommentsMap(doc).has('thread_1')).toBe(true);

		expect(applyUiReset(doc, { reviews: false, comments: true })).toEqual({
			reviewsCleared: 0,
			commentsCleared: 1
		});
		expect(getCommentsMap(doc).size).toBe(0);
	});

	it('is a no-op when there is nothing to clear', () => {
		const doc = seedDoc('hello');
		expect(applyUiReset(doc)).toEqual({ reviewsCleared: 0, commentsCleared: 0 });
		expect(serializeYDoc(doc)).toBe('hello');
	});
});
