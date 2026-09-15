import Placeholder from '@tiptap/extension-placeholder';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import Collaboration from '@tiptap/extension-collaboration';
import {
	ySyncPluginKey,
	absolutePositionToRelativePosition,
	relativePositionToAbsolutePosition
} from '@tiptap/y-tiptap';
import { Editor, Extension, Mark, type Extensions } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { AI_ATTR, FRAGMENT_NAME, COMMENTS_MAP_NAME, USER_ORIGIN, encodeRelPosition } from '$lib/shared/ydoc-codec';
import {
	COMMENT_ATTR,
	DELETION_ATTR,
	INSERTION_ATTR,
	SUGGEST_ATTR,
	SUGGEST_THREAD_ATTR
} from '$lib/shared/proposals';

// Re-export the y-sync plugin key + Yjs rel-position helpers so overlays read
// them from ONE place. These MUST come from `@tiptap/y-tiptap` — the exact
// package whose `ySyncPlugin` the `Collaboration` extension installs (see the
// `Collaboration.configure` call below). The identically-named `ySyncPluginKey`
// exported by `y-prosemirror` is a DIFFERENT PluginKey instance (its own
// dedup-suffixed key string), so `ySyncPluginKey.getState(view.state)` against
// the Collaboration plugin silently returns null — breaking rel-position
// anchoring and remote-vs-user transaction classification. Keep every consumer
// importing the key from here so it can never drift back to the wrong package.
export {
	ySyncPluginKey,
	absolutePositionToRelativePosition,
	relativePositionToAbsolutePosition
};

/** Pull the y-prosemirror sync binding off the editor state. Null when the
 * editor isn't using the Collaboration extension (won't happen here — every
 * editor instance is collaborative — but typed safely anyway). `mapping` is
 * opaque to us (it's y-prosemirror's internal PM-node → Y-node lookup, used
 * by the rel-pos helpers); we just pass it through. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YBindingMapping = any;
export function getYBinding(state: EditorState): {
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

/** Compute Yjs rel positions for a PM range and return them base64-encoded
 * so the server can turn the user's exact selection into a comment mark.
 * Returns null when the y-prosemirror binding isn't ready or the position
 * helpers throw — the server then falls back to matching the quote. */
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
		return { relStart: encodeRelPosition(start), relEnd: encodeRelPosition(end) };
	} catch {
		return null;
	}
}

/** AI-provenance mark. Maps 1:1 to the Yjs text-format attribute `AI_ATTR`
 * that the server's accept path stamps onto agent-introduced text. Every
 * mark below MUST be registered on every editor bound to a tab Y.Doc:
 * y-tiptap resolves delta attributes via `schema.mark(name, …)` inside a
 * try/catch that silently DROPS the whole paragraph node on failure — an
 * unregistered mark makes agent-touched paragraphs vanish from the editor.
 *
 * Rendering is a bare `span[data-ai-text]`; whether it is colored is decided
 * by CSS gated on the provenance toggle's container class, so flipping the
 * toggle never touches the document. */
export const AiProvenanceMark = Mark.create({
	name: AI_ATTR,
	inclusive: false,
	parseHTML() {
		return [{ tag: 'span[data-ai-text]' }];
	},
	renderHTML() {
		return ['span', { 'data-ai-text': 'true' }, 0];
	}
});

/** A mark that carries a thread id (see proposals.ts). Rendered as
 * `span[data-mark=<kind>][data-thread-id]`; the CSS in TiptapEditor colors
 * it and the thread overlay opens the thread on click. `parseHTML` is empty
 * on purpose: copied proposal text pastes as plain text and never re-enters
 * the document as a proposal. */
function threadMark(name: string, kind: 'insertion' | 'deletion' | 'comment', inclusive: boolean) {
	return Mark.create({
		name,
		inclusive,
		addAttributes() {
			return {
				threadId: {
					default: null,
					renderHTML: (attrs: { threadId?: string | null }) =>
						attrs.threadId ? { 'data-thread-id': attrs.threadId } : {}
				}
			};
		},
		parseHTML() {
			return [];
		},
		renderHTML({ HTMLAttributes }) {
			return ['span', { ...HTMLAttributes, 'data-mark': kind }, 0];
		}
	});
}

/** Proposed new text (green). */
export const InsertionMark = threadMark(INSERTION_ATTR, 'insertion', false);
/** Text proposed for removal (red, struck). */
export const DeletionMark = threadMark(DELETION_ATTR, 'deletion', false);
/** A comment with no edit (amber). Inclusive: typing at its end extends
 * the commented passage, as in Google Docs. */
export const CommentMark = threadMark(COMMENT_ATTR, 'comment', true);

/** Paragraph with the proposal attributes: a whole line added (`ins`) or
 * removed (`del`) by the thread in `suggestThread`. Attribute names match
 * the Y.XmlElement attribute names, which is how y-prosemirror maps them. */
export const SuggestParagraph = Paragraph.extend({
	addAttributes() {
		return {
			...(this.parent?.() ?? {}),
			[SUGGEST_ATTR]: {
				default: null,
				parseHTML: (el: HTMLElement) => el.getAttribute('data-suggest') || null,
				renderHTML: (attrs: Record<string, unknown>) =>
					attrs[SUGGEST_ATTR] ? { 'data-suggest': String(attrs[SUGGEST_ATTR]) } : {}
			},
			[SUGGEST_THREAD_ATTR]: {
				default: null,
				parseHTML: (el: HTMLElement) => el.getAttribute('data-thread-id') || null,
				renderHTML: (attrs: Record<string, unknown>) =>
					attrs[SUGGEST_THREAD_ATTR] ? { 'data-thread-id': String(attrs[SUGGEST_THREAD_ATTR]) } : {}
			}
		};
	}
});

/** Authorship: text the AUTHOR types is never AI-marked and never inside a
 * proposal, even when typed inside or against such a span ("as you type,
 * you make it your own", per iA Writer). ProseMirror inherits marks when
 * typing mid-span (and at a paragraph start whose first char is marked,
 * where it falls back to nodeAfter's marks), so this appended-transaction
 * plugin strips the three marks from any locally-inserted text. Remote
 * transactions — agent proposals, resolve deltas, Yjs undo/redo — carry
 * ySyncPluginKey meta and are left alone, so genuine marks survive sync and
 * undo. */
export const LocalInputMarkStrip = Extension.create({
	name: 'localInputMarkStrip',
	addProseMirrorPlugins() {
		const schema = this.editor.schema;
		const types = [AI_ATTR, INSERTION_ATTR, DELETION_ATTR]
			.map((name) => schema.marks[name])
			.filter((t): t is NonNullable<typeof t> => !!t);
		return [
			new Plugin({
				key: new PluginKey('localInputMarkStrip'),
				appendTransaction(transactions, _oldState, newState) {
					// Collect ranges inserted by LOCAL transactions, mapping
					// previously-collected ranges through every later step so
					// they stay valid against newState.doc.
					const ranges: Array<{ from: number; to: number }> = [];
					for (const tr of transactions) {
						if (!tr.docChanged) continue;
						const isLocal = tr.getMeta(ySyncPluginKey) === undefined;
						for (const step of tr.steps) {
							const map = step.getMap();
							for (const r of ranges) {
								r.from = map.map(r.from);
								r.to = map.map(r.to);
							}
							if (isLocal) {
								map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
									if (newEnd > newStart) ranges.push({ from: newStart, to: newEnd });
								});
							}
						}
					}
					let tr: typeof newState.tr | null = null;
					const docSize = newState.doc.content.size;
					for (const range of ranges) {
						const from = Math.max(0, Math.min(range.from, docSize));
						const to = Math.max(from, Math.min(range.to, docSize));
						if (from === to) continue;
						for (const type of types) {
							if (!newState.doc.rangeHasMark(from, to, type)) continue;
							tr = tr ?? newState.tr;
							tr.removeMark(from, to, type);
						}
					}
					// Clear lingering stored marks so the very next keystroke
					// doesn't re-insert marked text just to strip it again.
					if (newState.storedMarks?.some((m) => types.includes(m.type))) {
						tr = tr ?? newState.tr;
						tr.setStoredMarks(newState.storedMarks.filter((m) => !types.includes(m.type)));
					}
					return tr;
				}
			})
		];
	}
});

/** Plain-text extension set: minimal schema (doc, paragraph, text, hard-break)
 * plus the provenance and proposal marks. Every file — including `.md` /
 * `.markdown` / `.mdx` — is rendered as source text. `# Heading` shows as
 * `# Heading`, `**bold**` as `**bold**`. No parser in the pipeline means
 * `editor.getText({ blockSeparator: '\n' })` round-trips byte-identically
 * with the file on disk. */
export function plainBaseExtensions(options?: { placeholder?: string }): Extensions {
	return [
		Document,
		SuggestParagraph,
		Text,
		HardBreak,
		AiProvenanceMark,
		InsertionMark,
		DeletionMark,
		CommentMark,
		LocalInputMarkStrip,
		Placeholder.configure({ placeholder: options?.placeholder ?? 'Start writing...' })
	];
}

/** Collaborative wrapper: attaches ySyncPlugin + yUndoPlugin to the editor
 * and binds them to the supplied Y.Doc's `default` XmlFragment. Always plain
 * text — see `plainBaseExtensions` for why.
 *
 * The custom UndoManager scopes the text fragment and the comments map.
 * That keeps ordinary local typing undoable (`ySyncPluginKey`) while
 * letting Accept / Reject / Dismiss apply as undoable user actions
 * (`USER_ORIGIN`): ctrl+z after any of them brings the thread's marks back
 * AND un-resolves the thread in one step, because both live in scope. */
export function collaborativeExtensions(
	ydoc: Y.Doc,
	options?: { placeholder?: string }
): Extensions {
	const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
	const commentsMap = ydoc.getMap(COMMENTS_MAP_NAME);
	const undoManager = new Y.UndoManager([fragment, commentsMap], {
		trackedOrigins: new Set([ySyncPluginKey, USER_ORIGIN])
	});
	return [
		...plainBaseExtensions(options),
		Collaboration.configure({
			document: ydoc,
			field: FRAGMENT_NAME,
			yUndoOptions: { undoManager }
		})
	];
}
