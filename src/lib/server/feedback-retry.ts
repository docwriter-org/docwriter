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
	const mode = opts.message.match(/\[mode: (auto|edit|discuss)\]/)?.[1] ?? null;
	if (!threadId || mode !== 'edit' || !opts.tabId) return null;
	if (!/^I flagged this passage/.test(opts.message)) return null;
	let landed = false;
	for (const id of opts.roundsAfter) if (!opts.roundsBefore.has(id)) landed = true;
	if (landed) return null;
	return [
		`You ended this turn without proposing an edit, but my feedback on thread_id="${threadId}" asked for a change ([mode: edit]), and no pending diff landed on ${opts.tabId}.`,
		`If an edit_doc call failed, call read_doc, copy old_string exactly from the current text (including its line breaks), and call edit_doc again with thread_id="${threadId}".`,
		`If you had not yet proposed anything, propose the edit now on that thread.`,
		`Do nothing only if you already told me on the thread that the passage needs no change, or you asked me a question there and are waiting for my answer. Do not describe an edit as done unless the tool result says it was proposed.`
	].join('\n');
}
