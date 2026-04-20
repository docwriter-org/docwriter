/**
 * Server-side markdown (and plain-text) serialization for a Y.Doc.
 *
 * Phase 3 makes the server authoritative for Y.Doc state, which means the
 * server is also responsible for writing the workspace file to disk when
 * the doc changes. Serialization runs through a headless Tiptap editor
 * bound to a clone of the Y.Doc — same code path the client uses, so the
 * round-trip is byte-identical with what TiptapEditor.svelte emits.
 *
 * Why a clone and not the live doc: Hocuspocus's internal Document is
 * actively mutated by the WebSocket connections. Attaching a Tiptap editor
 * to it (even a headless one) would register a ySyncPlugin that emits extra
 * transactions during binding — those transactions would echo back through
 * `onChange` and retrigger flushes. Cloning via encodeStateAsUpdate /
 * applyUpdate is cheap and keeps the live doc untouched.
 *
 * The inverse direction (markdown string → Y.Doc) is used by `seedYDoc`
 * on first-open when the `yjs_updates` table is empty but a real workspace
 * file exists on disk. That mirrors the client's `seedYDocFromContent`.
 */
import './dom-shim';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { markdownBaseExtensions, plainBaseExtensions } from '$lib/editor-extensions';
import Collaboration from '@tiptap/extension-collaboration';

const FRAGMENT_NAME = 'default';

function markdownExtensionsFor(kind: 'markdown' | 'plain', ydoc: Y.Doc) {
	const base = kind === 'plain' ? plainBaseExtensions() : markdownBaseExtensions();
	return [...base, Collaboration.configure({ document: ydoc, field: FRAGMENT_NAME })];
}

/** Serialize a Y.Doc's `default` XmlFragment to the text form that should
 * appear on disk for this kind of tab.
 *
 * Markdown tabs (.md / .markdown / .mdx) round-trip through tiptap-markdown
 * so headings, lists, bold/italic, code blocks, etc. are preserved.
 *
 * Plain tabs (everything else) use `editor.getText({ blockSeparator: '\n' })`
 * which produces a 1:1 line-for-line match with what the user typed. */
export function serializeYDocToMarkdown(
	ydoc: Y.Doc,
	kind: 'markdown' | 'plain'
): string {
	// Clone so binding a headless editor doesn't pollute the live Y.Doc.
	const clone = new Y.Doc();
	Y.applyUpdate(clone, Y.encodeStateAsUpdate(ydoc));

	const editor = new Editor({
		extensions: markdownExtensionsFor(kind, clone)
	});
	try {
		if (kind === 'plain') {
			return editor.getText({ blockSeparator: '\n' });
		}
		// tiptap-markdown registers its serializer on editor.storage.markdown.
		const storage = editor.storage as { markdown?: { getMarkdown?: () => string } };
		return storage.markdown?.getMarkdown?.() ?? '';
	} finally {
		editor.destroy();
		clone.destroy();
	}
}

/** Seed an empty Y.Doc's `default` XmlFragment from a content string. No-op
 * if the fragment is already populated — seeding a non-empty doc would
 * produce merge garbage.
 *
 * Server-side mirror of `seedYDocFromContent` in src/lib/yjs-markdown.ts. */
export function seedYDocFromContent(
	ydoc: Y.Doc,
	content: string,
	kind: 'markdown' | 'plain'
): void {
	const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
	if (fragment.length > 0) return;
	if (!content) return;

	// Build PM JSON via a throwaway, non-collaborative editor. We then use
	// prosemirrorJSONToYXmlFragment to write it into the real Y.Doc — this
	// path doesn't emit a Collaboration plugin transaction, so the seeded
	// Y.Doc looks like a single `applyUpdate(state)` rather than a stream
	// of per-paragraph transactions.
	if (kind === 'plain') {
		const lines = content.split('\n');
		const json = {
			type: 'doc',
			content: lines.map((line) =>
				line.length === 0
					? { type: 'paragraph' }
					: { type: 'paragraph', content: [{ type: 'text', text: line }] }
			)
		};
		const headless = new Editor({ extensions: plainBaseExtensions() });
		try {
			prosemirrorJSONToYXmlFragment(headless.schema, json, fragment);
		} finally {
			headless.destroy();
		}
	} else {
		const headless = new Editor({ extensions: markdownBaseExtensions() });
		try {
			headless.commands.setContent(content, { emitUpdate: false });
			const json = headless.getJSON();
			prosemirrorJSONToYXmlFragment(headless.schema, json, fragment);
		} finally {
			headless.destroy();
		}
	}
}
