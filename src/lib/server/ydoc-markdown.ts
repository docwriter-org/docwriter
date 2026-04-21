/**
 * Server-side text serialization for a Y.Doc.
 *
 * Plain-text everywhere now — markdown files render as source. So serializing
 * the live Y.Doc is just walking its XmlFragment children and joining their
 * text content with `\n`. No headless Tiptap needed, no DOM shim, no
 * happy-dom dependency. The seed-from-disk path is similarly trivial: each
 * line of the file becomes one `<paragraph>` XmlElement.
 */
import * as Y from 'yjs';
import { Schema } from 'prosemirror-model';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';

const FRAGMENT_NAME = 'default';
const plainTextSchema = new Schema({
	nodes: {
		doc: { content: 'block*' },
		paragraph: { group: 'block', content: 'text*' },
		text: { group: 'inline' }
	},
	marks: {}
});

export function plainTextToPmJson(text: string): Record<string, unknown> {
	return {
		type: 'doc',
		content: text.split('\n').map((line) =>
			line.length === 0
				? { type: 'paragraph' }
				: { type: 'paragraph', content: [{ type: 'text', text: line }] }
		)
	};
}

/** Serialize a Y.Doc's `default` XmlFragment to plain text — paragraphs
 * joined by '\n', `<hardBreak/>` children rendered as their own '\n' inside
 * a paragraph. Round-trips byte-identically with `seedYDocFromContent`. */
export function serializeYDocToMarkdown(ydoc: Y.Doc): string {
	const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
	const lines: string[] = [];
	fragment.forEach((child) => {
		lines.push(textOf(child));
	});
	return lines.join('\n');
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

/** Seed an empty Y.Doc's `default` XmlFragment from a content string. No-op
 * if the fragment is already populated — seeding a non-empty doc would
 * produce merge garbage.
 *
 * One paragraph per `\n`-delimited line; empty lines become empty paragraphs. */
export function seedYDocFromContent(ydoc: Y.Doc, content: string): void {
	const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
	if (fragment.length > 0) return;
	if (!content) return;
	prosemirrorJSONToYXmlFragment(plainTextSchema, plainTextToPmJson(content), fragment);
}

/** Replace a Y.Doc's `default` XmlFragment with the plain-text schema shape
 * produced by y-prosemirror itself. This avoids hand-building XmlElements in
 * a way the bound collaboration client may later normalize back out. */
export function replaceYDocText(ydoc: Y.Doc, content: string): void {
	const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
	if (fragment.length > 0) {
		fragment.delete(0, fragment.length);
	}
	if (!content) return;
	prosemirrorJSONToYXmlFragment(plainTextSchema, plainTextToPmJson(content), fragment);
}
