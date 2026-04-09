<script lang="ts">
	import { onMount } from 'svelte';
	import { Settings, Undo2, MessageSquareText, FolderOpen, History, XCircle, RotateCcw } from 'lucide-svelte';
	import { normalizeAtomzFile, uploadText, buildAtomzFileFromCanonicalState, buildBlocksFromRuntimeView, type AtomzBlock, type AtomzPin } from '$lib/atomz';
	import { applyCanonicalFileToStores, reproject, getCanonicalRuntimeStateFromStores } from '$lib/runtime-canonical';
import { applyDocumentOp } from '$lib/document-op-utils';
import { buildDocumentOpProcessingPlan } from '$lib/document-op-processing';
import { SYNC_TIMING } from '$lib/sync-timing';
	import { themes, applyTheme } from '$lib/themes';
	import { wordDiff } from '$lib/diff';
	import type { DiffPart } from '$lib/diff';
	import ActionToolbar from '$lib/components/ActionToolbar.svelte';
	import RulesPanel from '$lib/components/RulesPanel.svelte';
	import ContentPane from '$lib/components/ContentPane.svelte';
	import TiptapEditor from '$lib/editor/TiptapEditor.svelte';
	import HistoryPane from '$lib/components/HistoryPane.svelte';
	import PanelResizer from '$lib/components/PanelResizer.svelte';
	import {
		atoms,
		fragments,
		rules,
		agentChangedBlockIds,
		agentChangedAtomIds,
		pendingEditBlockIds,
		paraBreaks,
		prose,
		isRendering,
		annotations,
		renderingSentences,
		sentenceTransitions,
		documentOps,
		checkpoints,
		blockHistory,
		pushBlockSnapshot,
		undoBlocks,
		agentHistory,
		showHistory,
		pushHistory,
		selectedModel,
		selectedTheme,
		blocks,
		editorPins,
		pins,
		sections,
		clearUserEdits,
		editorMode
	} from '$lib/stores';
	import type { Fragment, Sentence, DocumentOp } from '$lib/types';

	let showRules = $state(false);
	let rendering = $state(false);
	let currentAbort: AbortController | null = $state(null);
	const persistedDocumentOpIds = new Set<string>();
	const pendingDocumentOpPersistIds = new Set<string>();
	let isReplayingDocumentOps = $state(false);

	function cancelRender() {
		if (currentAbort) {
			currentAbort.abort();
			currentAbort = null;
			isRendering.set(false);
			renderingSentences.set(new Set());
			pushHistory({ type: 'render_end', timestamp: Date.now(), success: false, durationMs: 0 });
		}
	}

	async function newSession() {
		if (rendering) cancelRender();
		// Cancel any pending op processing timer to prevent race with warmup
		if (opDebounceTimer) { clearTimeout(opDebounceTimer); opDebounceTimer = null; }
		// Wait for any in-flight processOps to finish
		await waitForProcessing();
		// Clear server session
		await fetch('/api/session', { method: 'DELETE' });
		// Clear client history
		agentHistory.set([]);
		// Clear pending ops
		await resetPendingState();
		showHistory.set(true);
		pushHistory({ type: 'user_action', timestamp: Date.now(), description: 'Started new session' });
		// Warmup: agent reads and understands the document
		await doRender(undefined, undefined, false, true);
	}

	// Panel widths
	let atomsWidth = $state(480); // px
	let historyWidth = $state(380); // px
	isRendering.subscribe((v) => (rendering = v));

	let hasUndo = $state(false);
	blockHistory.subscribe((v) => (hasUndo = v.length > 0));

	let historyVisible = $state(true);
	showHistory.subscribe((v) => (historyVisible = v));

	let currentProse: Sentence[] = $state([]);
	prose.subscribe((v) => (currentProse = v));

	// Version history — backed by .atomz-history.json on disk (persists across refreshes)
	let showVersions = $state(false);
	let versionOpenedAt = $state(0);
	let diffVersionIndex: number | null = $state(null); // index into versions array

	interface VersionEntry {
		prose: Sentence[];
		timestamp: number;
		trigger: string;
		index: number;
	}
	let versions: VersionEntry[] = $state([]);

	async function loadVersions() {
		try {
			const res = await fetch('/api/versions');
			const data = await res.json();
			versions = (data.versions || []).map((v: any, i: number) => ({
				prose: v.prose.map((p: any) => ({ text: p.text, frags: p.frags, para: p.para })),
				timestamp: v.timestamp,
				trigger: v.trigger || '',
				index: i
			})).reverse(); // newest first
		} catch { versions = []; }
	}

	function selectVersionForDiff(idx: number) {
		diffVersionIndex = idx;
		showVersions = false;
	}

	async function restoreVersion() {
		if (diffVersionIndex === null) return;
		try {
			const res = await fetch('/api/versions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ index: diffVersionIndex })
			});
			const data = await res.json();
			if (data.document) {
				await resetPendingState();
				applyCanonicalDocument(normalizeAtomzFile(data.document));
				pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Restored version from ${formatTime(versions.find(v => v.index === diffVersionIndex)?.timestamp ?? 0)}` });
			}
		} catch (e) {
			console.error('Failed to restore version:', e);
		}
		diffVersionIndex = null;
	}

	function closeDiffView() {
		diffVersionIndex = null;
	}

	// Compute paragraph diffs between selected old version and current prose
	let paragraphDiffs = $derived.by(() => {
		if (diffVersionIndex === null) return [];
		const version = versions.find(v => v.index === diffVersionIndex);
		if (!version) return [];

		function groupByPara(sentences: Sentence[]): string[] {
			const paras: Map<number, string[]> = new Map();
			for (const s of sentences) {
				if (!paras.has(s.para)) paras.set(s.para, []);
				paras.get(s.para)!.push(s.text);
			}
			return [...paras.values()].map(texts => texts.join(' '));
		}

		const oldParas = groupByPara(version.prose);
		const newParas = groupByPara(currentProse);
		const maxLen = Math.max(oldParas.length, newParas.length);

		const diffs: { parts: DiffPart[]; changed: boolean }[] = [];
		for (let i = 0; i < maxLen; i++) {
			const oldP = oldParas[i] || '';
			const newP = newParas[i] || '';
			if (oldP === newP) {
				diffs.push({ parts: [{ text: newP, type: 'same' }], changed: false });
			} else {
				diffs.push({ parts: wordDiff(oldP, newP), changed: true });
			}
		}
		return diffs;
	});

	function formatTime(ts: number): string {
		const now = Date.now();
		const diffMs = now - ts;
		if (diffMs < 60000) return 'just now';
		if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
		if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;
		return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	function getVersionDiffSummary(versionProse: Sentence[]): string {
		const oldWords = versionProse.map(s => s.text).join(' ').split(/\s+/).length;
		const newWords = currentProse.map(s => s.text).join(' ').split(/\s+/).length;
		const diff = newWords - oldWords;
		if (diff > 0) return `+${diff} words since`;
		if (diff < 0) return `${diff} words since`;
		return 'no change';
	}

	function handleVersionClick(e: MouseEvent) {
		if (showVersions) {
			const wrapper = document.querySelector('.version-wrapper');
			if (wrapper && !wrapper.contains(e.target as Node) && Date.now() - versionOpenedAt > 200) {
				showVersions = false;
			}
		}
	}

	// Open — handles both .atomz files and raw text
	let importing = $state(false);

	async function handleOpen() {
		try {
			// Try as .atomz first
			const input = document.createElement('input');
			input.type = 'file';
			input.accept = '.atomz,.json,.txt,.md';

			const file = await new Promise<File>((resolve, reject) => {
				input.onchange = () => input.files?.[0] ? resolve(input.files[0]) : reject();
				input.click();
			});

			const text = await file.text();
			const isAtomz = file.name.endsWith('.atomz') || file.name.endsWith('.json');

			if (isAtomz) {
				// Load directly
				await resetPendingState();
				applyCanonicalDocument(normalizeAtomzFile(text));
				pushHistory({ type: 'user_action', timestamp: Date.now(), description: `Opened ${file.name}` });
			} else {
				// Atomize raw text
				importing = true;
				showHistory.set(true);
				pushHistory({ type: 'render_start', timestamp: Date.now(), trigger: `Atomize: ${file.name}` });

				const res = await fetch('/api/atomize', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ text, model })
				});

				await readSSE(res, {
					onToolCall: (data) => {
						pushHistory({ type: 'tool_call', timestamp: Date.now(), tool_name: data.tool_name, input: data.input });
					},
					onAssistantText: (data) => {
						agentHistory.update((h) => {
							const last = h[h.length - 1];
							if (last && last.type === 'assistant_text') return [...h.slice(0, -1), { ...last, text: last.text + data.text }];
							return [...h, { type: 'assistant_text' as const, timestamp: Date.now(), text: data.text }];
						});
					},
					onResult: (data) => {
						// Server already wrote document.atomz before sending this result.
						if (data.document) {
							applyCanonicalDocument(normalizeAtomzFile(data.document));
							return;
						}
						// Fallback: build blocks from returned atoms+sentences
						const frags = (data.fragments as Fragment[]) || [];
						const sents = data.sentences || [];
						const newBlocks = buildBlocksFromRuntimeView({ atoms: frags, prose: sents });
						atoms.set(frags);
						blocks.set(newBlocks);
						pins.set([]);
						reproject();
					}
				});
				await resetPendingState();

				pushHistory({ type: 'render_end', timestamp: Date.now(), success: true });
				importing = false;
			}
		} catch { /* cancelled */ }
	}

	// Reference import popover state
	let refPopover: 'own' | 'inspo' | null = $state(null);
	let refText = $state('');
	let refUrl = $state('');

	async function submitReference() {
		if (!refText.trim() && !refUrl.trim()) return;
		const tag = refPopover!;
		const url = refUrl.trim();
		const rawText = refText.trim();
		refPopover = null;
		refText = '';
		refUrl = '';

		const text = url
			? `Fetch and analyze the writing at: ${url}\nIf it's a blog, follow 2-3 relevant links by the same author.`
			: rawText;
		let name: string;
		try { name = url ? new URL(url).hostname : `${tag}-${Date.now()}`; } catch { name = url || `${tag}-${Date.now()}`; }

		showHistory.set(true);
		pushHistory({ type: 'render_start', timestamp: Date.now(), trigger: `Reference (${tag}): ${name}` });

		try {
			const body = { text, name, tag, model };

			const res = await fetch('/api/import-reference', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			await readSSE(res, {
				onToolCall: (data) => {
					pushHistory({ type: 'tool_call', timestamp: Date.now(), tool_name: data.tool_name, input: data.input });
				},
				onAssistantText: (data) => {
					agentHistory.update((h) => {
						const last = h[h.length - 1];
						if (last && last.type === 'assistant_text') return [...h.slice(0, -1), { ...last, text: last.text + data.text }];
						return [...h, { type: 'assistant_text' as const, timestamp: Date.now(), text: data.text }];
					});
				},
				onResult: () => {}
			});
			pushHistory({ type: 'render_end', timestamp: Date.now(), success: true });
		} catch (e) {
			console.error('Import reference failed:', e);
			pushHistory({ type: 'render_end', timestamp: Date.now(), success: false });
		}
	}

	async function attachRefFile() {
		try {
			const { text } = await uploadText();
			refText = text;
		} catch { /* cancelled */ }
	}

	// SSE reader
	async function readSSE(
		res: Response,
		callbacks: {
			onResult: (data: { sentences?: Sentence[]; document?: unknown; selective?: boolean; fragments?: unknown[]; paraBreaks?: number[] }) => void;
			onToolCall?: (data: { tool_name: string; input: Record<string, unknown> }) => void;
			onToolCallStart?: (data: { tool_name: string }) => void;
			onAssistantText?: (data: { text: string }) => void;
			onTextStreaming?: (data: { new_text: string; old_text: string }) => void;
			onCheckpoint?: (data: { id: string; sessionId: string; timestamp: number }) => void;
		}
	) {
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			let eventType = '';
			for (const line of lines) {
				if (line.startsWith('event: ')) {
					eventType = line.slice(7);
				} else if (line.startsWith('data: ') && eventType) {
					const data = JSON.parse(line.slice(6));
					if (eventType === 'result' && (data.document || data.sentences || data.fragments)) {
						callbacks.onResult(data);
					} else if (eventType === 'tool_call_start' && callbacks.onToolCallStart) {
						callbacks.onToolCallStart(data);
					} else if (eventType === 'tool_call' && callbacks.onToolCall) {
						callbacks.onToolCall(data);
					} else if (eventType === 'assistant_text' && callbacks.onAssistantText) {
						callbacks.onAssistantText(data);
					} else if (eventType === 'text_streaming' && callbacks.onTextStreaming) {
						callbacks.onTextStreaming(data);
					} else if (eventType === 'checkpoint' && callbacks.onCheckpoint) {
						callbacks.onCheckpoint(data);
					}
					eventType = '';
				}
			}
		}
	}

	// Clear annotations whose text no longer appears in current prose
	function clearStaleAnnotations() {
		let currentProse: Sentence[];
		prose.subscribe((v) => (currentProse = v))();
		const allText = currentProse!.map((s) => s.text).join(' ');
		annotations.update((annos) =>
			annos.filter((a) => allText.includes(a.text))
		);
	}

	let model = $state('opus');
	selectedModel.subscribe((v) => (model = v));

	let themeName = $state('light');
	selectedTheme.subscribe((v) => (themeName = v));

	let edMode = $state('markdown');
	editorMode.subscribe((v) => (edMode = v));

	function setTheme(name: string) {
		const theme = themes.find((t) => t.name === name);
		if (theme) {
			selectedTheme.set(name);
			applyTheme(theme);
		}
	}

	function applyCanonicalDocument(file: ReturnType<typeof normalizeAtomzFile>) {
		applyCanonicalFileToStores(file);
	}

	async function resetPendingState() {
		documentOps.set([]);
		persistedDocumentOpIds.clear();
		pendingDocumentOpPersistIds.clear();
		await fetch('/api/document-ops', { method: 'DELETE' }).catch(() => {});
	}

	async function loadPendingDocumentOps() {
		let hasReplayedOps = false;
		try {
			const res = await fetch('/api/document-ops');
			const data = await res.json();
			const ops = ((data.ops || []) as DocumentOp[]).sort((a, b) => a.createdAt - b.createdAt);
			persistedDocumentOpIds.clear();
			for (const op of ops) persistedDocumentOpIds.add(op.id);
			if (ops.length === 0) {
				documentOps.set([]);
				return;
			}
			hasReplayedOps = true;
			// Set BEFORE documentOps.set so subscriptions see the flag
			isReplayingDocumentOps = true;
			documentOps.set(ops);
			const state = getCurrentDocumentState();
			let currentBlk: AtomzBlock[] = [], currentPn: AtomzPin[] = [];
			blocks.subscribe((v) => (currentBlk = v))();
			pins.subscribe((v) => (currentPn = v))();
			let replayed = { ...state, blocks: currentBlk, pins: currentPn };
			for (const op of ops) {
				replayed = { ...replayed, ...applyDocumentOp(replayed, op) };
			}
			blocks.set(replayed.blocks);
			pins.set(replayed.pins);
			atoms.set(replayed.atoms);
			rules.set(replayed.rules);
			reproject();
		} catch {
			documentOps.set([]);
		} finally {
			isReplayingDocumentOps = false;
			// Trigger op processing for any unresolved ops from the WAL
			scheduleOpProcessing();
		}
	}

	async function persistDocumentOp(op: DocumentOp): Promise<boolean> {
		if (persistedDocumentOpIds.has(op.id) || pendingDocumentOpPersistIds.has(op.id)) return true;
		pendingDocumentOpPersistIds.add(op.id);
		try {
			const res = await fetch('/api/document-ops', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ops: [op] })
			});
			if (!res.ok) return false;
			persistedDocumentOpIds.add(op.id);
			return true;
		} catch {
			return false;
		} finally {
			pendingDocumentOpPersistIds.delete(op.id);
		}
	}

	async function resolvePendingDocumentOps(ops: DocumentOp[]) {
		if (ops.length === 0) return;
		await fetch('/api/document-ops', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids: ops.map((op) => op.id) })
		}).catch(() => {});
		documentOps.update((existingOps) => existingOps.filter((op) => !ops.some((resolvedOp) => resolvedOp.id === op.id)));
	}

	onMount(async () => {
		applyTheme(themes[0]);

		// Load document from file
		try {
			const res = await fetch('/api/document');
			const doc = await res.json();
			if (doc) {
				applyCanonicalDocument(normalizeAtomzFile(doc));
			}
			documentLoaded = true;
		} catch { /* no doc yet — start empty */ }

		await loadPendingDocumentOps();
		// Load session history
		try {
			const res = await fetch('/api/history');
			const data = await res.json();
			if (data.messages?.length > 0) {
				const entries: import('$lib/types').HistoryEntry[] = [];
				for (const msg of data.messages) {
					if (msg.type === 'assistant' && msg.message?.content) {
						for (const block of msg.message.content) {
							if (block.type === 'text' && block.text) {
								entries.push({ type: 'assistant_text', timestamp: 0, text: block.text });
							} else if (block.type === 'tool_use') {
								entries.push({ type: 'tool_call', timestamp: 0, tool_name: block.name, input: block.input || {} });
							}
						}
					}
				}
				if (entries.length > 0) {
					// Add a synthetic render_end so the "Done" bar shows on refresh
					entries.push({ type: 'render_end', timestamp: 0, success: true });
					agentHistory.set(entries);
				}
			}
		} catch { /* no session yet */ }

		// Load version history
		await loadVersions();
	});

	// document.atomz is ONLY written by the render endpoint after agent merge.
	// Crash recovery relies on the WAL (.atomz-ops.jsonl) to replay unresolved ops.
	let documentLoaded = false;
	documentOps.subscribe((ops) => {
		for (const op of ops) {
			void persistDocumentOp(op);
		}
	});

	function getCurrentDocumentState() {
		let f: Fragment[], p: Sentence[], r: typeof $rules, b: Set<number>;
		let ep: import('$lib/types').EditorPin[], sec: import('$lib/types').Section[];
		atoms.subscribe((v) => (f = v))();
		prose.subscribe((v) => (p = v))();
		rules.subscribe((v) => (r = v))();
		paraBreaks.subscribe((v) => (b = v))();
		editorPins.subscribe((v) => (ep = v))();
		sections.subscribe((v) => (sec = v))();
		return {
			atoms: f!,
			prose: p!,
			rules: r!,
			paraBreaks: b!,
			editorPins: ep!,
			sections: sec!
		};
	}

	// Build the unified document JSON from canonical stores (blocks/pins are source of truth)
	function getDocumentJson() {
		return buildAtomzFileFromCanonicalState(getCanonicalRuntimeStateFromStores());
	}

	function getRequestBody(editedFragId?: string, changes?: string, batched?: boolean, warmup?: boolean) {
		return {
			documentJson: getDocumentJson(),
			model,
			...(editedFragId ? { editedFragId } : {}),
			...(changes ? { changes } : {}),
			...(batched ? { batched: true } : {}),
			...(warmup ? { warmup: true } : {})
		};
	}

	// Shared render logic
	async function doRender(editedFragId?: string, trigger?: string, batched?: boolean, warmup?: boolean): Promise<boolean> {
		let currentProse: Sentence[];
		prose.subscribe((v) => (currentProse = v))();

		const targetIndices = editedFragId
			? currentProse!.map((s, i) => (s.frags.includes(editedFragId) ? i : -1)).filter((i) => i !== -1)
			: null;

		if (editedFragId && targetIndices && targetIndices.length === 0) return false;

		// Snapshot blocks for undo before agent edits
		let snapshotBlocks: AtomzBlock[] = [], snapshotPins: AtomzPin[] = [];
		blocks.subscribe((v) => (snapshotBlocks = v))();
		pins.subscribe((v) => (snapshotPins = v))();
		pushBlockSnapshot(snapshotBlocks, snapshotPins);

		isRendering.set(true);
		if (targetIndices) {
			renderingSentences.set(new Set(targetIndices));
		}

		// Show history immediately so user sees activity
		showHistory.set(true);
		const renderStartTime = Date.now();
		pushHistory({
			type: 'render_start',
			timestamp: renderStartTime,
			trigger: trigger || (editedFragId ? `Selective: atom ${editedFragId}` : 'Full re-render')
		});

		let success = false;
		let lastToolStartTime = 0;
		let lastEventTime = Date.now();

		// Track which ops existed before render so we can detect new ones after
		let preRenderOpIds: Set<string>;
		documentOps.subscribe((ops) => (preRenderOpIds = new Set(ops.map((o) => o.id))))();

		// Cancel any previous render
		if (currentAbort) currentAbort.abort();
		currentAbort = new AbortController();

		try {
			const res = await fetch('/api/render', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(getRequestBody(editedFragId, trigger, batched, warmup)),
				signal: currentAbort.signal
			});

			// Find which sentence index matches a given old text
			function findSentenceIndex(oldText: string): number {
				let curProse: Sentence[];
				prose.subscribe((v) => (curProse = v))();
				const trimmed = oldText.trim();
				for (let i = 0; i < curProse!.length; i++) {
					if (curProse![i].text.trim() === trimmed) return i;
				}
				// Partial match
				for (let i = 0; i < curProse!.length; i++) {
					if (trimmed.includes(curProse![i].text.trim()) || curProse![i].text.trim().includes(trimmed)) return i;
				}
				return -1;
			}

			let currentEditIdx = -1;
			let currentEditOldText = '';

			await readSSE(res, {
				onToolCallStart: (data) => {
					currentEditIdx = -1;
					currentEditOldText = '';
					lastToolStartTime = Date.now();
					lastEventTime = Date.now();
				},
				onTextStreaming: (data) => {
					// Edit tool: old_text tells us which sentence, new_text streams in
					if (data.old_text && currentEditIdx === -1) {
						currentEditIdx = findSentenceIndex(data.old_text);
						currentEditOldText = data.old_text;
						if (currentEditIdx >= 0) {
							renderingSentences.update((s) => {
								const next = new Set(s);
								next.delete(currentEditIdx);
								return next;
							});
						}
					}

					if (currentEditIdx >= 0 && data.new_text) {
						const words = data.new_text.split(/\s+/);
						sentenceTransitions.update((m) => {
							const next = new Map(m);
							next.set(currentEditIdx, {
								oldText: currentEditOldText,
								newText: data.new_text,
								wordsRevealed: words.length,
								done: false
							});
							return next;
						});
					}
				},
				onToolCall: (data) => {
					const now = Date.now();
					lastEventTime = now;
					pushHistory({
						type: 'tool_call',
						timestamp: now,
						tool_name: data.tool_name,
						input: data.input,
						durationMs: lastToolStartTime ? now - lastToolStartTime : undefined
					});

					// When Edit completes, mark transition done (show diff)
					if (data.tool_name === 'Edit' && currentEditIdx >= 0) {
						const newText = (data.input.new_string as string) || '';
						sentenceTransitions.update((m) => {
							const next = new Map(m);
							next.set(currentEditIdx, {
								oldText: currentEditOldText,
								newText: newText.trim(),
								wordsRevealed: newText.trim().split(/\s+/).length,
								done: true
							});
							return next;
						});
						currentEditIdx = -1;
						currentEditOldText = '';
					}
				},
				onAssistantText: (data) => {
					const now = Date.now();
					const gap = now - lastEventTime;
					lastEventTime = now;

					agentHistory.update((h) => {
						const last = h[h.length - 1];
						if (last && last.type === 'assistant_text') {
							return [...h.slice(0, -1), { ...last, text: last.text + data.text }];
						}
						// If there was a gap > 2s before this text, the agent was thinking
						const prefix = gap > 2000 ? `*[thought ${(gap / 1000).toFixed(1)}s]* ` : '';
						return [...h, { type: 'assistant_text' as const, timestamp: now, text: prefix + data.text }];
					});
				},
				onCheckpoint: (data) => {
					checkpoints.update((cps) => [...cps, { ...data, description: trigger }]);
				},
				onResult: (data) => {
					// Server already wrote document.atomz before sending this result.
					// Client just applies to in-memory stores.
					if (data.document) {
						applyCanonicalDocument(normalizeAtomzFile(data.document));
					} else if (data.sentences) {
						const curAtoms = getCurrentDocumentState().atoms;
						const newBlocks = buildBlocksFromRuntimeView({ atoms: curAtoms, prose: data.sentences });
						blocks.set(newBlocks);
						reproject();
					}
					// Clear pending edit indicators — agent has processed them
					pendingEditBlockIds.set(new Set());
					// Highlight agent changes for 5 seconds
					const cblocks = (data as any).changedBlockIds as string[] | undefined;
					const catoms = (data as any).changedAtomIds as string[] | undefined;
					if (cblocks?.length || catoms?.length) {
						agentChangedBlockIds.set(new Set(cblocks || []));
						agentChangedAtomIds.set(new Set(catoms || []));
						setTimeout(() => {
							agentChangedBlockIds.set(new Set());
							agentChangedAtomIds.set(new Set());
						}, 5000);
					}
					success = true;
				}
			});

			clearStaleAnnotations();
		} catch (e) {
			console.error('Render failed:', e);
		} finally {
			currentAbort = null;
			renderingSentences.set(new Set());
			isRendering.set(false);
			pushHistory({ type: 'render_end', timestamp: Date.now(), success, durationMs: Date.now() - renderStartTime });
			if (success) {
				clearUserEdits.set(Date.now());
				// Replay any ops the user pushed while the agent was rendering
				let currentOpsAfterRender: DocumentOp[] = [];
				documentOps.subscribe((ops) => (currentOpsAfterRender = ops))();
				const newOps = currentOpsAfterRender.filter((op) => !preRenderOpIds.has(op.id));
				if (newOps.length > 0) {
					const state = getCurrentDocumentState();
					let currentBlk: AtomzBlock[] = [], currentPn: AtomzPin[] = [];
					blocks.subscribe((v) => (currentBlk = v))();
					pins.subscribe((v) => (currentPn = v))();
					let replayed = { ...state, blocks: currentBlk, pins: currentPn };
					for (const op of newOps) {
						replayed = { ...replayed, ...applyDocumentOp(replayed, op) };
					}
					if (replayed.blocks) blocks.set(replayed.blocks);
					if (replayed.pins) pins.set(replayed.pins);
					atoms.set(replayed.atoms);
					rules.set(replayed.rules);
					reproject();
				}
			}
			loadVersions();
			// Don't clear transitions immediately — let the diff animation finish
		}
		return success;
	}

	// Process document ops. Uses a debounce timer + processing loop.
	// The loop keeps running as long as there are unresolved ops,
	// so ops that arrive during a render are picked up in the next iteration.
	let opDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let isProcessing = $state(false);
	let processingDone: (() => void) | null = null; // resolve fn for waitForProcessing()

	function scheduleOpProcessing() {
		if (opDebounceTimer) clearTimeout(opDebounceTimer);
		opDebounceTimer = setTimeout(() => processOps(), SYNC_TIMING.queueProcessMs);
	}

	function waitForProcessing(): Promise<void> {
		if (!isProcessing) return Promise.resolve();
		return new Promise((resolve) => { processingDone = resolve; });
	}

	async function processOps() {
		if (isProcessing || isReplayingDocumentOps) return;
		isProcessing = true;
		try {
			while (true) {
				let currentOps: DocumentOp[] = [];
				documentOps.subscribe((ops) => (currentOps = ops))();
				if (currentOps.length === 0) break;

				// Ensure all ops are in the WAL before processing.
				// If any persist fails, don't process — retry next time.
				const persistResults = await Promise.all(currentOps.map((op) => persistDocumentOp(op)));
				if (persistResults.some((ok) => !ok)) break;
				const currentState = getCurrentDocumentState();
				const plan = buildDocumentOpProcessingPlan(currentOps, currentState);
				if (plan.agentOps.length === 0) break;

				const success = await doRender(
					plan.editedFragId,
					plan.trigger,
					plan.agentOps.length > 1
				);
				if (success) {
					await resolvePendingDocumentOps(plan.agentOps);
				} else {
					break;
				}
			}
		} finally {
			isProcessing = false;
			if (processingDone) { processingDone(); processingDone = null; }
		}
	}

	documentOps.subscribe((ops) => {
		if (ops.length === 0 || isProcessing || isReplayingDocumentOps) return;
		scheduleOpProcessing();
	});

	function handleGlobalClick(e: MouseEvent) {
		if (showRules) {
			const wrapper = document.querySelector('.rules-wrapper');
			if (wrapper && !wrapper.contains(e.target as Node)) {
				showRules = false;
			}
		}
		handleVersionClick(e);
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
			e.preventDefault();
			// Abort any in-flight render so the undo isn't overwritten by onResult
			if (rendering) cancelRender();
			undoBlocks();
		}
		if (e.key === 'Escape' && rendering) {
			cancelRender();
		}
	}
</script>

<svelte:head>
	<link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap" rel="stylesheet" />
	<title>atomz</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} onclick={handleGlobalClick} />

<div class="app">
	<header class="header">
		<div class="header-left">
			<button class="text-btn" onclick={handleOpen} title="Open .atomz or import text">
				<FolderOpen size={14} /> Open
			</button>
			<div class="ref-wrapper">
				<button class="text-btn" onclick={() => (refPopover = refPopover ? null : 'inspo')}>
					+ Reference
				</button>
				{#if refPopover}
					<div class="ref-popover">
						<div class="ref-popover-title">Add reference</div>
						<input class="ref-url-input" bind:value={refUrl} placeholder="Paste a URL (blog, article...)" />
						<textarea class="ref-text-input" bind:value={refText} placeholder="Or paste text directly..." rows={3}></textarea>
						<div class="ref-actions">
							<label class="ref-mine-toggle">
								<input type="checkbox" checked={refPopover === 'own'} onchange={(e) => (refPopover = e.currentTarget.checked ? 'own' : 'inspo')} />
								This is my writing
							</label>
							<button class="ref-attach" onclick={attachRefFile}>Attach file</button>
							<button class="ref-submit" onclick={submitReference}>Add</button>
						</div>
					</div>
				{/if}
			</div>
			<select class="header-select" bind:value={model} onchange={(e) => selectedModel.set(e.currentTarget.value)}>
				<option value="opus">Opus</option>
				<option value="sonnet">Sonnet</option>
				<option value="haiku">Haiku</option>
			</select>
			<select class="header-select" bind:value={edMode} onchange={(e) => editorMode.set(e.currentTarget.value as any)}>
				<option value="markdown">Markdown</option>
				<option value="plaintext">Plain text</option>
			</select>
			<select class="header-select" bind:value={themeName} onchange={(e) => setTheme(e.currentTarget.value)}>
				{#each themes as t}
					<option value={t.name}>{t.label}</option>
				{/each}
			</select>
		</div>
		<div class="header-actions">
			<button class="icon-btn" onclick={newSession} disabled={rendering} title="New session (clear agent context)">
				<RotateCcw size={14} />
			</button>
			<div class="version-wrapper">
				<button
					class="icon-btn"
					class:version-active={showVersions}
					onclick={() => { showVersions = !showVersions; versionOpenedAt = Date.now(); }}
					disabled={versions.length === 0}
					title="Version history"
				>
					<History size={14} />
				</button>
				{#if showVersions && versions.length > 0}
					<div class="version-dropdown">
						<div class="version-title">Version history</div>
						<div class="version-list">
							{#each versions as version}
								<button
									class="version-item"
									class:version-active-item={diffVersionIndex === version.index}
									onclick={() => selectVersionForDiff(version.index)}
								>
									<span class="version-time">{formatTime(version.timestamp)}</span>
									<span class="version-diff">{getVersionDiffSummary(version.prose)}</span>
									<span class="version-preview-text">
										{version.prose.map(s => s.text).join(' ').slice(0, 80)}...
									</span>
								</button>
							{/each}
						</div>
					</div>
				{/if}
			</div>
			<button class="icon-btn" onclick={() => undoBlocks()} disabled={!hasUndo} title="Undo (⌘Z)">
				<Undo2 size={14} />
			</button>
			{#if currentAbort}
				<button class="icon-btn cancel-btn" onclick={cancelRender} title="Stop agent (Esc)">
					<XCircle size={14} />
				</button>
			{/if}
			<button
				class="icon-btn"
				class:history-active={historyVisible}
				onclick={() => showHistory.update((v) => !v)}
				title="Agent history"
			>
				<MessageSquareText size={14} />
			</button>
			<div class="rules-wrapper">
				<button
					class="icon-btn"
					class:rules-active={showRules}
					onclick={() => (showRules = !showRules)}
					title="Rules"
				>
					<Settings size={14} />
				</button>
				{#if showRules}
					<RulesPanel />
				{/if}
			</div>
		</div>
	</header>

	<div class="editor-body">
		<div style:width="{atomsWidth}px" style:flex-shrink="0" style:height="100%">
			<ContentPane />
		</div>
		<PanelResizer onResize={(d) => { atomsWidth = Math.max(200, Math.min(600, atomsWidth + d)); }} />
		<div class="prose-wrapper">
			{#if diffVersionIndex !== null}
				<!-- Diff view: comparing old version to current -->
				<div class="diff-view">
					<div class="diff-header">
						<span class="diff-label">Comparing with version from {formatTime(versions.find(v => v.index === diffVersionIndex)?.timestamp ?? 0)}</span>
						<div class="diff-actions">
							<button class="diff-restore-btn" onclick={restoreVersion}>Restore this version</button>
							<button class="diff-close-btn" onclick={closeDiffView}>Close</button>
						</div>
					</div>
					<div class="diff-content">
						{#each paragraphDiffs as para}
							<p class="diff-para" class:diff-changed={para.changed}>
								{#each para.parts as part}
									{#if part.type === 'removed'}
										<span class="diff-removed">{part.text}</span>
									{:else if part.type === 'added'}
										<span class="diff-added">{part.text}</span>
									{:else}
										{part.text}
									{/if}
								{/each}
							</p>
						{/each}
					</div>
				</div>
			{:else}
				<TiptapEditor />
				<div class="floating-toolbar">
					<ActionToolbar />
				</div>
			{/if}
		</div>
		{#if historyVisible}
			<PanelResizer onResize={(d) => { historyWidth = Math.max(250, Math.min(600, historyWidth - d)); }} />
			<div style:width="{historyWidth}px" style:flex-shrink="0" style:height="100%">
				<HistoryPane />
			</div>
		{/if}
	</div>
</div>

<style>
	:global(:root) {
		--bg: #ffffff;
		--bg-surface: #f9fafb;
		--bg-elevated: #ffffff;
		--bg-hover: #f3f4f6;
		--bg-active: #eef2ff;
		--border: #b0b5be;
		--border-light: #d1d5db;
		--text: #111827;
		--text-secondary: #374151;
		--text-muted: #4b5563;
		--text-faint: #6b7280;
		--accent: #4f46e5;
		--accent-light: #c7d2fe;
		--accent-bg: #eef2ff;
		--accent-subject: #4338ca;
		--prose-bg: #ffffff;
		--prose-text: #1f2937;
		--header-bg: #ffffff;
		--pane-bg: #ffffff;
		--diff-added-color: #059669;
		--diff-added-bg: #ecfdf5;
		--diff-removed-color: #dc2626;
		--feedback-bg: #fffbeb;
		--feedback-border: #f59e0b;
		--tool-bg: #f5f3ff;
		--tool-border: #ede9fe;
		--tool-accent: #7c3aed;
		--assistant-bg: #f0fdf4;
		--assistant-border: #dcfce7;
	}
	:global(*) {
		box-sizing: border-box;
		margin: 0;
		padding: 0;
	}
	:global(html), :global(body) {
		height: 100%;
		overflow: hidden;
	}
	:global(body) {
		font-family: 'Lora', Georgia, serif;
		background: var(--bg);
		color: var(--text);
		-webkit-font-smoothing: antialiased;
	}

	.app {
		height: 100vh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.header {
		padding: 8px 20px;
		border-bottom: 1px solid var(--border-light);
		background: var(--header-bg);
		display: flex;
		align-items: center;
		justify-content: space-between;
		position: sticky;
		top: 0;
		z-index: 50;
	}
	.header-left {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.text-btn {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 5px 12px;
		border-radius: 5px;
		border: 1px solid var(--border);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 13px;
		font-family: inherit;
		cursor: pointer;
		white-space: nowrap;
	}
	.text-btn:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-secondary);
		border-color: var(--border);
	}
	.text-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.header-select {
		padding: 5px 8px;
		border-radius: 5px;
		border: 1px solid var(--border);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 13px;
		font-family: inherit;
		cursor: pointer;
		outline: none;
	}
	.header-select:hover {
		border-color: var(--border);
	}
	.header-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.icon-btn {
		width: 34px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		border: 1px solid var(--border);
		background: var(--bg-elevated);
		color: var(--text-faint);
		cursor: pointer;
	}
	.icon-btn:hover:not(:disabled) {
		background: var(--accent-bg);
		color: var(--accent);
		border-color: var(--accent-light);
	}
	.icon-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.icon-btn.cancel-btn {
		border-color: #fecaca;
		background: #fef2f2;
		color: #dc2626;
	}
	.icon-btn.cancel-btn:hover {
		background: #fee2e2;
		border-color: #f87171;
	}
	.icon-btn.rules-active {
		border-color: var(--feedback-border);
		background: var(--feedback-bg);
		color: var(--feedback-border);
	}
	.icon-btn.history-active {
		border-color: var(--accent-light);
		background: var(--accent-bg);
		color: var(--accent);
	}

	:global(.spinning) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}

	.ref-wrapper {
		position: relative;
	}
	.ref-popover {
		position: absolute;
		top: 100%;
		left: 0;
		margin-top: 4px;
		width: 340px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 12px 36px rgba(0, 0, 0, 0.12);
		padding: 12px;
		z-index: 100;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.ref-popover-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}
	.ref-url-input {
		width: 100%;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 8px 10px;
		font-size: 13px;
		font-family: inherit;
		outline: none;
		color: var(--text);
		background: var(--bg);
	}
	.ref-url-input:focus { border-color: var(--accent); }
	.ref-text-input {
		width: 100%;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 8px 10px;
		font-size: 13px;
		font-family: inherit;
		outline: none;
		color: var(--text);
		background: var(--bg);
		resize: vertical;
		min-height: 60px;
	}
	.ref-text-input:focus { border-color: var(--accent); }
	.ref-actions {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.ref-mine-toggle {
		font-size: 12px;
		color: var(--text-muted);
		display: flex;
		align-items: center;
		gap: 4px;
		cursor: pointer;
		flex: 1;
	}
	.ref-attach {
		padding: 5px 12px;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--bg);
		color: var(--text-muted);
		font-size: 12px;
		cursor: pointer;
		font-family: inherit;
	}
	.ref-submit {
		padding: 5px 16px;
		border-radius: 6px;
		border: none;
		background: var(--accent);
		color: white;
		font-size: 12px;
		cursor: pointer;
		font-family: inherit;
		font-weight: 500;
	}
	.rules-wrapper {
		position: relative;
	}
	.version-wrapper {
		position: relative;
	}
	.icon-btn.version-active {
		border-color: var(--accent-light);
		background: var(--accent-bg);
		color: var(--accent);
	}
	.version-dropdown {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 4px;
		width: 320px;
		max-height: 400px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 12px 36px rgba(0, 0, 0, 0.12);
		z-index: 100;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
	.version-title {
		padding: 10px 14px 8px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.5px;
		border-bottom: 1px solid var(--border-light);
	}
	.version-list {
		overflow-y: auto;
		max-height: 350px;
	}
	.version-item {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 14px;
		border: none;
		border-bottom: 1px solid var(--border-light);
		background: transparent;
		cursor: pointer;
		text-align: left;
		font-family: inherit;
		transition: background 0.1s;
	}
	.version-item:hover, .version-item.version-preview {
		background: var(--accent-bg);
	}
	.version-item:last-child {
		border-bottom: none;
	}
	.version-time {
		font-size: 13px;
		font-weight: 500;
		color: var(--text);
	}
	.version-diff {
		font-size: 11px;
		color: var(--text-faint);
	}
	.version-preview-text {
		font-size: 11px;
		color: var(--text-muted);
		line-height: 1.4;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.prose-wrapper {
		flex: 1;
		position: relative;
		height: 100%;
	}

	/* Diff view */
	.diff-view {
		height: 100%;
		display: flex;
		flex-direction: column;
		background: var(--prose-bg);
	}
	.diff-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 20px;
		background: var(--bg-surface);
		border-bottom: 1px solid var(--border-light);
		flex-shrink: 0;
	}
	.diff-label {
		font-size: 13px;
		color: var(--text-muted);
		font-weight: 500;
	}
	.diff-actions {
		display: flex;
		gap: 6px;
	}
	.diff-restore-btn {
		padding: 6px 16px;
		border-radius: 6px;
		border: none;
		background: var(--accent);
		color: white;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		font-family: inherit;
	}
	.diff-restore-btn:hover {
		opacity: 0.9;
	}
	.diff-close-btn {
		padding: 6px 16px;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 12px;
		cursor: pointer;
		font-family: inherit;
	}
	.diff-close-btn:hover {
		background: var(--bg-hover);
	}
	.diff-content {
		flex: 1;
		overflow-y: auto;
		padding: 32px 48px 80px;
	}
	.diff-content {
		max-width: 700px;
		margin: 0 auto;
	}
	.diff-para {
		font-size: 15px;
		line-height: 1.85;
		color: var(--prose-text);
		margin: 0 0 24px;
		padding: 4px 0;
	}
	.diff-para.diff-changed {
		background: color-mix(in srgb, var(--accent) 4%, transparent);
		border-radius: 4px;
		padding: 4px 8px;
		margin-left: -8px;
		margin-right: -8px;
	}
	.diff-removed {
		color: var(--diff-removed-color);
		text-decoration: line-through;
		background: rgba(220, 38, 38, 0.08);
		border-radius: 2px;
		padding: 0 2px;
	}
	.diff-added {
		color: var(--diff-added-color);
		background: var(--diff-added-bg);
		border-radius: 2px;
		padding: 0 2px;
		font-weight: 500;
	}
	.version-item.version-active-item {
		background: var(--accent-bg);
		border-left: 2px solid var(--accent);
	}
	.prose-wrapper :global(.prose-pane) {
		height: 100%;
	}
	.floating-toolbar {
		position: absolute;
		bottom: 20px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 40;
		border-radius: 10px;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
	}
	.floating-toolbar :global(.toolbar) {
		border-radius: 10px;
	}
	.editor-body {
		display: flex;
		flex: 1;
		overflow: hidden;
		height: calc(100vh - 45px);
	}
</style>
