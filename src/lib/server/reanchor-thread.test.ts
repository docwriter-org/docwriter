import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getCommentsMap, getThread, seedYDoc, serializeYDoc } from '$lib/shared/ydoc-codec';
import { proposeReplacement, proposedText, summarizeThreadMarks } from '$lib/shared/proposals';
import { applyReplyToComment, createAgentCommentThread } from './mcp-doc-tools';
import type { CommentThread } from '$lib/types';

function seedDoc(text: string): Y.Doc {
	const doc = new Y.Doc();
	seedYDoc(doc, text);
	return doc;
}

function orphanThread(id: string): CommentThread {
	return {
		id,
		messages: [{ id: 'msg_1', author: 'agent', text: 'I will replace the placeholder.', timestamp: 1 }],
		resolved: false,
		createdAt: 1
	};
}

describe('thread re-attach', () => {
	it('re-attaches an existing thread onto a new passage as a comment mark', () => {
		const doc = seedDoc(
			'Course Logistics and Goals.\nA data-systems course on architecture and concurrency.'
		);
		expect(serializeYDoc(doc)).toContain('A data-systems course');
		// A legacy plain-object thread with no marks anywhere.
		getCommentsMap(doc).set('thread_orphan', orphanThread('thread_orphan'));

		const result = applyReplyToComment(
			doc,
			'thread_orphan',
			'document.md',
			'I am re-attaching this thread after a neighboring edit landed.',
			{ anchorText: 'A data-systems course on architecture and concurrency.' }
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.reanchored).toBe(true);

		// The reply also upgrades the legacy plain-object thread to nested Y
		// form in place; getThread reads both shapes.
		const updated = getThread(getCommentsMap(doc), 'thread_orphan');
		expect(updated?.resolved).toBe(false);
		expect(updated?.messages).toHaveLength(2);
		expect(updated?.messages[1]?.text).toMatch(/re-attaching/);
		const [summary] = summarizeThreadMarks(doc);
		expect(summary).toMatchObject({
			threadId: 'thread_orphan',
			hasProposal: false,
			para: 1,
			quote: 'A data-systems course on architecture and concurrency.'
		});
	});

	it('rejects re-attach when the new passage is not in the document', () => {
		const doc = seedDoc('Only this sentence remains.');
		getCommentsMap(doc).set('thread_orphan', orphanThread('thread_orphan'));
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

	it('refuses to re-attach onto a passage another thread holds, naming it', () => {
		const doc = seedDoc('First sentence here.\nSecond sentence here.');
		getCommentsMap(doc).set('thread_orphan', orphanThread('thread_orphan'));
		expect(proposeReplacement(doc, 'thread_edit', 'Second', 'Next')).toEqual({ ok: true, noop: false });
		// The agent reads the proposed view, where line two already says "Next".
		const result = applyReplyToComment(doc, 'thread_orphan', 'document.md', 'Moving.', {
			anchorText: 'sentence here.\nNext'
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/thread_edit/);
		// Nothing was written: no reply, no mark.
		expect(getThread(getCommentsMap(doc), 'thread_orphan')?.messages).toHaveLength(1);
		expect(summarizeThreadMarks(doc).map((s) => s.threadId)).toEqual(['thread_edit']);
	});
});

describe('agent comment threads', () => {
	it('anchor on the proposed view, so a comment can sit on proposed text', () => {
		const doc = seedDoc('The cat sat on the mat.');
		expect(proposeReplacement(doc, 'thread_edit', 'cat', 'dog')).toEqual({ ok: true, noop: false });
		expect(proposedText(doc)).toBe('The dog sat on the mat.');
		// The same thread may comment on its own proposal.
		const own = createAgentCommentThread(doc, 'document.md', 'dog sat', undefined, 'Note.');
		expect(own.ok).toBe(false); // a fresh thread cannot: the line belongs to thread_edit
		if (!own.ok) expect(own.error).toMatch(/thread_edit/);
	});

	it('creates a thread with a comment mark on the passage', () => {
		const doc = seedDoc('alpha\nbeta gamma\nomega');
		const created = createAgentCommentThread(doc, 'document.md', 'gamma', undefined, 'Why gamma?');
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const thread = getThread(getCommentsMap(doc), created.threadId);
		expect(thread?.messages[0]?.text).toBe('Why gamma?');
		const [summary] = summarizeThreadMarks(doc);
		expect(summary).toMatchObject({ threadId: created.threadId, para: 1, rawOffset: 5, quote: 'gamma' });
		expect(serializeYDoc(doc)).toBe('alpha\nbeta gamma\nomega');
	});
});
