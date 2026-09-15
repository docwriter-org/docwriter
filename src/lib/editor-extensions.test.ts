// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { collaborativeExtensions } from './editor-extensions';
import { FRAGMENT_NAME, seedYDoc } from './shared/ydoc-codec';
import { DELETION_ATTR, committedText, proposeText, resolveThreadMarks } from './shared/proposals';

const editors: Editor[] = [];
const docs: Y.Doc[] = [];
afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
	for (const doc of docs.splice(0)) doc.destroy();
});

function setup() {
	const doc = new Y.Doc();
	docs.push(doc);
	seedYDoc(doc, 'Hi :-)\n[[replace this]]\n[[and this one]]?');
	const editor = new Editor({ extensions: collaborativeExtensions(doc) });
	editors.push(editor);
	doc.transact(() => {
		for (const index of [1, 2]) {
			const paragraph = doc.getXmlFragment(FRAGMENT_NAME).get(index) as Y.XmlElement;
			const text = paragraph.get(0) as Y.XmlText;
			text.format(0, text.length, { [DELETION_ATTR]: { threadId: `t${index}` } });
		}
	}, 'agent');
	return editor;
}

function deletedText(editor: Editor) {
	return Array.from(editor.view.dom.querySelectorAll('[data-mark="deletion"]'))
		.map((span) => span.textContent);
}

describe('typing beside proposed deletions', () => {
	it('keeps proposed hardBreak ownership through editor sync and DOM reconstruction', async () => {
		const doc = new Y.Doc();
		docs.push(doc);
		const paragraph = new Y.XmlElement('paragraph');
		paragraph.insert(0, [new Y.XmlText('first'), new Y.XmlElement('hardBreak'), new Y.XmlText('second')]);
		doc.getXmlFragment(FRAGMENT_NAME).insert(0, [paragraph]);
		const editor = new Editor({ extensions: collaborativeExtensions(doc) });
		editors.push(editor);
		doc.transact(() => proposeText(doc, 'break-thread', 'replacement'), 'agent');
		expect(editor.view.dom.querySelector('br[data-thread-id="break-thread"]')).not.toBeNull();
		const domParagraph = editor.view.dom.firstElementChild!;
		domParagraph.innerHTML = domParagraph.innerHTML.replace('second', 'second mine');
		await vi.waitFor(() => expect(editor.getText()).toContain('second mine'));
		doc.transact(() => resolveThreadMarks(doc, 'break-thread', 'accepted'), 'user');
		expect(committedText(doc)).toBe(' mine\nreplacement');
		expect(editor.view.dom.querySelector('br[data-thread-id]')).toBeNull();
	});

	it('preserves the existing deletion through repeated typing', () => {
		const editor = setup();
		for (const char of ' for some reason when i start typing') {
			const pos = editor.state.doc.content.size - 1;
			editor.view.dispatch(editor.state.tr.insertText(char, pos));
		}
		expect(deletedText(editor)).toEqual(['[[replace this]]', '[[and this one]]?']);
	});

	it('preserves deletions when the browser rebuilds a span while typing', async () => {
		const editor = setup();
		const paragraph = editor.view.dom.lastElementChild!;
		// A recreated span has no ProseMirror view descriptor. Reading this
		// DOM edit must recover its existing mark from the HTML attributes.
		paragraph.innerHTML = paragraph.innerHTML.replace('[[and this one]]?', '[[and this one]]? more');
		await vi.waitFor(() => expect(editor.getText()).toContain('? more'));
		expect(deletedText(editor)).toEqual(['[[replace this]]', '[[and this one]]?']);
	});

	it('pastes proposal text without its marks or paragraph ownership', () => {
		const editor = setup();
		editor.commands.setTextSelection(editor.state.doc.content.size - 1);
		editor.view.pasteHTML('<p data-suggest="del" data-thread-id="copied"><span data-mark="deletion" data-thread-id="copied">pasted text</span><span data-mark="comment" data-thread-id="copied">commented text</span></p>');
		expect(editor.getText()).toContain('pasted textcommented text');
		expect(editor.getHTML()).not.toContain('copied');
		expect(deletedText(editor)).toEqual(['[[replace this]]', '[[and this one]]?']);
	});
});
