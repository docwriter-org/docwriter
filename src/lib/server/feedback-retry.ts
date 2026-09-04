/**
 * One-shot retry for an edit-mode feedback turn that landed no proposal.
 * Kept apart from the render route so the condition can be unit-tested
 * without loading the SDK.
 */
/** A feedback turn in edit mode is a request for a change on a thread. When
 * the turn ends with no new round on the tab, the author is left with a
 * reply that may describe an edit and a document that shows none — the
 * "agent thinks it did" report. One retry names the fact and the two
 * legitimate ways out. Pure, so the condition is testable. */
export function feedbackRetryPrompt(opts: {
	message: string;
	tabId: string | null;
	roundsBefore: Set<string>;
	roundsAfter: Set<string>;
}): string | null {
	const threadId = opts.message.match(/thread_id="([^"]+)"/)?.[1] ?? null;
	if (!threadId || !opts.tabId) return null;

	// Initial feedback trigger: "I flagged this passage … [mode: edit]"
	const isFeedbackTrigger = /^I flagged this passage/.test(opts.message);
	const isEditMode = /\[mode: edit\]/.test(opts.message);

	// Thread reply: "I replied on comment thread thread_id=…"
	const isReply = /^I replied on comment thread/.test(opts.message);

	// Only retry edit-mode feedback triggers and thread replies.
	// Discuss-mode triggers and other messages aren't expected to land edits.
	if (!(isFeedbackTrigger && isEditMode) && !isReply) return null;

	let landed = false;
	for (const id of opts.roundsAfter) if (!opts.roundsBefore.has(id)) landed = true;
	if (landed) return null;

	if (isReply) {
		return [
			`You replied on thread_id="${threadId}" but did not propose an edit. My reply on that thread was feedback asking for a change, and no pending diff landed on ${opts.tabId}.`,
			`If you understood the feedback and described what you would change, follow through now: call read_doc to see the current text, then call edit_doc with thread_id="${threadId}" to propose the edit.`,
			`Do nothing only if you explicitly told me on the thread that the passage needs no change, or you asked me a question and are waiting for my answer.`
		].join('\n');
	}
	return [
		`You ended this turn without proposing an edit, but my feedback on thread_id="${threadId}" asked for a change ([mode: edit]), and no pending diff landed on ${opts.tabId}.`,
		`If an edit_doc call failed, call read_doc, copy old_string exactly from the current text (including its line breaks), and call edit_doc again with thread_id="${threadId}".`,
		`If you had not yet proposed anything, propose the edit now on that thread.`,
		`Do nothing only if you already told me on the thread that the passage needs no change, or you asked me a question there and are waiting for my answer. Do not describe an edit as done unless the tool result says it was proposed.`
	].join('\n');
}
