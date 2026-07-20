import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Editor } from '@tiptap/core';
import { buildCharIndex } from './char-index';
import type { Rule } from '$lib/types';
import { freezeQuoteFromRule, isFreezeRule } from '$lib/freeze';

export interface FreezeOverlayState {
	rules: Rule[];
}

const freezeKey = new PluginKey<FreezeOverlayState>('freezeOverlay');

const INITIAL_STATE: FreezeOverlayState = { rules: [] };

export function setFreezeOverlayState(editor: Editor, state: FreezeOverlayState) {
	editor.view.dispatch(editor.state.tr.setMeta(freezeKey, state));
}

function resolveQuoteRange(
	plainText: string,
	charPositions: number[],
	quote: string
): { from: number; to: number } | null {
	if (!quote) return null;
	let needle = quote;
	let idx = plainText.indexOf(needle);
	if (idx < 0 && needle.includes('\n')) {
		needle = needle.split('\n').find((l) => l.trim()) ?? '';
		if (!needle) return null;
		idx = plainText.indexOf(needle);
	}
	if (idx < 0) return null;
	const endOffset = idx + needle.length - 1;
	if (endOffset >= charPositions.length) return null;
	const from = charPositions[idx];
	const to = charPositions[endOffset] + 1;
	if (from === undefined || to === undefined || to <= from) return null;
	return { from, to };
}

function buildDecorations(doc: Parameters<typeof buildCharIndex>[0], rules: Rule[]): DecorationSet {
	const quotes = rules.filter(isFreezeRule).map(freezeQuoteFromRule).filter(Boolean);
	if (quotes.length === 0) return DecorationSet.empty;
	const { plainText, charPositions } = buildCharIndex(doc);
	const decorations: ReturnType<typeof Decoration.inline>[] = [];
	const seen = new Set<string>();
	for (const quote of quotes) {
		const range = resolveQuoteRange(plainText, charPositions, quote);
		if (!range) continue;
		const key = `${range.from}:${range.to}`;
		if (seen.has(key)) continue;
		seen.add(key);
		decorations.push(
			Decoration.inline(range.from, range.to, {
				class: 'freeze-mark',
				'data-freeze': 'true'
			})
		);
	}
	return DecorationSet.create(doc, decorations);
}

export const FreezeOverlay = Extension.create({
	name: 'freezeOverlay',
	addProseMirrorPlugins() {
		return [
			new Plugin<FreezeOverlayState>({
				key: freezeKey,
				state: {
					init: () => INITIAL_STATE,
					apply(tr, prev) {
						const next = tr.getMeta(freezeKey) as FreezeOverlayState | undefined;
						return next ?? prev;
					}
				},
				props: {
					decorations(state) {
						const pluginState = freezeKey.getState(state) ?? INITIAL_STATE;
						return buildDecorations(state.doc, pluginState.rules);
					}
				}
			})
		];
	}
});

/** Resolve the editor position of a freeze quote for gutter anchoring. */
export function resolveFreezeAnchorPos(
	editor: Editor,
	quote: string
): number | null {
	const { plainText, charPositions } = buildCharIndex(editor.state.doc);
	const range = resolveQuoteRange(plainText, charPositions, quote);
	return range?.from ?? null;
}
