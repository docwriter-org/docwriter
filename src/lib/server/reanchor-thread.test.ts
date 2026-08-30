import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
	buildThreadAnchor,
	getCommentsMap,
	getReviewArray,
	readReviewRounds,
	seedYDoc,
	serializeYDoc
} from '$lib/shared/ydoc-codec';
import { applyPendingReviewRound } from '$lib/review-rounds';
import { applyReplyToComment, commitWriteToLiveDoc } from './mcp-doc-tools';
import { matchesStaleAcceptApply } from '$lib/shared/stale-accept';
import type { CommentThread } from '$lib/types';

function seedDoc(text: string): Y.Doc {
	const doc = new Y.Doc();
	seedYDoc(doc, text);
	return doc;
}

describe('stale proposal + thread re-attach', () => {
	it('marks an edit stale once its old_string is gone', () => {
		const applied = applyPendingReviewRound(
			'The course covers databases and systems.',
			{
				id: 'r1',
				timestamp: 1,
				operation: {
					type: 'edit',
					oldString: 'Placeholder: add a short description.',
					newString: 'A seminar on data systems.'
				}
			}
		);
		expect(applied.stale).toBe(true);
		expect(applied.staleReason).toMatch(/no longer present/i);
	});

	it('builds a quote anchor at the chosen occurrence', () => {
		const text = 'alpha\nThe course covers databases.\nomega';
		const anchor = buildThreadAnchor(text, 'The course covers databases.', 0);
		expect(anchor).not.toBeNull();
		expect(anchor?.quote).toBe('The course covers databases.');
		expect(anchor?.occurrenceIndex).toBe(0);
		expect(anchor?.contextBefore).toMatch(/alpha/);
		expect(anchor?.contextAfter).toMatch(/omega/);
		expect(anchor?.relStart).toBeUndefined();
		expect(anchor?.relEnd).toBeUndefined();
	});

	it('re-attaches an existing thread onto a new passage', () => {
		const doc = seedDoc(
			'Course Logistics and Goals.\nA data-systems course on architecture and concurrency.'
		);
		expect(serializeYDoc(doc)).toContain('A data-systems course');

		const original: CommentThread = {
			id: 'thread_orphan',
			anchor: {
				quote: 'Placeholder: add a short description.',
				occurrenceIndex: 0
			},
			messages: [
				{
					id: 'msg_1',
					author: 'agent',
					text: 'I will replace the placeholder with a real description.',
					timestamp: 1
				}
			],
			resolved: false,
			createdAt: 1
		};
		getCommentsMap(doc).set(original.id, original);

		const result = applyReplyToComment(
			doc,
			'thread_orphan',
			'document.md',
			'I am re-attaching this thread after a neighboring edit landed.',
			{ anchorText: 'A data-systems course on architecture and concurrency.' }
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.reanchored).toBe(true);

		const updated = getCommentsMap(doc).get('thread_orphan');
		expect(updated?.resolved).toBe(false);
		expect(updated?.anchor.quote).toBe(
			'A data-systems course on architecture and concurrency.'
		);
		expect(updated?.messages).toHaveLength(2);
		expect(updated?.messages[1]?.text).toMatch(/re-attaching/);
	});

	it('rejects re-attach when the new passage is not in the document', () => {
		const doc = seedDoc('Only this sentence remains.');
		getCommentsMap(doc).set('thread_orphan', {
			id: 'thread_orphan',
			anchor: { quote: 'gone', occurrenceIndex: 0 },
			messages: [{ id: 'm', author: 'agent', text: 'hi', timestamp: 1 }],
			resolved: false,
			createdAt: 1
		});
		const result = applyReplyToComment(
			doc,
			'thread_orphan',
			'document.md',
			'Trying to move this thread.',
			{ anchorText: 'text that is not here' }
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/not found/);
	});
});

describe('stale Accept commits the rebased write', () => {
	it('matches only the tab the user accepted', () => {
		const ctx = { tabId: 'document.md', staleRoundId: 'r1' };
		expect(matchesStaleAcceptApply(ctx, 'document.md')).toBe(true);
		expect(matchesStaleAcceptApply(ctx, 'other.md')).toBe(false);
		expect(matchesStaleAcceptApply(null, 'document.md')).toBe(false);
	});

	it('applies the current old_string and drops the stale round', () => {
		const live =
			'A draft note about course goals that no longer matches the proposal.';
		const intended =
			'This course surveys database architecture, data models, and concurrency.';
		const doc = seedDoc(live);
		getReviewArray(doc).push([
			{
				id: 'stale-round',
				timestamp: 1,
				feedbackThreadId: 'thread_orphan',
				operation: {
					type: 'edit',
					oldString: '[Placeholder: add a short description of the course goals and content.]',
					newString: intended
				}
			}
		]);
		getCommentsMap(doc).set('thread_orphan', {
			id: 'thread_orphan',
			anchor: {
				quote: '[Placeholder: add a short description of the course goals and content.]',
				occurrenceIndex: 0
			},
			messages: [
				{
					id: 'msg_1',
					author: 'agent',
					text: 'I will replace the placeholder.',
					timestamp: 1
				}
			],
			resolved: false,
			createdAt: 1
		});

		const result = commitWriteToLiveDoc(
			doc,
			{ type: 'edit', oldString: live, newString: intended },
			{ dropThreadId: 'thread_orphan', dropRoundId: 'stale-round' }
		);
		expect(result.ok).toBe(true);
		expect(serializeYDoc(doc)).toBe(intended);
		expect(readReviewRounds(doc)).toHaveLength(0);
	});

	it('leaves the document alone when the rebased old_string is missing', () => {
		const live = 'Current sentence that is not the target.';
		const doc = seedDoc(live);
		getReviewArray(doc).push([
			{
				id: 'stale-round',
				timestamp: 1,
				operation: {
					type: 'edit',
					oldString: 'gone placeholder',
					newString: 'intended'
				}
			}
		]);

		const result = commitWriteToLiveDoc(
			doc,
			{ type: 'edit', oldString: 'not in the document', newString: 'intended' },
			{ dropRoundId: 'stale-round' }
		);
		expect(result.ok).toBe(false);
		expect(serializeYDoc(doc)).toBe(live);
		expect(readReviewRounds(doc)).toHaveLength(1);
	});
});
