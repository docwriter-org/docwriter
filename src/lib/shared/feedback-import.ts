import type { ImportedComment } from '$lib/types';

export function buildFeedbackImportMessage(
	comments: ImportedComment[],
	tabId: string
): string {
	const lines = [
		'<mode>',
		`Feedback import. I imported ${comments.length} comment${comments.length === 1 ? '' : 's'} from external reviewers. Process each comment.`,
		'',
		'For each comment:',
		`1. Call read_doc("${tabId}") if you have not already.`,
		'2. Find the passage in the current document that the comment refers to. The "original anchor" (if given) is from an older draft version; find the best-matching current passage.',
		'3. Call comment_doc anchored to that passage, passing the external_author parameter with the commenter\'s name and their comment as the message.',
		'4. Reply on the same thread (reply_to_comment) with your one-to-three-sentence assessment: do you agree? Is a fix clear? What would you do?',
		'5. If the fix is clear and minimal, call edit_doc with that thread_id. If only the author can resolve it, leave the thread with the comment and your reply — do not edit.',
		'6. Move to the next comment.',
		'',
		'Work through them yourself, in this turn. Do not delegate to a subagent: comment_doc, reply_to_comment and edit_doc are connected to this turn only, so a subagent\'s threads and replies would be lost.',
		'',
		'Cap: at most 8 proposed edits per import pass. Every comment still gets a thread and a reply, even without an edit.',
		'Stop after processing all comments. Do not summarize at the end.',
		'</mode>',
		'',
		'<imported_comments>'
	];

	for (let i = 0; i < comments.length; i++) {
		const c = comments[i];
		lines.push(`${i + 1}. [${c.author}]: "${c.text}"`);
		if (c.originalAnchor) {
			const anchor =
				c.originalAnchor.length > 200
					? c.originalAnchor.slice(0, 197) + '...'
					: c.originalAnchor;
			lines.push(`   Original anchor: "${anchor}"`);
		}
	}

	lines.push('</imported_comments>');
	return lines.join('\n');
}

export function buildRawFeedbackMessage(rawText: string, tabId: string): string {
	return [
		'<mode>',
		'Feedback import. I pasted raw feedback from collaborators. Read it carefully, identify each distinct piece of feedback, and process them one at a time.',
		'',
		'For each piece of feedback you identify:',
		`1. Call read_doc("${tabId}") if you have not already.`,
		'2. Find the passage in the current document that the feedback refers to. Use any quoted text, passage references, or context clues from the feedback to locate the right spot.',
		'3. Call comment_doc anchored to that passage, passing the external_author parameter with the commenter\'s name (if identifiable from the text, otherwise use "Reviewer") and the feedback as the message.',
		'4. Reply on the same thread (reply_to_comment) with your one-to-three-sentence assessment: do you agree? Is a fix clear? What would you do?',
		'5. If the fix is clear and minimal, call edit_doc with that thread_id. If only the author can resolve it, leave the thread with the comment and your reply — do not edit.',
		'6. Move to the next piece of feedback.',
		'',
		'Work through them yourself, in this turn. Do not delegate to a subagent: comment_doc, reply_to_comment and edit_doc are connected to this turn only, so a subagent\'s threads and replies would be lost.',
		'',
		'Cap: at most 8 proposed edits per import pass. Every piece of feedback still gets a thread and a reply, even without an edit.',
		'Stop after processing all feedback. Do not summarize at the end.',
		'</mode>',
		'',
		'<pasted_feedback>',
		rawText,
		'</pasted_feedback>'
	].join('\n');
}
