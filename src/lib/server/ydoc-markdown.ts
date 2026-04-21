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

/** Build the plain-text `<paragraph>*` XmlElement shape directly, without
 * going through prosemirror-model's JSON API. Using y-prosemirror's
 * `prosemirrorJSONToYXmlFragment` pulls in prosemirror-model's Schema/Node
 * classes; Vite's SSR bundler was inlining one copy into this chunk while
 * y-prosemirror imported another from node_modules, so `instanceof` checks
 * inside `Fragment.from` failed with "multiple versions of prosemirror-model
 * were loaded". Hand-building the XmlElements avoids the dependency. */
function buildPlainTextElements(content: string): Y.XmlElement[] {
	return content.split('\n').map((line) => {
		const p = new Y.XmlElement('paragraph');
		if (line.length > 0) p.insert(0, [new Y.XmlText(line)]);
		return p;
	});
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
	fragment.insert(0, buildPlainTextElements(content));
}

/** Replace a Y.Doc's `default` XmlFragment with the plain-text paragraph
 * shape used by the collaboration binding. */
export function replaceYDocText(ydoc: Y.Doc, content: string): void {
	const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
	if (fragment.length > 0) {
		fragment.delete(0, fragment.length);
	}
	if (!content) return;
	fragment.insert(0, buildPlainTextElements(content));
}
