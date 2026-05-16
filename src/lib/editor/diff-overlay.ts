import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { diffLines, diffWords } from 'diff';
import type { Annotation } from '$lib/types';
import { buildReviewDiffPreview, normalizeReviewText } from '$lib/review-diff';
import { buildCharIndex } from './char-index';

/** Memoize diffWords / diffLines by their string inputs. The diff inputs
 * (baseline + proposedText) only change when the review state changes,
 * not when the user types — but `decorations(state)` runs on every
 * keystroke. Without memoization the diff library re-tokenizes a multi-KB
 * doc on every key press, which dominates the typing-lag profile. WeakMap
 * is unfit (string keys); a tiny LRU on string-pair identity is enough. */
type DiffPart = ReturnType<typeof diffWords>;
const diffWordsCache = new Map<string, DiffPart>();
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
	annotations?: Annotation[];
	activeFeedbackRange?: { from: number; to: number } | null;
	isPlainText?: boolean;
	/** True when every pending round is classified as `tiny`. Drives a
	 * softer ghost-text style for inline additions so a single typo fix
	 * doesn't look like a paragraph rewrite. */
	allRoundsTiny?: boolean;
	/** Block ids whose proposed (green) lines are currently expanded.
	 * Default state hides the proposed lines so the doc length stays
	 * neutral while the user is typing elsewhere; the user clicks the
	 * "Show suggestion" pill at the end of each strikethrough block to
	 * reveal the proposed replacement. */
	expandedBlocks?: Set<string>;
}

const diffKey = new PluginKey<DiffState>('diffOverlay');
	const INITIAL_STATE: DiffState = {
	baseline: null,
	proposedText: null,
	annotations: [],
	activeFeedbackRange: null,
	isPlainText: false,
	allRoundsTiny: false,
	expandedBlocks: new Set<string>()
};

export function setDiffState(editor: Editor, state: DiffState) {
	editor.view.dispatch(editor.state.tr.setMeta(diffKey, state));
}

/** Toggle whether a single diff block's proposed lines are visible.
 * Block ids are derived from the block's baseline line index (see the
 * decoration loop below); they're stable as long as the diff structure
 * is unchanged, and reset implicitly when a fresh diff arrives. */
function toggleDiffBlock(view: EditorView, blockId: string) {
	const current = diffKey.getState(view.state);
	if (!current) return;
	const next = new Set(current.expandedBlocks ?? []);
	if (next.has(blockId)) next.delete(blockId);
	else next.add(blockId);
	view.dispatch(
		view.state.tr.setMeta(diffKey, { expandedBlocks: next })
	);
}

/** Selectors that mark a DOM node as part of the diff overlay — clicks
 * on these should redirect to the nearest real (un-struck, non-widget)
 * paragraph so the user can actually type. */
const DIFF_NODE_SELECTOR =
	'.diff-added-line, .diff-removed-line, .diff-added, .diff-removed-widget';

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
							if (!target?.closest(DIFF_NODE_SELECTOR)) return false;
							return placeCaretFromClick(editor, view, event);
						}
					},
					decorations(state) {
						const {
							baseline,
							proposedText,
							annotations = [],
							activeFeedbackRange,
							isPlainText,
							allRoundsTiny,
							expandedBlocks = new Set<string>()
						} = diffKey.getState(state) ?? INITIAL_STATE;
						const addedClass = allRoundsTiny ? 'diff-added diff-added-tiny' : 'diff-added';
						const removedWidgetClass = allRoundsTiny
							? 'diff-removed-widget diff-removed-tiny'
							: 'diff-removed-widget';
						const removedInlineClass = 'diff-removed';
						const annotationClass = 'feedback-annotation';
						const activeFeedbackClass = 'feedback-selection';

						const decorations: Decoration[] = [];
						applyAnnotationDecorations(state, decorations, annotations, annotationClass);
						applyActiveFeedbackDecoration(state, decorations, activeFeedbackRange, activeFeedbackClass);

						// Fast path: nothing to decorate. User regions only act as
						// exclusions from the agent-added pass below; without a
						// baseline there is nothing to compare against.
						if (baseline === null) {
							return DecorationSet.create(state.doc, decorations);
						}

						// Cached char index: same doc reference returns instantly.
						const { charPositions, plainText } = buildCharIndex(state.doc);

						// ── Agent diff overlay ──────────────────────────────────
						if (baseline !== null) {
							const baselinePlain = isPlainText
								? normalizeReviewText(baseline).replace(/\n/g, '')
								: markdownToPlain(baseline);
							const targetPlain =
								proposedText !== null && proposedText !== undefined
									? isPlainText
										? normalizeReviewText(proposedText).replace(/\n/g, '')
										: markdownToPlain(proposedText)
									: plainText;

							if (baselinePlain !== targetPlain) {
								const parts = cachedDiff(diffWordsCache, baselinePlain, targetPlain, diffWords);

								if (proposedText !== null && proposedText !== undefined && isPlainText) {
									const paragraphs = paragraphRanges(state.doc);
									const lineParts = cachedDiff(
										diffLinesCache,
										normalizeReviewText(baseline),
										normalizeReviewText(proposedText),
										diffLines
									);
									// Group consecutive non-context parts into "blocks".
									// Each block is one strikethrough section + its
									// proposed replacement. Default UX: only the
									// strikethrough renders; a "Show suggestion" pill at
									// the end of the block reveals the green lines on
									// click. This keeps the doc visually length-neutral
									// while the user types elsewhere.
									interface DiffBlock {
										id: string;
										insertionPos: number;
										removedParagraphIdxs: number[];
										addedLines: string[];
									}
									const blocks: DiffBlock[] = [];
									let baselineLineIdx = 0;
									let currentBlock: DiffBlock | null = null;
									function ensureBlock(): DiffBlock {
										if (currentBlock) return currentBlock;
										currentBlock = {
											id: `block:${baselineLineIdx}`,
											insertionPos: 0,
											removedParagraphIdxs: [],
											addedLines: []
										};
										return currentBlock;
									}
									function flushBlock() {
										if (!currentBlock) return;
										currentBlock.insertionPos = resolveParagraphWidgetPos(
											state.doc.content.size,
											paragraphs,
											baselineLineIdx
										);
										blocks.push(currentBlock);
										currentBlock = null;
									}
									for (const part of lineParts) {
										const lines = splitLogicalLines(part.value);
										if (part.added) {
											const block = ensureBlock();
											for (const line of lines) block.addedLines.push(line);
											continue;
										}
										if (part.removed) {
											const block = ensureBlock();
											for (const _line of lines) {
												block.removedParagraphIdxs.push(baselineLineIdx);
												baselineLineIdx += 1;
											}
											continue;
										}
										flushBlock();
										baselineLineIdx += lines.length;
									}
									flushBlock();

									for (const block of blocks) {
										const expanded = expandedBlocks.has(block.id);
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
														{ class: 'diff-removed-line' }
													)
												);
											}
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
															createAddedLineWidget(view, getPos, line, className),
														{
															side: -1,
															ignoreSelection: true,
															key: `addline:${block.id}:${line}`
														}
													)
												);
											}
										}
										// Toggle pill — only when there's a proposed
										// replacement. We anchor it INSIDE the last
										// removed paragraph (at the position right
										// before its close token) so the pill becomes
										// an inline child of that paragraph; CSS then
										// pins it to the right margin without taking
										// any vertical layout space, leaving the
										// surrounding text flow untouched.
										//
										// A pure insertion (no removed lines, just
										// proposed adds) has no host paragraph; for
										// that case we fall back to the block-level
										// `insertionPos` so the pill at least stays
										// visible.
										if (block.addedLines.length > 0) {
											const addedCount = block.addedLines.length;
											const lastRemovedIdx =
												block.removedParagraphIdxs.length > 0
													? block.removedParagraphIdxs[
															block.removedParagraphIdxs.length - 1
													  ]
													: -1;
											const hostParagraph =
												lastRemovedIdx >= 0
													? paragraphs[lastRemovedIdx]
													: null;
											const pillPos = hostParagraph
												? hostParagraph.pos + hostParagraph.nodeSize - 1
												: block.insertionPos;
											const pillSide = hostParagraph ? 1 : -1;
											decorations.push(
												Decoration.widget(
													pillPos,
													(view) =>
														createDiffTogglePill(
															view,
															block.id,
															addedCount,
															expanded,
															hostParagraph !== null
														),
													{
														side: pillSide,
														ignoreSelection: true,
														key: `pill:${block.id}:${expanded}`
													}
												)
											);
										}
									}
								} else if (proposedText !== null && proposedText !== undefined) {
									let baselineIdx = 0;
									for (const part of parts) {
										if (part.added) {
											const editorPos = resolveWidgetPos(charPositions, baselineIdx);
											if (editorPos >= 0) {
												const value = part.value;
												decorations.push(
													Decoration.widget(
														editorPos,
														() => {
															const span = document.createElement('span');
															span.className = addedClass;
															span.textContent = value;
															span.setAttribute('contenteditable', 'false');
															return span;
														},
														{ side: -1, key: `add:${editorPos}:${value}` }
													)
												);
											}
										} else if (part.removed) {
											applyInlineClassRange(
												decorations,
												charPositions,
												baselineIdx,
												baselineIdx + part.value.length,
												removedInlineClass
											);
											baselineIdx += part.value.length;
										} else {
											baselineIdx += part.value.length;
										}
									}
								} else {
									let editorIdx = 0;
									for (const part of parts) {
										if (part.added) {
											applyInlineClassRange(
												decorations,
												charPositions,
												editorIdx,
												editorIdx + part.value.length,
												addedClass
											);
											editorIdx += part.value.length;
										} else if (part.removed) {
											const editorPos = resolveWidgetPos(charPositions, editorIdx);
											if (editorPos >= 0) {
												const value = part.value;
												decorations.push(
													Decoration.widget(
														editorPos,
														() => {
															const span = document.createElement('span');
															span.className = removedWidgetClass;
															span.textContent = value;
															span.setAttribute('contenteditable', 'false');
															return span;
														},
														{ side: -1, key: `rem:${editorPos}:${value}` }
													)
												);
											}
										} else {
											editorIdx += part.value.length;
										}
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

function applyAnnotationDecorations(
	state: any,
	decorations: Decoration[],
	annotations: Annotation[],
	cls: string
) {
	if (!annotations.length) return;
	const maxPos = state.doc.content.size;
	for (const annotation of annotations) {
		const from = Math.max(1, Math.min(annotation.from, maxPos));
		const to = Math.max(from, Math.min(annotation.to, maxPos));
		if (to > from) {
			decorations.push(
				Decoration.inline(from, to, {
					class: cls,
					'data-feedback-comment': annotation.comment
				})
			);
		}
	}
}

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
	cls: string
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
			decorations.push(Decoration.inline(from, to, { class: cls }));
		}
		i = j + 1;
	}
}

/** Return a PM position for a removal widget at the given editor index. */
function resolveWidgetPos(charPositions: number[], idx: number): number {
	if (idx < charPositions.length) return charPositions[idx];
	return (charPositions[charPositions.length - 1] ?? 0) + 1;
}

function splitLogicalLines(value: string): string[] {
	const lines = value.split('\n');
	if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	return lines.length > 0 ? lines : [''];
}

function paragraphRanges(doc: any): Array<{ pos: number; nodeSize: number }> {
	const ranges: Array<{ pos: number; nodeSize: number }> = [];
	doc.forEach((node: any, offset: number) => {
		ranges.push({ pos: offset, nodeSize: node.nodeSize });
	});
	return ranges;
}

function resolveParagraphWidgetPos(
	docEnd: number,
	paragraphs: Array<{ pos: number; nodeSize: number }>,
	lineIdx: number
): number {
	if (lineIdx < paragraphs.length) return paragraphs[lineIdx].pos;
	return docEnd;
}

function createAddedLineWidget(
	_view: EditorView,
	_getPos: () => number | undefined,
	line: string,
	className: string
): HTMLElement {
	const block = document.createElement('div');
	block.className = className;
	block.textContent = line || ' ';
	// `contenteditable=false` keeps PM from treating the widget DOM as
	// document content. Click handling lives in the plugin's
	// `handleDOMEvents.mousedown` so we don't need a per-widget listener
	// (and so the closure stays out of the way of HMR / view re-mounts).
	block.setAttribute('contenteditable', 'false');
	return block;
}

/** Render the inline "Show suggestion (+N lines)" / "Hide suggestion"
 * pill that toggles a diff block's proposed lines. We attach our own
 * `mousedown` listener that calls `toggleDiffBlock` and stops further
 * propagation so the plugin's general "click on diff" handler doesn't
 * also try to redirect the caret. */
function createDiffTogglePill(
	view: EditorView,
	blockId: string,
	addedCount: number,
	expanded: boolean,
	inline: boolean
): HTMLElement {
	const wrapper = document.createElement(inline ? 'span' : 'div');
	wrapper.className = inline
		? 'diff-toggle-pill-wrap inline'
		: 'diff-toggle-pill-wrap block';
	wrapper.setAttribute('contenteditable', 'false');

	const toggleBtn = document.createElement('button');
	toggleBtn.type = 'button';
	toggleBtn.className = expanded ? 'diff-toggle-pill expanded' : 'diff-toggle-pill';
	toggleBtn.textContent = expanded ? 'Hide' : `Show (+${addedCount})`;
	toggleBtn.title = expanded
		? 'Hide proposed replacement'
		: `Show proposed replacement (+${addedCount} line${addedCount === 1 ? '' : 's'})`;
	toggleBtn.addEventListener('mousedown', (e) => {
		e.preventDefault();
		e.stopPropagation();
		toggleDiffBlock(view, blockId);
	});
	toggleBtn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
	});
	wrapper.appendChild(toggleBtn);

	// Inline Accept pill: lets the user accept the change without
	// leaving their editing flow. The actual mutation lives in
	// `+page.svelte`'s `acceptAgentEdit` (gated by Y.Doc transaction +
	// review-state cleanup), so we just dispatch a bubbling custom event
	// that the editor host listens for and forwards to the parent.
	const acceptBtn = document.createElement('button');
	acceptBtn.type = 'button';
	acceptBtn.className = 'diff-accept-pill';
	acceptBtn.title = 'Accept this proposed change';
	acceptBtn.setAttribute('aria-label', 'Accept this proposed change');
	acceptBtn.innerHTML = `
		<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<polyline points="20 6 9 17 4 12"></polyline>
		</svg>
	`;
	acceptBtn.addEventListener('mousedown', (e) => {
		e.preventDefault();
		e.stopPropagation();
		wrapper.dispatchEvent(
			new CustomEvent('docwriter:accept-pending-edit', { bubbles: true })
		);
	});
	acceptBtn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
	});
	wrapper.appendChild(acceptBtn);

	return wrapper;
}

/** Strip markdown syntax to plain text, matching node.textContent semantics. */
function markdownToPlain(md: string): string {
	return normalizeReviewText(
		md
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/^[-*+]\s+/gm, '')
		.replace(/^\d+\.\s+/gm, '')
		.replace(/^>\s*/gm, '')
		.replace(/\*\*(.+?)\*\*/g, '$1')
		.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
		.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '$1')
		.replace(/`(.+?)`/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/\n+/g, '')
	);
}
