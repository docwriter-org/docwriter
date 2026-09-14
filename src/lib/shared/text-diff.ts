/**
 * Token-level diffs on top of diff-match-patch. diff-match-patch works on
 * characters; a raw character diff of "makes this" → "draws the" yields
 * `mak[es]{draw}s th[is]{e}`, mid-word fragments that read as gibberish in
 * a document. Both helpers here encode each distinct token (a word, a
 * whitespace run, or a whole line) as one sentinel character, diff in
 * token space, and decode. Every boundary lands on a token edge.
 */
import DiffMatchPatch from 'diff-match-patch';
import { createTwoFilesPatch } from 'diff';

const dmp = new DiffMatchPatch.diff_match_patch();

/** `[op, text]` with op −1 removed, 0 equal, 1 added (diff-match-patch). */
export type DiffOp = [number, string];

function tokenDiff(oldTokens: string[], newTokens: string[]): Array<[number, string[]]> | null {
	const tokenToChar = new Map<string, string>();
	const charToToken = new Map<string, string>();
	// Sentinel code points: skip the surrogate range so decoding can walk the
	// encoded string one UTF-16 unit at a time.
	let nextCode = 1;
	const encode = (tokens: string[]): string | null => {
		let out = '';
		for (const token of tokens) {
			let c = tokenToChar.get(token);
			if (c === undefined) {
				if (nextCode === 0xd800) nextCode = 0xe000;
				if (nextCode >= 0xfff0) return null;
				c = String.fromCharCode(nextCode++);
				tokenToChar.set(token, c);
				charToToken.set(c, token);
			}
			out += c;
		}
		return out;
	};
	const encodedOld = encode(oldTokens);
	const encodedNew = encodedOld === null ? null : encode(newTokens);
	if (encodedOld === null || encodedNew === null) return null;
	// No semantic cleanup: it folds a surviving word between two edits into
	// one big replacement, and a surviving word is exactly what track changes
	// must leave unmarked.
	const diffs = dmp.diff_main(encodedOld, encodedNew, false);
	return diffs.map(([op, chars]) => {
		const tokens: string[] = [];
		for (let i = 0; i < chars.length; i += 1) tokens.push(charToToken.get(chars[i]) ?? '');
		return [op, tokens] as [number, string[]];
	});
}

/** Word-level diff: tokens are words and whitespace runs. Falls back to a
 * plain character diff in the (pathological) case of more distinct tokens
 * than sentinel code points. */
export function diffWordLevel(oldText: string, newText: string): DiffOp[] {
	const tokenRe = /\S+|\s+/g;
	const diffs = tokenDiff(oldText.match(tokenRe) ?? [], newText.match(tokenRe) ?? []);
	if (diffs === null) {
		const charDiffs = dmp.diff_main(oldText, newText);
		dmp.diff_cleanupSemantic(charDiffs);
		return charDiffs as DiffOp[];
	}
	return diffs.map(([op, tokens]) => [op, tokens.join('')] as DiffOp);
}

/** One hunk of a line diff: `[aStart, aEnd)` in the old lines is replaced by
 * `[bStart, bEnd)` in the new lines. A pure deletion has `bStart === bEnd`,
 * a pure insertion `aStart === aEnd`. Equal runs are not reported. */
export interface LineHunk {
	aStart: number;
	aEnd: number;
	bStart: number;
	bEnd: number;
}

/** Line-level diff: tokens are whole lines. Adjacent delete + insert runs are
 * reported as one replacement hunk. */
export function diffLineLevel(oldLines: string[], newLines: string[]): LineHunk[] {
	let diffs = tokenDiff(oldLines, newLines);
	if (diffs === null) {
		// More distinct lines than sentinels: treat the whole thing as one
		// replacement rather than fail. Only reachable on documents with
		// >60k distinct lines.
		return oldLines.length === 0 && newLines.length === 0
			? []
			: [{ aStart: 0, aEnd: oldLines.length, bStart: 0, bEnd: newLines.length }];
	}
	const hunks: LineHunk[] = [];
	let a = 0;
	let b = 0;
	let open: LineHunk | null = null;
	for (const [op, tokens] of diffs) {
		if (op === 0) {
			if (open) {
				hunks.push(open);
				open = null;
			}
			a += tokens.length;
			b += tokens.length;
			continue;
		}
		if (!open) open = { aStart: a, aEnd: a, bStart: b, bEnd: b };
		if (op === -1) {
			a += tokens.length;
			open.aEnd = a;
		} else {
			b += tokens.length;
			open.bEnd = b;
		}
	}
	if (open) hunks.push(open);
	return hunks;
}

/**
 * Unified-diff-style line diff between two texts, the format the agent
 * already understands well (used for the per-turn "what changed" block).
 * Returns an empty string if the texts are identical.
 */
export function unifiedLineDiff(oldText: string, newText: string, contextLines = 3): string {
	if (oldText === newText) return '';
	const patch = createTwoFilesPatch('a', 'b', oldText, newText, '', '', { context: contextLines });
	// Strip the file header lines (--- a, +++ b) for cleaner output
	return patch.split('\n').slice(2).join('\n').trim();
}
