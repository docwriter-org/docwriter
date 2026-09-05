import type { CommentThread } from '$lib/types';

function formatOneThread(thread: CommentThread, dismissed: boolean): string {
	const status = dismissed ? ' [dismissed]' : '';
	const quote = thread.anchor.quote.slice(0, 120);
	const ellipsis = thread.anchor.quote.length > 120 ? '…' : '';
	const lines = [`Thread \`${thread.id}\`${status} — anchor: "${quote}${ellipsis}"`];
	for (const msg of thread.messages) {
		const role =
			msg.author === 'agent'
				? 'you'
				: msg.author === 'external'
					? (msg.externalAuthor ?? 'reviewer')
					: 'user';
		lines.push(`  [${role}] ${msg.text}`);
	}
	return lines.join('\n');
}

/** Text the agent sees from `list_threads`. Open threads first; dismissed
 * threads only when `includeDismissed` is set. If dismissed threads exist
 * but were not requested, a one-line hint tells the agent how to read them
 * and how to put one back in the gutter (`review_action reopen_thread`). */
export function formatListedThreads(
	filePath: string,
	threads: CommentThread[],
	includeDismissed: boolean
): string {
	const open = threads.filter((t) => !t.resolved).sort((a, b) => a.createdAt - b.createdAt);
	const dismissed = threads.filter((t) => t.resolved).sort((a, b) => a.createdAt - b.createdAt);

	if (open.length === 0 && dismissed.length === 0) {
		return `No comment threads on ${filePath}.`;
	}

	const parts: string[] = [];
	if (open.length > 0) {
		parts.push(
			`${open.length} open thread${open.length === 1 ? '' : 's'} on ${filePath}:\n`
		);
		for (const thread of open) {
			parts.push(formatOneThread(thread, false));
			parts.push('');
		}
	} else {
		parts.push(`No open threads on ${filePath}.`);
	}

	if (includeDismissed && dismissed.length > 0) {
		parts.push(
			`${dismissed.length} dismissed thread${dismissed.length === 1 ? '' : 's'} on ${filePath} (hidden from the gutter; review_action reopen_thread brings one back):\n`
		);
		for (const thread of dismissed) {
			parts.push(formatOneThread(thread, true));
			parts.push('');
		}
	} else if (dismissed.length > 0) {
		parts.push(formatDismissedThreadsHint(dismissed.length));
	}

	return parts.join('\n').replace(/\n+$/, '');
}

/** One-line breadcrumb for the per-turn workspace_state stub. */
export function formatDismissedThreadsHint(dismissedCount: number): string {
	if (dismissedCount <= 0) return '';
	return `${dismissedCount} dismissed thread${dismissedCount === 1 ? '' : 's'}. Call list_threads with include_dismissed=true to read them; review_action(reopen_thread) to bring one back.`;
}
