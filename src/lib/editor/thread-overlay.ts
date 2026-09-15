import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
	COMMENT_ATTR,
	DELETION_ATTR,
	INSERTION_ATTR,
	SUGGEST_ATTR,
	SUGGEST_THREAD_ATTR
} from '$lib/shared/proposals';

/**
 * Thread overlay. Proposals and comments are MARKS on the document (see
 * proposals.ts), rendered by CSS on the mark spans; nothing here draws a
 * diff. This plugin adds the transient, per-viewer state on top:
 *
 *   - only the active thread's proposal is shown for review;
 *   - the feedback popup's selection is highlighted (`feedback-selection`);
 *   - each open thread gets a small pill after its last mark showing the
 *     message count; clicking a pill dispatches `docwriter:open-thread`.
 *     Clicking deleted text opens its diff; other document text leaves review.
 */

export interface ThreadOverlayState {
	openThreadId: string | null;
	feedbackRange: { from: number; to: number } | null;
	/** Open threads and their message counts, for the pills. */
	pills: Array<{ threadId: string; count: number }>;
}

const threadKey = new PluginKey<ThreadOverlayState>('threadOverlay');

const INITIAL_STATE: ThreadOverlayState = {
	openThreadId: null,
	feedbackRange: null,
	pills: []
};

export function setThreadOverlayState(editor: Editor, state: Partial<ThreadOverlayState>) {
	editor.view.dispatch(editor.state.tr.setMeta(threadKey, state));
}

export interface ThreadRange {
	from: number;
	to: number;
}

/** Every mark range in the document, by thread id, in document order. A
 * paragraph carrying the proposal attribute contributes its whole content
 * range. Cached by doc identity (ProseMirror creates a new doc node per
 * transaction), so the gutter and the overlay share one walk. */
const rangeCache = new WeakMap<PMNode, Map<string, ThreadRange[]>>();
export function threadRanges(doc: PMNode): Map<string, ThreadRange[]> {
	const cached = rangeCache.get(doc);
	if (cached) return cached;
	const out = new Map<string, ThreadRange[]>();
	const push = (threadId: string, from: number, to: number) => {
		const list = out.get(threadId) ?? [];
		const last = list[list.length - 1];
		if (last && last.to === from) last.to = to;
		else list.push({ from, to });
		out.set(threadId, list);
	};
	doc.descendants((node, pos) => {
		if (node.type.name === 'paragraph') {
			const thread = node.attrs[SUGGEST_THREAD_ATTR];
			if (node.attrs[SUGGEST_ATTR] && typeof thread === 'string') {
				push(thread, pos + 1, pos + node.nodeSize - 1);
			}
			return true;
		}
		if (!node.isText) return false;
		for (const mark of node.marks) {
			if (
				mark.type.name !== INSERTION_ATTR &&
				mark.type.name !== DELETION_ATTR &&
				mark.type.name !== COMMENT_ATTR
			) {
				continue;
			}
			const threadId = mark.attrs.threadId;
			if (typeof threadId === 'string') push(threadId, pos, pos + node.nodeSize);
		}
		return false;
	});
	rangeCache.set(doc, out);
	return out;
}

/** Position of a thread's first mark, or null when the thread has no marks
 * in this document (its passage is gone). */
export function firstThreadPos(doc: PMNode, threadId: string): number | null {
	const ranges = threadRanges(doc).get(threadId);
	return ranges && ranges.length > 0 ? ranges[0].from : null;
}

/** The thread whose marks intersect `[from, to)`, if any. Used before the
 * feedback popup opens a new thread: a passage has one thread, so feedback
 * on a passage that already has one becomes a reply there. */
export function threadUnderRange(doc: PMNode, from: number, to: number): string | null {
	for (const [threadId, ranges] of threadRanges(doc)) {
		for (const r of ranges) {
			if (r.from < to && r.to > from) return threadId;
		}
	}
	return null;
}

function dispatchOpenThread(el: HTMLElement, threadId: string): void {
	const rect = el.getBoundingClientRect();
	el.dispatchEvent(
		new CustomEvent('docwriter:open-thread', {
			detail: { threadId, x: rect.right, y: rect.top },
			bubbles: true
		})
	);
}

export const ThreadOverlay = Extension.create({
	name: 'threadOverlay',

	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: threadKey,
				state: {
					init: () => ({ ...INITIAL_STATE }),
					apply: (tr, prev) => {
						const meta = tr.getMeta(threadKey) as Partial<ThreadOverlayState> | undefined;
						return meta === undefined ? prev : { ...prev, ...meta };
					}
				},
				props: {
					handleDOMEvents: {
						click(view, event) {
							// Run after mouseup has placed the cursor and focus/selection
							// handlers have closed the previous review. Preserve drag selection.
							if (!view.state.selection.empty || event.button !== 0) return false;
							const target = event.target;
							if (!(target instanceof Element) || target.closest('.comment-thread-pill')) return false;
							const deletion = target.closest<HTMLElement>('[data-mark="deletion"], p[data-suggest="del"]');
							const threadId = deletion?.getAttribute('data-thread-id');
							if (!deletion || !threadId || !view.dom.contains(deletion)) return false;
							dispatchOpenThread(deletion, threadId);
							return false;
						}
					},
					decorations(state) {
						const { openThreadId, feedbackRange, pills } =
							threadKey.getState(state) ?? INITIAL_STATE;
						const decorations: Decoration[] = [];
						const ranges = threadRanges(state.doc);
						// Review is local UI state. Keep the underlying proposal
						// intact while showing the committed text outside review.
						state.doc.descendants((node, pos) => {
							if (node.type.name !== 'paragraph') return;
							let reviewing = !!openThreadId && node.attrs[SUGGEST_THREAD_ATTR] === openThreadId;
							let onlyInsertions = node.attrs[SUGGEST_ATTR] === 'ins';
							node.descendants((child) => {
								if (openThreadId && child.marks.some((mark) =>
									(mark.type.name === INSERTION_ATTR || mark.type.name === DELETION_ATTR) &&
									mark.attrs.threadId === openThreadId
								)) reviewing = true;
								if (!child.marks.some((mark) => mark.type.name === INSERTION_ATTR)) onlyInsertions = false;
							});
							if (reviewing || onlyInsertions) {
								decorations.push(Decoration.node(pos, pos + node.nodeSize, {
									class: reviewing ? 'proposal-review' : 'proposal-hidden-line'
								}));
							}
							return false;
						});
						if (feedbackRange) {
							const maxPos = state.doc.content.size;
							const from = Math.max(1, Math.min(feedbackRange.from, maxPos));
							const to = Math.max(from, Math.min(feedbackRange.to, maxPos));
							if (to > from) decorations.push(Decoration.inline(from, to, { class: 'feedback-selection' }));
						}
						for (const { threadId, count } of pills) {
							const list = ranges.get(threadId);
							if (!list || list.length === 0) continue;
							const at = list[list.length - 1].to;
							const isOpen = threadId === openThreadId;
							decorations.push(
								Decoration.widget(
									at,
									() => {
										const btn = document.createElement('button');
										btn.className = `comment-thread-pill${isOpen ? ' comment-thread-pill-open' : ''}`;
										btn.setAttribute('data-thread-id', threadId);
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
											dispatchOpenThread(btn, threadId);
										});
										return btn;
									},
									{ side: 1, ignoreSelection: true, key: `pill:${threadId}:${count}:${isOpen}` }
								)
							);
						}
						return DecorationSet.create(state.doc, decorations);
					}
				}
			})
		];
	}
});
