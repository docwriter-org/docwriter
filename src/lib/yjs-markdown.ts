import { Editor, type JSONContent } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { plainBaseExtensions } from './editor-extensions';
import { getXmlFragment, isYDocEmpty } from './yjs-doc';

/**
 * Detached headless Tiptap editor used to convert raw file content into
 * ProseMirror JSON for the plain-text schema. Every file — including
 * `.md` / `.markdown` — uses this path now; markdown is kept as literal source
 * rather than parsed into headings/lists/marks.
 */

let plainHeadless: Editor | null = null;

function getPlainHeadless(): Editor {
	if (plainHeadless) return plainHeadless;
	plainHeadless = new Editor({ extensions: plainBaseExtensions(), content: '' });
	return plainHeadless;
}

/** Convert a raw text string into PM JSON for the plain-text schema. Each
 * line becomes its own paragraph; empty lines become empty paragraphs. */
export function plainTextToPMJson(text: string): JSONContent {
	const lines = text.split('\n');
	return {
		type: 'doc',
		content: lines.map((line) =>
			line.length === 0
				? { type: 'paragraph' }
				: { type: 'paragraph', content: [{ type: 'text', text: line }] }
		)
	};
}

/** Seed an empty Y.XmlFragment from file content. No-op if the fragment is
 * already populated (seeding a non-empty fragment wipes history). */
export function seedYDocFromContent(content: string): void {
	if (!isYDocEmpty()) return;
	if (!content) return;
	const json = plainTextToPMJson(content);
	const schema = getPlainHeadless().schema;
	prosemirrorJSONToYXmlFragment(schema, json, getXmlFragment());
}

export function destroyHeadless(): void {
	if (plainHeadless) {
		plainHeadless.destroy();
		plainHeadless = null;
	}
}
