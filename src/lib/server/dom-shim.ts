/**
 * Happy-dom shim for Tiptap / ProseMirror on the server.
 *
 * Tiptap's `Editor` constructor parses its initial content through the DOM
 * (`document.createElement`, etc.). In Node there is no `window`/`document`,
 * so a minimal DOM has to be attached to `globalThis` *before* any Tiptap
 * module is imported. This file does that as a side-effect of being
 * imported — every server module that needs a headless editor should
 * `import './dom-shim'` ahead of any `@tiptap/*` import.
 *
 * happy-dom is a lightweight DOM implementation designed for headless
 * testing / SSR; we only populate the globals Tiptap actually reaches for
 * (window, document, DocumentFragment, Element, Node). Installed once per
 * Node process; subsequent imports are no-ops.
 */
import { Window } from 'happy-dom';

type MinimalGlobals = {
	window?: unknown;
	document?: unknown;
	DocumentFragment?: unknown;
	Element?: unknown;
	Node?: unknown;
	__docwriterDomShimInstalled?: boolean;
};

const g = globalThis as unknown as MinimalGlobals;

if (!g.__docwriterDomShimInstalled) {
	const win = new Window();
	// `navigator` is a getter on Node >= 21 and throws on reassignment.
	// Tiptap doesn't need it; skipping keeps this shim compatible across Node
	// 20, 22, and 24 (which we support per package.json engines).
	g.window = win;
	g.document = win.document;
	g.DocumentFragment = (win as unknown as { DocumentFragment: unknown }).DocumentFragment;
	g.Element = (win as unknown as { Element: unknown }).Element;
	g.Node = (win as unknown as { Node: unknown }).Node;
	g.__docwriterDomShimInstalled = true;
}
