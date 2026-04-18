import { Editor } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { markdownBaseExtensions, plainBaseExtensions } from './editor-extensions';
import { getXmlFragment, isYDocEmpty } from './yjs-doc';

/**
 * Detached, headless tiptap editors for converting file content ↔ PM JSON
 * without going through the live editor. We keep one per mode because the
 * schemas differ: markdown mode has headings / lists / marks; plain mode
 * has just paragraph+text+hardBreak.
 */

let mdHeadless: Editor | null = null;
let plainHeadless: Editor | null = null;

function getMarkdownHeadless(): Editor {
	if (mdHeadless) return mdHeadless;
	mdHeadless = new Editor({ extensions: markdownBaseExtensions(), content: '' });
	return mdHeadless;
}

function getPlainHeadless(): Editor {
	if (plainHeadless) return plainHeadless;
	plainHeadless = new Editor({ extensions: plainBaseExtensions(), content: '' });
	return plainHeadless;
}

export function markdownToPMJson(md: string): unknown {
	const ed = getMarkdownHeadless();
	ed.commands.setContent(md, { emitUpdate: false });
	return ed.getJSON();
}

/** Convert a raw text string into PM JSON for the plain-text schema. Each
 * line becomes its own paragraph; empty lines become empty paragraphs. */
export function plainTextToPMJson(text: string): unknown {
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
export function seedYDocFromContent(content: string, kind: 'markdown' | 'plain' = 'markdown'): void {
	if (!isYDocEmpty()) return;
	if (!content) return;
	if (kind === 'plain') {
		const json = plainTextToPMJson(content);
		const schema = getPlainHeadless().schema;
		prosemirrorJSONToYXmlFragment(schema, json, getXmlFragment());
	} else {
		const json = markdownToPMJson(content);
		const schema = getMarkdownHeadless().schema;
		prosemirrorJSONToYXmlFragment(schema, json, getXmlFragment());
	}
}

export function destroyHeadless(): void {
	if (mdHeadless) {
		mdHeadless.destroy();
		mdHeadless = null;
	}
	if (plainHeadless) {
		plainHeadless.destroy();
		plainHeadless = null;
	}
}
