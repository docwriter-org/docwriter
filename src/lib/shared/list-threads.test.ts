import { describe, expect, it } from 'vitest';
import type { CommentThread } from '$lib/types';
import { formatDismissedThreadsHint, formatListedThreads } from './list-threads';

function thread(
	id: string,
	resolved: boolean,
	quote: string,
	userText: string
): CommentThread {
	return {
		id,
		resolved,
		createdAt: Number(id.replace(/\D/g, '') || 0),
		anchor: { quote, occurrenceIndex: 0 },
		messages: [{ id: `msg_${id}`, author: 'user', text: userText, timestamp: 1 }]
	};
}

describe('formatListedThreads', () => {
	const open = thread('thread_1', false, 'Rayleigh scattering', 'explain this term');
	const dismissed = thread('thread_2', true, 'At sunset', 'too abrupt');

	it('lists only open threads by default and hints at dismissed ones', () => {
		const text = formatListedThreads('document.md', [open, dismissed], false);
		expect(text).toContain('1 open thread on document.md');
		expect(text).toContain('thread_1');
		expect(text).toContain('explain this term');
		expect(text).not.toContain('too abrupt');
		expect(text).toContain('1 dismissed thread');
		expect(text).toContain('include_dismissed=true');
		expect(text).toContain('reopen_thread');
	});

	it('includes dismissed thread bodies when asked', () => {
		const text = formatListedThreads('document.md', [open, dismissed], true);
		expect(text).toContain('[dismissed]');
		expect(text).toContain('thread_2');
		expect(text).toContain('too abrupt');
		expect(text).toContain('reopen_thread');
	});

	it('says there are no threads when the map is empty', () => {
		expect(formatListedThreads('document.md', [], false)).toBe(
			'No comment threads on document.md.'
		);
	});

	it('still reports dismissed-only tabs without include_dismissed', () => {
		const text = formatListedThreads('document.md', [dismissed], false);
		expect(text).toContain('No open threads on document.md.');
		expect(text).toContain('1 dismissed thread');
		expect(text).not.toContain('too abrupt');
	});
});

describe('formatDismissedThreadsHint', () => {
	it('is empty when nothing is dismissed', () => {
		expect(formatDismissedThreadsHint(0)).toBe('');
	});

	it('pluralizes', () => {
		expect(formatDismissedThreadsHint(2)).toContain('2 dismissed threads');
	});
});
