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
import { Mark, type Extensions } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import * as Y from 'yjs';
import {
	AI_ATTR,
	FRAGMENT_NAME,
	REVIEW_ARRAY_NAME,
	COMMENTS_MAP_NAME,
	USER_ORIGIN
} from '$lib/shared/ydoc-codec';

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

/** AI-provenance mark. Maps 1:1 to the Yjs text-format attribute `AI_ATTR`
 * that the server's accept path stamps onto agent-introduced text (see
 * `applyEditToFragment` / `replaceYDocTextWithAiProvenance` in ydoc-codec).
 * The mark MUST be registered on every editor bound to a tab Y.Doc: y-tiptap
 * resolves delta attributes via `schema.mark(name, …)` inside a try/catch
 * that silently DROPS the whole paragraph node on failure — an unregistered
 * mark makes agent-touched paragraphs vanish from the editor.
 *
 * Rendering is a bare `span[data-ai-text]`; whether it is colored is decided
 * by CSS gated on the provenance toggle's container class, so flipping the
 * toggle never touches the document.
 *
 * Authorship semantics ("as you type, you make it your own", per iA Writer):
 * text the USER types must never come out AI-marked, even when typed inside
 * or against an AI span. `inclusive: false` stops the mark from extending at
 * span edges, and the appended-transaction plugin below strips it from any
 * locally-inserted text (typing mid-span inherits marks in ProseMirror;
 * so does typing at a paragraph start whose first char is AI-marked, where
 * PM falls back to nodeAfter's marks). Remote transactions — agent edits,
 * accept deltas, Yjs undo/redo — carry ySyncPluginKey meta and are left
 * alone, so genuine AI provenance survives sync and undo. */
export const AiProvenanceMark = Mark.create({
	name: AI_ATTR,
	inclusive: false,
	parseHTML() {
		return [{ tag: 'span[data-ai-text]' }];
	},
	renderHTML() {
		return ['span', { 'data-ai-text': 'true' }, 0];
	},
	addProseMirrorPlugins() {
		const type = this.type;
		return [
			new Plugin({
				key: new PluginKey('aiProvenanceStrip'),
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
						if (!newState.doc.rangeHasMark(from, to, type)) continue;
						tr = tr ?? newState.tr;
						tr.removeMark(from, to, type);
					}
					// Clear a lingering stored mark so the very next keystroke
					// doesn't re-insert AI-marked text just to strip it again.
					if (newState.storedMarks?.some((m) => m.type === type)) {
						tr = tr ?? newState.tr;
						tr.setStoredMarks(newState.storedMarks.filter((m) => m.type !== type));
					}
					return tr;
				}
			})
		];
	}
});

/** Plain-text extension set: minimal schema (doc, paragraph, text, hard-break).
 * Every file — including `.md` / `.markdown` / `.mdx` — is rendered as source
 * text. `# Heading` shows as `# Heading`, `**bold**` as `**bold**`. No parser
 * in the pipeline means `editor.getText({ blockSeparator: '\n' })` round-trips
 * byte-identically with the file on disk, and all the "did tiptap-markdown
 * lose my backslash" / "agent's big edit only half-landed" failure modes go
 * away — they were artifacts of the markdown round-trip. */
export function plainBaseExtensions(options?: { placeholder?: string }): Extensions {
	return [
		Document,
		Paragraph,
		Text,
		HardBreak,
		AiProvenanceMark,
		Placeholder.configure({ placeholder: options?.placeholder ?? 'Start writing...' })
	];
}

/** Collaborative wrapper: attaches ySyncPlugin + yUndoPlugin to the editor
 * and binds them to the supplied Y.Doc's `default` XmlFragment. Always plain
 * text — see `plainBaseExtensions` for why.
 *
 * The custom UndoManager scopes the text fragment, the pending review array,
 * and the comments map. That keeps ordinary local typing undoable
 * (`ySyncPluginKey`) while letting Accept/Reject apply as undoable user
 * actions (`USER_ORIGIN`): ctrl+z after Accept reverts the text and
 * resurrects the just-deleted pending review card; ctrl+z after Reject
 * resurrects the diff card. The comments map is in scope so that undo also
 * un-resolves the edit's auto-thread — accept/reject auto-resolves an
 * edit-only thread, and without the map in scope the round would come back
 * pointing at a still-resolved (hidden) thread, so the card wouldn't reappear. */
export function collaborativeExtensions(
	ydoc: Y.Doc,
	options?: { placeholder?: string }
): Extensions {
	const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
	const reviewArray = ydoc.getArray(REVIEW_ARRAY_NAME);
	const commentsMap = ydoc.getMap(COMMENTS_MAP_NAME);
	const undoManager = new Y.UndoManager([fragment, reviewArray, commentsMap], {
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
