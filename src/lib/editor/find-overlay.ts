/**
 * Cmd/Ctrl+F find-in-doc overlay. Plugin state holds the active query +
 * its computed matches; decorations paint a soft background on every
 * match and a stronger outline on the current one.
 *
 * Public surface:
 *   - `FindOverlay` extension to register on the editor
 *   - `setFindQuery(editor, opts)` — change the query / case-sensitivity
 *   - `findStep(editor, +1 | -1)` — advance the current match; scrolls
 *     into view
 *   - `closeFind(editor)` — clear matches + decorations
 *
 * The bar component (FindBar.svelte) drives this; the editor itself
 * owns the keymap (Cmd/Ctrl+F to open, Esc to close, Enter / Shift+
 * Enter to step).
 */
import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { buildCharIndex } from './char-index';

export interface FindMatch {
	from: number;
	to: number;
}

export interface FindState {
	open: boolean;
	query: string;
	caseSensitive: boolean;
	matches: FindMatch[];
	/** Index into `matches`. -1 when there are no matches. */
	currentIdx: number;
}

const INITIAL: FindState = {
	open: false,
	query: '',
	caseSensitive: false,
	matches: [],
	currentIdx: -1
};

export const findKey = new PluginKey<FindState>('findOverlay');

interface FindMeta {
	open?: boolean;
	query?: string;
	caseSensitive?: boolean;
	step?: 1 | -1;
	close?: true;
}

export const FindOverlay = Extension.create({
	name: 'findOverlay',

	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: findKey,
				state: {
					init: (): FindState => ({ ...INITIAL }),
					apply(tr, prev) {
						const meta = tr.getMeta(findKey) as FindMeta | undefined;
						let next = prev;

						if (meta?.close) {
							return { ...INITIAL };
						}

						let queryChanged = false;
						let caseChanged = false;
						if (meta) {
							const open = meta.open ?? next.open;
							const query = meta.query ?? next.query;
							const caseSensitive = meta.caseSensitive ?? next.caseSensitive;
							queryChanged = query !== next.query;
							caseChanged = caseSensitive !== next.caseSensitive;
							next = { ...next, open, query, caseSensitive };
						}

						// Recompute matches whenever the query, case mode, or doc
						// changes. Computing against `tr.doc` (the post-tx state)
						// keeps the matches consistent with the decorations we'll
						// paint in the same render.
						if (next.open && (queryChanged || caseChanged || tr.docChanged)) {
							const matches = computeMatchesAgainstDoc(tr.doc, next.query, next.caseSensitive);
							const carriedIdx =
								matches.length > 0
									? Math.min(Math.max(0, next.currentIdx), matches.length - 1)
									: -1;
							next = {
								...next,
								matches,
								currentIdx: queryChanged || caseChanged ? (matches.length > 0 ? 0 : -1) : carriedIdx
							};
						}

						if (meta?.step && next.matches.length > 0) {
							const len = next.matches.length;
							const cur = next.currentIdx >= 0 ? next.currentIdx : 0;
							const stepped = (cur + meta.step + len) % len;
							next = { ...next, currentIdx: stepped };
						}

						return next;
					}
				},
				props: {
					decorations(state) {
						const s = findKey.getState(state);
						if (!s || !s.open || s.matches.length === 0) return null;
						const decorations: Decoration[] = [];
						for (let i = 0; i < s.matches.length; i += 1) {
							const m = s.matches[i];
							const cls =
								i === s.currentIdx
									? 'search-match search-match-current'
									: 'search-match';
							decorations.push(Decoration.inline(m.from, m.to, { class: cls }));
						}
						return DecorationSet.create(state.doc, decorations);
					}
				}
			})
		];
	}
});

/** Compute matches by walking a PM doc node directly. Uses the cached
 * char-index (keyed by doc identity) so repeated calls in the same
 * render-pass are free, and a fresh walk on a freshly-created doc node
 * is the same cost as inlining the descend loop here. */
function computeMatchesAgainstDoc(doc: unknown, query: string, caseSensitive: boolean): FindMatch[] {
	if (!query) return [];
	const { plainText, charPositions } = buildCharIndex(doc as Parameters<typeof buildCharIndex>[0]);
	const haystack = caseSensitive ? plainText : plainText.toLowerCase();
	const needle = caseSensitive ? query : query.toLowerCase();
	if (!needle) return [];
	const matches: FindMatch[] = [];
	let idx = 0;
	while ((idx = haystack.indexOf(needle, idx)) !== -1) {
		const endIdx = idx + needle.length - 1;
		if (endIdx >= charPositions.length) break;
		const from = charPositions[idx];
		const to = charPositions[endIdx] + 1;
		if (to > from) matches.push({ from, to });
		idx += needle.length;
	}
	return matches;
}

// ── Public actions ──────────────────────────────────────────────────────

// Internal only — the FindBar mirrors state via the editor's `transaction`
// event (see TiptapEditor), so this reader isn't part of the public surface.
function getFindState(editor: Editor): FindState {
	return findKey.getState(editor.view.state) ?? { ...INITIAL };
}

export function openFind(editor: Editor): void {
	editor.view.dispatch(editor.view.state.tr.setMeta(findKey, { open: true }));
}

export function closeFind(editor: Editor): void {
	editor.view.dispatch(editor.view.state.tr.setMeta(findKey, { close: true }));
}

export function setFindQuery(
	editor: Editor,
	opts: { query?: string; caseSensitive?: boolean }
): void {
	editor.view.dispatch(editor.view.state.tr.setMeta(findKey, { open: true, ...opts }));
}

export function findStep(editor: Editor, dir: 1 | -1): void {
	editor.view.dispatch(editor.view.state.tr.setMeta(findKey, { step: dir }));
	scrollCurrentIntoView(editor);
}

/** Scroll the current match into view (centered). Called after every step
 * so the user always sees where they are. */
function scrollCurrentIntoView(editor: Editor): void {
	const s = getFindState(editor);
	if (s.currentIdx < 0) return;
	const match = s.matches[s.currentIdx];
	if (!match) return;
	const view = editor.view;
	try {
		const coords = view.coordsAtPos(match.from);
		// Find the nearest scrollable ancestor and center the match.
		let el: HTMLElement | null = view.dom.parentElement;
		while (el) {
			const style = getComputedStyle(el);
			const overflowY = style.overflowY;
			if (overflowY === 'auto' || overflowY === 'scroll') break;
			el = el.parentElement;
		}
		if (!el) return;
		const elRect = el.getBoundingClientRect();
		const targetTop = coords.top - elRect.top - el.clientHeight / 2;
		el.scrollBy({ top: targetTop, behavior: 'smooth' });
	} catch {
		/* coordsAtPos can throw during teardown; ignore. */
	}
}
