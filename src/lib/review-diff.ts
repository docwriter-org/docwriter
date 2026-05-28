import { diffLines, diffWords } from 'diff';
import type { PendingReviewRound } from './types';
import type { DiffPart } from './diff';
import { pairLinesForDiff } from './diff-utils';

export function normalizeReviewText(text: string): string {
	return text.replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
}

export function classifyRoundKind(beforeMd: string, afterMd: string): 'tiny' | 'big' {
	let totalDelta = 0;
	for (const part of diffWords(normalizeReviewText(beforeMd), normalizeReviewText(afterMd))) {
		if (part.added || part.removed) totalDelta += part.value.length;
	}
	return totalDelta < 25 ? 'tiny' : 'big';
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

export interface ReviewPreviewLine {
	kind: 'context' | 'added' | 'removed' | 'gap';
	oldLine?: number;
	newLine?: number;
	parts: DiffPart[];
}

export function buildReviewDiffPreview(
	beforeMd: string,
	afterMd: string,
	contextLines = 1
): ReviewPreviewLine[] {
	const raw: ReviewPreviewLine[] = [];
	const changes = diffLines(normalizeReviewText(beforeMd), normalizeReviewText(afterMd));
	let oldLine = 1;
	let newLine = 1;

	for (let i = 0; i < changes.length; i++) {
		const part = changes[i];
		const next = changes[i + 1];
		if (part.removed && next?.added) {
			const removedLines = splitLines(part.value);
			const addedLines = splitLines(next.value);
			const linePairs = pairLinesForDiff(removedLines, addedLines);

			for (const pair of linePairs) {
				if (pair.removedLine !== undefined) {
					raw.push({
						kind: 'removed',
						oldLine: oldLine++,
						parts: pair.parts
							? pair.parts.filter((p) => p.type !== 'added')
							: [{ text: pair.removedLine, type: 'removed' }]
					});
				}
				if (pair.addedLine !== undefined) {
					raw.push({
						kind: 'added',
						newLine: newLine++,
						parts: pair.parts
							? pair.parts.filter((p) => p.type !== 'removed')
							: [{ text: pair.addedLine, type: 'added' }]
					});
				}
			}
			i++;
			continue;
		}

		const lines = splitLines(part.value);
		if (part.added) {
			for (const line of lines) {
				raw.push({
					kind: 'added',
					newLine: newLine++,
					parts: [{ text: line, type: 'added' }]
				});
			}
		} else if (part.removed) {
			for (const line of lines) {
				raw.push({
					kind: 'removed',
					oldLine: oldLine++,
					parts: [{ text: line, type: 'removed' }]
				});
			}
		} else {
			for (const line of lines) {
				raw.push({
					kind: 'context',
					oldLine: oldLine++,
					newLine: newLine++,
					parts: [{ text: line, type: 'same' }]
				});
			}
		}
	}

	const keep = new Set<number>();
	for (let i = 0; i < raw.length; i++) {
		if (raw[i].kind === 'context') continue;
		for (let j = Math.max(0, i - contextLines); j <= Math.min(raw.length - 1, i + contextLines); j++) {
			keep.add(j);
		}
	}
	if (keep.size === 0) return [];

	const preview: ReviewPreviewLine[] = [];
	let prev = -1;
	for (let i = 0; i < raw.length; i++) {
		if (!keep.has(i)) continue;
		if (prev >= 0 && i - prev > 1) {
			preview.push({
				kind: 'gap',
				parts: [{ text: '...', type: 'same' }]
			});
		}
		preview.push(raw[i]);
		prev = i;
	}
	return preview;
}

function splitLines(value: string): string[] {
	const normalized = normalizeReviewText(value);
	if (!normalized) return [];
	return normalized.split('\n');
}
