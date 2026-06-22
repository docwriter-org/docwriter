import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export type SourceCommentStyle =
	| { kind: 'line'; marker: string }
	| { kind: 'block'; open: string; close: string };

interface SourceCommentOptions {
	style: SourceCommentStyle | null;
}

const sourceCommentKey = new PluginKey('sourceCommentOverlay');

function isEscaped(text: string, index: number): boolean {
	let slashCount = 0;
	for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
		slashCount += 1;
	}
	return slashCount % 2 === 1;
}

function findUnescapedMarker(text: string, marker: string): number {
	let index = text.indexOf(marker);
	while (index >= 0) {
		if (!isEscaped(text, index)) return index;
		index = text.indexOf(marker, index + marker.length);
	}
	return -1;
}

function findLineCommentStart(text: string, marker: string): number {
	const indentLength = text.match(/^\s*/)?.[0].length ?? 0;
	if (text.slice(indentLength).startsWith(marker)) return indentLength;

	// TeX comments are often inline (`text % note`). Other languages need
	// real parsers to avoid false positives in strings and URLs, so keep
	// those to full-line comments for now.
	if (marker === '%') return findUnescapedMarker(text, marker);
	return -1;
}

function addLineCommentDecorations(
	doc: PMNode,
	marker: string,
	decorations: Decoration[]
) {
	doc.descendants((node, pos) => {
		if (node.type.name !== 'paragraph') return;
		const text = node.textContent;
		if (!text) return false;
		const commentStart = findLineCommentStart(text, marker);
		if (commentStart < 0) return false;
		const start = pos + 1;
		decorations.push(
			Decoration.inline(start + commentStart, start + text.length, {
				class: 'source-comment'
			})
		);
		return false;
	});
}

function addBlockCommentDecorations(
	doc: PMNode,
	openToken: string,
	closeToken: string,
	decorations: Decoration[]
) {
	const open = openToken.trim();
	const close = closeToken.trim();
	if (!open || !close) return;

	let inBlock = false;
	doc.descendants((node, pos) => {
		if (node.type.name !== 'paragraph') return;
		const text = node.textContent;
		if (!text && !inBlock) return false;
		const start = pos + 1;
		let cursor = 0;

		while (cursor < text.length) {
			if (inBlock) {
				const closeIndex = text.indexOf(close, cursor);
				if (closeIndex < 0) {
					decorations.push(
						Decoration.inline(start + cursor, start + text.length, {
							class: 'source-comment'
						})
					);
					return false;
				}
				decorations.push(
					Decoration.inline(start + cursor, start + closeIndex + close.length, {
						class: 'source-comment'
					})
				);
				cursor = closeIndex + close.length;
				inBlock = false;
				continue;
			}

			const openIndex = text.indexOf(open, cursor);
			if (openIndex < 0) return false;
			const closeIndex = text.indexOf(close, openIndex + open.length);
			if (closeIndex < 0) {
				decorations.push(
					Decoration.inline(start + openIndex, start + text.length, {
						class: 'source-comment'
					})
				);
				inBlock = true;
				return false;
			}
			decorations.push(
				Decoration.inline(start + openIndex, start + closeIndex + close.length, {
					class: 'source-comment'
				})
			);
			cursor = closeIndex + close.length;
		}

		return false;
	});
}

function buildDecorations(style: SourceCommentStyle | null, doc: PMNode): DecorationSet {
	if (!style) return DecorationSet.empty;
	const decorations: Decoration[] = [];
	if (style.kind === 'line') {
		addLineCommentDecorations(doc, style.marker, decorations);
	} else {
		addBlockCommentDecorations(doc, style.open, style.close, decorations);
	}
	if (decorations.length === 0) return DecorationSet.empty;
	return DecorationSet.create(doc, decorations);
}

export const SourceCommentOverlay = Extension.create<SourceCommentOptions>({
	name: 'sourceCommentOverlay',

	addOptions() {
		return {
			style: null
		};
	},

	addProseMirrorPlugins() {
		const style = this.options.style;
		return [
			new Plugin({
				key: sourceCommentKey,
				props: {
					decorations(state) {
						return buildDecorations(style, state.doc);
					}
				}
			})
		];
	}
});
