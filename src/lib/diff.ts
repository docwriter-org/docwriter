import { createTwoFilesPatch } from 'diff';
import DiffMatchPatch from 'diff-match-patch';

export type DiffPart = { text: string; type: 'same' | 'added' | 'removed' };

const dmp = new DiffMatchPatch.diff_match_patch();

/** Human-readable diff. Uses diff-match-patch with `diff_cleanupSemantic`,
 * which merges noisy small fragments into bigger blocks — so a mostly-rewritten
 * paragraph reads as one removed + one added chunk instead of confetti. */
export function wordDiff(oldText: string, newText: string): DiffPart[] {
	const diffs = dmp.diff_main(oldText, newText);
	dmp.diff_cleanupSemantic(diffs);
	return diffs.map(([op, text]) => ({
		text,
		type: op === 1 ? 'added' : op === -1 ? 'removed' : 'same'
	}));
}

/**
 * Unified-diff-style line diff between two texts. Returns the unified diff
 * format the agent already understands well. Returns empty string if texts are identical.
 */
export function unifiedLineDiff(oldText: string, newText: string, contextLines = 3): string {
	if (oldText === newText) return '';
	const patch = createTwoFilesPatch('a', 'b', oldText, newText, '', '', { context: contextLines });
	// Strip the file header lines (--- a, +++ b) for cleaner output
	return patch.split('\n').slice(2).join('\n').trim();
}
