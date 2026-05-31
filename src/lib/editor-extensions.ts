import Placeholder from '@tiptap/extension-placeholder';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import Collaboration from '@tiptap/extension-collaboration';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type { Extensions } from '@tiptap/core';
import * as Y from 'yjs';
import {
	FRAGMENT_NAME,
	REVIEW_ARRAY_NAME,
	COMMENTS_MAP_NAME,
	USER_ORIGIN
} from '$lib/shared/ydoc-codec';

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
