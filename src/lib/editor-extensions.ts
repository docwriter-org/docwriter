import Placeholder from '@tiptap/extension-placeholder';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import Collaboration from '@tiptap/extension-collaboration';
import type { Extensions } from '@tiptap/core';
import type * as Y from 'yjs';

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
 * text — see `plainBaseExtensions` for why. */
export function collaborativeExtensions(
	ydoc: Y.Doc,
	options?: { placeholder?: string }
): Extensions {
	return [
		...plainBaseExtensions(options),
		Collaboration.configure({ document: ydoc, field: 'default' })
	];
}
