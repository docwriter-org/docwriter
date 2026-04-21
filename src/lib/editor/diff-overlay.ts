import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { diffLines, diffWords } from 'diff';
import type { Annotation } from '$lib/types';
import { buildReviewDiffPreview, normalizeReviewText } from '$lib/review-diff';

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
}

const diffKey = new PluginKey<DiffState>('diffOverlay');
	const INITIAL_STATE: DiffState = {
	baseline: null,
	proposedText: null,
	annotations: [],
	activeFeedbackRange: null,
	isPlainText: false,
	allRoundsTiny: false
};

export function setDiffState(editor: Editor, state: DiffState) {
	editor.view.dispatch(editor.state.tr.setMeta(diffKey, state));
}

export const DiffOverlay = Extension.create({
	name: 'diffOverlay',

	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: diffKey,
				state: {
					init: () => ({ ...INITIAL_STATE }),
					apply: (tr, prev) => {
						const next = tr.getMeta(diffKey);
						return next !== undefined ? next : prev;
					}
				},
				props: {
					decorations(state) {
						const {
							baseline,
							proposedText,
							annotations = [],
							activeFeedbackRange,
							isPlainText,
							allRoundsTiny
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

						// Build a flat map from plain-text-character-index → PM position
						// so we can translate plain-text offsets into PM ranges.
						const charPositions: number[] = [];
						let plainText = '';
						state.doc.descendants((node, pos) => {
							if (node.isText) {
								const text = node.text || '';
								for (let i = 0; i < text.length; i++) {
									charPositions.push(pos + i);
									plainText += text[i];
								}
							}
							return true;
						});

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
								const parts = diffWords(baselinePlain, targetPlain);

								if (proposedText !== null && proposedText !== undefined && isPlainText) {
									const paragraphs = paragraphRanges(state.doc);
									const lineParts = diffLines(normalizeReviewText(baseline), normalizeReviewText(proposedText));
									let baselineLineIdx = 0;
									for (const part of lineParts) {
										const lines = splitLogicalLines(part.value);
										if (part.added) {
											const widgetPos = resolveParagraphWidgetPos(state.doc.content.size, paragraphs, baselineLineIdx);
											for (const line of lines) {
												decorations.push(
													Decoration.widget(
														widgetPos,
														() => {
															const block = document.createElement('div');
															block.className = allRoundsTiny
																? 'diff-added-line diff-added-line-tiny'
																: 'diff-added-line';
															block.textContent = line || ' ';
															block.setAttribute('contenteditable', 'false');
															return block;
														},
														{ side: -1 }
													)
												);
											}
											continue;
										}
										if (part.removed) {
											for (const _line of lines) {
												const paragraph = paragraphs[baselineLineIdx];
												if (paragraph) {
													decorations.push(
														Decoration.node(paragraph.pos, paragraph.pos + paragraph.nodeSize, {
															class: 'diff-removed-line'
														})
													);
												}
												baselineLineIdx += 1;
											}
											continue;
										}
										baselineLineIdx += lines.length;
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
														{ side: -1 }
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
														{ side: -1 }
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
