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
import type { CommentThread, PendingReviewRound } from '$lib/types';

/**
 * Normalize typographic characters to their ASCII equivalents. Applied at
 * serialization so all consumers (read_doc, edit_doc, prompt diffs, disk
 * writes) see consistent plain-ASCII text. This prevents agent edit failures
 * when LLMs generate old_string with straight quotes/hyphens but the document
 * contains curly quotes/en-dashes.
 */
export function normalizeTypography(text: string): string {
	return text
		// Curly double quotes → straight double quote
		.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
		// Curly single quotes, apostrophes → straight single quote
		.replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
		// En-dash, em-dash, figure dash, horizontal bar → hyphen-minus
		.replace(/[\u2013\u2014\u2012\u2015]/g, '-')
		// Ellipsis → three dots
		.replace(/\u2026/g, '...')
		// Non-breaking space → regular space
		.replace(/\u00A0/g, ' ');
}

export const FRAGMENT_NAME = 'default';
export const REVIEW_ARRAY_NAME = 'rounds';
export const COMMENTS_MAP_NAME = 'comments';
export const AGENT_ORIGIN = 'agent';
/** Origin for user-initiated server-side mutations (accept / reject /
 * reject-all). Anything `ydoc.transact(..., USER_ORIGIN)` tags becomes
 * client-undoable: the Tiptap Collaboration extension is configured to
 * include this origin in its `Y.UndoManager.trackedOrigins`, so ctrl+z
 * in the editor reverses these transactions one step at a time. Reuse
 * carefully — adding a new USER_ORIGIN transact site opts it into undo
 * by default. Use SYSTEM_ORIGIN (or a fresh origin) for mutations that
 * should NOT be reversible from the editor. */
export const USER_ORIGIN = 'user';
export const SYSTEM_ORIGIN = 'system';

export function getFragment(ydoc: Y.Doc): Y.XmlFragment {
	return ydoc.getXmlFragment(FRAGMENT_NAME);
}

export function getReviewArray(ydoc: Y.Doc): Y.Array<PendingReviewRound> {
	return ydoc.getArray<PendingReviewRound>(REVIEW_ARRAY_NAME);
}

export function getCommentsMap(ydoc: Y.Doc): Y.Map<CommentThread> {
	return ydoc.getMap<CommentThread>(COMMENTS_MAP_NAME);
}

export function readCommentThreads(ydoc: Y.Doc): CommentThread[] {
	const out: CommentThread[] = [];
	getCommentsMap(ydoc).forEach((thread) => out.push(thread));
	return out.sort((a, b) => a.createdAt - b.createdAt);
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
	return normalizeTypography(lines.join('\n'));
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

/** Apply an edit-op (replace one occurrence of `oldString` with `newString`)
 * to the fragment by replacing only the paragraphs the edit actually touches.
 * Returns true on success, false if `oldString` is not found.
 *
 * The point: a wholesale `replaceYDocText` eats any concurrent user typing
 * because every character lives in the about-to-be-deleted old content. By
 * only deleting + reinserting the paragraphs the edit covers, concurrent
 * typing in any other paragraph merges through Yjs CRDT untouched.
 *
 * Caller must be inside a `ydoc.transact(..., origin)`. */
export function applyEditToFragment(
	fragment: Y.XmlFragment,
	oldString: string,
	newString: string,
	replaceAll: boolean
): boolean {
	if (!oldString) return false;

	// Snapshot paragraph texts so we can compute affected range. Mirrors
	// serializeFragment's per-child textOf walk.
	const paraTexts: string[] = [];
	fragment.forEach((child) => paraTexts.push(textOf(child)));

	if (replaceAll) {
		// Sweeping rename: replace every occurrence in one pass. Concurrent
		// typing protection is weaker here (we touch the whole fragment),
		// but replace_all is a sweeping rename by intent — the caller is
		// asking for it.
		const fullText = normalizeTypography(paraTexts.join('\n'));
		if (fullText.indexOf(oldString) < 0) return false;
		const replaced = fullText.split(oldString).join(normalizeTypography(newString));
		if (replaced === fullText) return false;
		const newParas = buildParagraphElements(replaced);
		fragment.delete(0, fragment.length);
		fragment.insert(0, newParas);
		return true;
	}

	const fullText = normalizeTypography(paraTexts.join('\n'));
	const startOffset = fullText.indexOf(oldString);
	if (startOffset < 0) return false;
	const endOffset = startOffset + oldString.length;

	// Walk paragraphs to find which ones are affected. Range boundaries are
	// inclusive on the start, exclusive on the end — but a match landing
	// exactly at a paragraph boundary (a '\n') belongs to the paragraph
	// preceding the boundary for the start and the one after for the end.
	let cursor = 0;
	let firstAffected = -1;
	let lastAffected = -1;
	let startInFirst = 0;
	let endInLast = 0;
	for (let i = 0; i < paraTexts.length; i += 1) {
		const paraStart = cursor;
		const paraEnd = cursor + paraTexts[i].length;
		if (firstAffected < 0 && startOffset >= paraStart && startOffset <= paraEnd) {
			firstAffected = i;
			startInFirst = startOffset - paraStart;
		}
		if (firstAffected >= 0 && endOffset >= paraStart && endOffset <= paraEnd) {
			lastAffected = i;
			endInLast = endOffset - paraStart;
			break;
		}
		cursor = paraEnd + 1; // +1 for the '\n' separator between paragraphs
	}
	if (firstAffected < 0 || lastAffected < 0) return false;

	const before = paraTexts[firstAffected].slice(0, startInFirst);
	const after = paraTexts[lastAffected].slice(endInLast);
	const splicedText = before + normalizeTypography(newString) + after;
	const newParas = buildParagraphElements(splicedText);
	const count = lastAffected - firstAffected + 1;
	fragment.delete(firstAffected, count);
	fragment.insert(firstAffected, newParas);
	return true;
}

/** Seed an EMPTY Y.Doc's fragment from a content string. No-op if non-empty
 * (seeding a populated fragment produces merge garbage). Does NOT wrap in a
 * transact — callers pick their own origin. */
export function seedYDoc(ydoc: Y.Doc, content: string): void {
	const fragment = getFragment(ydoc);
	if (fragment.length > 0) return;
	if (!content) return;
	fragment.insert(0, buildParagraphElements(normalizeTypography(content)));
}

/** Replace the fragment's content wholesale. Callers must wrap this in
 * `ydoc.transact(..., origin)` so the update carries the right origin tag. */
export function replaceYDocText(ydoc: Y.Doc, content: string): void {
	const fragment = getFragment(ydoc);
	if (fragment.length > 0) fragment.delete(0, fragment.length);
	if (content) fragment.insert(0, buildParagraphElements(normalizeTypography(content)));
}
