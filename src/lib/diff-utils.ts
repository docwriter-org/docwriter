import type { DiffPart } from './diff';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const diff_match_patch = require('diff-match-patch');
const dmp = new diff_match_patch() as {
	diff_main: (a: string, b: string) => [number, string][];
	diff_cleanupSemantic: (diffs: [number, string][]) => void;
};

/**
 * Character-level diff with semantic cleanup.
 * Uses Google's diff-match-patch which produces more intuitive diffs
 * by cleaning up small edits that cross word boundaries.
 */
export function charDiff(oldText: string, newText: string): DiffPart[] {
	const diffs = dmp.diff_main(oldText, newText);
	dmp.diff_cleanupSemantic(diffs);
	return diffs.map(([op, text]: [number, string]) => ({
		text,
		type: op === 0 ? 'same' : op === -1 ? 'removed' : 'added'
	}));
}

export interface LinePair {
	removedLine?: string;
	addedLine?: string;
	/** Character-level diff if both lines exist */
	parts: DiffPart[] | null;
}

/**
 * Pair lines from a removed/added block for word-level diffing.
 * When line counts don't match, pairs as many as possible and
 * treats extras as full additions/removals.
 */
export function pairLinesForDiff(removedLines: string[], addedLines: string[]): LinePair[] {
	const pairs: LinePair[] = [];
	const maxLen = Math.max(removedLines.length, addedLines.length);

	for (let i = 0; i < maxLen; i++) {
		const removed = removedLines[i];
		const added = addedLines[i];

		if (removed !== undefined && added !== undefined) {
			pairs.push({
				removedLine: removed,
				addedLine: added,
				parts: charDiff(removed, added)
			});
		} else if (removed !== undefined) {
			pairs.push({
				removedLine: removed,
				addedLine: undefined,
				parts: null
			});
		} else if (added !== undefined) {
			pairs.push({
				removedLine: undefined,
				addedLine: added,
				parts: null
			});
		}
	}
	return pairs;
}
