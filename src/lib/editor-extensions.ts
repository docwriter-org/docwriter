import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import { Markdown } from 'tiptap-markdown';
import Collaboration from '@tiptap/extension-collaboration';
import type { Extensions } from '@tiptap/core';
import type * as Y from 'yjs';

/** Markdown extension set: StarterKit (headings, lists, bold/italic/…),
 * image / table / task list, and tiptap-markdown for parsing/serializing. */
export function markdownBaseExtensions(options?: { placeholder?: string }): Extensions {
	return [
		StarterKit.configure({
			heading: { levels: [1, 2, 3] },
			undoRedo: false,
			link: {
				openOnClick: true,
				HTMLAttributes: { target: '_blank', rel: 'noopener' }
			}
		}),
		Highlight,
		Image.configure({ inline: false, allowBase64: true }),
		TableKit.configure({
			table: { resizable: false, HTMLAttributes: { class: 'md-table' } }
		}),
		TaskList,
		TaskItem.configure({ nested: true }),
		Markdown.configure({
			html: true,
			transformPastedText: true,
			transformCopiedText: true
		}),
		Placeholder.configure({ placeholder: options?.placeholder ?? 'Start writing...' })
	];
}

/** Plain-text extension set: minimal schema (doc, paragraph, text, hard-break)
 * with no markdown parsing, no headings, no lists, no marks. Tiptap renders
 * raw text exactly as typed and `getText({ blockSeparator: '\n' })` produces
 * a byte-identical round-trip with the file on disk. */
export function plainBaseExtensions(options?: { placeholder?: string }): Extensions {
	return [
		Document,
		Paragraph,
		Text,
		HardBreak,
		Placeholder.configure({ placeholder: options?.placeholder ?? 'Start writing...' })
	];
}

/** Collaborative wrapper around a given base set. `Collaboration` attaches
 * ySyncPlugin + yUndoPlugin to the editor and binds them to the supplied
 * Y.Doc's `default` XmlFragment. */
export function collaborativeExtensions(
	ydoc: Y.Doc,
	options?: { placeholder?: string; kind?: 'markdown' | 'plain' }
): Extensions {
	const base =
		options?.kind === 'plain'
			? plainBaseExtensions(options)
			: markdownBaseExtensions(options);
	return [...base, Collaboration.configure({ document: ydoc, field: 'default' })];
}
