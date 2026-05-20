import Placeholder from '@tiptap/extension-placeholder';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import Collaboration from '@tiptap/extension-collaboration';
import type { Extensions } from '@tiptap/core';
import type * as Y from 'yjs';
import { USER_ORIGIN } from '$lib/shared/ydoc-codec';

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
 * `yUndoOptions.trackedOrigins` is additive: y-prosemirror's yUndoPlugin
 * always tracks `ySyncPluginKey` (so local typing stays undoable) and
 * concatenates whatever we pass here. Including `USER_ORIGIN` makes the
 * server-side accept / reject / reject-all transactions undoable from
 * the client — ctrl+z after an Accept reverts the text edit AND
 * resurrects the just-deleted pending review card in one step (they're
 * applied in a single `ydoc.transact(..., USER_ORIGIN)`, so the
 * UndoManager treats them as one stack entry). */
export function collaborativeExtensions(
	ydoc: Y.Doc,
	options?: { placeholder?: string }
): Extensions {
	return [
		...plainBaseExtensions(options),
		Collaboration.configure({
			document: ydoc,
			field: 'default',
			yUndoOptions: { trackedOrigins: [USER_ORIGIN] }
		})
	];
}
