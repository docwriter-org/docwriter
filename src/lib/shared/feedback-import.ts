import type { ImportedComment } from '$lib/types';

export function buildFeedbackImportMessage(
	comments: ImportedComment[],
	tabId: string
): string {
	const lines = [
		'<mode>',
		`Feedback import. The user imported ${comments.length} comment${comments.length === 1 ? '' : 's'} from external reviewers. Process each comment.`,
		'',
		'For each comment:',
		`1. Call read_doc("${tabId}") if you have not already.`,
		'2. Find the passage in the current document that the comment refers to. The "original anchor" (if given) is from an older draft version; find the best-matching current passage.',
		'3. Call comment_doc anchored to that passage, passing the external_author parameter with the commenter\'s name and their comment as the message.',
		'4. Reply on the same thread (reply_to_comment) with your one-to-three-sentence assessment: do you agree? Is a fix clear? What would you do?',
		'5. If the fix is clear and minimal, call edit_doc with that thread_id. If only the author can resolve it, leave the thread with the comment and your reply — do not edit.',
		'6. Move to the next comment.',
		'',
		'You may spawn subagents via the Agent tool to parallelize — for example, split comments across subagents grouped by topic or section. The strategy is yours based on volume and complexity.',
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

export function parseCommentsPaste(raw: string): ImportedComment[] {
	const trimmed = raw.trim();
	if (!trimmed) return [];

	const results: ImportedComment[] = [];
	const blocks = trimmed.split(/\n{2,}/);

	for (const block of blocks) {
		const lines = block.trim().split('\n');
		if (!lines.length) continue;

		const firstLine = lines[0];
		const bracketMatch = firstLine.match(/^\[([^\]]+)\]:\s*(.*)$/);
		const colonMatch = !bracketMatch ? firstLine.match(/^([^:]{1,40}):\s+(.+)$/) : null;

		let author: string;
		let text: string;

		if (bracketMatch) {
			author = bracketMatch[1].trim();
			text = [bracketMatch[2], ...lines.slice(1)].join('\n').trim();
		} else if (colonMatch) {
			author = colonMatch[1].trim();
			text = [colonMatch[2], ...lines.slice(1)].join('\n').trim();
		} else {
			author = 'Reviewer';
			text = lines.join('\n').trim();
		}

		if (text) {
			results.push({
				id: 'imp_' + Math.random().toString(36).slice(2, 10),
				author,
				text
			});
		}
	}

	return results;
}
