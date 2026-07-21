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

function lockWidget(ruleId: string): HTMLElement {
	// Zero-width slot so the lock can hang in the left page margin without
	// shoving the frozen text to the right.
	const slot = document.createElement('span');
	slot.className = 'freeze-lock-slot';
	slot.contentEditable = 'false';

	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'freeze-lock';
	btn.title = 'Frozen — click to unlock';
	btn.setAttribute('aria-label', 'Frozen passage — open unlock menu');
	btn.setAttribute('aria-haspopup', 'menu');
	btn.setAttribute('data-freeze-rule', ruleId);
	// Inline SVG (lucide Lock) — no component tree in a PM widget.
	btn.innerHTML =
		'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
	btn.addEventListener('mousedown', (e) => {
		// Keep the editor from taking focus / collapsing selection first.
		e.preventDefault();
		e.stopPropagation();
	});
	btn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		const rect = btn.getBoundingClientRect();
		btn.dispatchEvent(
			new CustomEvent('docwriter:freeze-menu', {
				bubbles: true,
				detail: {
					ruleId,
					x: rect.left + rect.width / 2,
					y: rect.bottom + 6
				}
			})
		);
	});
	slot.appendChild(btn);
	return slot;
}

function buildDecorations(doc: Parameters<typeof buildCharIndex>[0], rules: Rule[]): DecorationSet {
	const freezes = rules.filter(isFreezeRule);
	if (freezes.length === 0) return DecorationSet.empty;
	const { plainText, charPositions } = buildCharIndex(doc);
	const decorations: ReturnType<typeof Decoration.inline>[] = [];
	const seen = new Set<string>();
	for (const rule of freezes) {
		const quote = freezeQuoteFromRule(rule);
		const range = resolveQuoteRange(plainText, charPositions, quote);
		if (!range) continue;
		const key = `${range.from}:${range.to}`;
		if (seen.has(key)) continue;
		seen.add(key);
		decorations.push(
			Decoration.widget(range.from, () => lockWidget(rule.id), {
				side: -1,
				key: `freeze-lock-${rule.id}`
			})
		);
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
