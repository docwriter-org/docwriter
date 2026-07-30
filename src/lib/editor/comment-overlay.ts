import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import * as Y from 'yjs';
// The y-sync plugin key + rel-position helpers MUST come from the same package
// whose ySyncPlugin the Collaboration extension installs (@tiptap/y-tiptap),
// re-exported via editor-extensions. Importing them from `y-prosemirror`
// yields a different PluginKey, so getYBinding() below always returns null and
// the entire RelativePosition anchoring tier goes dead. See editor-extensions.
import {
	ySyncPluginKey,
	absolutePositionToRelativePosition,
	relativePositionToAbsolutePosition
} from '$lib/editor-extensions';
import {
	getCommentsMap,
	SYSTEM_ORIGIN,
	captureAnchorContext,
	matchCommentAnchor,
	nthIndexOf
} from '$lib/shared/ydoc-codec';
import { buildCharIndex as cachedBuildCharIndex } from './char-index';
import type { CommentThread } from '$lib/types';

/**
 * Comment-thread overlay: per unresolved thread, draws an inline dotted
 * underline over the anchored passage AND a small gutter pill at the end
 * of the passage showing the message count. Clicking either dispatches a
 * custom `docwriter:open-thread` DOM event carrying the thread id — the
 * editor host listens for it and opens the CommentThreadPopover.
 *
 * Anchoring is two-tier:
 *   1. Yjs `RelativePosition` (preferred). Stored on each thread anchor
 *      as `relStart` / `relEnd` (base64-encoded). CRDT-tracks through any
 *      concurrent edit — typing inside the passage grows the highlight,
 *      deletions shrink it, agent edits keep it pinned to the right text,
 *      and reloads/syncs preserve it.
 *   2. Quote-string lookup (fallback). When `relStart` / `relEnd` are
 *      absent (legacy thread, server-created thread that hasn't been
 *      seen by a client yet), we `indexOf` the quote in the current
 *      plain text. The view hook below backfills rel positions on first
 *      render so the fallback is one-shot per thread.
 *
 * When neither path resolves (text fully deleted), the thread is
 * "detached" — no decoration is emitted; the Outline pane lists detached
 * threads separately.
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

// buildCharIndex moved to ./char-index for cross-overlay caching.
// Aliased here so the rest of this file reads cleanly.
const buildCharIndex = cachedBuildCharIndex;

/** Base64 encode/decode for storing Y.RelativePosition (a Uint8Array) in
 * a JSON-friendly Y.Map value. We pass through atob/btoa because (a) it
 * works in browser without polyfills and (b) the encoded length is short
 * enough that the byte-string-detour overhead doesn't matter. */
function encodeRelPos(rp: Y.RelativePosition): string {
	const bytes = Y.encodeRelativePosition(rp);
	let bin = '';
	for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}
function decodeRelPos(s: string): Y.RelativePosition | null {
	try {
		const bin = atob(s);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
		return Y.decodeRelativePosition(bytes);
	} catch {
		return null;
	}
}

/** Compute Yjs rel positions for a PM range and return them base64-
 * encoded so callers can ship them over the wire. Returns null when the
 * y-prosemirror binding isn't ready or the position helpers throw —
 * caller should fall back to the indexOf-based path in that case.
 *
 * Used by comment creation: capturing rel positions at the user's actual
 * selection avoids the "comment lands on the first matching keyword"
 * bug, because the rel positions encode the exact location, not a quote
 * + occurrence-index that loses information when the same text appears
 * multiple times. */
export function computeRelPositionsForRange(
	editor: Editor,
	from: number,
	to: number
): { relStart: string; relEnd: string } | null {
	const binding = getYBinding(editor.view.state);
	if (!binding) return null;
	try {
		const start = absolutePositionToRelativePosition(from, binding.type, binding.mapping);
		const end = absolutePositionToRelativePosition(to, binding.type, binding.mapping);
		return { relStart: encodeRelPos(start), relEnd: encodeRelPos(end) };
	} catch {
		return null;
	}
}

/** Pull the y-prosemirror sync binding off the editor state. Null when
 * the editor isn't using the Collaboration extension (won't happen here
 * — every editor instance is collaborative — but typed safely anyway).
 * `mapping` is opaque to us (it's y-prosemirror's internal PM-node →
 * Y-node lookup, used by the rel-pos helpers); we just pass it through. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YBindingMapping = any;
function getYBinding(state: EditorState): {
	doc: Y.Doc;
	type: Y.XmlFragment;
	mapping: YBindingMapping;
} | null {
	const syncState = ySyncPluginKey.getState(state) as
		| {
				binding?: {
					doc: Y.Doc;
					type: Y.XmlFragment;
					mapping: YBindingMapping;
					isDestroyed?: boolean;
				};
		  }
		| undefined;
	const binding = syncState?.binding;
	if (!binding || binding.isDestroyed) return null;
	return { doc: binding.doc, type: binding.type, mapping: binding.mapping };
}

/** Resolve a thread's anchor to PM positions. Tries rel positions first
 * (live, CRDT-tracked); falls back to indexOf when rel positions are
 * missing or no longer resolvable. Returns null when neither finds a
 * range — the thread is detached.
 *
 * The quote fallback is context-aware: when the anchor stores the text
 * that surrounded the passage (captured at creation or backfilled while
 * the anchor was alive), a fallback match must ALSO match that context.
 * Without this, a thread whose passage was deleted (e.g. the user
 * accepted an agent edit replacing it) re-attached to ANY occurrence of
 * the same string typed anywhere later — feedback left on "ABC" and long
 * dealt with popped back up as soon as "ABC" was typed elsewhere (a real
 * shipped bug). Undo still re-attaches: restored text brings its
 * original surroundings back, so the context matches. */
function resolveAnchorPMRange(
	state: EditorState,
	thread: CommentThread
): { from: number; to: number } | null {
	const anchor = thread.anchor;
	const binding = getYBinding(state);

	// Tier 1: rel positions, when available.
	if (binding && anchor.relStart && anchor.relEnd) {
		const relStart = decodeRelPos(anchor.relStart);
		const relEnd = decodeRelPos(anchor.relEnd);
		if (relStart && relEnd) {
			const from = relativePositionToAbsolutePosition(
				binding.doc,
				binding.type,
				relStart,
				binding.mapping
			);
			const to = relativePositionToAbsolutePosition(
				binding.doc,
				binding.type,
				relEnd,
				binding.mapping
			);
			if (typeof from === 'number' && typeof to === 'number' && to > from) {
				return { from, to };
			}
		}
	}

	// Tier 2: quote-lookup fallback — the exact ladder (occurrenceIndex →
	// first occurrence → first-non-empty-line for multi-line quotes, plus
	// the context check) lives in `matchCommentAnchor`, shared with the
	// per-tab thread counting behind the TabBar dots so the two can't
	// disagree about which threads are attached.
	const { charPositions, plainText } = buildCharIndex(state.doc);
	const match = matchCommentAnchor(plainText, anchor);
	if (!match) return null;
	const endOffset = match.idx + match.quote.length - 1;
	if (endOffset >= charPositions.length) return null;
	const from = charPositions[match.idx];
	const to = charPositions[endOffset] + 1;
	if (from === undefined || to === undefined || to <= from) return null;
	return { from, to };
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
						const decorations: Decoration[] = [];

						for (const thread of active) {
							const range = resolveAnchorPMRange(state, thread);
							if (!range) continue;
							const { from, to } = range;

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
				},
				view(editorView) {
					// Backfill anchor metadata for any thread that is missing it:
					// rel positions (server-created or pre-rel-position legacy
					// threads) and the surrounding-text context that the quote
					// fallback validates against. Runs after every state update;
					// cheap because the filter exits early once every thread is
					// fully stamped. Threads in the local `attempted` set are
					// skipped to avoid re-attempting in the (rare) case
					// `absolutePositionToRelativePosition` returns a position that
					// re-resolves to a different range — the loop would otherwise
					// repeatedly write back.
					const attempted = new Set<string>();
					const tryBackfill = () => {
						const binding = getYBinding(editorView.state);
						if (!binding) return;
						const pluginState = commentKey.getState(editorView.state) ?? INITIAL_STATE;
						const candidates = pluginState.threads.filter(
							(t) =>
								!t.resolved &&
								(!t.anchor.relStart ||
									!t.anchor.relEnd ||
									(t.anchor.contextBefore === undefined &&
										t.anchor.contextAfter === undefined)) &&
								!attempted.has(t.id)
						);
						if (candidates.length === 0) return;

						const { charPositions, plainText } = buildCharIndex(editorView.state.doc);
						const updates: { id: string; thread: CommentThread }[] = [];
						for (const thread of candidates) {
							attempted.add(thread.id);
							// Prefer the LIVE rel-position range when present — it is
							// the authoritative anchor location (an exact selection may
							// not be the occurrenceIndex-th quote match). Fall back to
							// the quote lookup for threads without rel positions.
							let resolvedIdx = -1;
							let quoteLen = thread.anchor.quote.length;
							const live = resolveAnchorPMRange(editorView.state, thread);
							if (live && thread.anchor.relStart && thread.anchor.relEnd) {
								const startIdx = charPositions.indexOf(live.from);
								const endIdx = charPositions.indexOf(live.to - 1);
								if (startIdx >= 0 && endIdx >= startIdx) {
									resolvedIdx = startIdx;
									quoteLen = endIdx - startIdx + 1;
								}
							}
							if (resolvedIdx < 0) {
								const idx = nthIndexOf(plainText, thread.anchor.quote, thread.anchor.occurrenceIndex);
								resolvedIdx = idx >= 0 ? idx : nthIndexOf(plainText, thread.anchor.quote, 0);
								quoteLen = thread.anchor.quote.length;
							}
							if (resolvedIdx < 0) continue;
							const endOffset = resolvedIdx + quoteLen - 1;
							if (endOffset >= charPositions.length) continue;
							const fromPM = charPositions[resolvedIdx];
							const toPM = charPositions[endOffset] + 1;
							if (fromPM === undefined || toPM === undefined || toPM <= fromPM) continue;

							let relStart: Y.RelativePosition;
							let relEnd: Y.RelativePosition;
							try {
								relStart = absolutePositionToRelativePosition(
									fromPM,
									binding.type,
									binding.mapping
								);
								relEnd = absolutePositionToRelativePosition(toPM, binding.type, binding.mapping);
							} catch {
								continue;
							}
							const context =
								thread.anchor.contextBefore === undefined &&
								thread.anchor.contextAfter === undefined
									? captureAnchorContext(plainText, resolvedIdx, quoteLen)
									: {};
							const updated: CommentThread = {
								...thread,
								anchor: {
									...thread.anchor,
									relStart: thread.anchor.relStart ?? encodeRelPos(relStart),
									relEnd: thread.anchor.relEnd ?? encodeRelPos(relEnd),
									...context
								}
							};
							updates.push({ id: thread.id, thread: updated });
						}
						if (updates.length === 0) return;
						const commentsMap = getCommentsMap(binding.doc);
						// SYSTEM_ORIGIN (not USER_ORIGIN) so this machine-generated
						// rel-position backfill stays off the UndoManager's stack —
						// trackedOrigins is {ySyncPluginKey, USER_ORIGIN}. Otherwise the
						// first backfill after loading a legacy/agent thread would plant
						// a phantom undo step the user could Cmd+Z into.
						binding.doc.transact(() => {
							for (const u of updates) {
								// Re-check existence before writing — the thread may have
								// been deleted between our read and this transact.
								if (commentsMap.has(u.id)) commentsMap.set(u.id, u.thread);
							}
						}, SYSTEM_ORIGIN);
					};

					return {
						update: () => {
							tryBackfill();
						}
					};
				}
			})
		];
	}
});

/** Resolve a thread's anchor to PM positions. Used by the margin-gutter
 * component to decide where to stack each thread card vertically.
 * Mirrors the overlay's two-tier logic. */
export function resolveThreadRange(
	editor: Editor,
	thread: CommentThread
): { from: number; to: number } | null {
	return resolveAnchorPMRange(editor.state, thread);
}
