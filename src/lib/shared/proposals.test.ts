import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
	AGENT_ORIGIN,
	AI_ATTR,
	COMMENTS_MAP_NAME,
	FRAGMENT_NAME,
	USER_ORIGIN,
	seedYDoc
} from './ydoc-codec';
import {
	COMMENT_ATTR,
	DELETION_ATTR,
	INSERTION_ATTR,
	SUGGEST_ATTR,
	SUGGEST_THREAD_ATTR,
	committedText,
	migrateLegacyReviewState,
	proposalFingerprints,
	proposeReplacement,
	proposeText,
	proposedText,
	resolveThreadMarks,
	setCommentMarkByCommittedOffsets,
	summarizeThreadMarks
} from './proposals';

function docWith(text: string): Y.Doc {
	const doc = new Y.Doc();
	doc.transact(() => seedYDoc(doc, text), 'system');
	return doc;
}

interface Seg {
	text: string;
	attrs: Record<string, unknown>;
}

/** Every formatted run of the fragment, paragraph by paragraph, so a test
 * can assert exactly which marks landed where. */
function segments(doc: Y.Doc): Seg[][] {
	const out: Seg[][] = [];
	doc.getXmlFragment(FRAGMENT_NAME).forEach((p) => {
		const segs: Seg[] = [];
		(p as Y.XmlElement).forEach((c: unknown) => {
			if (c instanceof Y.XmlText) {
				for (const d of c.toDelta() as Array<{ insert: string; attributes?: Record<string, unknown> }>) {
					segs.push({ text: d.insert, attributes: d.attributes ?? {} } as unknown as Seg);
				}
			} else if (c instanceof Y.XmlElement && c.nodeName === 'hardBreak') {
				segs.push({ text: '<br>', attrs: {} });
			}
		});
		out.push(segs.map((s) => ({ text: s.text, attrs: (s as unknown as { attributes: Record<string, unknown> }).attributes ?? s.attrs })));
	});
	return out;
}

function paraAttrs(doc: Y.Doc): Array<{ suggest: unknown; thread: unknown }> {
	const out: Array<{ suggest: unknown; thread: unknown }> = [];
	doc.getXmlFragment(FRAGMENT_NAME).forEach((p) => {
		const el = p as Y.XmlElement;
		out.push({ suggest: el.getAttribute(SUGGEST_ATTR), thread: el.getAttribute(SUGGEST_THREAD_ATTR) });
	});
	return out;
}

function threadOf(seg: Seg, key: string): string | undefined {
	return (seg.attrs[key] as { threadId?: string } | undefined)?.threadId;
}

describe('word-level proposals', () => {
	const ORIGINAL = "The lab's expected answer was originally entered as 10.\nEarly annotations marked correct answers wrong.";

	it('marks removed words as deletions and added words as insertions, in place', () => {
		const doc = docWith(ORIGINAL);
		const r = proposeReplacement(doc, 't1', 'expected answer was originally entered as 10', 'answer originally read 10');
		expect(r).toEqual({ ok: true, noop: false });

		expect(committedText(doc)).toBe(ORIGINAL);
		expect(proposedText(doc)).toBe("The lab's answer originally read 10.\nEarly annotations marked correct answers wrong.");

		const [line] = segments(doc);
		const removed = line.filter((s) => threadOf(s, DELETION_ATTR) === 't1').map((s) => s.text);
		const added = line.filter((s) => threadOf(s, INSERTION_ATTR) === 't1').map((s) => s.text);
		expect(removed.map((s) => s.trim())).toEqual(['expected', 'was', 'entered as']);
		expect(added).toEqual(['read']);
		// Boundaries land on words, never inside them.
		for (const s of line) expect(s.text).not.toMatch(/^[a-z]+[A-Z]/);
		// The second paragraph is untouched.
		expect(segments(doc)[1].every((s) => Object.keys(s.attrs).length === 0)).toBe(true);
		expect(paraAttrs(doc).every((a) => a.suggest === undefined)).toBe(true);
	});

	it('summarizes the proposal per paragraph', () => {
		const doc = docWith(ORIGINAL);
		proposeReplacement(doc, 't1', 'entered as 10', 'read 10');
		const [s] = summarizeThreadMarks(doc);
		expect(s.threadId).toBe('t1');
		expect(s.hasProposal).toBe(true);
		expect(s.para).toBe(0);
		expect(s.changes).toEqual([
			{
				para: 0,
				before: "The lab's expected answer was originally entered as 10.",
				after: "The lab's expected answer was originally read 10."
			}
		]);
		expect(s.removedChars).toBeGreaterThan(0);
		expect(s.addedChars).toBeGreaterThan(0);
	});

	it('accept keeps the insertion as AI text and removes the struck text', () => {
		const doc = docWith(ORIGINAL);
		proposeReplacement(doc, 't1', 'entered as 10', 'read 10');
		doc.transact(() => resolveThreadMarks(doc, 't1', 'accepted'), USER_ORIGIN);
		expect(committedText(doc)).toBe("The lab's expected answer was originally read 10.\nEarly annotations marked correct answers wrong.");
		expect(proposedText(doc)).toBe(committedText(doc));
		const [line] = segments(doc);
		const ai = line.filter((s) => s.attrs[AI_ATTR] === true).map((s) => s.text);
		expect(ai).toEqual(['read']);
		expect(line.some((s) => s.attrs[INSERTION_ATTR] || s.attrs[DELETION_ATTR])).toBe(false);
		expect(summarizeThreadMarks(doc)).toEqual([]);
	});

	it('reject restores the original with no marks left behind', () => {
		const doc = docWith(ORIGINAL);
		proposeReplacement(doc, 't1', 'entered as 10', 'read 10');
		doc.transact(() => resolveThreadMarks(doc, 't1', 'rejected'), USER_ORIGIN);
		expect(committedText(doc)).toBe(ORIGINAL);
		expect(segments(doc).flat().every((s) => Object.keys(s.attrs).length === 0)).toBe(true);
		expect(summarizeThreadMarks(doc)).toEqual([]);
	});

	it('an identical replacement proposes nothing', () => {
		const doc = docWith(ORIGINAL);
		expect(proposeReplacement(doc, 't1', 'entered as 10', 'entered as 10')).toEqual({ ok: true, noop: true });
		expect(summarizeThreadMarks(doc)).toEqual([]);
	});

	it('reports a missing or ambiguous old_string', () => {
		const doc = docWith('same\nsame');
		expect(proposeReplacement(doc, 't1', 'gone', 'x')).toEqual({ ok: false, reason: 'not-found', hits: 0 });
		expect(proposeReplacement(doc, 't1', 'same', 'x')).toEqual({ ok: false, reason: 'ambiguous', hits: 2 });
		expect(proposeReplacement(doc, 't1', 'same', 'other', true)).toEqual({ ok: true, noop: false });
		expect(proposedText(doc)).toBe('other\nother');
	});
});

describe('line-level proposals', () => {
	it('a heavily rewritten line is struck whole and re-added as one line', () => {
		const doc = docWith('alpha\nThe quick brown fox jumps over the lazy dog.\nomega');
		proposeReplacement(doc, 't1', 'The quick brown fox jumps over the lazy dog.', 'Nothing here resembles the sentence before.');
		expect(paraAttrs(doc)).toEqual([
			{ suggest: undefined, thread: undefined },
			{ suggest: 'del', thread: 't1' },
			{ suggest: 'ins', thread: 't1' },
			{ suggest: undefined, thread: undefined }
		]);
		expect(committedText(doc)).toBe('alpha\nThe quick brown fox jumps over the lazy dog.\nomega');
		expect(proposedText(doc)).toBe('alpha\nNothing here resembles the sentence before.\nomega');
		doc.transact(() => resolveThreadMarks(doc, 't1', 'accepted'), USER_ORIGIN);
		expect(committedText(doc)).toBe('alpha\nNothing here resembles the sentence before.\nomega');
		expect(paraAttrs(doc).every((a) => a.suggest === undefined)).toBe(true);
	});

	it('added and removed lines, including blank ones, become inserted and deleted paragraphs', () => {
		const doc = docWith('one\ntwo\nthree');
		proposeReplacement(doc, 't1', 'one\ntwo\nthree', 'one\n\nnew line\nthree');
		expect(paraAttrs(doc)).toEqual([
			{ suggest: undefined, thread: undefined },
			{ suggest: 'del', thread: 't1' },
			{ suggest: 'ins', thread: 't1' },
			{ suggest: 'ins', thread: 't1' },
			{ suggest: undefined, thread: undefined }
		]);
		expect(proposedText(doc)).toBe('one\n\nnew line\nthree');
		expect(committedText(doc)).toBe('one\ntwo\nthree');
		doc.transact(() => resolveThreadMarks(doc, 't1', 'rejected'), USER_ORIGIN);
		expect(committedText(doc)).toBe('one\ntwo\nthree');
		expect(doc.getXmlFragment(FRAGMENT_NAME).length).toBe(3);
	});

	it('a whole new document lands as inserted paragraphs and accepts as AI text', () => {
		const doc = docWith('');
		expect(proposeText(doc, 't1', 'First line.\n\nThird line.')).toEqual({ ok: true, noop: false });
		expect(committedText(doc)).toBe('');
		expect(proposedText(doc)).toBe('First line.\n\nThird line.');
		doc.transact(() => resolveThreadMarks(doc, 't1', 'accepted'), USER_ORIGIN);
		expect(committedText(doc)).toBe('First line.\n\nThird line.');
		expect(segments(doc)[0][0].attrs[AI_ATTR]).toBe(true);
	});

	it('appending after the last line inserts at the end', () => {
		const doc = docWith('only');
		proposeReplacement(doc, 't1', 'only', 'only\nappended');
		expect(proposedText(doc)).toBe('only\nappended');
		expect(paraAttrs(doc)[1]).toEqual({ suggest: 'ins', thread: 't1' });
	});
});

describe('revising and overlapping', () => {
	it('a new proposal on the same thread replaces the old one', () => {
		const doc = docWith('The cat sat on the mat.');
		proposeReplacement(doc, 't1', 'cat', 'dog');
		expect(proposedText(doc)).toBe('The dog sat on the mat.');
		// The agent read the proposed view and revises against it.
		const r = proposeReplacement(doc, 't1', 'dog sat', 'fox slept');
		expect(r).toEqual({ ok: true, noop: false });
		expect(proposedText(doc)).toBe('The fox slept on the mat.');
		expect(committedText(doc)).toBe('The cat sat on the mat.');
		const [line] = segments(doc);
		// The surviving space between the two new words stays unmarked.
		expect(line.filter((s) => threadOf(s, INSERTION_ATTR)).map((s) => s.text)).toEqual(['fox', 'slept']);
		expect(line.filter((s) => threadOf(s, DELETION_ATTR)).map((s) => s.text)).toEqual(['cat', 'sat']);
		expect(summarizeThreadMarks(doc)).toHaveLength(1);
	});

	it('re-proposing the original text withdraws the proposal', () => {
		const doc = docWith('The cat sat.');
		proposeReplacement(doc, 't1', 'cat', 'dog');
		expect(proposeReplacement(doc, 't1', 'dog', 'cat')).toEqual({ ok: true, noop: true });
		expect(summarizeThreadMarks(doc)).toEqual([]);
		expect(committedText(doc)).toBe('The cat sat.');
	});

	it('another thread may not touch a line under proposal, and the document is untouched', () => {
		const doc = docWith('Line one here.\nLine two here.');
		proposeReplacement(doc, 't1', 'one', 'uno');
		const before = JSON.stringify(segments(doc));
		const r = proposeReplacement(doc, 't2', 'here.\nLine two', 'there.\nLine two');
		expect(r).toEqual({ ok: false, reason: 'overlap', otherThreadId: 't1' });
		expect(JSON.stringify(segments(doc))).toBe(before);
		// A different line is fine.
		expect(proposeReplacement(doc, 't2', 'two', 'dos')).toEqual({ ok: true, noop: false });
		expect(proposedText(doc)).toBe('Line uno here.\nLine dos here.');
		expect(summarizeThreadMarks(doc).map((s) => s.threadId)).toEqual(['t1', 't2']);
	});

	it('a comment highlight also claims its line', () => {
		const doc = docWith('Commented sentence.\nFree sentence.');
		doc.transact(() => {
			expect(setCommentMarkByCommittedOffsets(doc, 'c1', 0, 'Commented'.length)).toBe(true);
		}, AGENT_ORIGIN);
		expect(proposeReplacement(doc, 't1', 'sentence.\nFree', 'phrase.\nFree')).toEqual({
			ok: false,
			reason: 'overlap',
			otherThreadId: 'c1'
		});
		expect(proposeReplacement(doc, 'c1', 'Commented sentence', 'Commented phrase')).toEqual({ ok: true, noop: false });
		expect(proposeReplacement(doc, 't1', 'Free', 'Open')).toEqual({ ok: true, noop: false });
	});
});

describe('comment marks', () => {
	it('mark, summarize, and clear on resolve', () => {
		const doc = docWith('alpha beta gamma\ndelta');
		doc.transact(() => setCommentMarkByCommittedOffsets(doc, 'c1', 6, 10), AGENT_ORIGIN);
		const [s] = summarizeThreadMarks(doc);
		expect(s).toMatchObject({ threadId: 'c1', hasProposal: false, para: 0, rawOffset: 6, quote: 'beta' });
		expect(segments(doc)[0].find((x) => threadOf(x, COMMENT_ATTR) === 'c1')?.text).toBe('beta');
		doc.transact(() => resolveThreadMarks(doc, 'c1', 'dismissed'), USER_ORIGIN);
		expect(summarizeThreadMarks(doc)).toEqual([]);
		expect(committedText(doc)).toBe('alpha beta gamma\ndelta');
	});

	it('a range across lines marks each line and re-marking moves the highlight', () => {
		const doc = docWith('ab\ncd');
		doc.transact(() => setCommentMarkByCommittedOffsets(doc, 'c1', 1, 4), AGENT_ORIGIN);
		expect(segments(doc)[0].filter((x) => threadOf(x, COMMENT_ATTR)).map((x) => x.text)).toEqual(['b']);
		expect(segments(doc)[1].filter((x) => threadOf(x, COMMENT_ATTR)).map((x) => x.text)).toEqual(['c']);
		doc.transact(() => setCommentMarkByCommittedOffsets(doc, 'c1', 4, 5), AGENT_ORIGIN);
		expect(segments(doc)[0].some((x) => threadOf(x, COMMENT_ATTR))).toBe(false);
		expect(segments(doc)[1].filter((x) => threadOf(x, COMMENT_ATTR)).map((x) => x.text)).toEqual(['d']);
	});
});

describe('typography and structure', () => {
	it('matches the normalized text and marks the raw characters', () => {
		const doc = new Y.Doc();
		doc.transact(() => {
			const p = new Y.XmlElement('paragraph');
			p.insert(0, [new Y.XmlText('Wait… the “end” is near')]);
			doc.getXmlFragment(FRAGMENT_NAME).insert(0, [p]);
		}, 'system');
		expect(committedText(doc)).toBe('Wait... the "end" is near');
		expect(proposeReplacement(doc, 't1', '"end" is near', '"end" is here')).toEqual({ ok: true, noop: false });
		expect(proposedText(doc)).toBe('Wait... the "end" is here');
		const [line] = segments(doc);
		expect(line.filter((s) => threadOf(s, DELETION_ATTR)).map((s) => s.text)).toEqual(['near']);
		expect(line.filter((s) => threadOf(s, INSERTION_ATTR)).map((s) => s.text)).toEqual(['here']);
	});

	it('edits inside a hardBreak paragraph mark words; structural changes replace the paragraph', () => {
		const doc = new Y.Doc();
		doc.transact(() => {
			const p = new Y.XmlElement('paragraph');
			p.insert(0, [new Y.XmlText('first part'), new Y.XmlElement('hardBreak'), new Y.XmlText('second part')]);
			doc.getXmlFragment(FRAGMENT_NAME).insert(0, [p]);
		}, 'system');
		expect(committedText(doc)).toBe('first part\nsecond part');
		expect(proposeReplacement(doc, 't1', 'second part', 'second half')).toEqual({ ok: true, noop: false });
		expect(proposedText(doc)).toBe('first part\nsecond half');
		expect(paraAttrs(doc)).toEqual([{ suggest: undefined, thread: undefined }]);
		doc.transact(() => resolveThreadMarks(doc, 't1', 'rejected'), USER_ORIGIN);

		expect(proposeReplacement(doc, 't1', 'first part\nsecond part', 'first part\nmiddle\nsecond part')).toEqual({ ok: true, noop: false });
		expect(paraAttrs(doc)).toEqual([
			{ suggest: 'del', thread: 't1' },
			{ suggest: 'ins', thread: 't1' },
			{ suggest: 'ins', thread: 't1' },
			{ suggest: 'ins', thread: 't1' }
		]);
		expect(proposedText(doc)).toBe('first part\nmiddle\nsecond part');
		expect(committedText(doc)).toBe('first part\nsecond part');
	});

	it('author text typed into an inserted paragraph survives a reject', () => {
		const doc = docWith('one');
		proposeReplacement(doc, 't1', 'one', 'one\nadded');
		// The author types plain text into the proposed paragraph.
		doc.transact(() => {
			const p = doc.getXmlFragment(FRAGMENT_NAME).get(1) as Y.XmlElement;
			const t = p.get(0) as Y.XmlText;
			t.insert(t.length, ' mine', {});
		}, USER_ORIGIN);
		expect(proposedText(doc)).toBe('one\nadded mine');
		doc.transact(() => resolveThreadMarks(doc, 't1', 'rejected'), USER_ORIGIN);
		expect(committedText(doc)).toBe('one\n mine');
		expect(paraAttrs(doc).every((a) => a.suggest === undefined)).toBe(true);
	});
});

describe('fingerprints and migration', () => {
	it('fingerprints change when a thread\'s proposal changes', () => {
		const doc = docWith('a b c');
		proposeReplacement(doc, 't1', 'b', 'x');
		const f1 = proposalFingerprints(doc).get('t1');
		proposeReplacement(doc, 't1', 'x', 'y');
		const f2 = proposalFingerprints(doc).get('t1');
		expect(f1).toBeTruthy();
		expect(f2).toBeTruthy();
		expect(f1).not.toBe(f2);
	});

	it('legacy rounds become marks and legacy quote anchors become comment marks', () => {
		const doc = docWith('Keep this line.\nChange this line.\nLast line.');
		const threads = new Map<string, { resolved: boolean; quote: string | null }>([
			['t_edit', { resolved: false, quote: 'Change this line.' }],
			['t_comment', { resolved: false, quote: 'Last line.' }],
			['t_gone', { resolved: true, quote: null }]
		]);
		doc.getMap(COMMENTS_MAP_NAME).set('t_edit', {});
		doc.getMap(COMMENTS_MAP_NAME).set('t_comment', {});
		doc.getArray('rounds').push([
			{ id: 'r1', feedbackThreadId: 't_edit', operation: { type: 'edit', oldString: 'Change', newString: 'Alter' } },
			{ id: 'r2', feedbackThreadId: 't_gone', operation: { type: 'edit', oldString: 'Last', newString: 'Final' } },
			{ id: 'r3', feedbackThreadId: 't_edit', operation: { type: 'edit', oldString: 'nowhere', newString: 'x' } }
		]);
		const dropped: string[] = [];
		const result = doc.transact(() =>
			migrateLegacyReviewState(
				doc,
				(id) => {
					const t = threads.get(id);
					return { exists: !!t, resolved: t?.resolved ?? false, quote: t?.quote ?? null };
				},
				(id, reason) => dropped.push(`${id}:${reason}`)
			)
		, 'system') as unknown as ReturnType<typeof migrateLegacyReviewState> | undefined;
		void result;
		expect(doc.getArray('rounds').length).toBe(0);
		expect(proposedText(doc)).toBe('Keep this line.\nAlter this line.\nLast line.');
		const summaries = summarizeThreadMarks(doc);
		expect(summaries.map((s) => [s.threadId, s.hasProposal])).toEqual([
			['t_edit', true],
			['t_comment', false]
		]);
		expect(dropped).toHaveLength(2);
	});
});
