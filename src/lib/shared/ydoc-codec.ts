/**
 * Shared Y.Doc ↔ plain-text codec. Single source of truth for how we serialize
 * a tab's Y.Doc to the on-disk text file and how we seed/replace its content
 * from a text string. Imported by both client and server — no Tiptap, no DOM
 * shim, no prosemirror-model. Paragraph-per-line plain text: each file line
 * becomes one `<paragraph>` XmlElement; `<hardBreak/>` inside a paragraph
 * renders as a newline inside that paragraph's text.
 *
 * Proposals (agent edits pending review) are marks on the document; see
 * `proposals.ts`. `serializeYDoc` returns the COMMITTED view: no proposed
 * insertions, struck text still present, provenance stripped.
 */
import * as Y from 'yjs';
import type { CommentMessage, CommentThread, ThreadOutcome } from '$lib/types';
import { COMMENTS_MAP_NAME, FRAGMENT_NAME, SYSTEM_ORIGIN, normalizeTypography } from './ydoc-constants';
import { buildView } from './proposals';

export {
	normalizeTypography,
	FRAGMENT_NAME,
	COMMENTS_MAP_NAME,
	AGENT_ORIGIN,
	USER_ORIGIN,
	SYSTEM_ORIGIN,
	AI_ATTR
} from './ydoc-constants';

/** Locate the Nth occurrence of `needle` in `haystack`. Returns -1 when
 * fewer than N+1 matches exist. */
export function nthIndexOf(haystack: string, needle: string, occurrenceIndex: number): number {
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

export function getFragment(ydoc: Y.Doc): Y.XmlFragment {
	return ydoc.getXmlFragment(FRAGMENT_NAME);
}

// ── Comment threads: nested Y storage ─────────────────────────────────────
//
// A thread lives in the `comments` Y.Map as a NESTED Y.Map:
//
//   id: string · resolved: boolean · outcome?: ThreadOutcome ·
//   createdAt: number · messages: Y.Array<CommentMessage> (append-only)
//
// Fields merge per-key and messages merge by append, so a Dismiss racing an
// agent reply keeps BOTH. Legacy plain-object values remain readable via
// `readThreadValue`; any write upgrades them in place, and
// `migrateLegacyThreads` converts a whole doc at load time. A thread's
// position in the document is not stored here: it is the set of marks
// carrying its id (see proposals.ts). Legacy threads may still carry an
// `anchor` field, read once by the migration.

export type CommentsMap = Y.Map<unknown>;

export function getCommentsMap(ydoc: Y.Doc): CommentsMap {
	return ydoc.getMap<unknown>(COMMENTS_MAP_NAME);
}

function readOutcome(value: unknown): ThreadOutcome | undefined {
	return value === 'accepted' || value === 'rejected' || value === 'dismissed' ? value : undefined;
}

/** Materialize a stored thread value — nested Y.Map or legacy plain object
 * — into a plain CommentThread snapshot. Null for anything malformed. */
export function readThreadValue(value: unknown): CommentThread | null {
	if (value instanceof Y.Map) {
		const id = value.get('id');
		if (typeof id !== 'string') return null;
		const messages = value.get('messages');
		const createdAt = value.get('createdAt');
		const anchor = value.get('anchor');
		const outcome = readOutcome(value.get('outcome'));
		return {
			id,
			messages:
				messages instanceof Y.Array ? (messages.toArray() as CommentMessage[]) : [],
			resolved: value.get('resolved') === true,
			...(outcome ? { outcome } : {}),
			createdAt: typeof createdAt === 'number' ? createdAt : 0,
			...(anchor && typeof anchor === 'object' ? { anchor: anchor as CommentThread['anchor'] } : {})
		};
	}
	if (
		value &&
		typeof value === 'object' &&
		typeof (value as CommentThread).id === 'string' &&
		Array.isArray((value as CommentThread).messages)
	) {
		return value as CommentThread;
	}
	return null;
}

export function getThread(map: CommentsMap, threadId: string): CommentThread | null {
	return readThreadValue(map.get(threadId));
}

export function readCommentThreads(ydoc: Y.Doc): CommentThread[] {
	const out: CommentThread[] = [];
	getCommentsMap(ydoc).forEach((value) => {
		const thread = readThreadValue(value);
		if (thread) out.push(thread);
	});
	return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Write `thread` into the map in nested form (creating or replacing).
 * Callers run inside their own `ydoc.transact(..., origin)`. */
export function putThread(map: CommentsMap, thread: CommentThread): void {
	const m = new Y.Map<unknown>();
	m.set('id', thread.id);
	m.set('resolved', thread.resolved);
	if (thread.outcome) m.set('outcome', thread.outcome);
	m.set('createdAt', thread.createdAt);
	if (thread.anchor) m.set('anchor', { ...thread.anchor });
	const arr = new Y.Array<CommentMessage>();
	if (thread.messages.length > 0) arr.push(thread.messages.map((msg) => ({ ...msg })));
	m.set('messages', arr);
	map.set(thread.id, m);
}

/** The nested Y.Map for a thread, upgrading a legacy plain value in place
 * first. Null when the thread doesn't exist (or is malformed). Callers run
 * inside a transact. */
function ensureNestedThread(map: CommentsMap, threadId: string): Y.Map<unknown> | null {
	const value = map.get(threadId);
	if (value instanceof Y.Map) return value;
	const legacy = readThreadValue(value);
	if (!legacy) return null;
	putThread(map, legacy);
	return map.get(threadId) as Y.Map<unknown>;
}

/** Append one message. `reopen` also clears the resolved flag (a user reply
 * on a dismissed thread brings it back). Returns false when the thread
 * doesn't exist. Callers run inside a transact. */
export function appendThreadMessage(
	map: CommentsMap,
	threadId: string,
	message: CommentMessage,
	opts: { reopen?: boolean } = {}
): boolean {
	const m = ensureNestedThread(map, threadId);
	if (!m) return false;
	let messages = m.get('messages');
	if (!(messages instanceof Y.Array)) {
		messages = new Y.Array<CommentMessage>();
		m.set('messages', messages);
	}
	(messages as Y.Array<CommentMessage>).push([{ ...message }]);
	if (opts.reopen && m.get('resolved') === true) {
		m.set('resolved', false);
		m.delete('outcome');
	}
	return true;
}

/** Set the resolved flag and the outcome that closed the thread (cleared on
 * reopen). Returns false when the thread doesn't exist. Callers run inside a
 * transact. */
export function setThreadResolved(
	map: CommentsMap,
	threadId: string,
	resolved: boolean,
	outcome?: ThreadOutcome
): boolean {
	const m = ensureNestedThread(map, threadId);
	if (!m) return false;
	if (m.get('resolved') !== resolved) m.set('resolved', resolved);
	if (resolved) {
		if (outcome && m.get('outcome') !== outcome) m.set('outcome', outcome);
	} else if (m.has('outcome')) {
		m.delete('outcome');
	}
	return true;
}

/** Upgrade every legacy plain-object thread in the doc to nested form, in
 * one SYSTEM-origin transaction. Returns how many were converted. Run this
 * only on the authoritative load path (the delta must be persisted);
 * throwaway readers stay read-only via `readThreadValue`. */
export function migrateLegacyThreads(ydoc: Y.Doc): number {
	const map = getCommentsMap(ydoc);
	const legacyIds: string[] = [];
	map.forEach((value, id) => {
		if (!(value instanceof Y.Map) && readThreadValue(value)) legacyIds.push(id);
	});
	if (legacyIds.length === 0) return 0;
	ydoc.transact(() => {
		for (const id of legacyIds) {
			const thread = readThreadValue(map.get(id));
			if (thread) putThread(map, thread);
		}
	}, SYSTEM_ORIGIN);
	return legacyIds.length;
}

// ── Text ──────────────────────────────────────────────────────────────────

/** Serialize the `default` XmlFragment to plain text: the COMMITTED view —
 * paragraphs joined by '\n', a `<hardBreak/>` inside a paragraph as its own
 * '\n', proposed insertions omitted, struck text kept, typography
 * normalized, provenance stripped. */
export function serializeYDoc(ydoc: Y.Doc): string {
	return serializeFragment(getFragment(ydoc));
}

export function serializeFragment(fragment: Y.XmlFragment): string {
	return buildView(fragment, { kind: 'committed' }).text;
}

export function buildParagraphElements(content: string): Y.XmlElement[] {
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
	fragment.insert(0, buildParagraphElements(normalizeTypography(content)));
}

/** Replace the fragment's content wholesale. Callers must wrap this in
 * `ydoc.transact(..., origin)` so the update carries the right origin tag. */
export function replaceYDocText(ydoc: Y.Doc, content: string): void {
	const fragment = getFragment(ydoc);
	if (fragment.length > 0) fragment.delete(0, fragment.length);
	if (content) fragment.insert(0, buildParagraphElements(normalizeTypography(content)));
}

/** Base64 encode/decode for shipping a Y.RelativePosition (a Uint8Array)
 * over JSON. btoa/atob are global in both the browser and Node 16+, so one
 * implementation serves client and server. The client captures its feedback
 * selection this way; the server turns it into a comment mark. */
export function encodeRelPosition(rp: Y.RelativePosition): string {
	const bytes = Y.encodeRelativePosition(rp);
	let bin = '';
	for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

export function decodeRelPosition(s: string): Y.RelativePosition | null {
	try {
		const bin = atob(s);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
		return Y.decodeRelativePosition(bytes);
	} catch {
		return null;
	}
}
