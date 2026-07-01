import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

interface LineRange {
	readonly from: number;
	readonly to: number;
}

interface MarkdownTable {
	readonly id: string;
	readonly key: string;
	readonly insertAt: number;
	readonly sourceLines: readonly LineRange[];
	readonly headers: readonly string[];
	readonly rows: readonly string[][];
	readonly alignments: readonly ('left' | 'center' | 'right')[];
}

interface MarkdownCodeBlock {
	readonly id: string;
	readonly key: string;
	readonly language: string;
	readonly languageOffset: number;
	readonly opening: LineRange;
	readonly sourceLines: readonly LineRange[];
	readonly closing: LineRange;
	readonly markerChar: '`' | '~';
	readonly markerLength: number;
}

interface MarkdownRenderState {
	readonly tables: readonly MarkdownTable[];
	readonly codeBlocks: readonly MarkdownCodeBlock[];
	readonly expandedTableIds: ReadonlySet<string>;
}

interface TableToggleMeta {
	readonly type: 'table-toggle';
	readonly id: string;
}

const mdRenderKey = new PluginKey<MarkdownRenderState>('markdownRender');

/** Regex patterns for inline markdown syntax. */
const BOLD_RE = /(\*\*|__)(.+?)\1/g;
const ITALIC_RE = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g;
const CODE_RE = /`([^`]+)`/g;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const STRIKETHROUGH_RE = /~~(.+?)~~/g;

function hashString(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function splitTableRow(line: string): string[] {
	let text = line.trim();
	if (text.startsWith('|')) text = text.slice(1);
	if (text.endsWith('|')) text = text.slice(0, -1);
	const cells: string[] = [];
	let current = '';
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === '\\' && text[i + 1] === '|') {
			current += '|';
			i += 1;
		} else if (ch === '|') {
			cells.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	cells.push(current.trim());
	return cells;
}

function isPipeRow(line: string): boolean {
	const cells = splitTableRow(line);
	return line.includes('|') && cells.length >= 2 && cells.some((cell) => cell.length > 0);
}

function isSeparatorCell(cell: string): boolean {
	return /^:?-{3,}:?$/.test(cell.trim());
}

function parseAlignment(cell: string): 'left' | 'center' | 'right' {
	const trimmed = cell.trim();
	if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
	if (trimmed.endsWith(':')) return 'right';
	return 'left';
}

function normalizeRow(cells: string[], width: number): string[] {
	return Array.from({ length: width }, (_, i) => cells[i] ?? '');
}

function scanTables(doc: PMNode): MarkdownTable[] {
	const lines: Array<{ index: number; pos: number; end: number; text: string }> = [];
	let pos = 0;
	for (let i = 0; i < doc.childCount; i += 1) {
		const child = doc.child(i);
		const end = pos + child.nodeSize;
		if (child.type.name === 'paragraph') {
			lines.push({ index: i, pos, end, text: child.textContent });
		}
		pos = end;
	}

	const tables: MarkdownTable[] = [];
	for (let i = 0; i < lines.length - 1; i += 1) {
		const headerLine = lines[i];
		const separatorLine = lines[i + 1];
		if (!isPipeRow(headerLine.text) || !isPipeRow(separatorLine.text)) continue;
		const headers = splitTableRow(headerLine.text);
		const separator = splitTableRow(separatorLine.text);
		if (
			headers.length < 2 ||
			separator.length !== headers.length ||
			!separator.every(isSeparatorCell)
		) {
			continue;
		}

		const sourceLines: LineRange[] = [
			{ from: headerLine.pos, to: headerLine.end },
			{ from: separatorLine.pos, to: separatorLine.end }
		];
		const rows: string[][] = [];
		let j = i + 2;
		while (j < lines.length && isPipeRow(lines[j].text)) {
			const cells = splitTableRow(lines[j].text);
			sourceLines.push({ from: lines[j].pos, to: lines[j].end });
			rows.push(normalizeRow(cells, headers.length));
			j += 1;
		}

		const raw = lines.slice(i, j).map((line) => line.text).join('\n');
		const id = `table:${tables.length}`;
		tables.push({
			id,
			key: `${id}:${hashString(raw)}`,
			insertAt: sourceLines[sourceLines.length - 1].to,
			sourceLines,
			headers: normalizeRow(headers, headers.length),
			rows,
			alignments: separator.map(parseAlignment)
		});
		i = j - 1;
	}
	return tables;
}

function scanCodeBlocks(doc: PMNode): MarkdownCodeBlock[] {
	const out: MarkdownCodeBlock[] = [];
	let pos = 0;
	let inBlock = false;
	let opening: LineRange | null = null;
	let markerChar: '`' | '~' = '`';
	let markerLength = 3;
	let language = '';
	let languageOffset = -1;
	let sourceLines: LineRange[] = [];
	let rawLines: string[] = [];
	let blockIndex = 0;

	for (let i = 0; i < doc.childCount; i += 1) {
		const child = doc.child(i);
		const childEnd = pos + child.nodeSize;
		if (child.type.name === 'paragraph') {
			const text = child.textContent;
			if (!inBlock) {
				const open = text.match(/^(\s*)(`{3,}|~{3,})\s*(.*?)\s*$/);
				if (open) {
					const rawLanguage = open[3].trim();
					markerChar = open[2][0] as '`' | '~';
					markerLength = open[2].length;
					language = rawLanguage;
					inBlock = true;
					opening = { from: pos, to: childEnd };
					languageOffset = rawLanguage
						? text.indexOf(rawLanguage, open[1].length + markerLength)
						: -1;
					sourceLines = [];
					rawLines = [text];
				}
			} else {
				const closeRe =
					markerChar === '`'
						? new RegExp(`^\\s*\`{${markerLength},}\\s*$`)
						: new RegExp(`^\\s*~{${markerLength},}\\s*$`);
				if (closeRe.test(text)) {
					rawLines.push(text);
					if (opening) {
						const id = `code:${blockIndex}`;
						out.push({
							id,
							key: `${id}:${hashString(rawLines.join('\n'))}`,
							language,
							languageOffset,
							opening,
							sourceLines,
							closing: { from: pos, to: childEnd },
							markerChar,
							markerLength
						});
						blockIndex += 1;
					}
					inBlock = false;
					opening = null;
					languageOffset = -1;
					sourceLines = [];
					rawLines = [];
				} else {
					sourceLines.push({ from: pos, to: childEnd });
					rawLines.push(text);
				}
			}
		}
		pos = childEnd;
	}
	return out.filter((block) => block.language.trim().toLowerCase() !== 'd3');
}

function appendInlineMarkdown(parent: HTMLElement, text: string): void {
	let i = 0;
	while (i < text.length) {
		const candidates = [
			{ marker: '**', tag: 'strong' },
			{ marker: '__', tag: 'strong' },
			{ marker: '`', tag: 'code' },
			{ marker: '*', tag: 'em' },
			{ marker: '_', tag: 'em' }
		]
			.map((candidate) => ({ ...candidate, index: text.indexOf(candidate.marker, i) }))
			.filter((candidate) => candidate.index >= 0)
			.sort((a, b) => a.index - b.index || b.marker.length - a.marker.length);

		const next = candidates[0];
		if (!next) {
			parent.append(document.createTextNode(text.slice(i)));
			return;
		}
		if (next.index > i) {
			parent.append(document.createTextNode(text.slice(i, next.index)));
		}
		const contentStart = next.index + next.marker.length;
		const close = text.indexOf(next.marker, contentStart);
		if (close === -1) {
			parent.append(document.createTextNode(text.slice(next.index)));
			return;
		}
		const el = document.createElement(next.tag);
		el.textContent = text.slice(contentStart, close);
		parent.append(el);
		i = close + next.marker.length;
	}
}

function renderTableWidget(table: MarkdownTable): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'md-table-widget';
	wrap.setAttribute('contenteditable', 'false');

	const label = document.createElement('div');
	label.className = 'md-table-label';
	label.textContent = 'Markdown table';
	wrap.appendChild(label);

	const scroller = document.createElement('div');
	scroller.className = 'md-table-scroll';
	const tableEl = document.createElement('table');
	tableEl.className = 'md-table-preview';

	const thead = document.createElement('thead');
	const headTr = document.createElement('tr');
	table.headers.forEach((header, i) => {
		const th = document.createElement('th');
		th.style.textAlign = table.alignments[i] ?? 'left';
		appendInlineMarkdown(th, header);
		headTr.appendChild(th);
	});
	thead.appendChild(headTr);
	tableEl.appendChild(thead);

	const tbody = document.createElement('tbody');
	for (const row of table.rows) {
		const tr = document.createElement('tr');
		row.forEach((cell, i) => {
			const td = document.createElement('td');
			td.style.textAlign = table.alignments[i] ?? 'left';
			appendInlineMarkdown(td, cell);
			tr.appendChild(td);
		});
		tbody.appendChild(tr);
	}
	tableEl.appendChild(tbody);

	scroller.appendChild(tableEl);
	wrap.appendChild(scroller);
	return wrap;
}

function dispatchTableToggle(view: EditorView, tableId: string): void {
	view.dispatch(view.state.tr.setMeta(mdRenderKey, { type: 'table-toggle', id: tableId } satisfies TableToggleMeta));
	requestAnimationFrame(() => {
		view.dom.dispatchEvent(new CustomEvent('docwriter:markdown-layout-changed', { bubbles: true }));
	});
}

function renderTableSourceToggle(table: MarkdownTable, expanded: boolean, view: EditorView): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'md-table-source-toggle';
	wrap.setAttribute('contenteditable', 'false');

	const button = document.createElement('button');
	button.className = 'md-table-source-toggle-btn';
	button.type = 'button';
	button.textContent = expanded ? 'hide table source' : 'show table source';
	button.setAttribute('aria-label', expanded ? 'Hide table source' : 'Show table source');
	button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
	button.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		dispatchTableToggle(view, table.id);
	});
	wrap.appendChild(button);
	return wrap;
}

function buildDecorations(state: MarkdownRenderState, doc: PMNode): DecorationSet {
	const decorations: Decoration[] = [];
	const tableLineStarts = new Set<number>();
	const codeLineStarts = new Set<number>();
	const codeFenceStarts = new Set<number>();
	const codeCoveredStarts = new Set<number>();

	for (const block of state.codeBlocks) {
		codeCoveredStarts.add(block.opening.from);
		codeCoveredStarts.add(block.closing.from);
		for (const line of block.sourceLines) codeCoveredStarts.add(line.from);
	}

	for (const table of state.tables) {
		if (table.insertAt > doc.content.size) continue;
		if (table.sourceLines.some((line) => codeCoveredStarts.has(line.from))) continue;
		const expanded = state.expandedTableIds.has(table.id);
		const firstLine = table.sourceLines[0];
		if (firstLine) {
			decorations.push(
				Decoration.widget(firstLine.to, (view) => renderTableSourceToggle(table, expanded, view), {
					side: 1,
					key: `${table.key}:source-toggle:${expanded ? 'open' : 'closed'}`,
					ignoreSelection: true
				})
			);
		}
		for (const line of table.sourceLines) {
			tableLineStarts.add(line.from);
			decorations.push(
				Decoration.node(line.from, line.to, {
					class: expanded
						? 'md-table-source-line md-table-source-line-expanded'
						: 'md-table-source-line md-table-source-line-hidden'
				})
			);
		}
		decorations.push(
			Decoration.widget(table.insertAt, () => renderTableWidget(table), {
				side: 1,
				key: `${table.key}:preview`,
				ignoreSelection: true
			})
		);
	}

	for (const block of state.codeBlocks) {
		const lang = block.language || 'code';
		const openingTextStart = block.opening.from + 1;
		const closingTextStart = block.closing.from + 1;
		const firstSource = block.sourceLines[0];
		const lastSource = block.sourceLines[block.sourceLines.length - 1];
		codeFenceStarts.add(block.opening.from);
		codeFenceStarts.add(block.closing.from);
		decorations.push(
			Decoration.node(block.opening.from, block.opening.to, {
				class: 'md-code-fence md-code-fence-open',
				'data-code-lang': lang
			}),
			Decoration.inline(openingTextStart, openingTextStart + block.markerLength, {
				class: 'md-code-fence-marker'
			})
		);
		if (block.language && block.languageOffset >= 0) {
			decorations.push(
				Decoration.inline(
					openingTextStart + block.languageOffset,
					openingTextStart + block.languageOffset + block.language.length,
					{ class: 'md-code-lang' }
				)
			);
		}
		for (const line of block.sourceLines) {
			codeLineStarts.add(line.from);
			const classes = ['md-code-block-line'];
			if (line === firstSource) classes.push('md-code-block-line-first');
			if (line === lastSource) classes.push('md-code-block-line-last');
			if (block.sourceLines.length === 1) classes.push('md-code-block-line-single');
			decorations.push(
				Decoration.node(line.from, line.to, {
					class: classes.join(' ')
				})
			);
		}
		decorations.push(
			Decoration.node(block.closing.from, block.closing.to, {
				class: 'md-code-fence md-code-fence-close'
			}),
			Decoration.inline(closingTextStart, closingTextStart + block.markerLength, {
				class: 'md-code-fence-marker'
			})
		);
	}

	doc.descendants((node, pos) => {
		if (node.type.name !== 'paragraph') return;
		const text = node.textContent;
		if (!text) return;
		const start = pos + 1;
		if (codeLineStarts.has(pos) || codeFenceStarts.has(pos)) return false;
		if (tableLineStarts.has(pos)) {
			addInlineDecorations(text, start, decorations);
			return false;
		}

		// Heading lines: # through ######
		const headingMatch = text.match(/^(#{1,6})\s/);
		if (headingMatch) {
			const level = headingMatch[1].length;
			decorations.push(
				Decoration.node(pos, pos + node.nodeSize, {
					class: `md-heading md-h${level}`
				})
			);
			decorations.push(
				Decoration.inline(start, start + headingMatch[0].length, {
					class: 'md-syntax'
				})
			);
			addInlineDecorations(text, start, decorations);
			return false;
		}

		// Blockquote lines: >
		const bqMatch = text.match(/^(>\s?)/);
		if (bqMatch) {
			decorations.push(
				Decoration.node(pos, pos + node.nodeSize, {
					class: 'md-blockquote'
				})
			);
			decorations.push(
				Decoration.inline(start, start + bqMatch[0].length, {
					class: 'md-syntax'
				})
			);
			addInlineDecorations(text, start, decorations);
			return false;
		}

		// Unordered list: - or * at start
		const ulMatch = text.match(/^(\s*[-*+]\s)/);
		if (ulMatch) {
			decorations.push(
				Decoration.node(pos, pos + node.nodeSize, {
					class: 'md-list-item'
				})
			);
			decorations.push(
				Decoration.inline(start, start + ulMatch[0].length, {
					class: 'md-syntax md-list-marker md-bullet'
				})
			);
			addInlineDecorations(text, start, decorations);
			return false;
		}

		// Ordered list: 1. 2. etc.
		const olMatch = text.match(/^(\s*\d+[.)]\s)/);
		if (olMatch) {
			decorations.push(
				Decoration.node(pos, pos + node.nodeSize, {
					class: 'md-list-item md-ol-item'
				})
			);
			decorations.push(
				Decoration.inline(start, start + olMatch[0].length, {
					class: 'md-syntax md-list-marker md-ordered-marker'
				})
			);
			addInlineDecorations(text, start, decorations);
			return false;
		}

		// Horizontal rule
		if (/^(---|\*\*\*|___)\s*$/.test(text)) {
			decorations.push(
				Decoration.node(pos, pos + node.nodeSize, {
					class: 'md-hr'
				})
			);
			return false;
		}

		// Regular paragraph: just inline decorations
		addInlineDecorations(text, start, decorations);
		return false;
	});

	return DecorationSet.create(doc, decorations);
}

function addInlineDecorations(
	text: string,
	start: number,
	decorations: Decoration[]
) {
	// Track which character positions are already decorated to avoid overlaps
	const claimed = new Set<number>();

	function claim(from: number, to: number): boolean {
		for (let i = from; i < to; i++) {
			if (claimed.has(i)) return false;
		}
		for (let i = from; i < to; i++) claimed.add(i);
		return true;
	}

	// Bold: **text** or __text__
	let m: RegExpExecArray | null;
	BOLD_RE.lastIndex = 0;
	while ((m = BOLD_RE.exec(text)) !== null) {
		const mLen = m[1].length; // 2 for ** or __
		const from = m.index;
		const to = from + m[0].length;
		if (!claim(from, to)) continue;
		// Dim opening marker
		decorations.push(
			Decoration.inline(start + from, start + from + mLen, { class: 'md-syntax' })
		);
		// Bold content
		decorations.push(
			Decoration.inline(start + from + mLen, start + to - mLen, { class: 'md-bold' })
		);
		// Dim closing marker
		decorations.push(
			Decoration.inline(start + to - mLen, start + to, { class: 'md-syntax' })
		);
	}

	// Italic: *text* or _text_ (not ** or __)
	ITALIC_RE.lastIndex = 0;
	while ((m = ITALIC_RE.exec(text)) !== null) {
		const from = m.index;
		const to = from + m[0].length;
		if (!claim(from, to)) continue;
		decorations.push(
			Decoration.inline(start + from, start + from + 1, { class: 'md-syntax' })
		);
		decorations.push(
			Decoration.inline(start + from + 1, start + to - 1, { class: 'md-italic' })
		);
		decorations.push(
			Decoration.inline(start + to - 1, start + to, { class: 'md-syntax' })
		);
	}

	// Inline code: `text`
	CODE_RE.lastIndex = 0;
	while ((m = CODE_RE.exec(text)) !== null) {
		const from = m.index;
		const to = from + m[0].length;
		if (!claim(from, to)) continue;
		decorations.push(
			Decoration.inline(start + from, start + from + 1, { class: 'md-syntax' })
		);
		decorations.push(
			Decoration.inline(start + from + 1, start + to - 1, { class: 'md-code' })
		);
		decorations.push(
			Decoration.inline(start + to - 1, start + to, { class: 'md-syntax' })
		);
	}

	// Strikethrough: ~~text~~
	STRIKETHROUGH_RE.lastIndex = 0;
	while ((m = STRIKETHROUGH_RE.exec(text)) !== null) {
		const from = m.index;
		const to = from + m[0].length;
		if (!claim(from, to)) continue;
		decorations.push(
			Decoration.inline(start + from, start + from + 2, { class: 'md-syntax' })
		);
		decorations.push(
			Decoration.inline(start + from + 2, start + to - 2, { class: 'md-strikethrough' })
		);
		decorations.push(
			Decoration.inline(start + to - 2, start + to, { class: 'md-syntax' })
		);
	}

	// Links: [text](url)
	LINK_RE.lastIndex = 0;
	while ((m = LINK_RE.exec(text)) !== null) {
		const from = m.index;
		const to = from + m[0].length;
		if (!claim(from, to)) continue;
		const linkTextEnd = from + 1 + m[1].length;
		// [ syntax
		decorations.push(
			Decoration.inline(start + from, start + from + 1, { class: 'md-syntax' })
		);
		// link text
		decorations.push(
			Decoration.inline(start + from + 1, start + linkTextEnd, { class: 'md-link-text' })
		);
		// ](url) part
		decorations.push(
			Decoration.inline(start + linkTextEnd, start + to, { class: 'md-syntax md-link-url' })
		);
	}
}

export const MarkdownRender = Extension.create({
	name: 'markdownRender',

	addProseMirrorPlugins() {
		return [
			new Plugin<MarkdownRenderState>({
				key: mdRenderKey,
				state: {
					init: (_config, instance): MarkdownRenderState => ({
						tables: scanTables(instance.doc),
						codeBlocks: scanCodeBlocks(instance.doc),
						expandedTableIds: new Set()
					}),
					apply(tr, prev): MarkdownRenderState {
						const meta = tr.getMeta(mdRenderKey) as TableToggleMeta | undefined;
						let next = prev;
						if (tr.docChanged) {
							const tables = scanTables(tr.doc);
							const codeBlocks = scanCodeBlocks(tr.doc);
							const tableIds = new Set(tables.map((table) => table.id));
							next = {
								tables,
								codeBlocks,
								expandedTableIds: new Set(
									Array.from(prev.expandedTableIds).filter((id) => tableIds.has(id))
								)
							};
						}
						if (meta?.type === 'table-toggle') {
							const expandedTableIds = new Set(next.expandedTableIds);
							if (expandedTableIds.has(meta.id)) expandedTableIds.delete(meta.id);
							else expandedTableIds.add(meta.id);
							next = { ...next, expandedTableIds };
						}
						return next;
					}
				},
				props: {
					decorations(state) {
						const s = mdRenderKey.getState(state);
						if (!s) return null;
						return buildDecorations(s, state.doc);
					}
				}
			})
		];
	}
});
