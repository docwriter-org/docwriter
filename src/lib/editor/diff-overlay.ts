import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { diffWords } from 'diff';
import type { UserEditRegion } from '$lib/stores';

/**
 * Renders decorations over the editor while a review is pending:
 *
 *   - Agent additions (present in editor, absent from baseline) → inline
 *     class decoration on the existing text nodes, coloring them green.
 *   - Agent removals (present in baseline, absent from editor) → ghost
 *     widget with strikethrough inserted at the position the text used to
 *     occupy.
 *   - User edit regions → orange highlight on the user's recent ranges.
 *
 * In the Yjs-backed model the editor *always* shows the live Y.Doc state
 * (there is no separate "agent" display mode), and the baseline is a string
 * captured by +page.svelte at render_start. The diff overlay compares the
 * editor's current plain text against that baseline; concurrent user edits
 * merged into the doc via the CRDT are also reflected in the overlay.
 */

export interface DiffState {
	baseline: string | null;
	userEditRegions: UserEditRegion[];
	/** PM positions for an active text selection we should visually
	 * highlight with a magic-style swipe (used while the feedback popup is
	 * open). Null when no selection is active. */
	feedbackSelection?: { from: number; to: number } | null;
	/** True when every pending round is classified as `tiny`. Drives a
	 * softer ghost-text style for inline additions so a single typo fix
	 * doesn't look like a paragraph rewrite. */
	allRoundsTiny?: boolean;
}

const diffKey = new PluginKey<DecorationSet>('diffOverlay');
let currentState: DiffState = {
	baseline: null,
	userEditRegions: [],
	feedbackSelection: null,
	allRoundsTiny: false
};

export function setDiffState(state: DiffState) {
	currentState = state;
}

export const DiffOverlay = Extension.create({
	name: 'diffOverlay',

	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: diffKey,
				props: {
					decorations(state) {
						const { baseline, userEditRegions, feedbackSelection, allRoundsTiny } = currentState;
						const addedClass = allRoundsTiny ? 'diff-added diff-added-tiny' : 'diff-added';
						const removedClass = allRoundsTiny
							? 'diff-removed-widget diff-removed-tiny'
							: 'diff-removed-widget';

						// Fast path: nothing to decorate. User regions no longer
						// paint anything (they just exclude ranges from the
						// agent-added pass below), so we only need a baseline
						// OR a feedback selection to have work to do.
						if (baseline === null && !feedbackSelection) {
							return DecorationSet.empty;
						}

						const decorations: Decoration[] = [];

						// Note: we used to paint feedback-selected text with a PM
						// inline decoration here, but rough-notation inserts its
						// SVG as a sibling of the annotated element, and PM's
						// DOM observer wipes it on the next state change.
						// Feedback selection is now drawn via an overlay OUTSIDE
						// the editor DOM — see refreshFeedbackOverlay in
						// TiptapEditor.svelte. `feedbackSelection` is kept in
						// DiffState for future use but no decoration here.
						void feedbackSelection;

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

						// `userEditRegions` is kept purely for the subtraction pass
						// below (so user keystrokes don't get painted agent-green).
						// The visual orange decoration this plugin used to draw
						// was removed — it was a leftover from an earlier "show
						// user edits inline" feature that didn't pull its weight.

						// ── Agent diff: editor (current) vs baseline ─────────────
						if (baseline !== null) {
							const baselinePlain = markdownToPlain(baseline);

							if (baselinePlain !== plainText) {
								const parts = diffWords(baselinePlain, plainText);
								let editorIdx = 0;

								/** Exclude ranges that the user typed (tracked via
								 * `userEditRegions`) — those already get the orange
								 * treatment and should NOT be painted green. Without
								 * this, user keystrokes during a pending review look
								 * like agent additions. */
								const isUserRange = (a: number, b: number) =>
									userEditRegions.some((r) => a < r.to && b > r.from);

								for (const part of parts) {
									if (part.added) {
										// Text is in the editor but not in baseline → agent
										// addition. Skip user-typed ranges so the user's own
										// keystrokes don't show up as agent green.
										if (!isUserRange(editorIdx, editorIdx + part.value.length)) {
											applyInlineClassRange(
												decorations,
												charPositions,
												editorIdx,
												editorIdx + part.value.length,
												addedClass
											);
										}
										editorIdx += part.value.length;
									} else if (part.removed) {
										// Text is in baseline but not in editor → agent
										// removed it. Not present in the doc tree; render as
										// a ghost widget with strikethrough.
										const editorPos = resolveWidgetPos(charPositions, editorIdx);
										if (editorPos >= 0) {
											const value = part.value;
											decorations.push(
												Decoration.widget(
													editorPos,
													() => {
														const span = document.createElement('span');
														span.className = removedClass;
														span.textContent = value;
														span.setAttribute('contenteditable', 'false');
														return span;
													},
													{ side: -1 }
												)
											);
										}
										// Don't advance editorIdx — removed text isn't in editor.
									} else {
										// same — advance editor cursor
										editorIdx += part.value.length;
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

/** Strip markdown syntax to plain text, matching node.textContent semantics. */
function markdownToPlain(md: string): string {
	return md
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/^[-*+]\s+/gm, '')
		.replace(/^\d+\.\s+/gm, '')
		.replace(/^>\s*/gm, '')
		.replace(/\*\*(.+?)\*\*/g, '$1')
		.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
		.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '$1')
		.replace(/`(.+?)`/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/\n+/g, '');
}
