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

const FRAGMENT_NAME = 'default';

/** Serialize a Y.Doc's `default` XmlFragment to plain text — paragraphs
 * joined by '\n', `<hardBreak/>` children rendered as their own '\n' inside
 * a paragraph. Round-trips byte-identically with `seedYDocFromContent`. */
export function serializeYDocToMarkdown(ydoc: Y.Doc, _kind?: 'markdown' | 'plain'): string {
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
 * Server-side mirror of `seedYDocFromContent` in src/lib/yjs-markdown.ts.
 * One paragraph per `\n`-delimited line; empty lines become empty paragraphs. */
export function seedYDocFromContent(
	ydoc: Y.Doc,
	content: string,
	_kind?: 'markdown' | 'plain'
): void {
	const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
	if (fragment.length > 0) return;
	if (!content) return;

	const lines = content.split('\n');
	const elements = lines.map((line) => {
		const p = new Y.XmlElement('paragraph');
		if (line.length > 0) p.insert(0, [new Y.XmlText(line)]);
		return p;
	});
	fragment.insert(0, elements);
}
