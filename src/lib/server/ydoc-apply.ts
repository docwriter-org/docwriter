import './dom-shim';

import * as Y from 'yjs';
import { Editor } from '@tiptap/core';

import { collaborativeExtensions } from '$lib/editor-extensions';
import { plainTextToPmJson } from './ydoc-markdown';

/**
 * Apply plain-text content to a live collaborative Y.Doc through the same
 * ProseMirror/Yjs binding the browser uses. This avoids raw fragment
 * replacement on the server, which the connected client was racing and
 * stomping back out.
 */
export function applyTextToYDoc(ydoc: Y.Doc, content: string): void {
	const editor = new Editor({
		element: document.createElement('div'),
		extensions: collaborativeExtensions(ydoc)
	});
	try {
		editor.commands.setContent(plainTextToPmJson(content));
	} finally {
		editor.destroy();
	}
}
