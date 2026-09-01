/**
 * Shared Y.Doc ↔ plain-text codec. Single source of truth for how we serialize
 * a tab's Y.Doc to the on-disk text file and how we seed/replace its content
 * from a text string. Imported by both client and server — no Tiptap, no DOM
 * shim, no prosemirror-model. Paragraph-per-line plain text: each file line
 * becomes one `<paragraph>` XmlElement; `<hardBreak/>` inside a paragraph
 * renders as a newline inside that paragraph's text.
 *
 * Also exports the single Y.Doc schema constants (`FRAGMENT_NAME`,
 * `REVIEW_ARRAY_NAME`, `AGENT_ORIGIN`) so the client and server never drift.
 */
import * as Y from 'yjs';
import DiffMatchPatch from 'diff-match-patch';
import type { CommentThread, PendingReviewRound } from '$lib/types';

/**
 * Normalize typographic characters to their ASCII equivalents. Applied at
 * serialization so all consumers (read_doc, edit_doc, prompt diffs, disk
 * writes) see consistent plain-ASCII text. This prevents agent edit failures
 * when LLMs generate old_string with straight quotes/hyphens but the document
 * contains curly quotes/en-dashes.
 */
export function normalizeTypography(text: string): string {
	return text
		// Curly double quotes → straight double quote
		.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
		// Curly single quotes, apostrophes → straight single quote
		.replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
		// En-dash, em-dash, figure dash, horizontal bar → hyphen-minus
		.replace(/[\u2013\u2014\u2012\u2015]/g, '-')
		// Ellipsis → three dots
		.replace(/\u2026/g, '...')
		// Non-breaking space → regular space
		.replace(/\u00A0/g, ' ');
}

export const FRAGMENT_NAME = 'default';
export const REVIEW_ARRAY_NAME = 'rounds';
export const COMMENTS_MAP_NAME = 'comments';
export const AGENT_ORIGIN = 'agent';
/** Origin for user-initiated server-side mutations (accept / reject /
 * reject-all). Anything `ydoc.transact(..., USER_ORIGIN)` tags becomes
 * client-undoable: the Tiptap Collaboration extension is configured to
 * include this origin in its `Y.UndoManager.trackedOrigins`, so ctrl+z
 * in the editor reverses these transactions one step at a time. Reuse
 * carefully — adding a new USER_ORIGIN transact site opts it into undo
 * by default. Use SYSTEM_ORIGIN (or a fresh origin) for mutations that
 * should NOT be reversible from the editor. */
export const USER_ORIGIN = 'user';
export const SYSTEM_ORIGIN = 'system';

/** Yjs text-format attribute (and Tiptap mark name) that flags a run of text
 * as AI-authored. Set by the accept path when an agent round lands; the
 * client renders it as `span[data-ai-text]` and the provenance toggle colors
 * it. Absence of the attribute means human-authored — pre-existing docs need
 * no migration. Provenance lives only in the CRDT (SQLite `yjs_updates`);
 * `serializeFragment` strips it, so `document.md`, `read_doc`, prompt diffs
 * and stale checks all keep seeing plain text. */
export const AI_ATTR = 'ai';

/** One contiguous span of paragraph text with a single provenance flag. */
export type ProvenanceRun = { text: string; ai: boolean };

/** How much surrounding plain text (each side) a comment-thread anchor
 * snapshots as its context. Shared by the server (captures at thread
 * creation from the newline-joined serialization) and the client (captures
 * via backfill from the editor's paragraph-concatenated plain text, and
 * validates fallback re-attachment against it). Newlines are stripped so
 * both text spaces agree. */
export const ANCHOR_CONTEXT_RADIUS = 32;

/** Capture the anchor context around [idx, idx + quoteLen) in `text`. */
export function captureAnchorContext(
	text: string,
	idx: number,
	quoteLen: number
): { contextBefore: string; contextAfter: string } {
	return {
		contextBefore: text
			.slice(Math.max(0, idx - ANCHOR_CONTEXT_RADIUS), idx)
			.replace(/\n/g, ''),
		contextAfter: text
			.slice(idx + quoteLen, idx + quoteLen + ANCHOR_CONTEXT_RADIUS)
			.replace(/\n/g, '')
	};
}

/** Build a quote-based comment-thread anchor at a known occurrence.
 * Omits Yjs relative positions — the client backfills those on first
 * render, the same way server-created threads already work. */
export function buildThreadAnchor(
	liveText: string,
	quote: string,
	occurrenceIndex: number
): CommentThread['anchor'] | null {
	const idx = nthIndexOf(liveText, quote, occurrenceIndex);
	if (idx < 0) return null;
	return {
		quote,
		occurrenceIndex,
		...captureAnchorContext(liveText, idx, quote.length)
	};
}

/** Locate the Nth occurrence of `needle` in `haystack`. Returns -1 when
 * fewer than N+1 matches exist. */
export function nthIndexOf(haystack: string, needle: string, occurrenceIndex: number): number {
	if (!needle) return -1;
	let idx = 0;
	let found = 0;
	while ((idx = haystack.indexOf(needle, idx)) !== -1) {
		if (found === occurrenceIndex) return idx;
		found += 1;
		idx += needle.length;
	}
	return -1;
}

/** How many characters of stored anchor context must still match for a
 * quote fallback to re-attach a thread whose rel-position anchor died. */
const ANCHOR_CONTEXT_MIN_MATCH = 8;

/** Anchor contexts are compared newline-free: the editor's char index
 * concatenates paragraphs with no separator while server-captured contexts
 * come from the newline-joined serialization — strip newlines so both text
 * spaces agree. */
function normalizeAnchorContext(s: string): string {
	return s.replace(/\n/g, '');
}

function commonSuffixLen(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
	return n;
}

function commonPrefixLen(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
	return n;
}

/** Among all occurrences of `quote`, pick the one whose surroundings best
 * match the anchor's stored context; -1 when none matches well enough.
 * `preferredIdx` breaks score ties (the plain occurrenceIndex match). */
function findContextMatch(
	plainText: string,
	quote: string,
	contextBefore: string,
	contextAfter: string,
	preferredIdx: number
): number {
	const storedBefore = normalizeAnchorContext(contextBefore);
	const storedAfter = normalizeAnchorContext(contextAfter);
	// The bar adapts to how much context exists: a quote at the very start
	// of a short document may have less than ANCHOR_CONTEXT_MIN_MATCH chars
	// of context in total, and that's fine.
	const required = Math.min(ANCHOR_CONTEXT_MIN_MATCH, storedBefore.length + storedAfter.length);
	let bestIdx = -1;
	let bestScore = -1;
	let scan = 0;
	while ((scan = plainText.indexOf(quote, scan)) !== -1) {
		const actualBefore = normalizeAnchorContext(
			plainText.slice(Math.max(0, scan - ANCHOR_CONTEXT_RADIUS), scan)
		);
		const actualAfter = normalizeAnchorContext(
			plainText.slice(scan + quote.length, scan + quote.length + ANCHOR_CONTEXT_RADIUS)
		);
		const score =
			commonSuffixLen(storedBefore, actualBefore) + commonPrefixLen(storedAfter, actualAfter);
		if (score >= required && (score > bestScore || (score === bestScore && scan === preferredIdx))) {
			bestScore = score;
			bestIdx = scan;
		}
		scan += quote.length;
	}
	return bestIdx;
}

/** A resolved quote match: `idx` into the plain text that was searched, and
 * the `quote` that actually matched there (the anchor's full quote, or its
 * first non-empty line when the multi-line fallback kicked in). */
export interface AnchorQuoteMatch {
	idx: number;
	quote: string;
}

/**
 * Locate a comment-thread anchor's quote in `plainText` — the single
 * matching policy shared by the comment overlay's fallback resolver (which
 * maps the match to ProseMirror positions) and the per-tab thread counting
 * that drives the TabBar dots. Keeping one implementation is what keeps
 * "the dot pulses" and "a card renders" in agreement; they drifted once
 * (the overlay gained the context check, the dot count didn't) and the
 * dots nagged about threads that no longer rendered anywhere.
 *
 * The ladder, in order:
 *   1. Full quote at `occurrenceIndex` (falling back to the first
 *      occurrence when that index no longer exists).
 *   2. Multi-line quotes whose full text no longer matches fall back to
 *      their first non-empty line — enough to position/count the thread.
 *   3. When the anchor stores surrounding context (`contextBefore` /
 *      `contextAfter`) and the full quote matched, the occurrence must
 *      ALSO match that context (`findContextMatch`), so a thread whose
 *      passage was deleted doesn't re-attach to an unrelated occurrence
 *      of the same string elsewhere. The first-line fallback skips the
 *      context check — the stored context surrounds the full quote, not
 *      its first line.
 *
 * Returns null when nothing matches — the thread is detached.
 */
export function matchCommentAnchor(
	plainText: string,
	anchor: CommentThread['anchor']
): AnchorQuoteMatch | null {
	let quote = anchor.quote;
	if (!quote) return null;
	let idx = nthIndexOf(plainText, quote, anchor.occurrenceIndex);
	if (idx < 0) idx = nthIndexOf(plainText, quote, 0);
	let usedFirstLineFallback = false;
	if (idx < 0 && quote.includes('\n')) {
		const firstLine = quote.split('\n').find((l) => l.trim()) ?? '';
		if (firstLine) {
			quote = firstLine;
			idx = nthIndexOf(plainText, quote, 0);
			usedFirstLineFallback = true;
		}
	}
	if (idx < 0) return null;
	const hasContext = !!(anchor.contextBefore || anchor.contextAfter);
	if (hasContext && !usedFirstLineFallback) {
		idx = findContextMatch(
			plainText,
			quote,
			anchor.contextBefore ?? '',
			anchor.contextAfter ?? '',
			idx
		);
		if (idx < 0) return null;
	}
	return { idx, quote };
}

export function getFragment(ydoc: Y.Doc): Y.XmlFragment {
	return ydoc.getXmlFragment(FRAGMENT_NAME);
}

export function getReviewArray(ydoc: Y.Doc): Y.Array<PendingReviewRound> {
	return ydoc.getArray<PendingReviewRound>(REVIEW_ARRAY_NAME);
}

export function getCommentsMap(ydoc: Y.Doc): Y.Map<CommentThread> {
	return ydoc.getMap<CommentThread>(COMMENTS_MAP_NAME);
}

export function readCommentThreads(ydoc: Y.Doc): CommentThread[] {
	const out: CommentThread[] = [];
	getCommentsMap(ydoc).forEach((thread) => out.push(thread));
	return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function readReviewRounds(ydoc: Y.Doc): PendingReviewRound[] {
	return getReviewArray(ydoc).toArray();
}

/** Serialize the `default` XmlFragment to plain text: paragraphs joined by
 * '\n'; a `<hardBreak/>` inside a paragraph renders as its own '\n'. */
export function serializeYDoc(ydoc: Y.Doc): string {
	return serializeFragment(getFragment(ydoc));
}

export function serializeFragment(fragment: Y.XmlFragment): string {
	const lines: string[] = [];
	fragment.forEach((child) => lines.push(textOf(child)));
	return normalizeTypography(lines.join('\n'));
}

function textOf(node: unknown): string {
	return runsOf(node)
		.map((r) => r.text)
		.join('');
}

/** Flatten a node to provenance runs. Mirrors `textOf`'s walk exactly:
 * `<hardBreak/>` becomes a '\n' run, nested elements recurse. NOTE:
 * `Y.XmlText.toString()` cannot be used for text extraction once formatting
 * attributes exist — it serializes formatted ranges as XML tags
 * (`a <ai>b</ai>`), so all text extraction goes through `toDelta()`. */
function runsOf(node: unknown): ProvenanceRun[] {
	if (node instanceof Y.XmlText) {
		const runs: ProvenanceRun[] = [];
		for (const d of node.toDelta() as Array<{
			insert?: unknown;
			attributes?: Record<string, unknown>;
		}>) {
			if (typeof d.insert === 'string' && d.insert.length > 0) {
				runs.push({ text: d.insert, ai: Boolean(d.attributes?.[AI_ATTR]) });
			}
		}
		return runs;
	}
	if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
		const runs: ProvenanceRun[] = [];
		(node as Y.XmlElement).forEach((child: unknown) => {
			if (
				child instanceof Y.XmlElement &&
				typeof (child as Y.XmlElement).nodeName === 'string' &&
				(child as Y.XmlElement).nodeName === 'hardBreak'
			) {
				runs.push({ text: '\n', ai: false });
				return;
			}
			runs.push(...runsOf(child));
		});
		return runs;
	}
	return [];
}

/** Per-paragraph runs with typography normalized run-by-run. Every
 * normalizeTypography replacement is context-free, so normalizing each run
 * individually equals normalizing the concatenation — offsets computed
 * against the joined text stay valid against the runs. */
function paragraphRunsNormalized(child: unknown): ProvenanceRun[] {
	const out: ProvenanceRun[] = [];
	for (const r of runsOf(child)) {
		const text = normalizeTypography(r.text);
		if (text.length > 0) out.push({ text, ai: r.ai });
	}
	return out;
}

/** Join per-paragraph run lists with '\n' separator runs, mirroring how
 * `serializeFragment` joins paragraph texts. */
function joinParagraphRuns(paraRuns: ProvenanceRun[][]): ProvenanceRun[] {
	const out: ProvenanceRun[] = [];
	paraRuns.forEach((runs, i) => {
		if (i > 0) out.push({ text: '\n', ai: false });
		out.push(...runs);
	});
	return out;
}

/** Slice a run list by character offsets (like String.slice on the joined
 * text), preserving each character's provenance flag. */
function sliceRuns(runs: ProvenanceRun[], from: number, to: number): ProvenanceRun[] {
	const out: ProvenanceRun[] = [];
	let cursor = 0;
	for (const run of runs) {
		const runStart = cursor;
		const runEnd = cursor + run.text.length;
		cursor = runEnd;
		if (runEnd <= from) continue;
		if (runStart >= to) break;
		const text = run.text.slice(Math.max(0, from - runStart), Math.min(run.text.length, to - runStart));
		if (text.length > 0) out.push({ text, ai: run.ai });
	}
	return out;
}

const dmp = new DiffMatchPatch.diff_match_patch();

/** Word-level diff. A raw character diff produces mid-word provenance
 * boundaries — "cat" → "ferret" shares the trailing "t", so "ferre" would be
 * AI and "t" human, and the editor would color half a word. Instead we
 * tokenize both texts into words + whitespace runs, encode each distinct
 * token as one sentinel char (diff-match-patch's lines-to-chars technique at
 * word granularity), diff in token space, and run `diff_cleanupSemantic`
 * THERE — so a lone surviving token sandwiched between rewrites merges into
 * one phrase-level chunk, while genuinely surviving words stay unmarked.
 * Decoding restores the real text; every boundary lands on a token edge.
 * Falls back to a plain character diff in the (pathological) case of more
 * distinct tokens than sentinel code points. */
function diffWordLevel(oldText: string, newText: string): Array<[number, string]> {
	const tokenRe = /\S+|\s+/g;
	const tokenToChar = new Map<string, string>();
	const charToToken = new Map<string, string>();
	// Sentinel code points: skip the surrogate range so decoding can walk
	// the encoded string one UTF-16 unit at a time.
	let nextCode = 1;
	const encode = (text: string): string | null => {
		let out = '';
		for (const token of text.match(tokenRe) ?? []) {
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
	const encodedOld = encode(oldText);
	const encodedNew = encodedOld === null ? null : encode(newText);
	if (encodedOld === null || encodedNew === null) {
		const charDiffs = dmp.diff_main(oldText, newText);
		dmp.diff_cleanupSemantic(charDiffs);
		return charDiffs as Array<[number, string]>;
	}
	const diffs = dmp.diff_main(encodedOld, encodedNew, false);
	dmp.diff_cleanupSemantic(diffs);
	return diffs.map(([op, chars]) => {
		let text = '';
		for (let i = 0; i < chars.length; i += 1) text += charToToken.get(chars[i]) ?? '';
		return [op, text] as [number, string];
	});
}

/** Transform `oldRuns` into `newText`, marking inserted text with the
 * `insertedAi` provenance (AI-authored by default — the callers are agent
 * write paths) and carrying the provenance of surviving text through
 * unchanged. Uses the word-level diff above, so an agent rewrite of half a
 * sentence marks that half as AI — never sub-word fragments, never the
 * untouched remainder. */
function diffRunsToText(
	oldRuns: ProvenanceRun[],
	newText: string,
	insertedAi = true
): ProvenanceRun[] {
	const oldText = oldRuns.map((r) => r.text).join('');
	if (oldText === newText) return oldRuns;
	if (!newText) return [];
	if (!oldText) return [{ text: newText, ai: insertedAi }];
	const diffs = diffWordLevel(oldText, newText);
	const out: ProvenanceRun[] = [];
	let cursor = 0;
	for (const [op, text] of diffs) {
		if (op === 0) {
			out.push(...sliceRuns(oldRuns, cursor, cursor + text.length));
			cursor += text.length;
		} else if (op === -1) {
			cursor += text.length;
		} else {
			out.push({ text, ai: insertedAi });
		}
	}
	return out;
}

/** Build `<paragraph>` elements from runs, splitting on '\n' like
 * `buildParagraphElements`. Formatted text is written via `applyDelta`:
 * unlike `Y.Text.insert` without attributes — which INHERITS the formatting
 * of the character before the insertion point — `applyDelta` inserts
 * attribute-less ops as genuinely unformatted. */
function buildParagraphsFromRuns(runs: ProvenanceRun[]): Y.XmlElement[] {
	const paras: ProvenanceRun[][] = [[]];
	for (const run of runs) {
		const parts = run.text.split('\n');
		parts.forEach((part, i) => {
			if (i > 0) paras.push([]);
			if (part.length > 0) {
				const current = paras[paras.length - 1];
				const last = current[current.length - 1];
				if (last && last.ai === run.ai) last.text += part;
				else current.push({ text: part, ai: run.ai });
			}
		});
	}
	return paras.map((paraRuns) => {
		const p = new Y.XmlElement('paragraph');
		if (paraRuns.length > 0) {
			const t = new Y.XmlText();
			t.applyDelta(
				paraRuns.map((r) =>
					r.ai ? { insert: r.text, attributes: { [AI_ATTR]: true } } : { insert: r.text }
				)
			);
			p.insert(0, [t]);
		}
		return p;
	});
}

function buildParagraphElements(content: string): Y.XmlElement[] {
	return content.split('\n').map((line) => {
		const p = new Y.XmlElement('paragraph');
		if (line.length > 0) p.insert(0, [new Y.XmlText(line)]);
		return p;
	});
}

/** Apply an edit-op (replace one occurrence of `oldString` with `newString`)
 * to the fragment by replacing only the paragraphs the edit actually touches.
 * Returns true on success, false if `oldString` is not found.
 *
 * The point: a wholesale `replaceYDocText` eats any concurrent user typing
 * because every character lives in the about-to-be-deleted old content. By
 * only deleting + reinserting the paragraphs the edit covers, concurrent
 * typing in any other paragraph merges through Yjs CRDT untouched.
 *
 * Provenance: edit-ops are agent-authored by construction (they only exist
 * inside PendingReviewRounds), so the text this splice INTRODUCES is tagged
 * with the `ai` format attribute — at phrase granularity via
 * `diffRunsToText`, not "the whole new_string". Text that survives the edit
 * (including the untouched head/tail of the affected paragraphs) keeps
 * whatever provenance it already had.
 *
 * Caller must be inside a `ydoc.transact(..., origin)`. */
export function applyEditToFragment(
	fragment: Y.XmlFragment,
	oldString: string,
	newString: string,
	replaceAll: boolean
): boolean {
	if (!oldString) return false;

	// Snapshot paragraph runs (normalized) so we can compute the affected
	// range AND carry existing provenance through the rebuild. The joined
	// texts mirror serializeFragment's output exactly.
	const paraRuns: ProvenanceRun[][] = [];
	fragment.forEach((child) => paraRuns.push(paragraphRunsNormalized(child)));
	const paraTexts = paraRuns.map((runs) => runs.map((r) => r.text).join(''));

	if (replaceAll) {
		// Sweeping rename: replace every occurrence in one pass. Concurrent
		// typing protection is weaker here (we touch the whole fragment),
		// but replace_all is a sweeping rename by intent — the caller is
		// asking for it.
		const fullText = paraTexts.join('\n');
		if (fullText.indexOf(oldString) < 0) return false;
		const replaced = fullText.split(oldString).join(normalizeTypography(newString));
		if (replaced === fullText) return false;
		const newRuns = diffRunsToText(joinParagraphRuns(paraRuns), replaced);
		fragment.delete(0, fragment.length);
		fragment.insert(0, buildParagraphsFromRuns(newRuns));
		return true;
	}

	const fullText = paraTexts.join('\n');
	const startOffset = fullText.indexOf(oldString);
	if (startOffset < 0) return false;
	const endOffset = startOffset + oldString.length;

	// Walk paragraphs to find which ones are affected. Range boundaries are
	// inclusive on the start, exclusive on the end — but a match landing
	// exactly at a paragraph boundary (a '\n') belongs to the paragraph
	// preceding the boundary for the start and the one after for the end.
	let cursor = 0;
	let firstAffected = -1;
	let lastAffected = -1;
	let regionStart = 0;
	for (let i = 0; i < paraTexts.length; i += 1) {
		const paraStart = cursor;
		const paraEnd = cursor + paraTexts[i].length;
		if (firstAffected < 0 && startOffset >= paraStart && startOffset <= paraEnd) {
			firstAffected = i;
			regionStart = paraStart;
		}
		if (firstAffected >= 0 && endOffset >= paraStart && endOffset <= paraEnd) {
			lastAffected = i;
			break;
		}
		cursor = paraEnd + 1; // +1 for the '\n' separator between paragraphs
	}
	if (firstAffected < 0 || lastAffected < 0) return false;

	// Splice in run space: head and tail of the affected region pass through
	// with their existing provenance; only oldString → newString is diffed.
	const regionRuns = joinParagraphRuns(paraRuns.slice(firstAffected, lastAffected + 1));
	const regionLength = regionRuns.reduce((n, r) => n + r.text.length, 0);
	const startInRegion = startOffset - regionStart;
	const endInRegion = startInRegion + oldString.length;
	const newRuns = [
		...sliceRuns(regionRuns, 0, startInRegion),
		...diffRunsToText(
			sliceRuns(regionRuns, startInRegion, endInRegion),
			normalizeTypography(newString)
		),
		...sliceRuns(regionRuns, endInRegion, regionLength)
	];
	const count = lastAffected - firstAffected + 1;
	fragment.delete(firstAffected, count);
	fragment.insert(firstAffected, buildParagraphsFromRuns(newRuns));
	return true;
}

/** Seed an EMPTY Y.Doc's fragment from a content string. No-op if non-empty
 * (seeding a populated fragment produces merge garbage). Does NOT wrap in a
 * transact — callers pick their own origin. */
export function seedYDoc(ydoc: Y.Doc, content: string): void {
	const fragment = getFragment(ydoc);
	if (fragment.length > 0) return;
	if (!content) return;
	fragment.insert(0, buildParagraphElements(normalizeTypography(content)));
}

/** Replace the fragment's content wholesale. Callers must wrap this in
 * `ydoc.transact(..., origin)` so the update carries the right origin tag. */
export function replaceYDocText(ydoc: Y.Doc, content: string): void {
	const fragment = getFragment(ydoc);
	if (fragment.length > 0) fragment.delete(0, fragment.length);
	if (content) fragment.insert(0, buildParagraphElements(normalizeTypography(content)));
}

/** Like `replaceYDocText`, but for AGENT-authored content (accepting a
 * `write` op or a legacy afterMd round): diffs the new content against the
 * current fragment and tags only the text the agent actually introduced with
 * the `ai` provenance attribute. A wholesale rewrite that carries most of the
 * user's prose through unchanged keeps that prose human-authored; a brand-new
 * file (empty fragment) comes out entirely AI-authored. Callers must wrap
 * this in `ydoc.transact(..., origin)`. */
export function replaceYDocTextWithAiProvenance(ydoc: Y.Doc, content: string): void {
	const fragment = getFragment(ydoc);
	const paraRuns: ProvenanceRun[][] = [];
	fragment.forEach((child) => paraRuns.push(paragraphRunsNormalized(child)));
	const newRuns = diffRunsToText(joinParagraphRuns(paraRuns), normalizeTypography(content ?? ''));
	if (fragment.length > 0) fragment.delete(0, fragment.length);
	if (content) fragment.insert(0, buildParagraphsFromRuns(newRuns));
}

/** Replace the fragment's text with externally-authored content (a file
 * edited outside DocWriter), preserving the provenance of everything that
 * survives the diff and marking introduced text as human-authored. Used by
 * the disk-wins reseed: the external edit lands as one more update on the
 * live history instead of destroying it. Callers must wrap this in
 * `ydoc.transact(..., origin)`. */
export function replaceYDocTextFromExternal(ydoc: Y.Doc, content: string): void {
	const fragment = getFragment(ydoc);
	const paraRuns: ProvenanceRun[][] = [];
	fragment.forEach((child) => paraRuns.push(paragraphRunsNormalized(child)));
	const newRuns = diffRunsToText(
		joinParagraphRuns(paraRuns),
		normalizeTypography(content ?? ''),
		false
	);
	if (fragment.length > 0) fragment.delete(0, fragment.length);
	if (content) fragment.insert(0, buildParagraphsFromRuns(newRuns));
}
