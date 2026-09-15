// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { plainBaseExtensions } from '../editor-extensions';
import { MarkdownRender } from './markdown-render';

const editors: Editor[] = [];
afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
});

function setup(text: string) {
	const editor = new Editor({
		extensions: [...plainBaseExtensions(), MarkdownRender],
		content: { type: 'doc', content: text.split('\n').map((line) => ({
			type: 'paragraph', content: line ? [{ type: 'text', text: line }] : []
		})) }
	});
	editors.push(editor);
	return editor;
}

function hiddenSource(editor: Editor) {
	return Array.from(editor.view.dom.querySelectorAll('.md-link-syntax-hidden'))
		.map((span) => span.textContent).join('');
}

describe('Markdown link display', () => {
	it('shows only the label outside the link and preserves the document source', () => {
		const source = 'See [the guide](https://example.com/guide).';
		const editor = setup(source);
		expect(hiddenSource(editor)).toBe('[](https://example.com/guide)');
		expect(editor.view.dom.querySelector('.md-link-text')?.textContent).toBe('the guide');
		expect(editor.getText()).toBe(source);
	});

	it('reveals source on cursor entry and folds it again on exit', () => {
		const editor = setup('See [guide](https://example.com).');
		editor.commands.setTextSelection(8);
		expect(hiddenSource(editor)).toBe('');
		expect(editor.view.dom.querySelector('.md-link-url')?.textContent).toBe('](https://example.com)');
		editor.commands.setTextSelection(1);
		expect(hiddenSource(editor)).toBe('[](https://example.com)');
	});

	it('folds as soon as the closing parenthesis is typed', () => {
		const editor = setup('[guide](https://example.com');
		expect(hiddenSource(editor)).toBe('');
		editor.commands.setTextSelection(editor.state.doc.content.size - 1);
		editor.view.dispatch(editor.state.tr.insertText(')'));
		expect(hiddenSource(editor)).toBe('[](https://example.com)');
		editor.view.dispatch(editor.state.tr.insertText(' more'));
		expect(editor.getText()).toBe('[guide](https://example.com) more');
	});

	it('hides the complete destination with nested or escaped parentheses', () => {
		for (const destination of ['https://example.com/a_(b_(c))', 'https://example.com/a\\)b']) {
			const editor = setup(`[guide](${destination})`);
			expect(hiddenSource(editor)).toBe(`[](${destination})`);
		}
	});

	it('leaves incomplete links, images, escaped links, and code visible', () => {
		for (const source of [
			'[guide](https://example.com',
			'![image](https://example.com/image.png)',
			'\\[guide](https://example.com)',
			'`[guide](https://example.com)`',
			'```\n[guide](https://example.com)\n```'
		]) {
			expect(hiddenSource(setup(source))).toBe('');
		}
	});

	it('updates positions after typing before a link', () => {
		const editor = setup('[guide](https://example.com)');
		editor.view.dispatch(editor.state.tr.insertText('See ', 1));
		expect(hiddenSource(editor)).toBe('[](https://example.com)');
		editor.commands.setTextSelection(8);
		expect(hiddenSource(editor)).toBe('');
		expect(editor.getText()).toBe('See [guide](https://example.com)');
	});
});
