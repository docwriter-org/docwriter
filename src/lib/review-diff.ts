import { diffLines, diffWords } from 'diff';
import type { PendingReviewRound } from './types';
import { TINY_EDIT_THRESHOLD } from './types';

export function normalizeReviewText(text: string): string {
	return text.replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
}

export function classifyRoundKind(beforeMd: string, afterMd: string): 'tiny' | 'big' {
	let totalDelta = 0;
	for (const part of diffWords(normalizeReviewText(beforeMd), normalizeReviewText(afterMd))) {
		if (part.added || part.removed) totalDelta += part.value.length;
	}
	return totalDelta < TINY_EDIT_THRESHOLD ? 'tiny' : 'big';
}

export function summarizeRound(round: PendingReviewRound): string {
	if (round.stale) return 'stale proposal';
	if (typeof round.beforeMd !== 'string' || typeof round.afterMd !== 'string') {
		if (round.operation?.type === 'edit') return 'targeted text replacement';
		if (round.operation?.type === 'write') return 'document rewrite';
		return 'small edits';
	}
	let added = 0;
	let removed = 0;
	for (const part of diffLines(normalizeReviewText(round.beforeMd), normalizeReviewText(round.afterMd))) {
		if (part.added) added += part.count ?? 0;
		else if (part.removed) removed += part.count ?? 0;
	}
	const parts: string[] = [];
	if (added > 0) parts.push(`+${added} line${added === 1 ? '' : 's'}`);
	if (removed > 0) parts.push(`−${removed} line${removed === 1 ? '' : 's'}`);
	return parts.join(', ') || 'small edits';
}
