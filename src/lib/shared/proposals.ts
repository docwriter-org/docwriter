/**
 * Proposals as marks in the document.
 *
 * An agent proposal is track changes inside the CRDT, the way Word and
 * Google Docs represent a suggestion. Nothing is diffed at render time.
 *
 *   text format `insertion: { threadId }`   proposed new text (green)
 *   text format `deletion:  { threadId }`   text proposed for removal (red)
 *   text format `comment:   { threadId }`   a comment with no edit (amber)
 *   paragraph attrs `suggest: 'ins' | 'del'` + `suggestThread`
 *                                           a whole line added or removed
 *
 * Invariants:
 *   - A thread owns its marks. A thread's anchor IS the set of its marks.
 *   - Text belongs to one thread or to none: `propose` refuses to touch a
 *     line that carries another thread's marks (`overlap`).
 *   - A thread's proposal is replaced whole: `propose` reverts the thread's
 *     existing marks first.
 *   - Accept / Reject / Dismiss are one operation (`resolveThreadMarks`).
 *
 * Views: the agent speaks in strings and the document is a tree, so this
 * module is the ONLY place that turns the fragment into a string and maps a
 * match in that string back to tree positions (`buildView`). Three views:
 *   committed         no insertions, with deletions — what the author has
 *                     accepted; `document.md`.
 *   proposed          with insertions, no deletions — what `read_doc`
 *                     returns and `old_string` is matched against.
 *   proposed except T `proposed` with T's marks reverted — the base a
 *                     revision of T is diffed against.
 *
 * Shared by client and server: plain Yjs, no Tiptap, no DOM.
 */
import * as Y from 'yjs';
import { AI_ATTR, COMMENTS_MAP_NAME, FRAGMENT_NAME, normalizeTypography } from './ydoc-constants';
import { diffLineLevel, diffWordLevel, type LineHunk } from './text-diff';

export const INSERTION_ATTR = 'insertion';
export const DELETION_ATTR = 'deletion';
export const COMMENT_ATTR = 'comment';
export const SUGGEST_ATTR = 'suggest';
export const SUGGEST_THREAD_ATTR = 'suggestThread';

export type SuggestOp = 'ins' | 'del';
export type ThreadOutcome = 'accepted' | 'rejected' | 'dismissed';

/** Above this share of changed characters a modified line is shown as one
 * struck line plus one green line instead of a confetti of word swaps. */
export const WHOLE_LINE_CHURN = 0.8;

type Attrs = Record<string, unknown>;

interface Run {
	text: string;
	attrs: Attrs;
	/** A `<hardBreak/>` element, rendered as '\n'. Cannot carry marks. */
	br?: boolean;
}

interface Para {
	node: Y.XmlElement;
	runs: Run[];
	suggest: SuggestOp | null;
	suggestThread: string | null;
}

function markThread(attrs: Attrs | undefined, key: string): string | null {
	const v = attrs?.[key];
	if (v && typeof v === 'object' && typeof (v as { threadId?: unknown }).threadId === 'string') {
		return (v as { threadId: string }).threadId;
	}
	return null;
}

/** Every thread id a run's attributes name, across the three mark kinds. */
function runThreads(attrs: Attrs): string[] {
	const out: string[] = [];
	for (const key of [INSERTION_ATTR, DELETION_ATTR, COMMENT_ATTR]) {
		const t = markThread(attrs, key);
		if (t) out.push(t);
	}
	return out;
}

function collectRuns(el: Y.XmlElement | Y.XmlFragment, out: Run[]): void {
	el.forEach((child: unknown) => {
		if (child instanceof Y.XmlText) {
			for (const d of child.toDelta() as Array<{ insert?: unknown; attributes?: Attrs }>) {
				if (typeof d.insert === 'string' && d.insert.length > 0) {
					out.push({ text: d.insert, attrs: d.attributes ?? {} });
				}
			}
			return;
		}
		if (child instanceof Y.XmlElement) {
			if (child.nodeName === 'hardBreak') {
				out.push({ text: '\n', attrs: {}, br: true });
				return;
			}
			collectRuns(child, out);
		}
	});
}

function readParagraphs(fragment: Y.XmlFragment): Para[] {
	const out: Para[] = [];
	fragment.forEach((child) => {
		if (!(child instanceof Y.XmlElement)) return;
		const runs: Run[] = [];
		collectRuns(child, runs);
		const suggest = child.getAttribute(SUGGEST_ATTR);
		const thread = child.getAttribute(SUGGEST_THREAD_ATTR);
		out.push({
			node: child,
			runs,
			suggest: suggest === 'ins' || suggest === 'del' ? suggest : null,
			suggestThread: typeof thread === 'string' ? thread : null
		});
	});
	return out;
}

// ── Views ─────────────────────────────────────────────────────────────────

export type ViewMode = { kind: 'committed' } | { kind: 'proposed'; except?: string };

export interface ViewLine {
	/** Normalized text of the line (no '\n'). */
	text: string;
	/** Index of the paragraph in the fragment — after `except`'s marks are
	 * reverted, when the view has an `except` thread. */
	para: number;
	/** True when this is the first line of its paragraph (no hardBreak
	 * precedes it). */
	first: boolean;
	/** True when the paragraph holds more than one line (hardBreaks). */
	multi: boolean;
	/** Raw offset (Y.XmlText index space of the paragraph, after revert) of
	 * each normalized character. `rawStart` is the line's own start. */
	rawStart: number;
	rawMap: number[];
	/** Raw offset just past the line's last character. */
	rawEnd: number;
	/** Other threads with marks on this line (or on its paragraph). */
	foreign: string[];
}

export interface DocView {
	text: string;
	lines: ViewLine[];
	/** Offset of each line's first character in `text`. */
	lineStarts: number[];
	/** Paragraph count after revert (when `except`), else the fragment's. */
	paraCount: number;
}

const normCache = new Map<string, string>();
function normChar(c: string): string {
	let n = normCache.get(c);
	if (n === undefined) {
		n = normalizeTypography(c);
		normCache.set(c, n);
	}
	return n;
}

function paragraphIncluded(p: Para, mode: ViewMode): boolean {
	if (mode.kind === 'committed') return p.suggest !== 'ins';
	if (p.suggest === 'del') return !!mode.except && p.suggestThread === mode.except;
	if (p.suggest === 'ins') return !(mode.except && p.suggestThread === mode.except);
	return true;
}

/** Whether a run's text is part of the view, and whether it still occupies
 * raw index space in the fragment the view describes. */
function runDisposition(run: Run, mode: ViewMode): { shown: boolean; occupies: boolean } {
	const ins = markThread(run.attrs, INSERTION_ATTR);
	const del = markThread(run.attrs, DELETION_ATTR);
	if (mode.kind === 'committed') return { shown: !ins, occupies: true };
	if (ins && mode.except && ins === mode.except) return { shown: false, occupies: false };
	if (del) return { shown: !!mode.except && del === mode.except, occupies: true };
	return { shown: true, occupies: true };
}

export function buildView(fragment: Y.XmlFragment, mode: ViewMode): DocView {
	const paras = readParagraphs(fragment);
	const lines: ViewLine[] = [];
	let paraIndex = 0;
	for (const p of paras) {
		const included = paragraphIncluded(p, mode);
		const removedByRevert =
			mode.kind === 'proposed' && !!mode.except && p.suggest === 'ins' && p.suggestThread === mode.except;
		if (!included) {
			if (!removedByRevert) paraIndex += 1;
			continue;
		}
		const paraForeign = new Set<string>();
		if (p.suggest && p.suggestThread && !(mode.kind === 'proposed' && p.suggestThread === mode.except)) {
			paraForeign.add(p.suggestThread);
		}
		const multi = p.runs.some((r) => r.br || r.text.includes('\n'));
		let line: ViewLine = {
			text: '',
			para: paraIndex,
			first: true,
			multi,
			rawStart: 0,
			rawMap: [],
			rawEnd: 0,
			foreign: []
		};
		const lineForeign = new Set<string>(paraForeign);
		let raw = 0;
		const flush = () => {
			line.rawEnd = raw;
			line.foreign = [...lineForeign];
			lines.push(line);
		};
		for (const run of p.runs) {
			const { shown, occupies } = runDisposition(run, mode);
			for (const t of runThreads(run.attrs)) {
				if (!(mode.kind === 'proposed' && t === mode.except)) lineForeign.add(t);
			}
			if (!shown) {
				if (occupies) raw += run.text.length;
				continue;
			}
			for (let i = 0; i < run.text.length; i += 1) {
				const c = run.text[i];
				if (c === '\n') {
					flush();
					raw += 1;
					line = {
						text: '',
						para: paraIndex,
						first: false,
						multi,
						rawStart: raw,
						rawMap: [],
						rawEnd: raw,
						foreign: []
					};
					lineForeign.clear();
					for (const t of paraForeign) lineForeign.add(t);
					continue;
				}
				const n = normChar(c);
				for (let k = 0; k < n.length; k += 1) {
					line.text += n[k];
					line.rawMap.push(raw);
				}
				raw += 1;
			}
		}
		flush();
		paraIndex += 1;
	}
	const lineStarts: number[] = [];
	let offset = 0;
	for (const l of lines) {
		lineStarts.push(offset);
		offset += l.text.length + 1;
	}
	return { text: lines.map((l) => l.text).join('\n'), lines, lineStarts, paraCount: paraIndex };
}

export function committedText(doc: Y.Doc): string {
	return buildView(doc.getXmlFragment(FRAGMENT_NAME), { kind: 'committed' }).text;
}

export function proposedText(doc: Y.Doc): string {
	return buildView(doc.getXmlFragment(FRAGMENT_NAME), { kind: 'proposed' }).text;
}

// ── Mark walking ──────────────────────────────────────────────────────────

interface TextRange {
	node: Y.XmlText;
	start: number;
	length: number;
	attrs: Attrs;
}

/** Every formatted range of a paragraph's text nodes, with its index into
 * the owning Y.XmlText. Walk order is document order. */
function textRanges(para: Y.XmlElement): TextRange[] {
	const out: TextRange[] = [];
	const visit = (el: Y.XmlElement) => {
		el.forEach((child: unknown) => {
			if (child instanceof Y.XmlText) {
				let idx = 0;
				for (const d of child.toDelta() as Array<{ insert?: unknown; attributes?: Attrs }>) {
					if (typeof d.insert !== 'string') continue;
					out.push({ node: child, start: idx, length: d.insert.length, attrs: d.attributes ?? {} });
					idx += d.insert.length;
				}
			} else if (child instanceof Y.XmlElement && child.nodeName !== 'hardBreak') {
				visit(child);
			}
		});
	};
	visit(para);
	return out;
}

function paragraphNodes(fragment: Y.XmlFragment): Y.XmlElement[] {
	const out: Y.XmlElement[] = [];
	fragment.forEach((c) => {
		if (c instanceof Y.XmlElement) out.push(c);
	});
	return out;
}

/** The Y.XmlText holding raw offset `raw` of a paragraph, with the offset
 * translated into that node's own index space. A paragraph with no text
 * node gets one. `raw` may equal the text length (append position). */
function locate(para: Y.XmlElement, raw: number): { node: Y.XmlText; index: number } {
	let cursor = 0;
	let last: Y.XmlText | null = null;
	for (const child of para.toArray() as unknown[]) {
		if (child instanceof Y.XmlText) {
			const len = child.length;
			if (raw >= cursor && raw <= cursor + len) return { node: child, index: raw - cursor };
			last = child;
			cursor += len;
		} else if (child instanceof Y.XmlElement && child.nodeName === 'hardBreak') {
			cursor += 1;
		}
	}
	if (last) return { node: last, index: last.length };
	const t = new Y.XmlText();
	para.insert(0, [t]);
	return { node: t, index: 0 };
}

type ThreadRangeAction = 'revert' | 'accept';

/** Undo (`revert`) or land (`accept`) every mark thread `threadId` holds in
 * one paragraph. Returns true when the paragraph node itself should be
 * removed by the caller (an inserted paragraph being reverted, or a deleted
 * one being accepted, that holds nothing but this thread's text). */
function applyToParagraph(para: Y.XmlElement, threadId: string, action: ThreadRangeAction): boolean {
	const ranges = textRanges(para);
	// Descending so deletions never shift the ranges still to be visited.
	for (let i = ranges.length - 1; i >= 0; i -= 1) {
		const r = ranges[i];
		const ins = markThread(r.attrs, INSERTION_ATTR) === threadId;
		const del = markThread(r.attrs, DELETION_ATTR) === threadId;
		const com = markThread(r.attrs, COMMENT_ATTR) === threadId;
		if (!ins && !del && !com) continue;
		const fmt: Attrs = {};
		if (com) fmt[COMMENT_ATTR] = null;
		if (action === 'revert') {
			if (ins) {
				r.node.delete(r.start, r.length);
				continue;
			}
			if (del) fmt[DELETION_ATTR] = null;
		} else {
			if (del) {
				r.node.delete(r.start, r.length);
				continue;
			}
			if (ins) {
				fmt[INSERTION_ATTR] = null;
				fmt[AI_ATTR] = true;
			}
		}
		r.node.format(r.start, r.length, fmt);
	}
	const suggest = para.getAttribute(SUGGEST_ATTR);
	const owner = para.getAttribute(SUGGEST_THREAD_ATTR);
	if (owner !== threadId || (suggest !== 'ins' && suggest !== 'del')) return false;
	const dropNode = (action === 'revert' && suggest === 'ins') || (action === 'accept' && suggest === 'del');
	if (dropNode) {
		// Author text typed into the paragraph is never inside a proposal:
		// keep the node (as plain text) when anything survived the walk.
		let remaining = 0;
		para.forEach((c: unknown) => {
			if (c instanceof Y.XmlText) remaining += c.length;
			else if (c instanceof Y.XmlElement && c.nodeName === 'hardBreak') remaining += 1;
		});
		if (remaining === 0) return true;
	}
	para.removeAttribute(SUGGEST_ATTR);
	para.removeAttribute(SUGGEST_THREAD_ATTR);
	return false;
}

function applyToThread(fragment: Y.XmlFragment, threadId: string, action: ThreadRangeAction): void {
	const paras = paragraphNodes(fragment);
	for (let i = paras.length - 1; i >= 0; i -= 1) {
		if (applyToParagraph(paras[i], threadId, action)) fragment.delete(i, 1);
	}
}

/** Undo every mark a thread holds: its inserted text and paragraphs go,
 * its struck text and paragraphs come back, its comment highlight clears.
 * Callers run inside their own transact. */
export function revertThreadMarks(doc: Y.Doc, threadId: string): void {
	applyToThread(doc.getXmlFragment(FRAGMENT_NAME), threadId, 'revert');
}

/** Land or discard a thread's proposal and clear its comment highlight.
 * `accepted` keeps inserted text (stamped `ai`) and removes struck text;
 * `rejected` / `dismissed` revert. Callers run inside their own transact. */
export function resolveThreadMarks(doc: Y.Doc, threadId: string, outcome: ThreadOutcome): void {
	applyToThread(
		doc.getXmlFragment(FRAGMENT_NAME),
		threadId,
		outcome === 'accepted' ? 'accept' : 'revert'
	);
}

// ── Comment marks ─────────────────────────────────────────────────────────

export type CommentMarkResult =
	| { ok: true }
	| { ok: false; reason: 'overlap'; otherThreadId: string }
	| { ok: false; reason: 'range' };

/** Put a thread's comment highlight on `[start, end)` of a view's text
 * (offsets into `buildView(fragment, mode).text`), replacing any highlight
 * the thread had. Multi-line ranges mark each line's share. Refuses a line
 * another thread already holds (one passage, one thread) and a range that
 * does not land on text. Callers run inside their own transact. */
export function setCommentMarkByViewOffsets(
	doc: Y.Doc,
	threadId: string,
	mode: ViewMode,
	start: number,
	end: number
): CommentMarkResult {
	const fragment = doc.getXmlFragment(FRAGMENT_NAME);
	const view = buildView(fragment, mode);
	if (start < 0 || end > view.text.length || end <= start) return { ok: false, reason: 'range' };
	const hits: Array<{ line: ViewLine; s: number; e: number }> = [];
	for (let li = 0; li < view.lines.length; li += 1) {
		const line = view.lines[li];
		const lineStart = view.lineStarts[li];
		const lineEnd = lineStart + line.text.length;
		const s = Math.max(start, lineStart) - lineStart;
		const e = Math.min(end, lineEnd) - lineStart;
		if (e <= s) continue;
		const other = line.foreign.find((t) => t !== threadId);
		if (other) return { ok: false, reason: 'overlap', otherThreadId: other };
		hits.push({ line, s, e });
	}
	if (hits.length === 0) return { ok: false, reason: 'range' };
	const paras = paragraphNodes(fragment);
	clearCommentMarks(fragment, threadId);
	for (const { line, s, e } of hits) {
		const para = paras[line.para];
		if (!para) continue;
		const rawS = line.rawMap[s];
		const rawE = line.rawMap[e - 1] + 1;
		formatRaw(para, rawS, rawE, { [COMMENT_ATTR]: { threadId } });
	}
	return { ok: true };
}

/** `setCommentMarkByViewOffsets` on the committed view; false unless the
 * mark landed. */
export function setCommentMarkByCommittedOffsets(
	doc: Y.Doc,
	threadId: string,
	start: number,
	end: number
): boolean {
	return setCommentMarkByViewOffsets(doc, threadId, { kind: 'committed' }, start, end).ok;
}

/** Another thread with a mark on raw range `[s, e)` of a paragraph, or on
 * the paragraph itself; null when the range is free. */
function foreignInRaw(para: Y.XmlElement, s: number, e: number, threadId: string): string | null {
	const owner = para.getAttribute(SUGGEST_THREAD_ATTR);
	if (typeof owner === 'string' && owner !== threadId && para.getAttribute(SUGGEST_ATTR)) return owner;
	let cursor = 0;
	for (const c of para.toArray() as unknown[]) {
		if (c instanceof Y.XmlText) {
			for (const d of c.toDelta() as Array<{ insert?: unknown; attributes?: Attrs }>) {
				if (typeof d.insert !== 'string') continue;
				const from = cursor;
				const to = cursor + d.insert.length;
				cursor = to;
				if (to <= s || from >= e) continue;
				for (const t of runThreads(d.attributes ?? {})) if (t !== threadId) return t;
			}
		} else if (c instanceof Y.XmlElement && c.nodeName === 'hardBreak') {
			cursor += 1;
		}
	}
	return null;
}

/** Same as `setCommentMarkByViewOffsets`, addressed by Yjs absolute
 * positions (from relative positions a client captured on its selection). */
export function setCommentMarkByAbsolutePositions(
	doc: Y.Doc,
	threadId: string,
	from: Y.AbsolutePosition,
	to: Y.AbsolutePosition
): CommentMarkResult {
	const fragment = doc.getXmlFragment(FRAGMENT_NAME);
	const paras = paragraphNodes(fragment);
	const locateNode = (pos: Y.AbsolutePosition): { para: number; raw: number } | null => {
		if (!(pos.type instanceof Y.XmlText)) return null;
		for (let pi = 0; pi < paras.length; pi += 1) {
			let cursor = 0;
			for (const c of paras[pi].toArray() as unknown[]) {
				if (c === pos.type) return { para: pi, raw: cursor + pos.index };
				if (c instanceof Y.XmlText) cursor += c.length;
				else if (c instanceof Y.XmlElement && c.nodeName === 'hardBreak') cursor += 1;
			}
		}
		return null;
	};
	const a = locateNode(from);
	const b = locateNode(to);
	if (!a || !b) return { ok: false, reason: 'range' };
	if (b.para < a.para || (b.para === a.para && b.raw <= a.raw)) return { ok: false, reason: 'range' };
	const spans: Array<{ para: Y.XmlElement; s: number; e: number }> = [];
	for (let pi = a.para; pi <= b.para; pi += 1) {
		const para = paras[pi];
		const len = paragraphRawLength(para);
		const s = pi === a.para ? a.raw : 0;
		const e = pi === b.para ? b.raw : len;
		if (e <= s) continue;
		const other = foreignInRaw(para, s, e, threadId);
		if (other) return { ok: false, reason: 'overlap', otherThreadId: other };
		spans.push({ para, s, e });
	}
	if (spans.length === 0) return { ok: false, reason: 'range' };
	clearCommentMarks(fragment, threadId);
	for (const { para, s, e } of spans) formatRaw(para, s, e, { [COMMENT_ATTR]: { threadId } });
	return { ok: true };
}

function paragraphRawLength(para: Y.XmlElement): number {
	let n = 0;
	para.forEach((c: unknown) => {
		if (c instanceof Y.XmlText) n += c.length;
		else if (c instanceof Y.XmlElement && c.nodeName === 'hardBreak') n += 1;
	});
	return n;
}

function clearCommentMarks(fragment: Y.XmlFragment, threadId: string): void {
	for (const para of paragraphNodes(fragment)) {
		const ranges = textRanges(para);
		for (let i = ranges.length - 1; i >= 0; i -= 1) {
			const r = ranges[i];
			if (markThread(r.attrs, COMMENT_ATTR) === threadId) {
				r.node.format(r.start, r.length, { [COMMENT_ATTR]: null });
			}
		}
	}
}

/** Format raw range `[s, e)` of a paragraph, spanning text nodes as needed
 * (hardBreaks between them are skipped — they cannot carry marks). */
function formatRaw(para: Y.XmlElement, s: number, e: number, attrs: Attrs): void {
	let cursor = 0;
	para.forEach((c: unknown) => {
		if (c instanceof Y.XmlText) {
			const len = c.length;
			const from = Math.max(s, cursor);
			const to = Math.min(e, cursor + len);
			if (to > from) c.format(from - cursor, to - from, attrs);
			cursor += len;
		} else if (c instanceof Y.XmlElement && c.nodeName === 'hardBreak') {
			cursor += 1;
		}
	});
}

// ── Proposing ─────────────────────────────────────────────────────────────

export type ProposeResult =
	| { ok: true; noop: boolean }
	| { ok: false; reason: 'overlap'; otherThreadId: string };

type Op =
	| { kind: 'modify'; para: number; line: ViewLine; after: string }
	| { kind: 'delPara'; para: number }
	| { kind: 'insPara'; at: number; text: string };

function churn(before: string, after: string): number {
	let changed = 0;
	for (const [op, text] of diffWordLevel(before, after)) if (op !== 0) changed += text.length;
	return changed / Math.max(1, before.length + after.length);
}

/** Turn the line hunks of `base → after` into paragraph-level operations.
 * A one-to-one modified line becomes a word-level in-place edit unless it
 * churns past `WHOLE_LINE_CHURN`; everything else is whole lines struck
 * and added. A structural change inside a paragraph that holds several
 * lines (hardBreaks) replaces the whole paragraph, because a hardBreak is a
 * node, not a character, and cannot be struck. */
function planOps(base: DocView, afterLines: string[]): { ops: Op[]; overlap: string | null } {
	const ops: Op[] = [];
	const hunks = diffLineLevel(
		base.lines.map((l) => l.text),
		afterLines
	);
	const lines = base.lines;
	let overlap: string | null = null;
	const foreignOf = (l: ViewLine) => (l.foreign.length > 0 ? l.foreign[0] : null);
	const paraLineRange = (para: number): [number, number] => {
		let s = -1;
		let e = -1;
		for (let i = 0; i < lines.length; i += 1) {
			if (lines[i].para !== para) continue;
			if (s < 0) s = i;
			e = i + 1;
		}
		return [s, e];
	};
	const struck = new Set<number>();
	for (const h of hunks) {
		let { aStart, aEnd, bStart, bEnd } = h;
		const aLen = aEnd - aStart;
		const bLen = bEnd - bStart;
		// A hardBreak paragraph is involved when a changed line sits in one,
		// or a pure insertion lands between two lines of the same paragraph.
		let touchesMulti = lines.slice(aStart, aEnd).some((l) => l.multi);
		if (aLen === 0) {
			const prev = aStart > 0 ? lines[aStart - 1] : null;
			const next = aStart < lines.length ? lines[aStart] : null;
			if (prev && next && prev.para === next.para) touchesMulti = true;
		}
		const oneToOne = aLen === bLen && aLen > 0;
		if (oneToOne) {
			// Lines modified one-to-one get word-level marks in place. A line
			// that churns past the threshold is struck whole and re-added —
			// unless it sits in a hardBreak paragraph, where a whole-line
			// swap is structural and falls through to the paragraph path.
			const heavy = Array.from({ length: aLen }, (_, k) =>
				churn(lines[aStart + k].text, afterLines[bStart + k]) > WHOLE_LINE_CHURN
			);
			if (!touchesMulti || !heavy.some(Boolean)) {
				for (let k = 0; k < aLen; k += 1) {
					const line = lines[aStart + k];
					const after = afterLines[bStart + k];
					const f = foreignOf(line);
					if (f) {
						overlap = overlap ?? f;
						continue;
					}
					if (heavy[k]) {
						if (!struck.has(line.para)) {
							struck.add(line.para);
							ops.push({ kind: 'delPara', para: line.para });
						}
						ops.push({ kind: 'insPara', at: line.para + 1, text: after });
					} else {
						ops.push({ kind: 'modify', para: line.para, line, after });
					}
				}
				continue;
			}
		}
		// Structural: expand to whole paragraphs when a hardBreak paragraph
		// is involved, then strike the old paragraphs and add the new ones.
		if (touchesMulti) {
			const firstPara = aLen > 0 ? lines[aStart].para : lines[Math.min(aStart, lines.length - 1)].para;
			const lastPara = aLen > 0 ? lines[aEnd - 1].para : firstPara;
			const [s] = paraLineRange(firstPara);
			const [, e] = paraLineRange(lastPara);
			const growBefore = aStart - s;
			const growAfter = e - aEnd;
			aStart = s;
			aEnd = e;
			bStart -= growBefore;
			bEnd += growAfter;
		}
		const struckParas: number[] = [];
		for (let i = aStart; i < aEnd; i += 1) {
			const line = lines[i];
			if (struckParas[struckParas.length - 1] === line.para) continue;
			const f = foreignOf(line);
			if (f) overlap = overlap ?? f;
			struckParas.push(line.para);
		}
		for (const p of struckParas) {
			if (struck.has(p)) continue;
			struck.add(p);
			ops.push({ kind: 'delPara', para: p });
		}
		let at: number;
		if (struckParas.length > 0) at = struckParas[struckParas.length - 1] + 1;
		else if (aStart < lines.length) at = lines[aStart].para;
		else at = base.paraCount;
		for (let j = bStart; j < bEnd; j += 1) {
			ops.push({ kind: 'insPara', at, text: afterLines[j] });
		}
	}
	return { ops, overlap };
}

function applyModify(para: Y.XmlElement, threadId: string, line: ViewLine, after: string): void {
	const parts = diffWordLevel(line.text, after);
	// Cursor in the line's normalized text and in raw index space.
	let norm = 0;
	let raw = line.rawStart;
	const rawAt = (n: number) => (n < line.rawMap.length ? line.rawMap[n] : line.rawEnd);
	for (const [op, text] of parts) {
		if (op === 0) {
			norm += text.length;
			raw = rawAt(norm);
			continue;
		}
		if (op === -1) {
			const rawS = raw;
			const rawE = rawAt(norm + text.length);
			if (rawE > rawS) formatRaw(para, rawS, rawE, { [DELETION_ATTR]: { threadId } });
			norm += text.length;
			raw = rawE;
			continue;
		}
		const { node, index } = locate(para, raw);
		node.insert(index, text, { [INSERTION_ATTR]: { threadId } });
		raw += text.length;
		// Inserted text shifts every later raw offset of this line.
		for (let i = norm; i < line.rawMap.length; i += 1) line.rawMap[i] += text.length;
		line.rawEnd += text.length;
	}
}

function buildInsertedParagraph(threadId: string, text: string): Y.XmlElement {
	const p = new Y.XmlElement('paragraph');
	p.setAttribute(SUGGEST_ATTR, 'ins');
	p.setAttribute(SUGGEST_THREAD_ATTR, threadId);
	if (text.length > 0) {
		const t = new Y.XmlText();
		t.applyDelta([{ insert: text, attributes: { [INSERTION_ATTR]: { threadId } } }]);
		p.insert(0, [t]);
	}
	return p;
}

/** Replace thread `threadId`'s proposal so the proposed view becomes
 * `after` (the full document text). Reverts the thread's existing marks,
 * diffs the resulting base against `after`, and writes the marks. Refuses
 * (without touching the document) when a changed line carries another
 * thread's marks. Callers run inside their own transact. */
export function proposeText(doc: Y.Doc, threadId: string, after: string): ProposeResult {
	const fragment = doc.getXmlFragment(FRAGMENT_NAME);
	after = normalizeTypography(after);
	const base = buildView(fragment, { kind: 'proposed', except: threadId });
	const afterLines = after.split('\n');
	const { ops, overlap } = planOps(base, afterLines);
	if (overlap) return { ok: false, reason: 'overlap', otherThreadId: overlap };
	revertThreadMarks(doc, threadId);
	if (ops.length === 0) return { ok: true, noop: true };
	const paras = paragraphNodes(fragment);
	// Existing paragraphs are addressed by node, so their ops can run in any
	// order; new paragraphs are inserted by index, descending, last.
	for (const op of ops) {
		if (op.kind === 'modify') applyModify(paras[op.para], threadId, op.line, op.after);
		else if (op.kind === 'delPara') {
			const para = paras[op.para];
			const len = paragraphRawLength(para);
			if (len > 0) formatRaw(para, 0, len, { [DELETION_ATTR]: { threadId } });
			para.setAttribute(SUGGEST_ATTR, 'del');
			para.setAttribute(SUGGEST_THREAD_ATTR, threadId);
		}
	}
	const inserts = ops.filter((o): o is Extract<Op, { kind: 'insPara' }> => o.kind === 'insPara');
	// Stable descending by index; within one index keep source order.
	const grouped = new Map<number, string[]>();
	for (const ins of inserts) {
		const list = grouped.get(ins.at) ?? [];
		list.push(ins.text);
		grouped.set(ins.at, list);
	}
	for (const at of [...grouped.keys()].sort((a, b) => b - a)) {
		const texts = grouped.get(at)!;
		fragment.insert(
			Math.min(at, fragment.length),
			texts.map((t) => buildInsertedParagraph(threadId, t))
		);
	}
	return { ok: true, noop: false };
}

export type ReplaceResult =
	| ProposeResult
	| { ok: false; reason: 'not-found' | 'ambiguous'; hits: number };

/** `edit_doc`: replace `oldString` (matched in the proposed view, the text
 * the agent read) with `newString` as thread `threadId`'s proposal. */
export function proposeReplacement(
	doc: Y.Doc,
	threadId: string,
	oldString: string,
	newString: string,
	replaceAll = false
): ReplaceResult {
	const view = buildView(doc.getXmlFragment(FRAGMENT_NAME), { kind: 'proposed' });
	oldString = normalizeTypography(oldString);
	newString = normalizeTypography(newString);
	let hits = 0;
	if (oldString.length > 0) {
		let idx = 0;
		while ((idx = view.text.indexOf(oldString, idx)) !== -1) {
			hits += 1;
			idx += oldString.length;
		}
	}
	if (hits === 0) return { ok: false, reason: 'not-found', hits };
	if (hits > 1 && !replaceAll) return { ok: false, reason: 'ambiguous', hits };
	const after = replaceAll
		? view.text.split(oldString).join(newString)
		: view.text.replace(oldString, () => newString);
	return proposeText(doc, threadId, after);
}

// ── External edits ────────────────────────────────────────────────────────

/** Fold a workspace file edited outside DocWriter into the document: the
 * lines that differ between the committed view and `content` are replaced
 * as whole paragraphs (plain, human-authored text); everything else — and
 * every proposal outside the changed window — is left alone. A proposal
 * inside the window goes with the text it was on; its thread parks. Callers
 * run inside their own transact. */
export function applyExternalText(doc: Y.Doc, content: string): void {
	const fragment = doc.getXmlFragment(FRAGMENT_NAME);
	const view = buildView(fragment, { kind: 'committed' });
	const oldLines = view.lines.map((l) => l.text);
	// Split exactly like `seedYDoc`: a trailing newline is a final empty
	// paragraph, so a file that still ends the same way diffs as unchanged
	// there.
	const newLines = normalizeTypography(content).split('\n');
	if (oldLines.length === 1 && oldLines[0] === '' && fragment.length === 0) {
		fragment.insert(0, newLines.map(plainParagraph));
		return;
	}
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix += 1;
	}
	let aStart = prefix;
	let aEnd = oldLines.length - suffix;
	let bStart = prefix;
	let bEnd = newLines.length - suffix;
	if (aStart === aEnd && bStart === bEnd) return;
	// Expand a partial hardBreak paragraph to the whole paragraph, carrying
	// the same number of context lines on the new side.
	const lines = view.lines;
	if (aStart < aEnd) {
		const firstPara = lines[aStart].para;
		const lastPara = lines[aEnd - 1].para;
		while (aStart > 0 && lines[aStart - 1].para === firstPara) {
			aStart -= 1;
			bStart -= 1;
		}
		while (aEnd < lines.length && lines[aEnd].para === lastPara) {
			aEnd += 1;
			bEnd += 1;
		}
	} else if (aStart > 0 && aStart < lines.length && lines[aStart - 1].para === lines[aStart].para) {
		// Pure insertion inside a hardBreak paragraph: rewrite that paragraph.
		const para = lines[aStart].para;
		while (aStart > 0 && lines[aStart - 1].para === para) {
			aStart -= 1;
			bStart -= 1;
		}
		while (aEnd < lines.length && lines[aEnd].para === para) {
			aEnd += 1;
			bEnd += 1;
		}
	}
	const paras = paragraphNodes(fragment);
	// Fragment indices of the paragraphs to replace. The committed view skips
	// inserted paragraphs, so `para` is already a fragment index.
	let fragStart: number;
	let fragEnd: number;
	if (aStart < aEnd) {
		fragStart = lines[aStart].para;
		fragEnd = lines[aEnd - 1].para + 1;
	} else if (aStart < lines.length) {
		fragStart = fragEnd = lines[aStart].para;
	} else {
		fragStart = fragEnd = paras.length;
	}
	if (fragEnd > fragStart) fragment.delete(fragStart, fragEnd - fragStart);
	const inserted = newLines.slice(bStart, bEnd).map(plainParagraph);
	if (inserted.length > 0) fragment.insert(fragStart, inserted);
}

function plainParagraph(line: string): Y.XmlElement {
	const p = new Y.XmlElement('paragraph');
	if (line.length > 0) p.insert(0, [new Y.XmlText(line)]);
	return p;
}

// ── Summaries ─────────────────────────────────────────────────────────────

export interface ThreadChange {
	/** Fragment index of the paragraph. */
	para: number;
	/** The paragraph as committed (empty for an inserted paragraph). */
	before: string;
	/** The paragraph as proposed (empty for a removed paragraph). */
	after: string;
}

export interface ThreadMarkSummary {
	threadId: string;
	/** True when the thread holds insertion/deletion marks or paragraph
	 * attrs; false for a comment-only thread. */
	hasProposal: boolean;
	/** First mark position: paragraph index and raw offset within it. */
	para: number;
	rawOffset: number;
	/** Text under the thread's marks, for a one-line description. */
	quote: string;
	changes: ThreadChange[];
	addedChars: number;
	removedChars: number;
}

/** One summary per thread that holds any mark, in document order. */
export function summarizeThreadMarks(doc: Y.Doc): ThreadMarkSummary[] {
	const paras = readParagraphs(doc.getXmlFragment(FRAGMENT_NAME));
	const byThread = new Map<string, ThreadMarkSummary>();
	const touch = (threadId: string, para: number, raw: number): ThreadMarkSummary => {
		let s = byThread.get(threadId);
		if (!s) {
			s = {
				threadId,
				hasProposal: false,
				para,
				rawOffset: raw,
				quote: '',
				changes: [],
				addedChars: 0,
				removedChars: 0
			};
			byThread.set(threadId, s);
		}
		return s;
	};
	paras.forEach((p, pi) => {
		const threadsHere = new Set<string>();
		const proposalThreads = new Set<string>();
		let raw = 0;
		for (const run of p.runs) {
			const ins = markThread(run.attrs, INSERTION_ATTR);
			const del = markThread(run.attrs, DELETION_ATTR);
			const com = markThread(run.attrs, COMMENT_ATTR);
			for (const t of [ins, del, com]) {
				if (!t) continue;
				const s = touch(t, pi, raw);
				threadsHere.add(t);
				if (t === ins || t === del) proposalThreads.add(t);
				if (t === com && s.quote.length < 160) s.quote += run.text;
			}
			if (ins) touch(ins, pi, raw).addedChars += run.text.length;
			if (del) touch(del, pi, raw).removedChars += run.text.length;
			raw += run.text.length;
		}
		if (p.suggest && p.suggestThread) {
			touch(p.suggestThread, pi, 0);
			threadsHere.add(p.suggestThread);
			proposalThreads.add(p.suggestThread);
		}
		for (const t of proposalThreads) {
			const s = byThread.get(t)!;
			s.hasProposal = true;
			const before =
				p.suggest === 'ins'
					? ''
					: normalizeTypography(
							p.runs
								.filter((r) => !markThread(r.attrs, INSERTION_ATTR))
								.map((r) => r.text)
								.join('')
						);
			const after =
				p.suggest === 'del'
					? ''
					: normalizeTypography(
							p.runs
								.filter((r) => !markThread(r.attrs, DELETION_ATTR))
								.map((r) => r.text)
								.join('')
						);
			s.changes.push({ para: pi, before, after });
			if (!s.quote) s.quote = before || after;
		}
	});
	const out = [...byThread.values()];
	out.sort((a, b) => a.para - b.para || a.rawOffset - b.rawOffset);
	for (const s of out) s.quote = normalizeTypography(s.quote).replace(/\n+/g, ' ').trim();
	return out;
}

/** Ids of threads that currently hold a proposal. */
export function proposalThreadIds(doc: Y.Doc): Set<string> {
	return new Set(summarizeThreadMarks(doc).filter((s) => s.hasProposal).map((s) => s.threadId));
}

/** A string that changes whenever a thread's proposal changes, per thread.
 * The feedback retry compares these before and after a turn. */
export function proposalFingerprints(doc: Y.Doc): Map<string, string> {
	const out = new Map<string, string>();
	for (const s of summarizeThreadMarks(doc)) {
		if (!s.hasProposal) continue;
		out.set(
			s.threadId,
			s.changes.map((c) => `${c.para}:${c.before} ${c.after}`).join('')
		);
	}
	return out;
}

// ── Legacy migration ──────────────────────────────────────────────────────

/** Shape of the pre-marks review round, read once by the migration. */
interface LegacyRound {
	id?: string;
	feedbackThreadId?: string;
	operation?:
		| { type: 'edit'; oldString: string; newString: string; replaceAll?: boolean }
		| { type: 'write'; content: string };
	afterMd?: string;
}

const LEGACY_REVIEW_ARRAY = 'rounds';

/** Convert a document's pending review rounds (the string-pair model) into
 * marks, and give legacy quote-anchored comment threads a comment mark.
 * Rounds whose text no longer matches are dropped. Returns how many rounds
 * were carried over and how many dropped. Callers run inside a transact and
 * persist the delta. */
export function migrateLegacyReviewState(
	doc: Y.Doc,
	threadHasOpenState: (threadId: string) => { exists: boolean; resolved: boolean; quote: string | null },
	onDropped: (threadId: string | undefined, reason: string) => void
): { migrated: number; dropped: number; anchored: number } {
	const arr = doc.getArray<LegacyRound>(LEGACY_REVIEW_ARRAY);
	const rounds = arr.toArray();
	let migrated = 0;
	let dropped = 0;
	for (const round of rounds) {
		const tid = round.feedbackThreadId;
		if (!tid || !threadHasOpenState(tid).exists || threadHasOpenState(tid).resolved) {
			dropped += 1;
			onDropped(tid, 'its thread is gone or dismissed');
			continue;
		}
		let result: ReplaceResult;
		const op = round.operation;
		if (op?.type === 'edit') {
			result = proposeReplacement(doc, tid, op.oldString, op.newString, op.replaceAll === true);
		} else if (op?.type === 'write') {
			result = proposeText(doc, tid, op.content);
		} else if (typeof round.afterMd === 'string') {
			result = proposeText(doc, tid, round.afterMd);
		} else {
			result = { ok: false, reason: 'not-found', hits: 0 };
		}
		if (result.ok) migrated += 1;
		else {
			dropped += 1;
			onDropped(tid, result.reason === 'overlap' ? 'it overlapped another thread' : 'its text no longer matched');
		}
	}
	if (arr.length > 0) arr.delete(0, arr.length);
	// Quote-anchored threads (no marks) get a comment mark on their quote.
	let anchored = 0;
	const marked = new Set(summarizeThreadMarks(doc).map((s) => s.threadId));
	const committed = committedText(doc);
	const seen = new Set<string>();
	const walk = (tid: string) => {
		if (seen.has(tid) || marked.has(tid)) return;
		seen.add(tid);
		const state = threadHasOpenState(tid);
		if (!state.exists || state.resolved || !state.quote) return;
		const idx = committed.indexOf(state.quote);
		if (idx < 0) return;
		if (setCommentMarkByCommittedOffsets(doc, tid, idx, idx + state.quote.length)) anchored += 1;
	};
	doc.getMap(COMMENTS_MAP_NAME).forEach((_v, id) => walk(id));
	return { migrated, dropped, anchored };
}
