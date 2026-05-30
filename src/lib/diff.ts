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

/**
 * Strip markdown formatting to get the plain text characters, in the same
 * order PM's `node.textContent` would produce them. Used to compare baseline
 * markdown against the editor's current text content for diff highlighting.
 *
 * Removes: heading markers, list bullets, blockquote markers, bold/italic/code/link
 * syntax, and newlines (since PM textContent has no separators between flat children).
 */
export function markdownToPlainText(md: string): string {
	return md
		.replace(/^#{1,6}\s+/gm, '')              // headings: # foo
		.replace(/^[-*+]\s+/gm, '')               // bullet lists: - item
		.replace(/^\d+\.\s+/gm, '')               // numbered lists: 1. item
		.replace(/^>\s*/gm, '')                   // blockquotes: > quote
		.replace(/\*\*(.+?)\*\*/g, '$1')          // bold
		.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1') // italic *foo*
		.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '$1')      // italic _foo_
		.replace(/`(.+?)`/g, '$1')                // inline code
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [text](url)
		.replace(/\n+/g, '');                     // collapse newlines (PM joins flat)
}
