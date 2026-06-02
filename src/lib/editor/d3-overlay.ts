/**
 * D3 overlay — renders fenced ` ```d3 ` code blocks as live D3 diagrams.
 *
 * Same architectural pattern as `media-overlay.ts`: a ProseMirror plugin
 * that reads the plain-text doc, detects fenced D3 code blocks, and emits
 * block widget decorations after the closing ``` line. The markdown source
 * is never mutated.
 *
 * Each widget renders an iframe with D3.js loaded, executing the user's
 * code in a sandboxed environment. A "Get Feedback" button on the widget
 * dispatches a custom DOM event that the TiptapEditor component listens
 * for to trigger the agent with the D3 code for review.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

/** A detected fenced D3 code block in the document. */
interface D3Block {
	/** The D3 code content (lines between opening/closing fences). */
	readonly code: string;
	/** PM position immediately AFTER the closing-fence paragraph — where
	 * the widget decoration renders. */
	readonly insertAt: number;
	/** Stable key for the widget so PM can diff across transactions. */
	readonly key: string;
}

interface D3OverlayState {
	readonly blocks: readonly D3Block[];
}

const d3Key = new PluginKey<D3OverlayState>('d3Overlay');

/** Scan cache: unchanged paragraph nodes keep their text content. */
const textCache = new WeakMap<PMNode, string>();
function nodeText(node: PMNode): string {
	const cached = textCache.get(node);
	if (cached !== undefined) return cached;
	const text = node.textContent;
	textCache.set(node, text);
	return text;
}

function hashString(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

/** Walk the doc and collect fenced D3 code blocks. A block starts with
 * a paragraph whose text matches /^\s*```d3\s*$/ and ends with the next
 * paragraph matching /^\s*```\s*$/. Everything in between is the code. */
function scanD3Blocks(doc: PMNode): D3Block[] {
	const out: D3Block[] = [];
	let pos = 0;
	let inBlock = false;
	let codeLines: string[] = [];
	let blockIndex = 0;

	for (let i = 0; i < doc.childCount; i += 1) {
		const child = doc.child(i);
		const childEnd = pos + child.nodeSize;
		if (child.type.name === 'paragraph') {
			const text = nodeText(child);
			if (!inBlock && /^\s*```d3\s*$/.test(text)) {
				inBlock = true;
				codeLines = [];
			} else if (inBlock && /^\s*```\s*$/.test(text)) {
				const code = codeLines.join('\n');
				if (code.trim()) {
					out.push({
						code,
						insertAt: childEnd,
						key: `d3:${blockIndex}:${hashString(code)}`
					});
					blockIndex += 1;
				}
				inBlock = false;
				codeLines = [];
			} else if (inBlock) {
				codeLines.push(text);
			}
		}
		pos = childEnd;
	}
	return out;
}

const D3_CDN = 'https://d3js.org/d3.v7.min.js';
const widgetCleanup = new WeakMap<HTMLElement, () => void>();

function scriptString(value: string): string {
	return JSON.stringify(value).replace(/<\//g, '<\\/');
}

/** Build the srcdoc HTML for the D3 iframe. The user's D3 code runs
 * inside a <script> that has `d3` available globally. The SVG or canvas
 * output is expected to be appended to `document.body` or `#chart`. */
function buildSrcdoc(code: string): string {
	const userCode = scriptString(code);
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; display: flex; justify-content: center; align-items: start; background: transparent; overflow: hidden; }
  svg { max-width: 100%; height: auto; }
  #chart { width: 100%; }
</style>
</head>
<body>
<div id="chart"></div>
<script src="${D3_CDN}"><\/script>
<script>
let resizeRaf = 0;
const resize = () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    const chartEl = document.getElementById('chart');
    const h = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      chartEl ? chartEl.scrollHeight : 0
    );
    window.parent.postMessage({ type: 'd3-resize', height: h }, '*');
  });
};

const chartRoot = document.getElementById('chart');
if ('ResizeObserver' in window) {
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(document.documentElement);
  resizeObserver.observe(document.body);
  if (chartRoot) resizeObserver.observe(chartRoot);
}
window.addEventListener('load', resize);

const showError = (e) => {
  const errDiv = document.createElement('div');
  errDiv.style.cssText = 'color:#ef4444;font:13px/1.4 monospace;padding:12px;white-space:pre-wrap;';
  errDiv.textContent = 'D3 Error: ' + (e && e.message ? e.message : String(e));
  document.body.replaceChildren(errDiv);
  resize();
};

try {
  if (!window.d3) throw new Error('D3 failed to load');
  Object.defineProperties(window, {
    chart: { value: d3.select(chartRoot), configurable: true },
    container: { value: chartRoot, configurable: true }
  });
  new Function(${userCode} + '\\n//# sourceURL=docwriter-d3-block.js').call(window);
  resize();
} catch (e) {
  showError(e);
}
<\/script>
</body>
</html>`;
}

/** Render the D3 diagram widget: an iframe + a toolbar with a
 * "Get Feedback" button. The button dispatches a `d3-feedback`
 * CustomEvent on the editor DOM so TiptapEditor can handle it. */
function renderD3Widget(block: D3Block): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'd3-widget';
	wrap.setAttribute('contenteditable', 'false');

	// Toolbar
	const toolbar = document.createElement('div');
	toolbar.className = 'd3-widget-toolbar';

	const label = document.createElement('span');
	label.className = 'd3-widget-label';
	label.textContent = 'D3 Diagram';
	toolbar.appendChild(label);

	const feedbackBtn = document.createElement('button');
	feedbackBtn.className = 'd3-widget-feedback-btn';
	feedbackBtn.textContent = 'Get Agent Feedback';
	feedbackBtn.type = 'button';
	feedbackBtn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		wrap.dispatchEvent(
			new CustomEvent('d3-feedback', {
				bubbles: true,
				detail: { code: block.code }
			})
		);
	});
	toolbar.appendChild(feedbackBtn);
	wrap.appendChild(toolbar);

	// Iframe container
	const iframeWrap = document.createElement('div');
	iframeWrap.className = 'd3-widget-iframe-wrap';

	const iframe = document.createElement('iframe');
	iframe.className = 'd3-widget-iframe';
	iframe.setAttribute('sandbox', 'allow-scripts');
	iframe.setAttribute('loading', 'lazy');
	iframe.srcdoc = buildSrcdoc(block.code);
	iframe.style.width = '100%';
	iframe.style.height = '200px';
	iframe.style.border = 'none';
	iframe.style.background = 'white';
	iframe.style.borderRadius = '0 0 6px 6px';

	// Listen for resize messages from the iframe
	const resizeHandler = (event: MessageEvent) => {
		if (event.source !== iframe.contentWindow) return;
		if (event.data?.type === 'd3-resize' && typeof event.data.height === 'number') {
			iframe.style.height = `${Math.min(Math.max(event.data.height, 60), 800)}px`;
		}
	};
	window.addEventListener('message', resizeHandler);
	widgetCleanup.set(wrap, () => window.removeEventListener('message', resizeHandler));

	iframeWrap.appendChild(iframe);
	wrap.appendChild(iframeWrap);
	return wrap;
}

function destroyD3Widget(node: Node): void {
	if (!(node instanceof HTMLElement)) return;
	widgetCleanup.get(node)?.();
	widgetCleanup.delete(node);
}

function buildDecorations(state: D3OverlayState, doc: PMNode): DecorationSet {
	const decorations: Decoration[] = [];
	for (const block of state.blocks) {
		if (block.insertAt > doc.content.size) continue;
		decorations.push(
			Decoration.widget(block.insertAt, () => renderD3Widget(block), {
				side: 1,
				key: block.key,
				ignoreSelection: true,
				destroy: destroyD3Widget
			})
		);
	}
	if (decorations.length === 0) return DecorationSet.empty;
	return DecorationSet.create(doc, decorations);
}

export const D3Overlay = Extension.create({
	name: 'd3Overlay',
	addProseMirrorPlugins() {
		return [
			new Plugin<D3OverlayState>({
				key: d3Key,
				state: {
					init: (_config, instance): D3OverlayState => ({
						blocks: scanD3Blocks(instance.doc)
					}),
					apply(tr, prev): D3OverlayState {
						if (!tr.docChanged) return prev;
						return { blocks: scanD3Blocks(tr.doc) };
					}
				},
				props: {
					decorations(state) {
						const s = d3Key.getState(state);
						if (!s) return null;
						return buildDecorations(s, state.doc);
					}
				}
			})
		];
	}
});
