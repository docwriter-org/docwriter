/**
 * Shared Y.Doc ↔ plain-text codec. Single source of truth for how we serialize
 * a tab's Y.Doc to the on-disk text file and how we seed/replace its content
 * from a text string. Imported by both client and server — no Tiptap, no DOM
 * shim, no prosemirror-model. Paragraph-per-line plain text: each file line
 * becomes one `<paragraph>` XmlElement; `<hardBreak/>` inside a paragraph
 * renders as a newline inside that paragraph's text.
 *
 * Also exports the single Y.Doc schema constants (`FRAGMENT_NAME`,
 * `REVIEW_ARRAY_NAME`, `AGENT_ORIGIN`) so the client and server never drift.
 */
import * as Y from 'yjs';
import type { PendingReviewRound } from '$lib/types';

export const FRAGMENT_NAME = 'default';
export const REVIEW_ARRAY_NAME = 'rounds';
export const AGENT_ORIGIN = 'agent';
export const USER_ORIGIN = 'user';
export const SYSTEM_ORIGIN = 'system';

export function getFragment(ydoc: Y.Doc): Y.XmlFragment {
	return ydoc.getXmlFragment(FRAGMENT_NAME);
}

export function getReviewArray(ydoc: Y.Doc): Y.Array<PendingReviewRound> {
	return ydoc.getArray<PendingReviewRound>(REVIEW_ARRAY_NAME);
}

export function readReviewRounds(ydoc: Y.Doc): PendingReviewRound[] {
	return getReviewArray(ydoc).toArray();
}

/** Serialize the `default` XmlFragment to plain text: paragraphs joined by
 * '\n'; a `<hardBreak/>` inside a paragraph renders as its own '\n'. */
export function serializeYDoc(ydoc: Y.Doc): string {
	return serializeFragment(getFragment(ydoc));
}

export function serializeFragment(fragment: Y.XmlFragment): string {
	const lines: string[] = [];
	fragment.forEach((child) => lines.push(textOf(child)));
	return lines.join('\n');
}

function textOf(node: unknown): string {
	if (node instanceof Y.XmlText) return node.toString();
	if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
		const parts: string[] = [];
		(node as Y.XmlElement).forEach((child: unknown) => {
			if (
				child instanceof Y.XmlElement &&
				typeof (child as Y.XmlElement).nodeName === 'string' &&
				(child as Y.XmlElement).nodeName === 'hardBreak'
			) {
				parts.push('\n');
				return;
			}
			parts.push(textOf(child));
		});
		return parts.join('');
	}
	return '';
}

function buildParagraphElements(content: string): Y.XmlElement[] {
	return content.split('\n').map((line) => {
		const p = new Y.XmlElement('paragraph');
		if (line.length > 0) p.insert(0, [new Y.XmlText(line)]);
		return p;
	});
}

/** Seed an EMPTY Y.Doc's fragment from a content string. No-op if non-empty
 * (seeding a populated fragment produces merge garbage). Does NOT wrap in a
 * transact — callers pick their own origin. */
export function seedYDoc(ydoc: Y.Doc, content: string): void {
	const fragment = getFragment(ydoc);
	if (fragment.length > 0) return;
	if (!content) return;
	fragment.insert(0, buildParagraphElements(content));
}

/** Replace the fragment's content wholesale. Callers must wrap this in
 * `ydoc.transact(..., origin)` so the update carries the right origin tag. */
export function replaceYDocText(ydoc: Y.Doc, content: string): void {
	const fragment = getFragment(ydoc);
	if (fragment.length > 0) fragment.delete(0, fragment.length);
	if (content) fragment.insert(0, buildParagraphElements(content));
}
