<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Editor } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';
	import Placeholder from '@tiptap/extension-placeholder';
	import { reproject } from '$lib/runtime-canonical';
	import { Pinned, UserEdit } from './pinned-mark';
	import { SYNC_TIMING } from '$lib/sync-timing';
	import type { Sentence, Action, Fragment, EditorPin, Section, Annotation } from '$lib/types';
	import type { AtomzPin, AtomzBlock } from '$lib/atomz';
	import type { SentenceTransition } from '$lib/stores';
	import {
		blocks,
		pins,
		prose,
		pushDocumentOp,
		pushHistory,
		selectedAction,
		annotations,
		recentActions,
		pinnedActions,
		trackActionUsage,
		actionUsageCounts,
		rules,
		paraBreaks,
		fragments,
		editorPins,
		sections,
		highlightedFrags,
		highlightedSents,
		sentenceTransitions,
		renderingSentences,
		clearUserEdits,
		undoBlocks,
		editorMode,
		agentChangedBlockIds,
		pendingEditBlockIds
	} from '$lib/stores';

	let element: HTMLDivElement;
	let editor: Editor | null = $state(null);
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let countdownInterval: ReturnType<typeof setInterval> | null = null;
	let lastContent = '';
	let hasUnsavedEdits = $state(false);
	let countdownSeconds = $state(0);
	let suppressUpdate = false;

	let currentMode: 'plaintext' | 'markdown' = $state('markdown');
	let plaintextValue = $state('');
	let plaintextBaseline = '';

	function proseToPlaintext(sentences: Sentence[]): string {
		return sentences.map((sentence) => sentence.text).join('\n');
	}

	function buildUpdatedProseFromPlaintext(text: string): Sentence[] {
		const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
		const updated: Sentence[] = [];
		for (let paraIdx = 0; paraIdx < lines.length; paraIdx++) {
			const line = lines[paraIdx];
			const existing = currentProse[paraIdx];
			if (existing) {
				updated.push({ ...existing, text: line });
				continue;
			}
			updated.push({ frags: [], para: paraIdx, text: line });
		}
		return updated.filter((sentence) => sentence.text.trim().length > 0);
	}

	function buildDiffSummary(before: string, after: string): string[] {
		const oldLines = new Set(before.split('\n').filter((line) => line.trim().length > 0));
		const newLines = new Set(after.split('\n').filter((line) => line.trim().length > 0));
		const added = [...newLines].filter((line) => !oldLines.has(line));
		const removed = [...oldLines].filter((line) => !newLines.has(line));
		const changes: string[] = [];
		for (const line of added) changes.push(`Added: "${line.slice(0, 80)}"`);
		for (const line of removed) changes.push(`Removed: "${line.slice(0, 80)}"`);
		if (changes.length === 0) {
			changes.push(`Text changed (${before.length} → ${after.length} chars)`);
		}
		return changes;
	}

	function normalizePinnedText(text: string): string {
		const normalized = text.trim().replace(/^[^\w]+|[^\w]+$/g, '').toLowerCase();
		return normalized || text.trim().toLowerCase();
	}

	function hasPinnedText(text: string, pinnedText: string): boolean {
		return text.toLowerCase().includes(normalizePinnedText(pinnedText));
	}

	function findFragmentById(frags: Fragment[], id: string): Fragment | null {
		for (const f of frags) {
			if (f.id === id) return f;
			for (const c of f.children || []) {
				if (c.id === id) return c;
			}
		}
		return null;
	}

	function commitPlaintextEdits() {
		if (plaintextValue === plaintextBaseline) return;
		// Build blocks from plaintext lines
		const lines = plaintextValue.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
		const existingMdBlocks = currentBlocks.filter((b): b is import('$lib/atomz').AtomzMarkdownBlock => b.type === 'markdown');
		const nextBlocks: AtomzBlock[] = [];
		let mdIdx = 0;
		for (const line of lines) {
			const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
			if (headingMatch) {
				nextBlocks.push({
					id: `block_heading_${nextBlocks.length}`,
					type: 'heading',
					level: headingMatch[1].length as 1 | 2 | 3,
					text: headingMatch[2]
				});
			} else {
				const existing = existingMdBlocks[mdIdx];
				nextBlocks.push({
					id: existing?.id || `block_markdown_${mdIdx + 1}`,
					type: 'markdown',
					markdown: line,
					atomIds: existing?.atomIds || []
				});
				mdIdx++;
			}
		}
		blocks.set(nextBlocks);
		reproject();
		pushDocumentOp({
			type: 'update_blocks',
			blocks: nextBlocks,
			source: 'editor'
		});
		plaintextBaseline = plaintextValue;
		hasUnsavedEdits = false;
		clearCountdown();
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	}

	editorMode.subscribe((v) => {
		const prev = currentMode;
		currentMode = v;
		if (prev === 'markdown' && v === 'plaintext') {
			// Always use canonical prose source so markdown markers (#, etc.) are preserved.
			plaintextValue = proseToPlaintext(currentProse);
			plaintextBaseline = plaintextValue;
			hasUnsavedEdits = false;
			clearCountdown();
			return;
		}
		if (prev === 'plaintext' && v === 'markdown' && editor) {
			commitPlaintextEdits();
			const html = proseToHtml(currentProse);
			if (editor.getHTML() !== html) {
				suppressUpdate = true;
				editor.commands.setContent(html || '<p></p>', { emitUpdate: false });
				suppressUpdate = false;
			}
			lastContent = editor.getText();
			buildSentenceRanges();
			if (hlSents.size > 0) applyEditorHighlight(hlSents);
		}
	});

	function onPlaintextInput() {
		// Same idle-timer logic as tiptap, but for the textarea
		hasUnsavedEdits = plaintextValue !== plaintextBaseline;
		if (!hasUnsavedEdits) {
			clearCountdown();
			if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
			return;
		}
		if (idleTimer) clearTimeout(idleTimer);
		startCountdown();
		idleTimer = setTimeout(() => {
			commitPlaintextEdits();
		}, SYNC_TIMING.editorIdleMs);
	}

	// Feedback popup state
	let feedbackPopup: { text: string; x: number; y: number } | null = $state(null);
	let feedbackText = $state('');
	let feedbackPopupEl: HTMLDivElement | null = $state(null);
	let feedbackOpenedAt = $state(0);

	let selected: Action | null = $state(null);
	selectedAction.subscribe((v) => (selected = v));

	let recent: Action[] = $state([]);
	recentActions.subscribe((v) => (recent = v));

	let allActions = $derived([...pinnedActions, ...recent]);

	let currentFragments: Fragment[] = $state([]);
	fragments.subscribe((v) => {
		currentFragments = v;
		if (editor) applyPinMarks();
	});

	let currentEditorPins: EditorPin[] = $state([]);
	editorPins.subscribe((v) => {
		currentEditorPins = v;
		if (editor) applyPinMarks();
	});

	let currentPins: AtomzPin[] = $state([]);
	pins.subscribe((v) => { currentPins = v; });

	let currentBlocks: AtomzBlock[] = $state([]);
	blocks.subscribe((v) => { currentBlocks = v; });

	let currentSections: Section[] = $state([]);
	sections.subscribe((v) => {
		currentSections = v;
	});

	let currentRules: typeof $rules = $state([]);
	rules.subscribe((v) => {
		currentRules = v;
	});

	let currentParaBreaks: Set<number> = $state(new Set());
	paraBreaks.subscribe((v) => {
		currentParaBreaks = v;
	});

	let currentProse: Sentence[] = $state([]);
	prose.subscribe((v) => {
		currentProse = v;
		if (currentMode === 'plaintext' && !hasUnsavedEdits) {
			plaintextValue = proseToPlaintext(v);
			plaintextBaseline = plaintextValue;
		}
		if (editor && !editor.isFocused) {
			updateEditorFromProse(v);
			return;
		}
		if (editor) {
			buildSentenceRanges();
			if (hlSents.size > 0) applyEditorHighlight(hlSents);
		}
	});

	// Bidirectional highlighting: sentence range map
	interface SentenceRange {
		from: number;
		to: number;
		sentIdx: number;
		frags: string[];
	}
	let sentenceRanges: SentenceRange[] = $state([]);

	/** Build a mapping from ProseMirror positions to sentence indices */
	function buildSentenceRanges() {
		if (!editor || currentProse.length === 0) {
			sentenceRanges = [];
			return;
		}
		const ranges: SentenceRange[] = [];
		const blockNodes: { pos: number; textStart: number }[] = [];
		editor.state.doc.descendants((node, pos) => {
			if ((node.type.name !== 'paragraph' && node.type.name !== 'heading') || !node.textContent.trim()) return;
			blockNodes.push({ pos, textStart: pos + 1 });
			return false;
		});
		type RenderedBlock = {
			type: 'paragraph' | 'heading';
			para: number;
			entries: { sentIdx: number; text: string; frags: string[] }[];
		};
		const renderedBlocks: RenderedBlock[] = [];
		for (let sentIdx = 0; sentIdx < currentProse.length; sentIdx++) {
			const sentence = currentProse[sentIdx];
			const headingMatch = sentence.text.match(/^(#{1,3})\s+(.+)/);
			if (headingMatch) {
				renderedBlocks.push({
					type: 'heading',
					para: sentence.para,
					entries: [{ sentIdx, text: headingMatch[2], frags: sentence.frags }]
				});
				continue;
			}
			const prevBlock = renderedBlocks[renderedBlocks.length - 1];
			if (prevBlock && prevBlock.type === 'paragraph' && prevBlock.para === sentence.para) {
				prevBlock.entries.push({ sentIdx, text: sentence.text, frags: sentence.frags });
				continue;
			}
			renderedBlocks.push({
				type: 'paragraph',
				para: sentence.para,
				entries: [{ sentIdx, text: sentence.text, frags: sentence.frags }]
			});
		}
		const blockCount = Math.min(blockNodes.length, renderedBlocks.length);
		for (let blockIdx = 0; blockIdx < blockCount; blockIdx++) {
			const blockNode = blockNodes[blockIdx];
			const rendered = renderedBlocks[blockIdx];
			let relPos = 0;
			for (let entryIdx = 0; entryIdx < rendered.entries.length; entryIdx++) {
				const entry = rendered.entries[entryIdx];
				const text = entry.text.trim();
				if (!text) continue;
				const from = blockNode.textStart + relPos;
				ranges.push({
					from,
					to: from + text.length,
					sentIdx: entry.sentIdx,
					frags: entry.frags
				});
				relPos += text.length;
				if (entryIdx < rendered.entries.length - 1) relPos += 1;
			}
		}
		sentenceRanges = ranges;
	}

	/** Handle mousemove over the editor to highlight corresponding atoms */
	function handleEditorMouseMove(e: MouseEvent) {
		// Don't highlight while user is selecting text (dragging)
		if (e.buttons !== 0) return;
		if (!editor || sentenceRanges.length === 0) return;
		const coords = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
		if (!coords) return;
		const pos = coords.pos;

		for (const range of sentenceRanges) {
			if (pos >= range.from && pos <= range.to) {
				highlightedSents.set(new Set([range.sentIdx]));
				highlightedFrags.set(new Set(range.frags));
				return;
			}
		}
		highlightedSents.set(new Set());
		highlightedFrags.set(new Set());
	}

	/** Clear highlights when mouse leaves the editor */
	function handleEditorMouseLeave() {
		highlightedSents.set(new Set());
		highlightedFrags.set(new Set());
	}

	// Subscribe to highlightedSents for atoms pane -> editor highlighting
	let hlSents: Set<number> = $state(new Set());
	highlightedSents.subscribe((v) => {
		hlSents = v;
		applyEditorHighlight(v);
	});

	// Feature 4: Clear UserEdit marks when agent finishes processing
	clearUserEdits.subscribe((v) => { if (v > 0 && editor) clearUserEditMarks(); });

	// Agent edit highlights — apply after a short delay to let DOM settle
	agentChangedBlockIds.subscribe(() => {
		if (!editor || !element) return;
		requestAnimationFrame(() => applyAgentHighlights());
	});

	// Pending user edit highlights — amber indicator on blocks awaiting agent
	pendingEditBlockIds.subscribe(() => {
		if (!editor || !element) return;
		requestAnimationFrame(() => applyPendingHighlights());
	});

	function applyPendingHighlights() {
		if (!editor || !element) return;
		let pendingIds: Set<string> = new Set();
		pendingEditBlockIds.subscribe((v) => (pendingIds = v))();
		element.querySelectorAll('.pending-edit').forEach((el) => el.classList.remove('pending-edit'));
		if (pendingIds.size === 0) return;
		let currentBlockList: import('$lib/atomz').AtomzBlock[] = [];
		blocks.subscribe((v) => (currentBlockList = v))();
		const pendingIndices = new Set<number>();
		currentBlockList.forEach((block, idx) => {
			if (pendingIds.has(block.id)) pendingIndices.add(idx);
		});
		let blockIdx = 0;
		editor.state.doc.descendants((node, pos) => {
			if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return;
			if (pendingIndices.has(blockIdx)) {
				try {
					const dom = editor!.view.nodeDOM(pos);
					if (dom instanceof HTMLElement) dom.classList.add('pending-edit');
				} catch {}
			}
			blockIdx++;
			return false;
		});
	}

	// Feature 6: Diff transitions
	let transitions: Map<number, SentenceTransition> = $state(new Map());
	sentenceTransitions.subscribe((v) => { transitions = v; });
	let hasPendingDiffs = $derived(transitions.size > 0 && [...transitions.values()].some(t => t.done));

	function acceptAll() { sentenceTransitions.set(new Map()); }
	function rejectAll() { sentenceTransitions.set(new Map()); undoBlocks(); }

	// Feature 7: Annotation rendering
	let annoList: Annotation[] = $state([]);
	annotations.subscribe((v) => { annoList = v; if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => applyAnnotationStyles()); });

	/** Apply/remove highlight on editor DOM for highlighted sentences */
	function applyEditorHighlight(sents: Set<number>) {
		const cssHighlights = (globalThis as any).CSS?.highlights;
		if (cssHighlights?.delete) cssHighlights.delete('sentence-hover-highlight');
		if (!editor || sents.size === 0 || sentenceRanges.length === 0) return;
		const HighlightCtor = (globalThis as any).Highlight;
		if (!HighlightCtor || !cssHighlights?.set) return;
		const inlineRanges: Range[] = [];
		for (const range of sentenceRanges) {
			if (!sents.has(range.sentIdx)) continue;
			try {
				const start = editor.view.domAtPos(range.from);
				const end = editor.view.domAtPos(range.to);
				const domRange = document.createRange();
				domRange.setStart(start.node, start.offset);
				domRange.setEnd(end.node, end.offset);
				inlineRanges.push(domRange);
			} catch { /* stale position */ }
		}
		if (inlineRanges.length === 0) return;
		cssHighlights.set('sentence-hover-highlight', new HighlightCtor(...inlineRanges));
	}

	/** Apply annotation styles (colored underlines) to annotated text in the editor */
	let prevAnnoElements: HTMLElement[] = [];
	function applyAnnotationStyles() {
		// Clear previous
		for (const el of prevAnnoElements) {
			el.style.borderBottom = '';
			el.style.paddingBottom = '';
			el.removeAttribute('title');
		}
		prevAnnoElements = [];

		if (!editor || !element || annoList.length === 0) return;

		// Walk text nodes in the editor and check against annotations
		const contentEl = element.querySelector('.tiptap-content');
		if (!contentEl) return;
		const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			const text = node.textContent || '';
			for (const anno of annoList) {
				if (text.includes(anno.text)) {
					const parent = node.parentElement;
					if (parent) {
						parent.style.borderBottom = `2px solid ${anno.action.color}`;
						parent.style.paddingBottom = '1px';
						parent.setAttribute('title', anno.action.label);
						prevAnnoElements.push(parent);
					}
				}
			}
		}
	}

	function proseToHtml(sentences: Sentence[]): string {
		if (sentences.length === 0) return '<p></p>';
		let html = '';
		let currentPara = -1;
		for (const s of sentences) {
			// Check if text is a markdown heading
			const hMatch = s.text.match(/^(#{1,3})\s+(.+)/);
			if (hMatch) {
				if (currentPara >= 0) html += '</p>';
				const level = hMatch[1].length;
				html += `<h${level}>${hMatch[2]}</h${level}>`;
				currentPara = -1; // reset so next paragraph opens fresh
				continue;
			}

			if (s.para !== currentPara) {
				if (currentPara >= 0) html += '</p>';
				html += '<p>';
				currentPara = s.para;
			} else {
				html += ' ';
			}
			html += s.text;
		}
		if (currentPara >= 0) html += '</p>';
		return html;
	}

	function syncEditorToBlocks() {
		if (!editor) return;
		const json = editor.getJSON();
		const nextBlocks: AtomzBlock[] = [];
		let mdBlockIdx = 0;

		// Build a list of existing markdown blocks for atomId preservation
		const existingMdBlocks = currentBlocks.filter((b): b is import('$lib/atomz').AtomzMarkdownBlock => b.type === 'markdown');

		for (const node of json.content || []) {
			if (node.type === 'heading') {
				const text = (node.content || []).map((c: any) => c.text || '').join('');
				if (text.trim()) {
					const level = (node.attrs?.level || 1) as 1 | 2 | 3;
					// Try to match an existing heading block
					const existingHeading = currentBlocks.find((b) =>
						b.type === 'heading' && (b as import('$lib/atomz').AtomzHeadingBlock).level === level
					);
					nextBlocks.push({
						id: existingHeading?.id || `block_heading_${nextBlocks.length}`,
						type: 'heading',
						level,
						text: text.trim()
					});
				}
			} else if (node.type === 'paragraph') {
				const text = (node.content || []).map((c: any) => c.text || '').join('');
				if (text.trim()) {
					const existing = existingMdBlocks[mdBlockIdx];
					nextBlocks.push({
						id: existing?.id || `block_markdown_${mdBlockIdx + 1}`,
						type: 'markdown',
						markdown: text.trim(),
						atomIds: existing?.atomIds || []
					});
					mdBlockIdx++;
				}
			}
		}

		// Detect which blocks changed
		const changedIds = new Set<string>();
		for (const nb of nextBlocks) {
			const ob = currentBlocks.find((b) => b.id === nb.id);
			if (!ob) { changedIds.add(nb.id); continue; }
			if (nb.type === 'heading' && ob.type === 'heading' && nb.text !== ob.text) changedIds.add(nb.id);
			if (nb.type === 'markdown' && ob.type === 'markdown' && nb.markdown !== ob.markdown) changedIds.add(nb.id);
		}

		blocks.set(nextBlocks);
		reproject();

		// Mark changed blocks as pending agent review
		if (changedIds.size > 0) {
			pendingEditBlockIds.update((existing) => {
				const next = new Set(existing);
				for (const id of changedIds) next.add(id);
				return next;
			});
		}

		pushDocumentOp({
			type: 'update_blocks',
			blocks: nextBlocks,
			source: 'editor'
		});
		buildSentenceRanges();
	}

	function updateEditorFromProse(sentences: Sentence[]) {
		if (!editor) return;
		const html = proseToHtml(sentences);
		const currentHtml = editor.getHTML();
		if (html !== currentHtml) {
			editor.commands.setContent(html, { emitUpdate: false });
			lastContent = editor.getText();
			hasUnsavedEdits = false;
			clearCountdown();
			applyPinMarks();
			requestAnimationFrame(() => {
				applyAnnotationStyles();
				applyAgentHighlights();
			});
		}
		buildSentenceRanges();
		if (hlSents.size > 0) applyEditorHighlight(hlSents);
	}

	/** Apply green glow to paragraphs the agent edited */
	function applyAgentHighlights() {
		if (!editor || !element) return;
		let changedIds: Set<string> = new Set();
		agentChangedBlockIds.subscribe((v) => (changedIds = v))();
		// Remove old highlights
		element.querySelectorAll('.agent-edited').forEach((el) => el.classList.remove('agent-edited'));
		if (changedIds.size === 0) return;
		// Map block IDs to indices
		let currentBlockList: import('$lib/atomz').AtomzBlock[] = [];
		blocks.subscribe((v) => (currentBlockList = v))();
		const changedIndices = new Set<number>();
		currentBlockList.forEach((block, idx) => {
			if (changedIds.has(block.id)) changedIndices.add(idx);
		});
		// Apply to matching editor nodes
		let blockIdx = 0;
		editor.state.doc.descendants((node, pos) => {
			if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return;
			if (changedIndices.has(blockIdx)) {
				try {
					const dom = editor!.view.nodeDOM(pos);
					if (dom instanceof HTMLElement) dom.classList.add('agent-edited');
				} catch {}
			}
			blockIdx++;
			return false;
		});
	}

	function clearCountdown() {
		if (countdownInterval) {
			clearInterval(countdownInterval);
			countdownInterval = null;
		}
		countdownSeconds = 0;
	}

	function startCountdown() {
		clearCountdown();
		countdownSeconds = Math.ceil(SYNC_TIMING.editorIdleMs / 1000);
		countdownInterval = setInterval(() => {
			countdownSeconds--;
			if (countdownSeconds <= 0) clearCountdown();
		}, 1000);
	}

	function onEditorUpdate() {
		if (!editor || suppressUpdate) return;
		const text = editor.getText();

		if (text === lastContent) {
			// User undid all changes — cancel everything and clear marks
			hasUnsavedEdits = false;
			clearCountdown();
			if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
			clearUserEditMarks();
			return;
		}

		hasUnsavedEdits = true;

		// Feature 4: Apply UserEdit mark to the paragraph being edited
		try {
			const { from } = editor.state.selection;
			const resolvedPos = editor.state.doc.resolve(from);
			const start = resolvedPos.start();
			const end = resolvedPos.end();
			suppressUpdate = true;
			editor.chain().setTextSelection({ from: start, to: end }).setMark('userEdit', { timestamp: Date.now() }).setTextSelection(from).run();
			suppressUpdate = false;
		} catch { suppressUpdate = false; }

		if (idleTimer) clearTimeout(idleTimer);
		startCountdown();

		idleTimer = setTimeout(() => {
			const newText = editor!.getText();
			if (newText !== lastContent) {
				const oldLines = new Set(lastContent.split('\n').filter(l => l.trim()));
				const newLines = new Set(newText.split('\n').filter(l => l.trim()));

				// Find actually added/removed lines (not just shifted)
				const added = [...newLines].filter(l => !oldLines.has(l));
				const removed = [...oldLines].filter(l => !newLines.has(l));

				const changes: string[] = [];
				for (const l of added) changes.push(`Added: "${l.slice(0, 80)}"`);
				for (const l of removed) changes.push(`Removed: "${l.slice(0, 80)}"`);

				// If no clear add/remove, fall back to a simple summary
				if (changes.length === 0) {
					changes.push(`Text changed (${lastContent.length} → ${newText.length} chars)`);
				}

				syncEditorToBlocks();

				lastContent = newText;
			}
			hasUnsavedEdits = false;
			clearCountdown();
			clearUserEditMarks();
		}, SYNC_TIMING.editorIdleMs);
	}

	function clearUserEditMarks() {
		if (!editor) return;
		suppressUpdate = true;
		editor.chain().selectAll().unsetMark('userEdit').setTextSelection(editor.state.selection.from).run();
		suppressUpdate = false;
	}

	/** Collect all pinned text from atoms (pinnedWords) and editor pins */
	function collectAllPinnedText(): string[] {
		const texts: string[] = [];
		function walkAtoms(frags: Fragment[]) {
			for (const f of frags) {
				if (f.pinnedWords) texts.push(...f.pinnedWords);
				if (f.children?.length) walkAtoms(f.children);
			}
		}
		walkAtoms(currentFragments);
		for (const pin of currentEditorPins) {
			if (pin.text.trim()) texts.push(pin.text.trim());
		}
		// Deduplicate (case-insensitive)
		const seen = new Set<string>();
		return texts.filter((t) => {
			const lower = t.toLowerCase();
			if (seen.has(lower)) return false;
			seen.add(lower);
			return true;
		});
	}

	/** Scan editor doc and apply pinned marks on all pinned text */
	function applyPinMarks() {
		if (!editor) return;
		const pinnedTexts = collectAllPinnedText();
		const pinnedType = editor.schema.marks.pinned;

		// Remove all existing pinned marks
		suppressUpdate = true;
		const { tr } = editor.state;
		editor.state.doc.descendants((node, pos) => {
			if (!node.isText) return;
			if (node.marks.some((m) => m.type.name === 'pinned')) {
				tr.removeMark(pos, pos + node.nodeSize, pinnedType);
			}
		});
		editor.view.dispatch(tr);

		if (pinnedTexts.length === 0) {
			suppressUpdate = false;
			return;
		}

		// Build regex matching all pinned texts (longest first to match phrases before words)
		const sorted = [...pinnedTexts].sort((a, b) => b.length - a.length);
		const escaped = sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
		const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');

		const { tr: tr2 } = editor.state;
		editor.state.doc.descendants((node, pos) => {
			if (!node.isText) return;
			const text = node.text || '';
			let match: RegExpExecArray | null;
			pattern.lastIndex = 0;
			while ((match = pattern.exec(text)) !== null) {
				tr2.addMark(pos + match.index, pos + match.index + match[0].length, pinnedType.create({ word: match[0].toLowerCase() }));
			}
		});
		if (tr2.steps.length > 0) editor.view.dispatch(tr2);
		suppressUpdate = false;
	}

	/** Pin the currently selected text in the editor */
	function pinSelectedText() {
		if (!editor || !feedbackPopup) return;
		const { from, to } = editor.state.selection;
		if (from === to) return;
		const selectedText = feedbackPopup.text.trim();
		const normalizedSelectedText = normalizePinnedText(selectedText);
		if (!normalizedSelectedText) return;
		buildSentenceRanges();
		const linkedRange = sentenceRanges.find((range) => from <= range.to && to >= range.from);
		const linkedFragIds = linkedRange?.frags || [];
		const paraIndex = linkedRange ? (currentProse[linkedRange.sentIdx]?.para ?? 0) : 0;

		// Apply pinned mark
		suppressUpdate = true;
		editor.chain().setTextSelection({ from, to }).setMark('pinned').run();
		suppressUpdate = false;

		// Build anchors for the new pin
		const anchors: AtomzPin['anchors'] = [];

		// Add atom anchors for linked fragments whose text contains the pinned text
		const matchingAtomIds: string[] = [];
		for (const fragId of linkedFragIds) {
			const frag = findFragmentById(currentFragments, fragId);
			if (frag && hasPinnedText(`${frag.subject} ${frag.predicate}`, normalizedSelectedText)) {
				anchors.push({ type: 'atom', atomId: fragId });
				matchingAtomIds.push(fragId);
			}
		}

		// Add block anchor — find the markdown block for this paragraph
		const mdBlocks = currentBlocks.filter((b): b is import('$lib/atomz').AtomzMarkdownBlock => b.type === 'markdown');
		const targetBlock = mdBlocks[paraIndex - 1]; // paraIndex is 1-based in block ordering
		if (targetBlock) {
			anchors.push({ type: 'block', blockId: targetBlock.id });
		}

		// Check if pin already exists
		const alreadyExists = currentPins.some((p) =>
			normalizePinnedText(p.value) === normalizedSelectedText &&
			anchors.some((a) => p.anchors.some((pa) =>
				(a.type === 'atom' && pa.type === 'atom' && a.atomId === pa.atomId) ||
				(a.type === 'block' && pa.type === 'block' && a.blockId === pa.blockId)
			))
		);

		if (!alreadyExists && anchors.length > 0) {
			const newPin: AtomzPin = {
				id: `pin_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
				kind: 'verbatim',
				value: normalizedSelectedText,
				anchors
			};
			pins.set([...currentPins, newPin]);
			reproject();
		}

		pushDocumentOp({
			type: 'pin_prose_text',
			text: normalizedSelectedText,
			para: paraIndex,
			linkedFragIds
		});

		if (matchingAtomIds.length > 0) {
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description: `Pinned "${normalizedSelectedText}" in prose and mirrored to atoms ${matchingAtomIds.join(', ')}`
			});
		} else if (linkedFragIds.length > 0) {
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description: `Pinned "${normalizedSelectedText}" in prose (agent sync needed for atoms ${linkedFragIds.join(', ')})`
			});
		} else {
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description: `Pinned "${normalizedSelectedText}" in prose`
			});
		}

		// Close popup
		feedbackPopup = null;
		feedbackText = '';
		window.getSelection()?.removeAllRanges();
	}

	// Text selection → feedback popup
	function handleMouseUp() {
		const sel = window.getSelection();
		const text = sel?.toString()?.trim();
		if (!text || text.length < 2) return;

		// Make sure selection is inside our editor
		if (!element?.contains(sel?.anchorNode as Node)) return;

		if (selected) {
			// Apply pinned action directly
			annotations.update((prev) => [
				...prev,
				{ id: 'ann' + Date.now(), text, action: selected! }
			]);
			trackActionUsage(selected!.label);
			const feedbackDesc = selected!.id === 'a_transition'
				? `Fix the transition at: "${text.slice(0, 40)}..." — smooth the flow between this sentence and the next one`
				: `Feedback "${selected!.label}" on: "${text.slice(0, 40)}..."`;
			pushDocumentOp({ type: 'feedback_request', description: feedbackDesc });
			pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Annotated "${text.slice(0, 30)}..." with "${selected!.label}"` });
			sel!.removeAllRanges();
		} else {
			const range = sel!.getRangeAt(0);
			const rect = range.getBoundingClientRect();
			feedbackPopup = { text, x: rect.left, y: rect.bottom + 4 };
			feedbackOpenedAt = Date.now();
			feedbackText = '';
		}
	}

	function submitInlineFeedback() {
		if (!feedbackText.trim() || !feedbackPopup) return;
		const label = feedbackText.trim();
		const existing = allActions.find((a) => a.label.toLowerCase() === label.toLowerCase());
		const action: Action = existing || {
			id: 'a_' + Date.now(),
			label,
			icon: 'message-square',
			pinned: false,
			color: '#6366f1'
		};
		annotations.update((prev) => [
			...prev,
			{ id: 'ann' + Date.now(), text: feedbackPopup!.text, action }
		]);
		trackActionUsage(label);
		pushDocumentOp({ type: 'feedback_request', description: `Feedback "${label}" on: "${feedbackPopup!.text.slice(0, 40)}..."` });
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Feedback: "${label}" on "${feedbackPopup!.text.slice(0, 30)}..."` });
		if (!existing) {
			recentActions.update((prev) => [action, ...prev].slice(0, 6));
		}
		feedbackPopup = null;
		feedbackText = '';
		window.getSelection()?.removeAllRanges();
	}

	function applyQuickAction(action: Action) {
		if (!feedbackPopup) return;
		annotations.update((prev) => [
			...prev,
			{ id: 'ann' + Date.now(), text: feedbackPopup!.text, action }
		]);
		trackActionUsage(action.label);
		pushDocumentOp({ type: 'feedback_request', description: `Feedback "${action.label}" on: "${feedbackPopup!.text.slice(0, 40)}..."` });
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Annotated "${feedbackPopup!.text.slice(0, 30)}..." with "${action.label}"` });
		if (!action.pinned) {
			recentActions.update((prev) =>
				[action, ...prev.filter((x) => x.id !== action.id)].slice(0, 6)
			);
		}
		feedbackPopup = null;
		window.getSelection()?.removeAllRanges();
	}

	function handleWindowClick(e: MouseEvent) {
		if (!feedbackPopup) return;
		if (Date.now() - feedbackOpenedAt < 200) return;
		if (feedbackPopupEl && feedbackPopupEl.contains(e.target as Node)) return;
		feedbackPopup = null;
		feedbackText = '';
	}

	onMount(() => {
		editor = new Editor({
			element,
			extensions: [
				StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
				Placeholder.configure({ placeholder: 'Start writing or import a document...' }),
				Pinned,
				UserEdit
			],
			content: proseToHtml(currentProse),
			editorProps: { attributes: { class: 'tiptap-content' } },
			enableInputRules: currentMode === 'markdown',
			enablePasteRules: currentMode === 'markdown',
			onUpdate: () => onEditorUpdate()
		});
		lastContent = editor.getText();
		plaintextValue = proseToPlaintext(currentProse);
		plaintextBaseline = plaintextValue;
		buildSentenceRanges();
		applyPinMarks();
		applyPinMarks();
	});

	onDestroy(() => {
		if (editor) editor.destroy();
		if (idleTimer) clearTimeout(idleTimer);
		clearCountdown();
	});
</script>

<svelte:window onclick={handleWindowClick} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="tiptap-wrapper" onmouseup={handleMouseUp}>
	<div class="plaintext-editor" class:hidden={currentMode !== 'plaintext'}>
		<textarea
			class="plaintext-textarea"
			bind:value={plaintextValue}
			oninput={onPlaintextInput}
			placeholder="Start writing..."
			spellcheck="false"
		></textarea>
	</div>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="tiptap-editor" class:hidden={currentMode !== 'markdown'} bind:this={element} onmousemove={handleEditorMouseMove} onmouseleave={handleEditorMouseLeave}></div>

	<!-- Feature 6: Accept/Reject bar for agent diffs -->
	{#if hasPendingDiffs}
		<div class="accept-all-bar">
			<span class="accept-all-label">{transitions.size} pending {transitions.size === 1 ? 'edit' : 'edits'}</span>
			<button class="accept-all-btn" onclick={acceptAll}>Accept all</button>
			<button class="reject-all-btn" onclick={rejectAll}>Reject all</button>
		</div>
	{/if}

	{#if hasUnsavedEdits}
		<div class="edit-indicator">
			<span class="edit-dot"></span>
			{#if countdownSeconds > 0}
				Queuing feedback in {countdownSeconds}s
			{:else}
				Queuing...
			{/if}
		</div>
	{/if}

	<!-- Inline feedback popup on text selection -->
	{#if feedbackPopup}
		<div
			class="feedback-popup"
			bind:this={feedbackPopupEl}
			style:left="{Math.min(feedbackPopup.x, (typeof window !== 'undefined' ? window.innerWidth : 800) - 420)}px"
			style:top="{feedbackPopup.y}px"
		>
			<div class="feedback-quote">
				"{feedbackPopup.text.slice(0, 50)}{feedbackPopup.text.length > 50 ? '...' : ''}"
			</div>
			<button class="pin-btn" onclick={pinSelectedText}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V5a1 1 0 0 1 1-1 1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z"/></svg>
				Pin this text
			</button>
			<div class="feedback-input-row">
				<textarea
					class="feedback-input"
					bind:value={feedbackText}
					oninput={(e) => {
						const el = e.currentTarget;
						el.style.height = 'auto';
						el.style.height = el.scrollHeight + 'px';
					}}
					onkeydown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitInlineFeedback(); }
						if (e.key === 'Escape') { feedbackPopup = null; window.getSelection()?.removeAllRanges(); }
					}}
					placeholder="What's wrong with this?"
					rows={1}
				></textarea>
				<button class="feedback-submit" onclick={submitInlineFeedback}>Go</button>
			</div>
			<div class="quick-actions">
				{#each allActions.slice(0, 6) as action}
					<button class="quick-btn" onclick={() => applyQuickAction(action)}>
						{action.label}
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.tiptap-wrapper {
		flex: 1;
		position: relative;
		height: 100%;
		display: flex;
		flex-direction: column;
	}
	.tiptap-editor {
		flex: 1;
		overflow-y: auto;
		padding: 32px 48px 80px;
		background: var(--prose-bg);
	}

	.tiptap-editor :global(.tiptap-content) {
		max-width: 600px;
		margin: 0 auto;
		outline: none;
		font-size: 15px;
		line-height: 1.85;
		color: var(--prose-text);
	}

	.tiptap-editor :global(.tiptap-content p) {
		margin: 0 0 24px;
	}

	.tiptap-editor :global(.tiptap-content h1) {
		font-size: 24px;
		font-weight: 700;
		margin: 32px 0 16px;
		color: var(--text);
	}

	.tiptap-editor :global(.tiptap-content h2) {
		font-size: 20px;
		font-weight: 600;
		margin: 28px 0 12px;
		color: var(--text);
	}

	.tiptap-editor :global(.tiptap-content h3) {
		font-size: 17px;
		font-weight: 600;
		margin: 24px 0 8px;
		color: var(--text);
	}

	.tiptap-editor :global(.tiptap-content .is-editor-empty:first-child::before) {
		content: attr(data-placeholder);
		float: left;
		color: var(--text-faint);
		pointer-events: none;
		height: 0;
	}

	/* Pending user edit — amber left border, waiting for agent */
	.tiptap-editor :global(.pending-edit) {
		border-left: 3px solid #f59e0b;
		padding-left: 8px;
		position: relative;
	}
	.tiptap-editor :global(.pending-edit)::after {
		content: 'queued';
		position: absolute;
		right: 0;
		top: 0;
		font-size: 9px;
		color: #f59e0b;
		opacity: 0.6;
		font-family: inherit;
	}

	/* Agent edit highlights */
	.tiptap-editor :global(.agent-edited) {
		background: color-mix(in srgb, #10b981 12%, transparent);
		border-radius: 4px;
		box-shadow: 0 0 12px color-mix(in srgb, #10b981 20%, transparent);
		position: relative;
		animation: agent-fade 5s ease-out forwards;
	}
	.tiptap-editor :global(.agent-edited)::before {
		content: '';
		position: absolute;
		left: -4px;
		top: 0;
		width: 3px;
		height: 100%;
		background: #10b981;
		border-radius: 2px;
		animation: agent-cursor-fade 5s ease-out forwards;
	}
	@keyframes agent-fade {
		0% { background: color-mix(in srgb, #10b981 15%, transparent); box-shadow: 0 0 12px color-mix(in srgb, #10b981 25%, transparent); }
		70% { background: color-mix(in srgb, #10b981 10%, transparent); box-shadow: 0 0 8px color-mix(in srgb, #10b981 15%, transparent); }
		100% { background: transparent; box-shadow: none; }
	}
	@keyframes agent-cursor-fade {
		0% { opacity: 1; }
		70% { opacity: 0.6; }
		100% { opacity: 0; }
	}

	.tiptap-editor :global(.pinned-mark) {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		border-radius: 3px;
		padding: 0 2px;
		box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 25%, transparent);
	}
	.tiptap-editor :global(.pinned-mark)::before {
		content: '';
		display: inline-block;
		width: 10px;
		height: 10px;
		margin-right: 2px;
		vertical-align: middle;
		opacity: 0.5;
		background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%237c3aed' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cline x1='12' y1='17' x2='12' y2='22'/%3E%3Cpath d='M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z'/%3E%3C/svg%3E") no-repeat center / contain;
	}

	/* Plaintext mode */
	.plaintext-editor {
		flex: 1;
		overflow-y: auto;
		padding: 32px 48px 80px;
		background: var(--prose-bg);
	}
	.plaintext-editor.hidden,
	.tiptap-editor.hidden {
		display: none;
	}
	.plaintext-textarea {
		width: 100%;
		max-width: 600px;
		margin: 0 auto;
		display: block;
		min-height: calc(100vh - 200px);
		border: none;
		outline: none;
		resize: none;
		background: transparent;
		font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
		font-size: 14px;
		line-height: 1.7;
		color: var(--prose-text);
		tab-size: 4;
	}

	/* User-edited text gets a subtle colored left border + background */
	.tiptap-editor :global([data-user-edit]) {
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		border-left: 2px solid var(--accent);
		padding-left: 3px;
		margin-left: -5px;
		border-radius: 2px;
	}

	/* Sentence highlight when hovering atoms or editor text */
	:global(::highlight(sentence-hover-highlight)) {
		background: color-mix(in srgb, var(--accent) 16%, transparent);
	}

	/* Accept/Reject bar */
	.accept-all-bar { position: absolute; bottom: 90px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 8px 14px; background: var(--bg-elevated); border: 1px solid var(--border-light); border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); z-index: 35; white-space: nowrap; }
	.accept-all-label { font-size: 13px; color: var(--text-muted); }
	.accept-all-btn { padding: 6px 14px; border-radius: 6px; border: 1px solid #bbf7d0; background: #f0fdf4; color: #16a34a; font-size: 12px; font-weight: 500; cursor: pointer; font-family: inherit; }
	.accept-all-btn:hover { background: #dcfce7; }
	.reject-all-btn { padding: 6px 14px; border-radius: 6px; border: 1px solid #fecaca; background: #fef2f2; color: #dc2626; font-size: 12px; font-weight: 500; cursor: pointer; font-family: inherit; }
	.reject-all-btn:hover { background: #fee2e2; }

	.edit-indicator {
		position: absolute;
		bottom: 60px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 14px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 20px;
		font-size: 12px;
		color: var(--text-muted);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
		z-index: 30;
		white-space: nowrap;
		animation: fadeIn 0.2s ease;
	}
	.edit-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		animation: pulse 1.5s ease-in-out infinite;
	}
	@keyframes fadeIn {
		from { opacity: 0; transform: translateX(-50%) translateY(4px); }
		to { opacity: 1; transform: translateX(-50%) translateY(0); }
	}
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	/* Feedback popup */
	.feedback-popup {
		position: fixed;
		z-index: 200;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 12px;
		box-shadow: 0 12px 36px rgba(0, 0, 0, 0.12);
		padding: 16px 18px;
		width: 400px;
	}
	.feedback-quote {
		font-size: 13px;
		color: var(--text-faint);
		margin-bottom: 10px;
		line-height: 1.4;
	}
	.pin-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 8px 12px;
		margin-bottom: 10px;
		border-radius: 8px;
		border: 1px solid #f59e0b40;
		background: #f59e0b10;
		color: #b45309;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		font-family: inherit;
		transition: background 0.15s, border-color 0.15s;
	}
	.pin-btn:hover {
		background: #f59e0b20;
		border-color: #f59e0b80;
	}
	.feedback-input-row {
		display: flex;
		gap: 6px;
	}
	.feedback-input {
		flex: 1;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		padding: 10px 14px;
		font-size: 15px;
		font-family: inherit;
		outline: none;
		color: var(--text);
		background: var(--bg);
		resize: none;
		overflow: hidden;
		line-height: 1.5;
		min-height: 42px;
		max-height: 200px;
	}
	.feedback-input:focus {
		border-color: var(--accent-light);
		box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.08);
	}
	.feedback-submit {
		padding: 10px 20px;
		border-radius: 8px;
		border: none;
		background: var(--accent);
		color: white;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		font-family: inherit;
		align-self: flex-end;
	}
	.quick-actions {
		display: flex;
		gap: 5px;
		flex-wrap: wrap;
		margin-top: 12px;
	}
	.quick-btn {
		padding: 6px 12px;
		border-radius: 6px;
		border: 1px solid var(--border-light);
		background: var(--bg-surface);
		color: var(--text-muted);
		font-size: 13px;
		cursor: pointer;
		font-family: inherit;
	}
	.quick-btn:hover {
		background: var(--accent-bg);
		border-color: var(--accent-light);
		color: var(--accent);
	}
</style>
