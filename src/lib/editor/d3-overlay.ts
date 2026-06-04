/**
 * D3 overlay: renders fenced ` ```d3 ` code blocks as live D3 diagrams.
 *
 * Same architectural pattern as `media-overlay.ts`: a ProseMirror plugin
 * that reads the plain-text doc, detects fenced D3 code blocks, and emits
 * block widget decorations after the closing ``` line. The markdown source
 * is never mutated.
 *
 * Each widget renders an iframe with D3.js loaded, executing the user's
 * code in a sandboxed environment.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

interface BlockLineRange {
	readonly from: number;
	readonly to: number;
}

/** A detected fenced D3 code block in the document. */
interface D3Block {
	/** Stable identity used for UI state such as source expansion. */
	readonly id: string;
	/** The D3 code content (lines between opening/closing fences). */
	readonly code: string;
	/** Opening-fence paragraph range. */
	readonly opening: BlockLineRange;
	/** Paragraph ranges for the source lines between the fences. */
	readonly sourceLines: readonly BlockLineRange[];
	/** Closing-fence paragraph range. */
	readonly closing: BlockLineRange;
	/** PM position immediately after the closing-fence paragraph, where
	 * the widget decoration renders. */
	readonly insertAt: number;
	/** Stable key for the widget so PM can diff across transactions. */
	readonly key: string;
}

interface D3OverlayState {
	readonly blocks: readonly D3Block[];
	readonly expandedIds: ReadonlySet<string>;
}

interface D3OverlayMeta {
	readonly toggleCodeId?: string;
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
	let sourceLines: BlockLineRange[] = [];
	let opening: BlockLineRange | null = null;
	let blockIndex = 0;

	for (let i = 0; i < doc.childCount; i += 1) {
		const child = doc.child(i);
		const childEnd = pos + child.nodeSize;
		if (child.type.name === 'paragraph') {
			const text = nodeText(child);
			if (!inBlock && /^\s*```d3\s*$/.test(text)) {
				inBlock = true;
				codeLines = [];
				sourceLines = [];
				opening = { from: pos, to: childEnd };
			} else if (inBlock && /^\s*```\s*$/.test(text)) {
				const code = codeLines.join('\n');
				if (code.trim() && opening) {
					const id = `d3:${blockIndex}`;
					out.push({
						id,
						code,
						opening,
						sourceLines,
						closing: { from: pos, to: childEnd },
						insertAt: childEnd,
						key: `${id}:${hashString(code)}`
					});
					blockIndex += 1;
				}
				inBlock = false;
				codeLines = [];
				sourceLines = [];
				opening = null;
			} else if (inBlock) {
				codeLines.push(text);
				sourceLines.push({ from: pos, to: childEnd });
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

function dispatchCodeToggle(view: EditorView, blockId: string): void {
	view.dispatch(view.state.tr.setMeta(d3Key, { toggleCodeId: blockId } satisfies D3OverlayMeta));
	requestAnimationFrame(() => {
		view.dom.dispatchEvent(new CustomEvent('d3-code-visibility-changed', { bubbles: true }));
	});
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

/** Render the D3 diagram widget: an iframe + a small toolbar. */
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

function renderCodeToggle(block: D3Block, expanded: boolean, view: EditorView): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'd3-code-toggle';
	wrap.setAttribute('contenteditable', 'false');

	const button = document.createElement('button');
	button.className = 'd3-code-toggle-btn';
	button.type = 'button';
	button.textContent = expanded ? 'hide source' : 'show source';
	button.setAttribute('aria-label', expanded ? 'Hide D3 source' : 'Show D3 source');
	button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
	button.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		dispatchCodeToggle(view, block.id);
	});
	wrap.appendChild(button);

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
		const expanded = state.expandedIds.has(block.id);
		if (block.insertAt > doc.content.size) continue;
		decorations.push(
			Decoration.node(block.opening.from, block.opening.to, { class: 'd3-code-fence' }),
			Decoration.widget(block.opening.to, (view) => renderCodeToggle(block, expanded, view), {
				side: 1,
				key: `${block.key}:source-toggle:${expanded ? 'open' : 'closed'}`,
				ignoreSelection: true
			}),
			Decoration.node(block.closing.from, block.closing.to, { class: 'd3-code-fence' })
		);
		for (const line of block.sourceLines) {
			decorations.push(
				Decoration.node(line.from, line.to, {
					class: expanded ? 'd3-code-line d3-code-line-expanded' : 'd3-code-line d3-code-line-hidden'
				})
			);
		}
		decorations.push(
			Decoration.widget(block.insertAt, () => renderD3Widget(block), {
				side: 1,
				key: `${block.key}:preview`,
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
						blocks: scanD3Blocks(instance.doc),
						expandedIds: new Set()
					}),
					apply(tr, prev): D3OverlayState {
						const meta = tr.getMeta(d3Key) as D3OverlayMeta | undefined;
						let blocks = prev.blocks;
						let expandedIds = prev.expandedIds;
						let changed = false;

						if (meta?.toggleCodeId) {
							const next = new Set(expandedIds);
							if (next.has(meta.toggleCodeId)) {
								next.delete(meta.toggleCodeId);
							} else {
								next.add(meta.toggleCodeId);
							}
							expandedIds = next;
							changed = true;
						}

						if (tr.docChanged) {
							blocks = scanD3Blocks(tr.doc);
							const blockIds = new Set(blocks.map((block) => block.id));
							expandedIds = new Set(
								Array.from(expandedIds).filter((id) => blockIds.has(id))
							);
							changed = true;
						}

						if (!changed) return prev;
						return { blocks, expandedIds };
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
