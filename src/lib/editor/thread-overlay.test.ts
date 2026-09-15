// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { plainBaseExtensions } from '../editor-extensions';
import { ThreadOverlay, setThreadOverlayState } from './thread-overlay';

const editors: Editor[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); });

function setup() {
	const text = (value: string, kind?: string, threadId = 'first') => ({
		type: 'text', text: value, ...(kind ? { marks: [{ type: kind, attrs: { threadId } }] } : {})
	});
	const editor = new Editor({
		extensions: [...plainBaseExtensions(), ThreadOverlay],
		content: { type: 'doc', content: [
			{ type: 'paragraph', content: [text('Old', 'deletion'), text('New', 'insertion')] },
			{ type: 'paragraph', attrs: { suggest: 'ins', suggestThread: 'second' }, content: [text('New line', 'insertion', 'second')] },
			{ type: 'paragraph', attrs: { suggest: 'ins', suggestThread: 'second' }, content: [text('Suggestion', 'insertion', 'second'), text('Author text')] }
		] }
	});
	editors.push(editor);
	return editor;
}

describe('proposal review visibility', () => {
	it('keeps inactive proposals folded, including entire added lines', () => {
		const editor = setup();
		expect(editor.view.dom.querySelectorAll('.proposal-review')).toHaveLength(0);
		expect(editor.view.dom.querySelectorAll('.proposal-hidden-line')).toHaveLength(1);
		expect(editor.view.dom.querySelector('.proposal-hidden-line')?.textContent).toBe('New line');
	});

	it('shows only the active thread and preserves the complete document when hiding it', () => {
		const editor = setup();
		const before = editor.getJSON();
		setThreadOverlayState(editor, { openThreadId: 'first' });
		expect(editor.view.dom.querySelectorAll('.proposal-review')).toHaveLength(1);
		expect(editor.view.dom.querySelector('.proposal-review')?.textContent).toBe('OldNew');
		setThreadOverlayState(editor, { openThreadId: 'second' });
		expect(editor.view.dom.querySelectorAll('.proposal-review')).toHaveLength(2);
		expect(editor.view.dom.querySelectorAll('.proposal-hidden-line')).toHaveLength(0);
		setThreadOverlayState(editor, { openThreadId: null });
		expect(editor.view.dom.querySelectorAll('.proposal-review')).toHaveLength(0);
		expect(editor.getJSON()).toEqual(before);
	});

	it('keeps author text visible in a paragraph containing a hidden suggestion', () => {
		const editor = setup();
		expect(editor.view.dom.lastElementChild?.classList.contains('proposal-hidden-line')).toBe(false);
		expect(editor.view.dom.querySelectorAll('.proposal-review')).toHaveLength(0);
	});
});
