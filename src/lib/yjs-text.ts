import * as Y from 'yjs';

function textOf(node: unknown): string {
	if (node instanceof Y.XmlText) return node.toString();
	if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
		const parts: string[] = [];
		(node as Y.XmlElement | Y.XmlFragment).forEach((child: unknown) => {
			if (
				child instanceof Y.XmlElement &&
				typeof child.nodeName === 'string' &&
				child.nodeName === 'hardBreak'
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

export function plainTextFromFragment(fragment: Y.XmlFragment): string {
	const lines: string[] = [];
	fragment.forEach((child: unknown) => {
		lines.push(textOf(child));
	});
	return lines.join('\n');
}
