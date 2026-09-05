/**
 * Guard: the agent explains on a thread and proposes the edit in the same
 * turn. There is no "Approve & propose edit" step in between.
 *
 * The removed flow had the agent attach a sketched `proposed_edit` to a
 * comment, the gutter render an approve button, and the approval trigger a
 * second render whose edit_doc finally landed the pending diff. Two
 * approvals for one change, and the agent's tool result in the middle told
 * the author the edit was already in. The contract now: a reply that names
 * a change is followed by edit_doc on the same thread; only genuine
 * uncertainty about the change itself earns a reply with no proposal.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('a reply that names a change comes with the edit, not an approve button', () => {
	it('no agent tool accepts a sketched edit for later approval', () => {
		for (const rel of [
			'src/lib/server/mcp-doc-tools.ts',
			'src/lib/server/providers/tool-handlers.ts'
		]) {
			const src = read(rel);
			expect(src, rel).not.toMatch(/proposed_edit/);
			expect(src, rel).not.toMatch(/Approve & propose/);
		}
	});

	it('the gutter has no approve button and the editor no approval trigger', () => {
		expect(read('src/lib/components/CommentGutter.svelte')).not.toMatch(/approve-btn|onApprove/);
		expect(read('src/lib/editor/TiptapEditor.svelte')).not.toMatch(/onApprove|I approved/);
	});

	it('the routing rule tells the agent to propose the edit in the same turn as its reply', () => {
		const prompt = read('src/routes/api/render/+server.ts').replace(/\s+/g, ' ');
		expect(prompt).toMatch(/call edit_doc with the thread_id in the same turn/);
		expect(prompt).toMatch(/There is no approval step between a reply and its edit/);
		expect(prompt).toMatch(/genuine uncertainty about how to make the change/);
		expect(prompt).not.toMatch(/proposed_edit/);
	});

	it('legacy sketched edits are not read back to the agent', () => {
		expect(read('src/lib/shared/list-threads.ts')).not.toMatch(/proposedEdit/);
	});
});

describe('a feedback turn that asks for a change ends with a diff or a retry', () => {
	// `Rewrite it: "<passage>"` read as "rewrite it TO this"; the agent
	// compared the quote with the document, found them identical, and
	// replied that nothing needed changing.
	it('a comment the author makes opens its card', () => {
		// Cards render collapsed by default; the author had to click the card
		// they had just written to see the agent's reply and proposal.
		const src = read('src/lib/editor/TiptapEditor.svelte');
		const helper = src.match(/function openFeedbackThread\(threadId: string\): void \{([\s\S]*?)\n\t\}/);
		expect(helper?.[1]).toMatch(/openCommentThreadId\.set\(threadId\)/);
		expect(helper?.[1]).toMatch(/markThreadAwaiting\(threadId\)/);
		for (const fn of ['sendFeedback', 'sendCustomFeedback']) {
			const body = src.slice(src.indexOf(`async function ${fn}(`));
			const submit = body.slice(0, body.indexOf('onSubmit(trigger)'));
			expect(submit, fn).toMatch(/if \(threadId\) openFeedbackThread\(threadId\);/);
		}
	});

	it('the feedback trigger says the quoted passage is the current text', () => {
		const src = read('src/lib/editor/TiptapEditor.svelte');
		expect(src).toMatch(/Current text of the passage, quoted verbatim from the document/);
		expect(src).toMatch(/That quote is what is there now, not what I want/);
		expect(src).not.toMatch(/Rewrite it: "\$\{passage\}"/);
	});

	it('the retry fires only for an edit-mode feedback turn that landed no round', async () => {
		const { feedbackRetryPrompt } = await import('$lib/server/feedback-retry');
		const message =
			'I flagged this passage with feedback "too vague". [mode: edit] Current text of the passage, quoted verbatim from the document: "Each dataset is very unique." That quote is what is there now, not what I want. Rewrite it so it addresses my feedback. A thread is open for this feedback (thread_id="thread_1").';
		const before = new Set(['r0']);
		expect(feedbackRetryPrompt({ message, tabId: 'essay.md', roundsBefore: before, roundsAfter: new Set(['r0']) })).toMatch(
			/no pending diff landed on essay\.md/
		);
		expect(feedbackRetryPrompt({ message, tabId: 'essay.md', roundsBefore: before, roundsAfter: new Set(['r0']) })).toMatch(
			/thread_id="thread_1"/
		);
		// A round landed: no retry.
		expect(feedbackRetryPrompt({ message, tabId: 'essay.md', roundsBefore: before, roundsAfter: new Set(['r0', 'r1']) })).toBeNull();
		// Discuss mode asked for words, not a diff.
		expect(feedbackRetryPrompt({ message: message.replace('[mode: edit]', '[mode: discuss]'), tabId: 'essay.md', roundsBefore: before, roundsAfter: before })).toBeNull();
		// No active tab: nothing to check against.
		expect(feedbackRetryPrompt({ message, tabId: null, roundsBefore: before, roundsAfter: before })).toBeNull();
	});

	it('the retry fires for a thread reply that landed no round', async () => {
		const { feedbackRetryPrompt } = await import('$lib/server/feedback-retry');
		const replyMsg =
			'I replied on comment thread thread_id="thread_1" on this tab.\n' +
			'Anchor passage: "Each dataset is very unique."\n' +
			'My latest reply: "say things like a reviewer can ...."\n' +
			'Full thread (latest reply included):\n- [you] The passage overexplains\n- [me] say things like a reviewer can ....';
		const before = new Set(['r0']);
		// No round landed → retry.
		expect(feedbackRetryPrompt({ message: replyMsg, tabId: 'essay.md', roundsBefore: before, roundsAfter: new Set(['r0']) })).toMatch(
			/did not propose an edit/
		);
		expect(feedbackRetryPrompt({ message: replyMsg, tabId: 'essay.md', roundsBefore: before, roundsAfter: new Set(['r0']) })).toMatch(
			/thread_id="thread_1"/
		);
		// A round landed → no retry.
		expect(feedbackRetryPrompt({ message: replyMsg, tabId: 'essay.md', roundsBefore: before, roundsAfter: new Set(['r0', 'r1']) })).toBeNull();
	});
});
