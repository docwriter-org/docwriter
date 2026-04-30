import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { CommentThread } from '$lib/types';

/**
 * Comment-thread overlay: per unresolved thread, draws an inline dotted
 * underline over the anchored passage AND a small gutter pill at the end
 * of the passage showing the message count. Clicking either dispatches a
 * custom `docwriter:open-thread` DOM event carrying the thread id — the
 * editor host listens for it and opens the CommentThreadPopover.
 *
 * Anchoring is quote-based: the plugin searches the editor's plain text
 * for each thread's `anchor.quote` and uses the `occurrenceIndex`-th
 * match to decide the decoration range. When the quote no longer appears
 * in the doc, the thread is considered "detached" and no decoration is
 * emitted here — the Outline pane surfaces detached threads separately.
 */

export interface CommentOverlayState {
	threads: CommentThread[];
	openThreadId: string | null;
}

const commentKey = new PluginKey<CommentOverlayState>('commentOverlay');

const INITIAL_STATE: CommentOverlayState = {
	threads: [],
	openThreadId: null
};

export function setCommentOverlayState(editor: Editor, state: CommentOverlayState) {
	editor.view.dispatch(editor.state.tr.setMeta(commentKey, state));
}

/** Map from plain-text character index → PM position, so we can turn a
 * plain-text offset into a valid editor range. Mirrors the helper inside
 * diff-overlay.ts. */
function buildCharIndex(doc: any): { charPositions: number[]; plainText: string } {
	const charPositions: number[] = [];
	let plainText = '';
	doc.descendants((node: any, pos: number) => {
		if (node.isText) {
			const text: string = node.text || '';
			for (let i = 0; i < text.length; i++) {
				charPositions.push(pos + i);
				plainText += text[i];
			}
		}
		return true;
	});
	return { charPositions, plainText };
}

/** Locate the Nth occurrence of `needle` in `haystack`. Returns -1 when
 * fewer than N+1 matches exist. */
function nthIndexOf(haystack: string, needle: string, occurrenceIndex: number): number {
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

export const CommentOverlay = Extension.create({
	name: 'commentOverlay',

	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: commentKey,
				state: {
					init: () => ({ ...INITIAL_STATE }),
					apply: (tr, prev) => {
						const next = tr.getMeta(commentKey);
						return next !== undefined ? next : prev;
					}
				},
				props: {
					decorations(state) {
						const pluginState = commentKey.getState(state) ?? INITIAL_STATE;
						const { threads, openThreadId } = pluginState;
						const active = threads.filter((t) => !t.resolved);
						if (active.length === 0) return DecorationSet.create(state.doc, []);
						const { charPositions, plainText } = buildCharIndex(state.doc);
						const decorations: Decoration[] = [];

						for (const thread of active) {
							const quote = thread.anchor.quote;
							const idx = nthIndexOf(plainText, quote, thread.anchor.occurrenceIndex);
							// Fall back to the first occurrence if the stored index
							// no longer exists (document shrank). Threads whose quote
							// is fully gone render nothing here — the Outline pane's
							// "Detached threads" group handles them.
							const resolvedIdx = idx >= 0 ? idx : nthIndexOf(plainText, quote, 0);
							if (resolvedIdx < 0) continue;
							const endOffset = resolvedIdx + quote.length - 1;
							if (endOffset >= charPositions.length) continue;
							const from = charPositions[resolvedIdx];
							const to = charPositions[endOffset] + 1;
							if (from === undefined || to === undefined || to <= from) continue;

							const isOpen = openThreadId === thread.id;
							const inlineClass = `comment-thread-highlight${isOpen ? ' comment-thread-open' : ''}`;
							decorations.push(
								Decoration.inline(from, to, {
									class: inlineClass,
									'data-thread-id': thread.id
								})
							);
							const count = thread.messages.length;
							decorations.push(
								Decoration.widget(
									to,
									() => {
										const btn = document.createElement('button');
										btn.className = `comment-thread-pill${isOpen ? ' comment-thread-pill-open' : ''}`;
										btn.setAttribute('data-thread-id', thread.id);
										btn.setAttribute('contenteditable', 'false');
										btn.setAttribute('type', 'button');
										btn.title = count === 1 ? '1 comment' : `${count} comments`;
										btn.innerHTML = `
											<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
												<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
											</svg>
											<span class="comment-thread-pill-count">${count}</span>
										`;
										btn.addEventListener('mousedown', (e) => {
											// Stop the mousedown so ProseMirror doesn't try to
											// place a cursor inside the widget first — that'd
											// create a NodeSelection + steal focus.
											e.preventDefault();
											e.stopPropagation();
										});
										btn.addEventListener('click', (e) => {
											e.preventDefault();
											e.stopPropagation();
											const detail = {
												threadId: thread.id,
												x: btn.getBoundingClientRect().right,
												y: btn.getBoundingClientRect().top
											};
											btn.dispatchEvent(
												new CustomEvent('docwriter:open-thread', {
													detail,
													bubbles: true
												})
											);
										});
										return btn;
									},
									{ side: 1, ignoreSelection: true }
								)
							);
						}
						return DecorationSet.create(state.doc, decorations);
					},
					handleClick(view, pos, event) {
						const target = event.target as HTMLElement | null;
						if (!target) return false;
						// Click on the inline highlight (not the pill — that's handled
						// by the button's own click). Walk up looking for the data
						// attribute the decoration adds.
						const el = target.closest?.('[data-thread-id]') as HTMLElement | null;
						if (!el) return false;
						// The pill already dispatches — don't double-fire.
						if (el.classList.contains('comment-thread-pill')) return false;
						const threadId = el.getAttribute('data-thread-id');
						if (!threadId) return false;
						const rect = el.getBoundingClientRect();
						el.dispatchEvent(
							new CustomEvent('docwriter:open-thread', {
								detail: { threadId, x: rect.right, y: rect.top },
								bubbles: true
							})
						);
						return true;
					}
				}
			})
		];
	}
});

/** Compute detached threads: unresolved threads whose quote can no longer
 * be located in the current plain text. */
export function computeDetachedThreads(
	threads: CommentThread[],
	plainText: string
): CommentThread[] {
	return threads.filter((t) => !t.resolved && plainText.indexOf(t.anchor.quote) === -1);
}

/** Resolve a thread's anchor to PM positions by searching the current
 * editor text for its quote. Returns null when the quote no longer
 * appears (thread is detached). Used by the margin-gutter component to
 * decide where to stack each thread card vertically. */
export function resolveThreadRange(
	editor: Editor,
	thread: CommentThread
): { from: number; to: number } | null {
	const { charPositions, plainText } = buildCharIndex(editor.state.doc);
	const quote = thread.anchor.quote;
	let idx = nthIndexOf(plainText, quote, thread.anchor.occurrenceIndex);
	if (idx < 0) idx = nthIndexOf(plainText, quote, 0);
	if (idx < 0) return null;
	const endOffset = idx + quote.length - 1;
	if (endOffset >= charPositions.length) return null;
	const from = charPositions[idx];
	const to = charPositions[endOffset] + 1;
	if (from === undefined || to === undefined || to <= from) return null;
	return { from, to };
}
