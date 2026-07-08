import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { diffLines, diffWords } from 'diff';
import { normalizeReviewText } from '$lib/review-diff';
import type { MaterializedPendingReviewRound } from '$lib/review-rounds';
import { wordDiff, type DiffPart as WordDiffPart } from '$lib/diff';
import type { Node as PMNode } from '@tiptap/pm/model';
import { buildCharIndex, paragraphPlainText } from './char-index';
import { applyProposedLinkAttrs } from './media-overlay';

/** Memoize per-round `diffLines` calls by their string inputs. The diff
 * inputs (a round's before/after text) only change when the review state
 * changes, not when the user types — but `decorations(state)` runs on every
 * keystroke. Without memoization the diff library re-tokenizes on every key
 * press, which dominates the typing-lag profile. WeakMap is unfit (string
 * keys); a tiny LRU on string-pair identity is enough. */
type DiffPart = ReturnType<typeof diffWords>;
const diffLinesCache = new Map<string, DiffPart>();
const DIFF_CACHE_MAX = 8;
function cachedDiff(
	cache: Map<string, DiffPart>,
	a: string,
	b: string,
	fn: (a: string, b: string) => DiffPart
): DiffPart {
	// Length-prefix to disambiguate `a$b` from a possible `a$$b` collision.
	const key = `${a.length}|${a}\x00${b}`;
	const hit = cache.get(key);
	if (hit) {
		// LRU touch — reinsert to mark recently used.
		cache.delete(key);
		cache.set(key, hit);
		return hit;
	}
	const out = fn(a, b);
	cache.set(key, out);
	if (cache.size > DIFF_CACHE_MAX) {
		// Evict the oldest entry (Map iteration order is insertion order).
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	return out;
}

/** Memoized per-paragraph word diff. Keyed on the (before, after) string
 * pair, same LRU discipline as `cachedDiff`. A modified paragraph's
 * inputs only change when the user types into THAT paragraph (the
 * before-line is fixed for the round, the after-text is the live
 * paragraph), so typing elsewhere reuses the cached result. The cap is a
 * little larger because a single round can touch several paragraphs. */
const wordDiffCache = new Map<string, WordDiffPart[]>();
const WORD_DIFF_CACHE_MAX = 32;
function cachedWordDiff(before: string, after: string): WordDiffPart[] {
	const key = `${before.length}|${before}\x00${after}`;
	const hit = wordDiffCache.get(key);
	if (hit) {
		wordDiffCache.delete(key);
		wordDiffCache.set(key, hit);
		return hit;
	}
	const out = wordDiff(before, after);
	wordDiffCache.set(key, out);
	if (wordDiffCache.size > WORD_DIFF_CACHE_MAX) {
		const oldest = wordDiffCache.keys().next().value;
		if (oldest !== undefined) wordDiffCache.delete(oldest);
	}
	return out;
}

/**
 * Renders decorations over the editor while a review is pending:
 *
 *   - Agent additions (present in editor, absent from baseline) → inline
 *     class decoration on the existing text nodes, coloring them green.
 *   - Agent removals (present in baseline, absent from editor) → ghost
 *     widget with strikethrough inserted at the position the text used to
 *     occupy.
 * In the Yjs-backed model the editor *always* shows the live Y.Doc state
 * (there is no separate "agent" display mode), and the baseline is a string
 * captured by +page.svelte at render_start. The diff overlay compares the
 * editor's current plain text against that baseline; concurrent user edits
 * merged into the doc via the CRDT are also reflected in the overlay.
 */

export interface DiffState {
	baseline: string | null;
	proposedText?: string | null;
	activeFeedbackRange?: { from: number; to: number } | null;
	/** True when every pending round is classified as `tiny`. Drives a
	 * softer ghost-text style for inline additions so a single typo fix
	 * doesn't look like a paragraph rewrite. */
	allRoundsTiny?: boolean;
	/** Round ids whose proposed (green) lines are currently revealed. Default
	 * hides them so the doc length stays neutral while typing elsewhere; a
	 * suggestion is revealed by focusing its gutter card or pinning it with
	 * the card's "keep diff visible" switch. Empty = nothing revealed. */
	revealedRoundIds?: Set<string>;
	/** roundId → 1-based number, shown as a badge on the round's in-doc diff
	 * when its feedback thread card is open (so each in-doc change maps to a
	 * numbered row in the card). Empty when no thread is focused. */
	roundNumbers?: Map<string, number>;
	/** roundId whose in-doc diff should pulse — set while the user hovers
	 * that edit's row in a thread card. Null when nothing is hovered. */
	flashRoundId?: string | null;
	/** Same pending rounds as the sidebar cards — each inline diff hunk is
	 * rendered from one round and carries that round's id on its pill. */
	pendingRounds?: MaterializedPendingReviewRound[];
}

const diffKey = new PluginKey<DiffState>('diffOverlay');
	const INITIAL_STATE: DiffState = {
	baseline: null,
	proposedText: null,
	activeFeedbackRange: null,
	allRoundsTiny: false,
	revealedRoundIds: new Set<string>(),
	roundNumbers: new Map<string, number>(),
	flashRoundId: null,
	pendingRounds: []
};

export function setDiffState(editor: Editor, state: DiffState) {
	editor.view.dispatch(editor.state.tr.setMeta(diffKey, state));
}

/** Map line indices in `currentMd` to the document baseline (rounds[0].beforeMd)
 * so each round's hunks land on the correct live paragraphs. */
function buildLineAlignmentMap(anchorMd: string, currentMd: string): Map<number, number> {
	const map = new Map<number, number>();
	const parts = diffLines(normalizeReviewText(anchorMd), normalizeReviewText(currentMd));
	let anchorIdx = 0;
	let currentIdx = 0;
	for (const part of parts) {
		const lineCount = splitLogicalLines(part.value).length;
		if (part.removed) {
			anchorIdx += lineCount;
		} else if (part.added) {
			for (let i = 0; i < lineCount; i += 1) {
				map.set(currentIdx + i, Math.max(0, anchorIdx - 1));
			}
			currentIdx += lineCount;
		} else {
			for (let i = 0; i < lineCount; i += 1) {
				map.set(currentIdx + i, anchorIdx + i);
			}
			anchorIdx += lineCount;
			currentIdx += lineCount;
		}
	}
	return map;
}

/** Selectors that mark a DOM node as part of the diff overlay — clicks
 * on these should redirect to the nearest real (un-struck, non-widget)
 * paragraph so the user can actually type. */
// NOTE: `.diff-added` is intentionally NOT listed. In the word-level
// modified-paragraph path it decorates *real, editable* doc text, so a
// click on it must place the caret normally rather than being redirected
// around a diff block. `.diff-removed-inline` (the inline removal ghost)
// is likewise omitted so a click near it lands in the host paragraph via
// PM's default handling instead of jumping to a sibling.
const DIFF_NODE_SELECTOR =
	'.diff-added-line, .diff-removed-line';
const DIFF_THREAD_SELECTOR = [
	'.diff-thread-btn[data-thread-id]',
	'.diff-added[data-thread-id]',
	'.diff-added-line[data-thread-id]',
	'.diff-removed[data-thread-id]',
	'.diff-removed-line[data-thread-id]',
	'.diff-insert-caret[data-thread-id]'
].join(',');

function isDiffNode(el: Element | null): boolean {
	return !!el?.matches?.(DIFF_NODE_SELECTOR);
}

/** Walk siblings of `start` in `direction` until reaching a non-diff
 * element (a real paragraph the user can type into). Returns null if we
 * fall off either end without finding one. */
function findRealSibling(
	start: Element,
	direction: 'next' | 'prev'
): HTMLElement | null {
	let cur = direction === 'next' ? start.nextElementSibling : start.previousElementSibling;
	while (cur && isDiffNode(cur)) {
		cur = direction === 'next' ? cur.nextElementSibling : cur.previousElementSibling;
	}
	return cur instanceof HTMLElement ? cur : null;
}

/** Move the caret to `pos` and focus the editor.
 *
 * Tiptap's `editor.commands.focus(pos)` chains the focus + selection
 * change as a single command. That's the only path I've found that
 * survives the focus race with the browser's native mousedown handling
 * on a `contenteditable=false` widget. Raw `view.dispatch` +
 * `view.focus()` keeps losing the selection because the browser fires a
 * post-mousedown selectionchange that PM's domObserver picks up and
 * clobbers the dispatched selection.
 *
 * The handler is wrapped in setTimeout(0) so the focus command runs
 * AFTER the click event has fully unwound, putting our selection in the
 * last word edge-wise. */
function applyCaret(editor: Editor, pos: number): boolean {
	const docSize = editor.state.doc.content.size;
	const clampedPos = Math.max(0, Math.min(pos, docSize));
	setTimeout(() => {
		try {
			editor.commands.focus(clampedPos);
		} catch {
			editor.commands.focus();
		}
	}, 0);
	return true;
}

/** Handle a click on a diff overlay node (green proposal, red
 * strikethrough paragraph, or removal widget). Redirects the caret to
 * the start of the next real paragraph, or the end of the previous one
 * if there is no real paragraph below. The struck-out paragraphs are
 * read-only by intent — the user said they don't want to type into a
 * line that's about to be deleted. The proposed (green) lines are
 * widgets, not real doc content, so we have to manually find a real
 * caret target.
 *
 * We use `view.posAtDOM` to translate the DOM node's start/end into a
 * doc position; this is more reliable than `posAtCoords` over a
 * `contenteditable=false` widget surface, which often returns null. */
function redirectCaretAroundDiff(
	editor: Editor,
	view: EditorView,
	anchor: HTMLElement
): boolean {
	const next = findRealSibling(anchor, 'next');
	if (next) {
		try {
			const pos = view.posAtDOM(next, 0);
			if (typeof pos === 'number' && pos >= 0) {
				return applyCaret(editor, pos);
			}
		} catch {
			/* fall through to prev */
		}
	}
	const prev = findRealSibling(anchor, 'prev');
	if (prev) {
		try {
			const pos = view.posAtDOM(prev, prev.childNodes.length);
			if (typeof pos === 'number' && pos >= 0) {
				return applyCaret(editor, pos);
			}
		} catch {
			/* fall through */
		}
	}
	return false;
}

/** Plugin-level click router. Runs before PM's default mousedown logic.
 *
 * - Click landed on a real paragraph (not part of any diff): return false
 *   so PM places the caret naturally.
 * - Click landed on a diff overlay node (green proposal widget OR
 *   strikethrough paragraph OR removal widget): hijack the click and
 *   redirect the caret around the diff block to the nearest typable
 *   paragraph.
 *
 * Why a plugin handler and not a per-widget DOM listener: Tiptap's
 * Collaboration + y-prosemirror layers can swallow listeners attached
 * to widget DOM nodes when the decoration set rebuilds; the plugin
 * handler always has the live view and runs through PM's standard
 * event pipeline. */
function placeCaretFromClick(
	editor: Editor,
	view: EditorView,
	event: MouseEvent
): boolean {
	const target = event.target as Element | null;
	if (!target) return false;
	const anchor = target.closest(DIFF_NODE_SELECTOR) as HTMLElement | null;
	if (!anchor) return false;
	event.preventDefault();
	if (redirectCaretAroundDiff(editor, view, anchor)) return true;
	const rect = anchor.getBoundingClientRect();
	const probe =
		view.posAtCoords({ left: event.clientX, top: rect.bottom + 1 }) ??
		view.posAtCoords({ left: event.clientX, top: rect.top - 1 });
	if (probe) return applyCaret(editor, probe.pos);
	setTimeout(() => editor.commands.focus(), 0);
	return true;
}

function dispatchOpenThread(view: EditorView, source: HTMLElement, threadId: string): void {
	const rect = source.getBoundingClientRect();
	view.dom.dispatchEvent(
		new CustomEvent('docwriter:open-thread', {
			detail: { threadId, x: rect.right, y: rect.top },
			bubbles: true
		})
	);
}

function openThreadFromDiff(view: EditorView, event: MouseEvent): boolean {
	const target = event.target as Element | null;
	const el = target?.closest(DIFF_THREAD_SELECTOR) as HTMLElement | null;
	const threadId = el?.getAttribute('data-thread-id');
	if (!el || !threadId) return false;
	event.preventDefault();
	event.stopPropagation();
	dispatchOpenThread(view, el, threadId);
	return true;
}

export const DiffOverlay = Extension.create({
	name: 'diffOverlay',

	addProseMirrorPlugins() {
		const editor = this.editor;
		return [
			new Plugin({
				key: diffKey,
				state: {
					init: () => ({ ...INITIAL_STATE }),
					apply: (tr, prev) => {
						const meta = tr.getMeta(diffKey) as Partial<DiffState> | undefined;
						if (meta === undefined) return prev;
						// Merge so partial updates (e.g. toggling expandedBlocks)
						// don't wipe baseline / proposedText / etc.
						return { ...prev, ...meta };
					}
				},
				props: {
					handleDOMEvents: {
						mousedown(view, event) {
							const target = event.target as Element | null;
							if (openThreadFromDiff(view, event)) return true;
							if (!target?.closest(DIFF_NODE_SELECTOR)) return false;
							return placeCaretFromClick(editor, view, event);
						}
					},
					decorations(state) {
						const {
							baseline,
							proposedText,
							activeFeedbackRange,
							allRoundsTiny,
							revealedRoundIds = new Set<string>(),
							roundNumbers = new Map<string, number>(),
							flashRoundId = null,
							pendingRounds = []
						} = diffKey.getState(state) ?? INITIAL_STATE;
						const addedClass = allRoundsTiny ? 'diff-added diff-added-tiny' : 'diff-added';
						const activeFeedbackClass = 'feedback-selection';

						const decorations: Decoration[] = [];
						applyActiveFeedbackDecoration(state, decorations, activeFeedbackRange, activeFeedbackClass);

						// Fast path: nothing to decorate. User regions only act as
						// exclusions from the agent-added pass below; without a
						// baseline there is nothing to compare against.
						if (baseline === null) {
							return DecorationSet.create(state.doc, decorations);
						}

						// Cached char index: same doc reference returns instantly.
						const { plainText } = buildCharIndex(state.doc);

						// ── Agent diff overlay ──────────────────────────────────
						// The live overlay always drives the round-based path below
						// (a string baseline and a materialized proposal), so
						// baseline/proposal are compared in the editor's plain-text
						// space (no markdown stripping).
						if (baseline !== null) {
							const baselinePlain = normalizeReviewText(baseline).replace(/\n/g, '');
							const targetPlain =
								proposedText !== null && proposedText !== undefined
									? normalizeReviewText(proposedText).replace(/\n/g, '')
									: plainText;

							if (baselinePlain !== targetPlain) {
								if (proposedText !== null && proposedText !== undefined) {
									const paragraphs = buildParagraphTextIndex(state.doc);
									// Round text is already in the editor's plain-text space
									// (serializeFragment does no escaping), so match it
									// directly against paragraph text.
									const documentBaseline = baseline;
									interface DiffBlock {
										id: string;
										roundId: string;
										threadId: string | null;
										insertionPos: number;
										removedParagraphIdxs: number[];
										addedLines: string[];
									}
									interface ModifiedPara {
										id: string;
										roundId: string;
										threadId: string | null;
										para: ParagraphTextSpan;
										afterText: string;
										stale: boolean;
										baselineText: string;
									}
									const blocks: DiffBlock[] = [];
									const modified: ModifiedPara[] = [];
									for (const round of pendingRounds) {
										if (round.beforeMd == null || round.afterMd == null) continue;
										const beforeMdU = round.beforeMd;
										const afterMdU = round.afterMd;
										const lineToDoc = buildLineAlignmentMap(
											documentBaseline,
											beforeMdU
										);
										const toDocLine = (roundLine: number) =>
											lineToDoc.get(roundLine) ?? roundLine;
										const lineParts = cachedDiff(
											diffLinesCache,
											normalizeReviewText(beforeMdU),
											normalizeReviewText(afterMdU),
											diffLines
										);
										let roundLineIdx = 0;
										let currentBlock: DiffBlock | null = null;
										function ensureBlock(): DiffBlock {
											if (currentBlock) return currentBlock;
											const docLine = toDocLine(roundLineIdx);
											currentBlock = {
												id: `block:${round.id}:${docLine}`,
												roundId: round.id,
												threadId: round.feedbackThreadId ?? null,
												insertionPos: 0,
												removedParagraphIdxs: [],
												addedLines: []
											};
											return currentBlock;
										}
										function flushBlock() {
											if (!currentBlock) return;
											// When the block REPLACES text (has struck paragraphs),
											// anchor its green proposal right after the last struck
											// paragraph — those are already correctly located, so the
											// green stays next to the red. Only a pure insertion (no
											// struck paragraphs) needs the line-alignment lookup, which
											// can otherwise drift to a similar paragraph elsewhere.
											const removed = currentBlock.removedParagraphIdxs;
											const lastPara =
												removed.length > 0 ? paragraphs[removed[removed.length - 1]] : undefined;
											currentBlock.insertionPos = lastPara
												? lastPara.pos + lastPara.nodeSize
												: resolveParagraphWidgetPos(
														state.doc.content.size,
														paragraphs,
														toDocLine(roundLineIdx)
													);
											blocks.push(currentBlock);
											currentBlock = null;
										}
										for (let i = 0; i < lineParts.length; i++) {
											const part = lineParts[i];
											const next = lineParts[i + 1];
											if (part.removed && next?.added) {
												const removedLines = splitLogicalLines(part.value);
												const addedLines = splitLogicalLines(next.value);
												const canModifyInPlace =
													removedLines.length === addedLines.length &&
													removedLines.every(
														(line, k) => line !== '' && addedLines[k] !== ''
													);
												if (canModifyInPlace) {
													flushBlock();
													for (let j = 0; j < removedLines.length; j++) {
														const roundLine = roundLineIdx + j;
														const docLine = toDocLine(roundLine);
														const para = paragraphs[docLine];
														if (!para) {
															ensureBlock().addedLines.push(addedLines[j]);
															continue;
														}
														const stale = para.text !== removedLines[j];
														modified.push({
															id: `mod:${round.id}:${docLine}`,
															roundId: round.id,
															threadId: round.feedbackThreadId ?? null,
															para,
															afterText: addedLines[j],
															stale,
															baselineText: removedLines[j]
														});
													}
													roundLineIdx += removedLines.length;
													i += 1;
													continue;
												}
											}
											const lines = splitLogicalLines(part.value);
											if (part.added) {
												const block = ensureBlock();
												for (const line of lines) block.addedLines.push(line);
												continue;
											}
											if (part.removed) {
												const block = ensureBlock();
												for (const _line of lines) {
													block.removedParagraphIdxs.push(toDocLine(roundLineIdx));
													roundLineIdx += 1;
												}
												continue;
											}
											flushBlock();
											roundLineIdx += lines.length;
										}
										flushBlock();
									}

									// Number badges (when a feedback thread card is open) +
									// hover flash. One badge per round, on its first hunk.
									// Multiple badges landing on the same line fan out to the
									// left so they don't stack on top of each other.
									const numberedRoundsDone = new Set<string>();
									const badgeStackAtPos = new Map<number, number>();
									const threadButtonsDone = new Set<string>();
									const threadButtonStackAtPos = new Map<number, number>();
									const pushNumberBadge = (roundId: string, pos: number) => {
										const num = roundNumbers.get(roundId);
										if (num == null || numberedRoundsDone.has(roundId)) return;
										numberedRoundsDone.add(roundId);
										const stackIdx = badgeStackAtPos.get(pos) ?? 0;
										badgeStackAtPos.set(pos, stackIdx + 1);
										decorations.push(
											Decoration.widget(
												pos,
												() => {
													const el = document.createElement('span');
													el.className = 'diff-num-badge';
													el.textContent = String(num);
													el.style.setProperty('--badge-i', String(stackIdx));
													el.setAttribute('contenteditable', 'false');
													return el;
												},
												{ side: -1, ignoreSelection: true, key: `numbadge:${roundId}:${num}` }
											)
										);
									};
									const pushThreadButton = (
										roundId: string,
										threadId: string | null,
										pos: number
									) => {
										if (!threadId || threadButtonsDone.has(roundId)) return;
										threadButtonsDone.add(roundId);
										const stackIdx = threadButtonStackAtPos.get(pos) ?? 0;
										threadButtonStackAtPos.set(pos, stackIdx + 1);
										decorations.push(
											Decoration.widget(
												pos,
												(view) => createThreadButton(view, threadId, stackIdx),
												{
													side: -1,
													ignoreSelection: true,
													key: `threadbtn:${roundId}:${threadId}`
												}
											)
										);
									};

									for (const block of blocks) {
										const expanded = revealedRoundIds.has(block.roundId);
										const flashing = block.roundId === flashRoundId;
										// Red strikethrough on the paragraphs slated for
										// removal — always rendered, since they're real
										// document content.
										for (const idx of block.removedParagraphIdxs) {
											const paragraph = paragraphs[idx];
											if (paragraph) {
												decorations.push(
													Decoration.node(
														paragraph.pos,
														paragraph.pos + paragraph.nodeSize,
														{
															class: flashing ? 'diff-removed-line diff-flash' : 'diff-removed-line',
															...(block.threadId ? { 'data-thread-id': block.threadId } : {})
														}
													)
												);
												pushNumberBadge(block.roundId, paragraph.pos + 1);
												pushThreadButton(block.roundId, block.threadId, paragraph.pos + 1);
											}
										}
										if (block.removedParagraphIdxs.length === 0) {
											pushThreadButton(block.roundId, block.threadId, block.insertionPos);
										}
										// Proposed (green) lines: only when expanded.
										if (expanded && block.addedLines.length > 0) {
											const className = allRoundsTiny
												? 'diff-added-line diff-added-line-tiny'
												: 'diff-added-line';
											for (const line of block.addedLines) {
												decorations.push(
													Decoration.widget(
														block.insertionPos,
														(view, getPos) =>
															createAddedLineWidget(view, getPos, line, className, block.threadId),
														{
															side: -1,
															ignoreSelection: true,
															key: `addline:${block.id}:${line}`
														}
													)
												);
											}
										}
									}

									// ── Modified-in-place paragraphs ───────────────
									// Word-level inline diff. The doc holds the BEFORE
									// text, so removed tokens are struck on the real
									// text (always shown, length-neutral) and the
									// proposed (added) tokens are ghost widgets revealed
									// only when the per-paragraph pill is expanded. No
									// whole-paragraph strikethrough.
									for (const m of modified) {
										const expanded = revealedRoundIds.has(m.roundId);
										let changeGroups: number;
										if (m.stale) {
											// User has been typing into this paragraph
											// since `reviewBaseline` was captured —
											// inline strikes against `para.text` would
											// hit the chars they just typed. Count
											// changes from the baseline line instead,
											// and render the proposal as a green ghost
											// block beneath the paragraph on expand.
											changeGroups = countWordDiffGroups(
												m.baselineText,
												m.afterText
											);
											if (changeGroups > 0 && expanded) {
												const className = allRoundsTiny
													? 'diff-added-line diff-added-line-tiny'
													: 'diff-added-line';
												const value = m.afterText;
												decorations.push(
													Decoration.widget(
														m.para.pos + m.para.nodeSize,
														(view, getPos) =>
															createAddedLineWidget(view, getPos, value, className, m.threadId),
														{
															side: 1,
															ignoreSelection: true,
															key: `staleadd:${m.id}`
														}
													)
												);
											}
										} else {
											changeGroups = renderModifiedParagraph(
												decorations,
												m.para,
												m.afterText,
												expanded,
												addedClass,
												m.threadId
											);
										}
										if (changeGroups <= 0) continue;
										// Positioning-only class (no color / strike).
										// Deliberately NOT in DIFF_NODE_SELECTOR — the
										// paragraph stays normal editable text.
										decorations.push(
											Decoration.node(
												m.para.pos,
												m.para.pos + m.para.nodeSize,
												{
													class:
														m.roundId === flashRoundId
															? 'diff-modified-line diff-flash'
															: 'diff-modified-line',
													...(m.threadId ? { 'data-thread-id': m.threadId } : {})
												}
											)
										);
										pushNumberBadge(m.roundId, m.para.pos + 1);
										pushThreadButton(m.roundId, m.threadId, m.para.pos + 1);
									}
								}
							}
						}

						return DecorationSet.create(state.doc, decorations);
					}
				}
			})
		];
	}
});

function applyActiveFeedbackDecoration(
	state: any,
	decorations: Decoration[],
	range: { from: number; to: number } | null | undefined,
	cls: string
) {
	if (!range) return;
	const maxPos = state.doc.content.size;
	const from = Math.max(1, Math.min(range.from, maxPos));
	const to = Math.max(from, Math.min(range.to, maxPos));
	if (to > from) {
		decorations.push(
			Decoration.inline(from, to, {
				class: cls
			})
		);
	}
}

/** Apply an inline class decoration over the editor range corresponding to
 * plain-text indices [start, end). Splits on block boundaries (detected by
 * non-contiguous PM positions) so decorations never span list items. */
function applyInlineClassRange(
	decorations: Decoration[],
	charPositions: number[],
	start: number,
	end: number,
	cls: string,
	attrs?: Record<string, string>
) {
	let i = start;
	const clampedEnd = Math.min(end, charPositions.length);
	while (i < clampedEnd) {
		let j = i;
		while (
			j < clampedEnd - 1 &&
			charPositions[j + 1] === charPositions[j] + 1
		) {
			j++;
		}
		const from = charPositions[i];
		const to = charPositions[j] + 1;
		if (from !== undefined && to > from) {
			decorations.push(Decoration.inline(from, to, { ...attrs, class: cls }));
		}
		i = j + 1;
	}
}

function splitLogicalLines(value: string): string[] {
	const lines = value.split('\n');
	if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	return lines.length > 0 ? lines : [''];
}

/** One top-level paragraph of the live doc, with the slice of the
 * plain-text char index it occupies. `text` is the paragraph's literal
 * content (in plain-text mode this is the raw markdown line). `charStart`
 * / `charEnd` index into the same flat `charPositions` / `plainText` that
 * `buildCharIndex` produces — there are no separators between paragraphs,
 * so paragraph N's chars are `[charStart, charEnd)`. */
interface ParagraphTextSpan {
	pos: number;
	nodeSize: number;
	charStart: number;
	charEnd: number;
	text: string;
	/** PM position for each char in `text` (same order as paragraphPlainText). */
	localCharPositions: number[];
}

/** Map each character of a paragraph to its document position. Kept local
 * to the paragraph so word-level diff decorations never read the global
 * char index (which jumps across block boundaries and can leave only the
 * first character of a token decorated). */
function buildLocalCharPositions(paraNode: PMNode, paraPos: number): number[] {
	const positions: number[] = [];
	paraNode.forEach((child, offset) => {
		const base = paraPos + 1 + offset;
		if (child.isText && child.text) {
			for (let i = 0; i < child.text.length; i += 1) {
				positions.push(base + i);
			}
		} else if (child.type.name === 'hardBreak') {
			positions.push(base);
		}
	});
	return positions;
}

function buildParagraphTextIndex(doc: PMNode): ParagraphTextSpan[] {
	const out: ParagraphTextSpan[] = [];
	let running = 0;
	doc.forEach((node, offset) => {
		const text = paragraphPlainText(node);
		out.push({
			pos: offset,
			nodeSize: node.nodeSize,
			charStart: running,
			charEnd: running + text.length,
			text,
			localCharPositions: buildLocalCharPositions(node, offset)
		});
		running += text.length;
	});
	return out;
}

function resolveParagraphWidgetPos(
	docEnd: number,
	paragraphs: ParagraphTextSpan[],
	lineIdx: number
): number {
	if (lineIdx < paragraphs.length) return paragraphs[lineIdx].pos;
	return docEnd;
}

/** PM position of the first paragraph a pending round changes, so a margin
 * gutter card can be aligned to its in-situ diff. Mirrors the first-changed
 * line walk the decoration pass does for DiffBlocks: it locates the first
 * added/removed line in the round and maps it (via the baseline alignment)
 * to the live paragraph's document position. Returns null when the round has
 * no materialized text. */
export function resolveRoundAnchorPos(
	editor: Editor,
	round: MaterializedPendingReviewRound,
	baseline: string
): number | null {
	if (round.beforeMd == null || round.afterMd == null) return null;
	const doc = editor.state.doc;
	const paragraphs = buildParagraphTextIndex(doc);
	// Round text is already in the editor's plain-text space (serializeFragment
	// does no escaping), so align it directly against paragraph text.
	const beforeMdU = round.beforeMd;
	const lineToDoc = buildLineAlignmentMap(baseline, beforeMdU);
	const toDocLine = (roundLine: number) => lineToDoc.get(roundLine) ?? roundLine;
	const lineParts = cachedDiff(
		diffLinesCache,
		normalizeReviewText(beforeMdU),
		normalizeReviewText(round.afterMd),
		diffLines
	);
	let beforeLineIdx = 0;
	for (const part of lineParts) {
		if (part.added || part.removed) {
			return resolveParagraphWidgetPos(doc.content.size, paragraphs, toDocLine(beforeLineIdx));
		}
		beforeLineIdx += splitLogicalLines(part.value).length;
	}
	return null;
}

/** PM position for a proposed-token ghost inside a modified paragraph. */
function ghostPosLocal(para: ParagraphTextSpan, cursor: number): number {
	const local = para.localCharPositions;
	if (cursor < local.length) return local[cursor];
	return para.pos + para.nodeSize - 1;
}

/** Count the number of distinct change groups (maximal runs of
 * non-`same` parts) in a word diff. Used by the stale-modified path,
 * which needs the pill's count but skips the inline decorations. */
function countWordDiffGroups(before: string, after: string): number {
	let groups = 0;
	let inChange = false;
	for (const p of cachedWordDiff(before, after)) {
		if (p.type === 'same') {
			inChange = false;
			continue;
		}
		if (!inChange) {
			groups += 1;
			inChange = true;
		}
	}
	return groups;
}

/** Render one paragraph that was modified in place as a word-level
 * inline diff.
 *
 * While a review is pending the editor doc still holds the BEFORE text
 * (the agent only pushes a review round; the proposed text isn't applied
 * to the Y.Doc until Accept). So `para.text` is the original line and
 * `afterText` is the proposed replacement. Per word-diff token:
 *   - removed (in the doc, not in the proposal) → inline strikethrough
 *     on the real text. Always shown — it's existing content, so the
 *     decoration is length-neutral, and it gives the reviewer the
 *     "what's going away" signal at a glance.
 *   - added (in the proposal, not in the doc) → green ghost span, shown
 *     only when `expanded`, so the collapsed view stays length-neutral
 *     and uncluttered until the reader opens the pill.
 *   - same → no decoration.
 *
 * Returns the number of distinct change groups (drives the pill count).
 */
function renderModifiedParagraph(
	decorations: Decoration[],
	para: ParagraphTextSpan,
	afterText: string,
	expanded: boolean,
	addedClass: string,
	threadId?: string | null
): number {
	const parts = cachedWordDiff(para.text, afterText);
	const charPositions = para.localCharPositions;
	const threadAttrs = threadId ? { 'data-thread-id': threadId } : undefined;

	// Threshold fallback: when most of the paragraph is being rewritten,
	// the per-token diff turns into a confetti of small strikes around
	// short common substrings (real overlap, but visually noisy). At
	// that point "rewrote this paragraph" reads better than a dozen
	// interleaved word swaps. Render the whole BEFORE as one strike +
	// the whole AFTER as one ghost.
	let removedChars = 0;
	let addedChars = 0;
	let groupCount = 0;
	{
		let inGroup = false;
		for (const p of parts) {
			if (p.type === 'same') { inGroup = false; continue; }
			if (!inGroup) { groupCount += 1; inGroup = true; }
			if (p.type === 'removed') removedChars += p.text.length;
			else addedChars += p.text.length;
		}
	}
	const denom = Math.max(1, para.text.length + afterText.length);
	const churnRatio = (removedChars + addedChars) / denom;
	if (churnRatio > 0.8 || groupCount > 6) {
		applyInlineClassRange(decorations, charPositions, 0, para.text.length, 'diff-removed', threadAttrs);
		if (expanded && afterText.length > 0) {
			const widgetPos = ghostPosLocal(para, para.text.length);
			decorations.push(
				Decoration.widget(
					widgetPos,
					() => {
						const span = document.createElement('span');
						span.className = addedClass;
						span.textContent = afterText;
						span.setAttribute('contenteditable', 'false');
						if (threadId) span.setAttribute('data-thread-id', threadId);
						applyProposedLinkAttrs(span, afterText);
						return span;
					},
					{ side: -1, ignoreSelection: true, key: `modadd-block:${para.pos}` }
				)
			);
		}
		return 1;
	}

	let cursor = 0;
	let changeGroups = 0;
	let inChange = false;
	for (const p of parts) {
		if (p.type === 'same') {
			inChange = false;
			cursor += p.text.length;
			continue;
		}
		if (!inChange) {
			changeGroups += 1;
			inChange = true;
		}
		if (p.type === 'removed') {
			// Real text in the doc — strike just these tokens (not the
			// whole paragraph). Length-neutral, so it's always rendered.
			applyInlineClassRange(
				decorations,
				charPositions,
				cursor,
				cursor + p.text.length,
				'diff-removed',
				threadAttrs
			);
			cursor += p.text.length;
		} else if (expanded) {
			// Proposed text is NOT in the doc; show it as a green ghost
			// at the position it would occupy. contenteditable=false and
			// its class is intentionally absent from DIFF_NODE_SELECTOR
			// so a click near it lands in this paragraph normally instead
			// of being redirected.
			const widgetPos = ghostPosLocal(para, cursor);
			const value = p.text;
			decorations.push(
				Decoration.widget(
					widgetPos,
					() => {
						const span = document.createElement('span');
						span.className = addedClass;
						span.textContent = value;
						span.setAttribute('contenteditable', 'false');
						if (threadId) span.setAttribute('data-thread-id', threadId);
						applyProposedLinkAttrs(span, value);
						return span;
					},
					{
						side: -1,
						ignoreSelection: true,
						key: `modadd:${para.pos}:${cursor}:${value}`
					}
				)
			);
			// Do NOT advance `cursor`: proposed text occupies no space in
			// the BEFORE paragraph that's currently in the doc.
		} else {
			// Collapsed (card not open) AND this group only ADDS text — so
			// there's nothing struck out to mark the change and the green
			// ghost is hidden until the card opens. Drop a small insertion
			// caret where the proposed text will land, so a purely additive
			// edit still reads as "more coming here" in the document.
			const caretPos = ghostPosLocal(para, cursor);
			decorations.push(
				Decoration.widget(
					caretPos,
					() => {
						const el = document.createElement('span');
						el.className = 'diff-insert-caret';
						el.setAttribute('contenteditable', 'false');
						el.setAttribute('aria-hidden', 'true');
						if (threadId) el.setAttribute('data-thread-id', threadId);
						return el;
					},
					{ side: -1, ignoreSelection: true, key: `inscaret:${para.pos}:${cursor}` }
				)
			);
			// Do NOT advance `cursor` (proposed text isn't in the doc yet).
		}
	}
	return changeGroups;
}

function createAddedLineWidget(
	_view: EditorView,
	_getPos: () => number | undefined,
	line: string,
	className: string,
	threadId?: string | null
): HTMLElement {
	const block = document.createElement('div');
	block.className = className;
	block.textContent = line || ' ';
	applyProposedLinkAttrs(block, line);
	// `contenteditable=false` keeps PM from treating the widget DOM as
	// document content. Click handling lives in the plugin's
	// `handleDOMEvents.mousedown` so we don't need a per-widget listener
	// (and so the closure stays out of the way of HMR / view re-mounts).
	block.setAttribute('contenteditable', 'false');
	if (threadId) block.setAttribute('data-thread-id', threadId);
	return block;
}

function createThreadButton(view: EditorView, threadId: string, stackIdx: number): HTMLElement {
	const button = document.createElement('button');
	button.className = 'diff-thread-btn';
	button.type = 'button';
	button.title = 'Open comment thread';
	button.setAttribute('aria-label', 'Open comment thread');
	button.setAttribute('contenteditable', 'false');
	button.setAttribute('data-thread-id', threadId);
	button.style.setProperty('--thread-i', String(stackIdx));
	button.innerHTML = `
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
		</svg>
	`;
	button.addEventListener('mousedown', (event) => {
		event.preventDefault();
		event.stopPropagation();
		dispatchOpenThread(view, button, threadId);
	});
	button.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
	});
	return button;
}

