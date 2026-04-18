<script lang="ts">
	import { onMount } from 'svelte';
	import { ScrollText } from 'lucide-svelte';
	import MenuBar, { type MenuSpec } from '$lib/components/MenuBar.svelte';
	import OutlinePane from '$lib/components/OutlinePane.svelte';
	import FileTree from '$lib/components/FileTree.svelte';
	import type { FileEntry } from '$lib/components/FileTree.svelte';
	import TiptapEditor from '$lib/editor/TiptapEditor.svelte';
	import HistoryPane from '$lib/components/HistoryPane.svelte';
	import RulesPanel from '$lib/components/RulesPanel.svelte';
	import PanelResizer from '$lib/components/PanelResizer.svelte';
	import AgentDock from '$lib/components/AgentDock.svelte';
	import AgentSettingsPanel from '$lib/components/AgentSettingsPanel.svelte';
	import HooksPanel from '$lib/components/HooksPanel.svelte';
	import ChatPanel from '$lib/components/ChatPanel.svelte';
	import { themes, applyTheme } from '$lib/themes';
	import { unifiedLineDiff } from '$lib/diff';
	import { diffWords } from 'diff';
	import { TINY_EDIT_THRESHOLD } from '$lib/types';

	/** Turn a submit trigger into a compact description for the history
	 * pane. Full text of long prompts (including feedback-on-passage quotes)
	 * becomes a single-line label; the agent still gets the full prompt.
	 * When no trigger is given, describe the default "review and improve"
	 * prompt the agent actually receives, not a vague "Submitted". */
	function shortDescription(trigger: string | undefined): string {
		if (!trigger) return 'Review document and improve';
		// `Feedback "Too verbose" on this passage: "…"` → `Feedback: Too verbose`
		const feedbackMatch = trigger.match(/^Feedback "([^"]+)" on this passage:/);
		if (feedbackMatch) return `Feedback: ${feedbackMatch[1]}`;
		// Apply-rules trigger: "Review the document against the following rules…"
		if (/^Review the document against the following rules/.test(trigger)) {
			return 'Apply rules';
		}
		// Reject-and-reconsider trigger starts with "The user just rejected"
		if (/^The user just rejected/.test(trigger)) {
			return 'Reconsider after rejection';
		}
		if (trigger.length > 80) return trigger.slice(0, 77) + '…';
		return trigger;
	}

	/** Classify a round's size by summing added+removed char counts. */
	function classifyRoundKind(beforeMd: string, afterMd: string): 'tiny' | 'big' {
		let totalDelta = 0;
		for (const part of diffWords(beforeMd, afterMd)) {
			if (part.added || part.removed) totalDelta += part.value.length;
		}
		return totalDelta < TINY_EDIT_THRESHOLD ? 'tiny' : 'big';
	}
	import {
		applyAgentMarkdown,
		undoAgentChanges,
		captureBaselineForAgent,
		clearAgentBaseline,
		clearAllAgentBaselines
	} from '$lib/yjs-agent';
	import {
		getReviewMap,
		getReviewMapForTab,
		whenYDocReady,
		setCurrentTab,
		destroyTab,
		renameTab
	} from '$lib/yjs-doc';
	import type { Editor } from '@tiptap/core';
	import {
		userMd,
		reviewBaseline,
		preAgentSnapshot,
		pendingReviewRounds,
		rules,
		proposedRules,
		proposedHooks,
		pendingUserQuestions,
		userEditRegions,
		isRendering,
		agentHistory,
		showHistory,
		pushHistory,
		selectedModel,
		selectedTheme,
		submitCountdown,
		editorFontScale,
		historyVerbosity,
		agentSettings,
		tabs,
		activeTab,
		activeTabKind,
		recentActions,
		addRoundCost,
		resetSessionCost,
		actionUsageCounts,
		type TabInfo
	} from '$lib/stores';
	import TabBar from '$lib/components/TabBar.svelte';
	import type { AgentSettings, HistoryEntry, PendingReviewRound } from '$lib/types';

	type EditorRef = {
		getEditor: () => Editor | undefined;
		flushAutosave: () => Promise<void>;
	};

	let rendering = $state(false);
	isRendering.subscribe((v) => (rendering = v));

	// Synchronous guard: set to true the moment submit() is entered, before any
	// await. Prevents two concurrent calls from the same event loop tick (e.g.
	// a button click firing just as the idle timer callback is about to run).
	let submitInFlight = false;

	let currentAbort: AbortController | null = null;
	/** Per-tab: the last agentMd the client applied to each tab. Passed to
	 * the server so it can build a per-tab "what the user changed since the
	 * last round" diff. */
	let lastRenderMarkdownByTab: Record<string, string> = $state({});
	/** Which tabs currently have a pending review (drives the tab dot badges
	 * and gates the Accept/Reject UI in the OutlinePane). */
	/** Map tabId → pending round count. Drives the numbered badge on
	 * each tab. 0 / absent means no pending review on that tab. */
	let pendingReviewTabs: Map<string, number> = $state(new Map());
	/** Per-tab pre-render markdown snapshot (for the diff overlay baseline). */
	let preRenderMdByTab: Record<string, string> = {};
	/** Per-tab pre-agent-apply snapshot (for reject-after-refresh restore). */
	let preAgentMdByTab: Record<string, string> = {};

	function getCurrentTabList(): string[] {
		let v: TabInfo[] = [];
		tabs.subscribe((x) => (v = x))();
		return v.map((t) => t.id);
	}

	function getTabKind(tabId: string): 'markdown' | 'plain' {
		let v: TabInfo[] = [];
		tabs.subscribe((x) => (v = x))();
		const match = v.find((t) => t.id === tabId);
		return match?.kind ?? 'markdown';
	}

	/** Fetch a tab's current markdown from the server. Used to snapshot
	 * pre-render content for tabs other than the active one. */
	async function fetchTabMd(tabId: string): Promise<string> {
		try {
			const res = await fetch(`/api/document?tab=${encodeURIComponent(tabId)}`);
			const data = await res.json();
			return data.userMd || '';
		} catch (e) {
			console.error(`Failed to fetch md for tab "${tabId}":`, e);
			return '';
		}
	}

	let editorRef: EditorRef | undefined = $state();

	/** Load the tab list from the server and bootstrap a default tab if none
	 * exist. Returns the chosen active tab ID. */
	async function loadTabs(): Promise<string | null> {
		try {
			const res = await fetch('/api/tabs');
			const data = await res.json();
			let tabInfo: TabInfo[] =
				(data.tabs as TabInfo[] | undefined) ??
				(data.order || []).map((id: string) => ({ id, kind: 'markdown' as const }));
			let active: string | null = data.active ?? null;
			if (tabInfo.length === 0) {
				// Fresh install: create the default tab so the user has something
				// to open. The server's POST /api/tabs also seeds the file.
				const createRes = await fetch('/api/tabs', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ id: 'document.txt' })
				});
				const created = await createRes.json();
				// Re-fetch to get kinds
				const refreshed = await fetch('/api/tabs').then((r) => r.json());
				tabInfo = refreshed.tabs || [{ id: 'document.txt', kind: 'plain' }];
				active = created.active || 'document.txt';
			}
			tabs.set(tabInfo);
			activeTab.set(active);
			if (active) activeTabKind.set(getTabKind(active));
			const pending = new Map<string, number>();
			for (const info of tabInfo) {
				const map = getReviewMapForTab(info.id);
				const rounds = map.get('pendingRounds');
				const legacyBaseline = map.get('baseline');
				if (Array.isArray(rounds) && rounds.length > 0) {
					pending.set(info.id, rounds.length);
				} else if (typeof legacyBaseline === 'string') {
					pending.set(info.id, 1);
				}
			}
			pendingReviewTabs = pending;
			return active;
		} catch (e) {
			console.error('Failed to load tabs:', e);
			return null;
		}
	}

	/** Load a single tab's markdown + meta, and hydrate the per-tab review
	 * state from its Y.Doc. Must be called after `setCurrentTab(tabId)` so
	 * `getReviewMap()` operates on the right Y.Doc. */
	async function loadTab(tabId: string) {
		try {
			const res = await fetch(`/api/document?tab=${encodeURIComponent(tabId)}`);
			const data = await res.json();
			// userMd seeds the Y.Doc via TiptapEditor's mount/remount flow.
			userMd.set(data.userMd || '');
			rules.set(data.meta?.rules || []);
			userEditRegions.set(data.meta?.userEditRegions || []);
			if (data.meta?.agentSettings) {
				agentSettings.set(data.meta.agentSettings);
			}
			// Hydrate review stores from this tab's Y.Doc review map.
			await whenYDocReady();
			const reviewMap = getReviewMap();
			const persistedRounds = reviewMap.get('pendingRounds');
			const persistedLastAgentMd = reviewMap.get('lastAgentMd');
			// `pendingRounds` is the authoritative source in the new per-round
			// model. `baseline` / `preAgent` are legacy single-round fields
			// we still read for backward compat (old review maps written
			// before the composition refactor). If we find them, convert
			// into a synthetic single-round array so the UI still lights up.
			let rounds: PendingReviewRound[] = Array.isArray(persistedRounds)
				? (persistedRounds as PendingReviewRound[]).map((r) => ({
						...r,
						// Backfill `kind` on rounds written before the tiny/big
						// classification existed.
						kind: r.kind ?? classifyRoundKind(r.beforeMd, r.afterMd)
				  }))
				: [];
			if (rounds.length === 0) {
				const legacyBaseline = reviewMap.get('baseline');
				if (typeof legacyBaseline === 'string') {
					const after = data.userMd || '';
					rounds = [
						{
							id: 'legacy_' + Date.now(),
							beforeMd: legacyBaseline,
							afterMd: after,
							timestamp: Date.now(),
							kind: classifyRoundKind(legacyBaseline, after)
						}
					];
				}
			}
			pendingReviewRounds.set(rounds);
			reviewBaseline.set(rounds.length > 0 ? rounds[0].beforeMd : null);
			preAgentSnapshot.set(rounds.length > 0 ? rounds[0].beforeMd : null);
			// Restore the "what the agent last saw" snapshot for this tab so
			// the next submit's user_action diff has a real baseline to compare
			// against, not "first render" after every reload.
			if (typeof persistedLastAgentMd === 'string') {
				lastRenderMarkdownByTab[tabId] = persistedLastAgentMd;
				lastRenderMarkdownByTab = { ...lastRenderMarkdownByTab };
			}
		} catch (e) {
			console.error(`Failed to load tab "${tabId}":`, e);
		}
	}

	/** Switch the editor to a different tab. Tears down the editor, sets
	 * the current tab on the Y.Doc layer, loads the new tab's content, then
	 * remounts the editor against the new Y.Doc. */
	async function switchTab(tabId: string) {
		const current = getCurrentActiveTab();
		if (tabId === current) return;
		docLoaded = false; // unmounts TiptapEditor
		setCurrentTab(tabId);
		activeTab.set(tabId);
		activeTabKind.set(getTabKind(tabId));
		try {
			await fetch('/api/tabs', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: tabId, active: true })
			});
		} catch (e) {
			console.error('Failed to persist active tab:', e);
		}
		await loadTab(tabId);
		docLoaded = true;
	}

	async function createTab(id: string) {
		const res = await fetch('/api/tabs', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id })
		});
		if (!res.ok) {
			const err = await res.text();
			throw new Error(err || 'Failed to create tab');
		}
		const data = await res.json();
		// Refetch the full tab list to get kinds for every tab (including the new one).
		const listRes = await fetch('/api/tabs');
		const listData = await listRes.json();
		tabs.set(listData.tabs || []);
		await switchTab(data.active);
	}

	async function closeTab(id: string) {
		// Just drop the tab from the registry. File stays on disk; the
		// user can reopen it from the FileTree later.
		await removeTab(id, /* deleteFile */ false);
	}

	async function deleteTab(id: string) {
		// Destructive: close the tab AND unlink the file.
		await removeTab(id, /* deleteFile */ true);
	}

	async function removeTab(id: string, deleteFile: boolean) {
		const qs = new URLSearchParams({ id });
		if (deleteFile) qs.set('deleteFile', 'true');
		const res = await fetch(`/api/tabs?${qs.toString()}`, { method: 'DELETE' });
		if (!res.ok) throw new Error(await res.text());
		const data = await res.json();
		// Destroy this tab's Y.Doc binding regardless of whether the file
		// was unlinked — we don't want a stale in-memory doc if the tab
		// gets re-opened.
		await destroyTab(id);
		const listData = await fetch('/api/tabs').then((r) => r.json());
		tabs.set(listData.tabs || []);
		if (data.active && data.active !== getCurrentActiveTab()) {
			await switchTab(data.active);
		} else if (!data.active) {
			docLoaded = false;
			activeTab.set(null);
		}
	}

	async function renameTabAction(oldId: string, newId: string) {
		const res = await fetch('/api/tabs', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: oldId, newId })
		});
		if (!res.ok) throw new Error(await res.text());
		const data = await res.json();
		await renameTab(oldId, newId);
		const listData = await fetch('/api/tabs').then((r) => r.json());
		tabs.set(listData.tabs || []);
		if (getCurrentActiveTab() === oldId) {
			activeTab.set(newId);
			activeTabKind.set(getTabKind(newId));
		}
	}

	function getCurrentActiveTab(): string | null {
		let v: string | null = null;
		activeTab.subscribe((x) => (v = x))();
		return v;
	}

	/** Path of the currently active tab — same as its id. Used by the
	 * FileTree to highlight the active file. */
	let activeTabFilePath = $state<string | null>(null);
	$effect(() => {
		activeTabFilePath = getCurrentActiveTab();
	});

	/** Open a file from the FileTree. Any text file becomes an agent-
	 * editable tab: either switch to it (if already open) or register it
	 * via POST /api/tabs (which creates the file if missing). */
	async function onFileOpened(entry: FileEntry) {
		if (entry.kind !== 'file') return;
		const existing = getCurrentTabList();
		if (existing.includes(entry.path)) {
			await switchTab(entry.path);
		} else {
			await createTab(entry.path);
		}
	}

	/** Reconcile open tabs after a FileTree rename. */
	async function onFileTreeRenamed(fromPath: string, toPath: string) {
		const existing = getCurrentTabList();
		if (existing.includes(fromPath)) {
			try {
				await renameTabAction(fromPath, toPath);
			} catch (e) {
				console.error('Renaming open tab failed:', e);
			}
		}
	}

	/** After a FileTree delete, close any open tab whose path is (under)
	 * the deleted one. Matches both the file itself and any files under a
	 * deleted folder. */
	async function onFileTreeDeleted(path: string) {
		const prefix = path + '/';
		const toClose = getCurrentTabList().filter(
			(id) => id === path || id.startsWith(prefix)
		);
		for (const id of toClose) {
			try {
				await deleteTab(id);
			} catch {
				// File may already be gone on disk; ignore.
			}
		}
	}

	/**
	 * Write the pending-rounds array for a specific tab into its Y.Doc
	 * review map (persisted by y-indexeddb). If the tab is the currently
	 * active one, mirror into the live stores so the diff overlay and the
	 * OutlinePane cards update immediately.
	 *
	 * Also clears the legacy `baseline`/`preAgent` keys when the new rounds
	 * array is empty, so a fully-accepted tab doesn't flicker back on reload.
	 */
	function writeTabRounds(tabId: string, rounds: PendingReviewRound[]) {
		const map = getReviewMapForTab(tabId);
		map.set('pendingRounds', rounds);
		// Keep legacy keys in sync so older code paths / tests that still
		// read `baseline`/`preAgent` see a sane value. Earliest round's
		// beforeMd doubles as both.
		if (rounds.length === 0) {
			map.set('baseline', null);
			map.set('preAgent', null);
		} else {
			map.set('baseline', rounds[0].beforeMd);
			map.set('preAgent', rounds[0].beforeMd);
		}
		if (tabId === getCurrentActiveTab()) {
			pendingReviewRounds.set(rounds);
			reviewBaseline.set(rounds.length > 0 ? rounds[0].beforeMd : null);
			preAgentSnapshot.set(rounds.length > 0 ? rounds[0].beforeMd : null);
		}
		// Tab-bar badge bookkeeping — count reflects rounds length.
		const nextPending = new Map(pendingReviewTabs);
		if (rounds.length > 0) nextPending.set(tabId, rounds.length);
		else nextPending.delete(tabId);
		pendingReviewTabs = nextPending;
	}

	/** Persist agent settings through `/api/document` so the server can read
	 * them at render time (for agency-level prompt injection). */
	async function persistAgentSettings(next: AgentSettings) {
		try {
			const tabId = getCurrentActiveTab();
			const q = tabId ? `?tab=${encodeURIComponent(tabId)}` : '';
			await fetch(`/api/document${q}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ meta: { agentSettings: next } })
			});
		} catch (e) {
			console.error('Failed to persist agent settings:', e);
		}
	}

	async function submit(trigger?: string) {
		if (rendering || submitInFlight) return;
		submitInFlight = true;

		// Diff composition: if there's an existing pending review, we do NOT
		// wipe it. The next agent edit stacks on top, and the diff overlay
		// keeps comparing current editor state to the original baseline, so
		// the user sees every agent change since the last Accept — across
		// multiple rounds. Only Accept/Reject (or "New session") clears the
		// review state. `pendingReviewTabs` stays as-is for the same reason.

		// Flush the active editor's pending autosave so the file on disk
		// reflects every keystroke before we read it back. Without this,
		// submitting within ~50ms of typing reads stale content and the
		// "what changed since last render" diff comes back empty.
		try {
			await editorRef?.flushAutosave();
		} catch (e) {
			console.error('flushAutosave failed:', e);
		}

		// Capture the pre-render markdown AND the Y.Doc state per tab so
		// applyAgentMarkdown can merge via CRDT against the right baseline
		// and the diff overlay can compare against the pre-render text.
		const tabList = getCurrentTabList();
		preRenderMdByTab = {};
		preAgentMdByTab = {};
		for (const id of tabList) {
			const md = await fetchTabMd(id);
			preRenderMdByTab[id] = md;
			captureBaselineForAgent(id);
		}

		// Lead the history with a user_action entry summarising what the
		// agent received this round: the trigger message plus unified diffs
		// for any tabs whose content has actually changed since the last
		// round. Unchanged tabs and first-render tabs are intentionally
		// omitted — we don't need "0/4 changed" noise, just the real diffs.
		const diffLinesByTab: Record<string, string> = {};
		for (const id of tabList) {
			const prev = lastRenderMarkdownByTab[id];
			const curr = preRenderMdByTab[id] ?? '';
			if (typeof prev === 'string' && prev !== curr) {
				diffLinesByTab[id] = unifiedLineDiff(prev, curr, 1);
			}
		}
		pushHistory({
			type: 'user_action',
			timestamp: Date.now(),
			description: shortDescription(trigger),
			tabDiffs: diffLinesByTab
		});

		isRendering.set(true);
		const renderStart = Date.now();

		currentAbort = new AbortController();
		let success = true;

		// Streaming state: each incremental_apply increments a per-tab
		// counter and adds to `incrementalAppliedTabs`. At result time these
		// feed into the new PendingReviewRound's stepCount so reject knows
		// how many undo steps to pop (one per Edit/Write tool call).
		const incrementalAppliedTabs = new Set<string>();
		const incrementalStepCountByTab: Record<string, number> = {};

		try {
			let model = 'opus';
			selectedModel.subscribe((v) => (model = v))();

			const tabId = getCurrentActiveTab();
			const res = await fetch('/api/render', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					userMessage: trigger,
					model,
					lastMarkdownByTab: lastRenderMarkdownByTab,
					tab: tabId
				}),
				signal: currentAbort.signal
			});

			if (!res.body) throw new Error('No response body');

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				let lineEnd: number;
				while ((lineEnd = buffer.indexOf('\n\n')) !== -1) {
					const chunk = buffer.slice(0, lineEnd);
					buffer = buffer.slice(lineEnd + 2);

					let event = '';
					let data = '';
					for (const line of chunk.split('\n')) {
						if (line.startsWith('event: ')) event = line.slice(7);
						else if (line.startsWith('data: ')) data = line.slice(6);
					}

					if (!event || !data) continue;
					let parsed: any;
					try { parsed = JSON.parse(data); } catch { continue; }

					if (event === 'tool_call_start') {
						pushHistory({
							type: 'tool_call',
							timestamp: Date.now(),
							tool_name: parsed.tool_name,
							input: {},
							subagent: parsed.subagent
						});
					} else if (event === 'tool_call') {
						agentHistory.update((h) => {
							const last = h[h.length - 1];
							if (last && last.type === 'tool_call' && last.tool_name === parsed.tool_name) {
								return [...h.slice(0, -1), { ...last, input: parsed.input }];
							}
							return h;
						});
					} else if (event === 'assistant_text') {
						agentHistory.update((h) => {
							const last = h[h.length - 1];
							if (last && last.type === 'assistant_text') {
								return [...h.slice(0, -1), { ...last, text: last.text + parsed.text }];
							}
							return [...h, { type: 'assistant_text', timestamp: Date.now(), text: parsed.text }];
						});
					} else if (event === 'incremental_apply') {
						// Streaming partial apply: the server's internal
						// PostToolUse hook fired after an agent Edit/Write.
						// Apply the shadow's current content to the target
						// tab's Y.Doc so the user sees each edit land in
						// real time instead of in one lump at `result`.
						//
						// We apply with trackChanges=true (AGENT_ORIGIN) so
						// each incremental apply creates its own step on the
						// tab's UndoManager — rejecting the round later will
						// undo that many steps via `round.stepCount`.
						const iTabId: string = parsed.tabId;
						const iAgentMd: string = parsed.agentMd;
						if (typeof iTabId === 'string' && typeof iAgentMd === 'string') {
							const activeTabId = getCurrentActiveTab();
							const activeEditor = editorRef?.getEditor();
							// Capture baseline on the first stream of a round so
							// the CRDT merge anchors at the right pre-round state.
							if (!incrementalAppliedTabs.has(iTabId)) {
								captureBaselineForAgent(iTabId);
								incrementalAppliedTabs.add(iTabId);
							}
							applyAgentMarkdown(
								iTabId,
								iAgentMd,
								true,
								iTabId === activeTabId ? activeEditor : undefined,
								getTabKind(iTabId)
							);
							incrementalStepCountByTab[iTabId] =
								(incrementalStepCountByTab[iTabId] ?? 0) + 1;
						}
					} else if (event === 'result') {
						// Multi-tab result: parsed.edits is an array of
						// { tabId, agentMd } for every tab the agent touched.
						let currentSettings: AgentSettings = {
							agency: 'conservative',
							trackChanges: true
						};
						agentSettings.subscribe((v) => (currentSettings = v))();

						const edits: Array<{ tabId: string; agentMd: string }> =
							Array.isArray(parsed.edits) ? parsed.edits : [];
						const activeTabId = getCurrentActiveTab();
						const activeEditor = editorRef?.getEditor();

						for (const { tabId, agentMd } of edits) {
							if (typeof agentMd !== 'string') continue;
							if (currentSettings.trackChanges) {
								// Track-changes mode: append a new round to this
								// tab's pending list. Every round gets its own
								// OutlinePane card; the editor's composite diff
								// overlay anchors at rounds[0].beforeMd so all
								// accumulated agent changes show at once.
								const preRender = preRenderMdByTab[tabId] ?? '';
								const reviewMap = getReviewMapForTab(tabId);
								const existing = reviewMap.get('pendingRounds');
								const prior: PendingReviewRound[] = Array.isArray(existing)
									? (existing as PendingReviewRound[])
									: [];
								// If streaming already landed intermediate edits
								// for this tab, the Y.Doc has them. Final apply
								// still runs so the `afterMd` is canonical, and
								// it adds one more undo step (or a no-op if
								// content already matches). Total step count
								// for this round = stream count + 1.
								const streamedSteps =
									incrementalStepCountByTab[tabId] ?? 0;
								const newRound: PendingReviewRound = {
									id:
										'rr_' +
										Date.now().toString(36) +
										Math.random().toString(36).slice(2, 6),
									beforeMd: preRender,
									afterMd: agentMd,
									trigger: trigger || undefined,
									timestamp: Date.now(),
									kind: classifyRoundKind(preRender, agentMd),
									stepCount: streamedSteps + 1
								};
								writeTabRounds(tabId, [...prior, newRound]);
								applyAgentMarkdown(
									tabId,
									agentMd,
									true,
									tabId === activeTabId ? activeEditor : undefined,
									getTabKind(tabId)
								);
							} else {
								// Silent mode: apply to the target tab's Y.Doc
								// without any review UI. Clean up the server
								// shadow for that tab since there's no Accept.
								applyAgentMarkdown(
									tabId,
									agentMd,
									false,
									tabId === activeTabId ? activeEditor : undefined,
									getTabKind(tabId)
								);
								const q = `?tab=${encodeURIComponent(tabId)}`;
								void fetch(`/api/document${q}`, {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({ action: 'accept' })
								});
							}
							lastRenderMarkdownByTab[tabId] = agentMd;
							// Persist the per-tab "last agent saw" snapshot in the
							// tab's review map so a page refresh doesn't reset it
							// to "first render". y-indexeddb takes care of survival.
							getReviewMapForTab(tabId).set('lastAgentMd', agentMd);
						}
						lastRenderMarkdownByTab = { ...lastRenderMarkdownByTab };
					} else if (event === 'hook_run') {
						// Hook execution notification. `running` creates a new
						// entry; `done`/`failed` find the matching running
						// entry by hookId+command and update it in place so we
						// don't double-log each hook.
						agentHistory.update((h) => {
							if (parsed.status === 'running') {
								return [...h, {
									type: 'hook_run',
									timestamp: Date.now(),
									hookId: parsed.hookId,
									event: parsed.event,
									command: parsed.command,
									status: 'running'
								}];
							}
							// Update the most recent running entry with matching ids.
							for (let i = h.length - 1; i >= 0; i--) {
								const e = h[i];
								if (
									e.type === 'hook_run' &&
									e.hookId === parsed.hookId &&
									e.command === parsed.command &&
									e.status === 'running'
								) {
									const next = [...h];
									next[i] = {
										...e,
										status: parsed.status,
										exitCode: parsed.exitCode,
										stdout: parsed.stdout,
										stderr: parsed.stderr,
										durationMs: parsed.durationMs
									};
									return next;
								}
							}
							// No matching running entry (shouldn't happen) —
							// append a terminal entry as a fallback.
							return [...h, {
								type: 'hook_run',
								timestamp: Date.now(),
								hookId: parsed.hookId,
								event: parsed.event,
								command: parsed.command,
								status: parsed.status,
								exitCode: parsed.exitCode,
								stdout: parsed.stdout,
								stderr: parsed.stderr,
								durationMs: parsed.durationMs
							}];
						});
					} else if (event === 'rule_proposal') {
						// Agent invoked the propose_rule MCP tool. Push into the
						// proposedRules store; OutlinePane renders the card with
						// Accept/Reject next to any pending edit.
						if (typeof parsed.text === 'string' && parsed.text.trim()) {
							proposedRules.update((list) => [
								...list,
								{
									id: 'pr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
									text: parsed.text.trim(),
									reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
									timestamp: Date.now()
								}
							]);
						}
					} else if (event === 'hook_proposal') {
						// Agent invoked the propose_hook MCP tool (via the
						// hooks-creator skill). Show a pending card in the
						// OutlinePane — accept appends to .docwriter/hooks.json.
						if (typeof parsed.command === 'string' && parsed.command.trim()) {
							proposedHooks.update((list) => [
								...list,
								{
									id: 'ph_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
									event: parsed.event,
									matcher: typeof parsed.matcher === 'string' && parsed.matcher ? parsed.matcher : undefined,
									command: parsed.command.trim(),
									reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
									timestamp: Date.now()
								}
							]);
						}
					} else if (event === 'user_question') {
						// Agent invoked AskUserQuestion. Render a card in the
						// outline pane; the user's answer comes back via
						// POST /api/ask-user-reply which unblocks the agent.
						if (typeof parsed.id === 'string' && Array.isArray(parsed.questions)) {
							pendingUserQuestions.update((list) => [
								...list,
								{ id: parsed.id, questions: parsed.questions }
							]);
						}
					} else if (event === 'cost') {
						// Per-round cost + usage from the SDK. Accumulated
						// into the sessionCost store; shown in the agent dock.
						addRoundCost({
							totalCostUsd: parsed.totalCostUsd,
							usage: parsed.usage
						});
					} else if (event === 'error') {
						success = false;
						pushHistory({
							type: 'assistant_text',
							timestamp: Date.now(),
							text: `Error: ${parsed.error}`
						});
					}
				}
			}
		} catch (e) {
			console.error('Render failed:', e);
			success = false;
		} finally {
			currentAbort = null;
			submitInFlight = false;
			isRendering.set(false);
			// If the render failed, push one visible error entry. Otherwise
			// the mascot already tells the user it's done.
			if (!success) {
				pushHistory({
					type: 'assistant_text',
					timestamp: Date.now(),
					text: `Render failed after ${Math.round((Date.now() - renderStart) / 100) / 10}s.`
				});
			}
		}
	}

	/** Read the pending-rounds array for the active tab from the store. */
	function currentRounds(): PendingReviewRound[] {
		let rounds: PendingReviewRound[] = [];
		pendingReviewRounds.subscribe((v) => (rounds = v))();
		return rounds;
	}

	/**
	 * Accept the earliest pending round. The OutlinePane only surfaces the
	 * Accept button on the first round in the list, enforcing FIFO order —
	 * this sidesteps the "accept round 2 while round 1 still pending"
	 * ambiguity (the composite diff overlay would keep showing round 2's
	 * text as unresolved green). The monotonic fallback below (accepts
	 * rounds 0..=idx) is kept as a safety net in case something triggers
	 * this with a non-first id.
	 *
	 * Nothing to do on the Yjs side — agent ops stay in the doc as-is;
	 * we just drop the cards and let the diff overlay re-anchor at the
	 * next pending round's `beforeMd` (or clear entirely if none left).
	 */
	async function acceptAgentEdit(roundId?: string) {
		const tabId = getCurrentActiveTab();
		if (!tabId) return;
		const rounds = currentRounds();
		// No id → accept all (legacy call sites, "Accept all" button).
		let next: PendingReviewRound[];
		if (!roundId) {
			next = [];
		} else {
			const idx = rounds.findIndex((r) => r.id === roundId);
			if (idx < 0) return;
			// Monotonic: drop rounds[0..=idx]. Leaves rounds[idx+1..] pending.
			next = rounds.slice(idx + 1);
		}
		const acceptedCount = rounds.length - next.length;
		writeTabRounds(tabId, next);
		if (next.length === 0) {
			clearAgentBaseline(tabId);
			userEditRegions.set([]);
		}
		try {
			const q = `?tab=${encodeURIComponent(tabId)}`;
			await fetch(`/api/document${q}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'accept' })
			});
		} catch (e) {
			console.error('Accept (server cleanup) failed:', e);
		}
		pushHistory({
			type: 'user_action',
			timestamp: Date.now(),
			description:
				acceptedCount === rounds.length
					? `Accepted all ${rounds.length} agent edit${rounds.length === 1 ? '' : 's'}`
					: `Accepted ${acceptedCount} agent edit${acceptedCount === 1 ? '' : 's'}`
		});
	}

	/**
	 * Reject one round by id: rewinds that round's agent ops AND every
	 * later round's agent ops (later rounds built on this one, so they no
	 * longer make sense).
	 *
	 * Uses the per-tab Yjs UndoManager, which only tracks `AGENT_ORIGIN`
	 * transactions — so user keystrokes made between / after agent rounds
	 * are PRESERVED (they're never in the undo stack). Hard-reset via
	 * `applyAgentMarkdown(beforeMd)` is the fallback for cases where the
	 * UndoManager has no in-memory history (reject-after-refresh).
	 *
	 * UX: for non-latest rejections (drops N>0 later rounds), confirms with
	 * the user first.
	 */
	async function rejectAgentEdit(roundId?: string) {
		const tabId = getCurrentActiveTab();
		if (!tabId) return;
		const rounds = currentRounds();

		// How many rounds (from the tail) does this reject invalidate?
		let firstIdx: number;
		if (!roundId) {
			firstIdx = 0; // reject-all
		} else {
			firstIdx = rounds.findIndex((r) => r.id === roundId);
			if (firstIdx < 0) return;
		}
		const droppedCount = rounds.length - firstIdx;
		const laterCount = droppedCount - 1;

		// Non-latest rejection: dropping later rounds feels like wasted
		// work. Instead, after rewinding, re-run the agent with the
		// rejection as explicit feedback so it can re-propose edits
		// that take the rejection into account.
		const shouldReconsider = laterCount > 0;

		// Pop the right number of agent-op steps. With incremental streaming
		// each round contributes `stepCount` steps (one per Edit/Write +
		// one final apply). Sum across the rejected rounds and pop that
		// many — captureTimeout:0 makes every tracked transaction its own
		// step, so the math is direct.
		let stepsToPop = 0;
		for (let i = firstIdx; i < rounds.length; i++) {
			stepsToPop += rounds[i].stepCount ?? 1;
		}
		let rewoundCount = 0;
		for (let i = 0; i < stepsToPop; i++) {
			if (undoAgentChanges(tabId)) rewoundCount++;
			else break;
		}

		// Fallback: UndoManager had fewer steps than we needed (typically
		// after a page refresh, where the in-memory stack is empty). Hard-
		// reset to the earliest-rejected round's beforeMd. User edits made
		// before that round still apply (they're in the Y.Doc history but
		// not reversible from this path).
		if (rewoundCount < stepsToPop && rounds.length > 0) {
			const ed = editorRef?.getEditor();
			applyAgentMarkdown(
				tabId,
				rounds[firstIdx].beforeMd,
				true,
				ed,
				getTabKind(tabId)
			);
		}

		const keep = rounds.slice(0, firstIdx);
		writeTabRounds(tabId, keep);
		if (keep.length === 0) {
			clearAgentBaseline(tabId);
			// Clear stale user-edit regions; they're indexed on pre-reject
			// positions and would paint wrong spots orange now.
			userEditRegions.set([]);
		}

		try {
			const q = `?tab=${encodeURIComponent(tabId)}`;
			await fetch(`/api/document${q}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'reject' })
			});
		} catch (e) {
			console.error('Reject (server cleanup) failed:', e);
		}
		pushHistory({
			type: 'user_action',
			timestamp: Date.now(),
			description:
				droppedCount === rounds.length
					? `Rejected all ${rounds.length} agent edit${rounds.length === 1 ? '' : 's'}`
					: `Rejected ${droppedCount} agent edit${droppedCount === 1 ? '' : 's'}`
		});

		// If we cascade-dropped later rounds, re-run the agent so it can
		// reconsider those pending edits in light of the rejection, rather
		// than throwing away the work entirely. The new render produces
		// fresh rounds that replace the discarded ones.
		if (shouldReconsider) {
			const rejected = rounds[firstIdx];
			const droppedLater = rounds.slice(firstIdx + 1);
			const rejectedDiff = unifiedLineDiff(rejected.beforeMd, rejected.afterMd, 1);
			const lines: string[] = [
				`The user just rejected your previous edit on \`${tabId}\`:`,
				'',
				'```diff',
				rejectedDiff,
				'```',
				'',
				"Do not make that same change again. Take this rejection as feedback on what the user wants different in that area of the file."
			];
			if (droppedLater.length > 0) {
				lines.push(
					'',
					`Because accept/reject applies in order, rejecting that edit also dropped ${droppedLater.length} later edit${droppedLater.length === 1 ? '' : 's'} you had proposed. For each one, decide whether it still makes sense given the rejection — if yes, re-propose (possibly adjusted); if no, skip:`
				);
				droppedLater.forEach((r, i) => {
					const d = unifiedLineDiff(r.beforeMd, r.afterMd, 1);
					lines.push('', `Dropped edit ${i + 1}:`, '```diff', d, '```');
				});
			}
			lines.push('', 'Propose a new set of edits that takes the rejection into account.');
			const followup = lines.join('\n');
			// Defer to next tick so all state updates settle before the new
			// submit() re-enters the render loop.
			setTimeout(() => void submit(followup), 50);
		}
	}

	/** Accept a rule the agent proposed: append it to the rules list and
	 * persist via /api/document. Removes the proposal from the pending set. */
	async function acceptProposedRule(id: string) {
		let proposal: { id: string; text: string } | undefined;
		proposedRules.update((list) => {
			proposal = list.find((p) => p.id === id);
			return list.filter((p) => p.id !== id);
		});
		if (!proposal) return;
		const rule = { id: 'r' + Date.now(), text: proposal.text };
		let currentRules: { id: string; text: string }[] = [];
		rules.subscribe((v) => (currentRules = v))();
		const nextRules = [...currentRules, rule];
		rules.set(nextRules);
		try {
			await fetch('/api/document', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ meta: { rules: nextRules } })
			});
		} catch (e) {
			console.error('Failed to persist rule:', e);
		}
		pushHistory({
			type: 'user_action',
			timestamp: Date.now(),
			description: `Accepted rule: "${proposal.text}"`
		});
	}

	/** Dismiss a proposed rule without saving. */
	function rejectProposedRule(id: string) {
		let proposal: { id: string; text: string } | undefined;
		proposedRules.update((list) => {
			proposal = list.find((p) => p.id === id);
			return list.filter((p) => p.id !== id);
		});
		if (proposal) {
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description: `Rejected rule: "${proposal.text}"`
			});
		}
	}

	/** Accept a hook the agent proposed: append to .docwriter/hooks.json via
	 * /api/hooks. Removes the proposal from the pending set. */
	async function acceptProposedHook(id: string) {
		let proposal:
			| {
					id: string;
					event: import('$lib/types').ProposedHookEvent;
					matcher?: string;
					command: string;
			  }
			| undefined;
		proposedHooks.update((list) => {
			proposal = list.find((p) => p.id === id);
			return list.filter((p) => p.id !== id);
		});
		if (!proposal) return;
		try {
			// GET current hooks, append, PUT back. Server is source of truth.
			const current = await fetch('/api/hooks').then((r) => r.json());
			const existing: Array<Record<string, unknown>> = Array.isArray(current?.hooks)
				? current.hooks
				: [];
			const hook = {
				id: 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
				event: proposal.event,
				matcher: proposal.matcher,
				command: proposal.command,
				enabled: true
			};
			const next = [...existing, hook];
			await fetch('/api/hooks', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ hooks: next })
			});
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description: `Accepted hook: ${proposal.event} — ${proposal.command}`
			});
		} catch (e) {
			console.error('Failed to save proposed hook:', e);
		}
	}

	/** Send the user's selections for an AskUserQuestion card back to the
	 * server, which resolves the SDK's paused tool call and lets the
	 * agent continue with the answers in context. */
	async function answerUserQuestion(id: string, answers: string[]) {
		pendingUserQuestions.update((list) => list.filter((q) => q.id !== id));
		try {
			await fetch('/api/ask-user-reply', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, answers })
			});
		} catch (e) {
			console.error('Answer failed:', e);
		}
		pushHistory({
			type: 'user_action',
			timestamp: Date.now(),
			description: `Answered: ${answers.join(', ')}`
		});
	}

	function rejectProposedHook(id: string) {
		let proposal: { id: string; command: string } | undefined;
		proposedHooks.update((list) => {
			proposal = list.find((p) => p.id === id);
			return list.filter((p) => p.id !== id);
		});
		if (proposal) {
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description: `Rejected hook: ${proposal.command}`
			});
		}
	}

	function cancelRender() {
		if (currentAbort) {
			currentAbort.abort();
			currentAbort = null;
		}
	}

	async function newSession() {
		if (rendering) cancelRender();
		try {
			await fetch('/api/session', { method: 'DELETE' });
			agentHistory.set([]);
			// Also reject any pending agent edits — fresh start across all tabs.
			for (const id of getCurrentTabList()) {
				undoAgentChanges(id);
				writeTabRounds(id, []);
				// Reset the per-tab "what the agent last saw" snapshot too, so
				// the next submit really shows "first render" — matching the
				// fact that the SDK session is gone.
				getReviewMapForTab(id).set('lastAgentMd', null);
			}
			pendingReviewTabs = new Map();
			lastRenderMarkdownByTab = {};
			proposedRules.set([]);
			proposedHooks.set([]);
			pendingUserQuestions.set([]);
			recentActions.set([]);
			actionUsageCounts.set({});
			resetSessionCost();
			clearAllAgentBaselines();
			const tabId = getCurrentActiveTab();
			const q = tabId ? `?tab=${encodeURIComponent(tabId)}` : '';
			await fetch(`/api/document${q}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'reject' })
			});
			pushHistory({ type: 'user_action', timestamp: Date.now(), description: 'Started new session' });
		} catch (e) {
			console.error('New session failed:', e);
		}
	}

	function setTheme(name: string) {
		const theme = themes.find((t) => t.name === name);
		if (theme) {
			selectedTheme.set(name);
			applyTheme(theme);
		}
	}

	let model = $state('opus');
	selectedModel.subscribe((v) => (model = v));

	let themeName = $state('light');
	selectedTheme.subscribe((v) => (themeName = v));

	let historyVisible = $state(true);
	showHistory.subscribe((v) => (historyVisible = v));

	let currentVerbosity = $state<'verbose' | 'minimal'>('verbose');
	historyVerbosity.subscribe((v) => (currentVerbosity = v));

	let countdown = $state(0);
	submitCountdown.subscribe((v) => (countdown = v));

	let fontScale = $state(1.0);
	editorFontScale.subscribe((v) => (fontScale = v));

	// Preset font sizes exposed in the View → Font size submenu. The inline
	// keyboard path (Ctrl+/Ctrl-) still bumps by 0.1.
	const FONT_PRESETS: Array<{ label: string; scale: number }> = [
		{ label: 'Small (85%)', scale: 0.85 },
		{ label: 'Default (100%)', scale: 1.0 },
		{ label: 'Large (115%)', scale: 1.15 },
		{ label: 'Extra large (130%)', scale: 1.3 },
		{ label: 'Huge (150%)', scale: 1.5 }
	];

	/**
	 * Top menu bar spec. `$derived` so checkmarks track the live stores
	 * (selected model / theme / font scale / history pane visibility) and
	 * each open/close of a submenu picks up current state.
	 */
	const menus = $derived<MenuSpec[]>([
		{
			label: 'Settings',
			items: [
				{ kind: 'panel', label: 'Send message', panelKey: 'chat' },
				{ kind: 'divider' },
				{
					kind: 'submenu',
					label: 'Model',
					items: [
						{ kind: 'action', label: 'Opus', checked: model === 'opus', onClick: () => selectedModel.set('opus') },
						{ kind: 'action', label: 'Sonnet', checked: model === 'sonnet', onClick: () => selectedModel.set('sonnet') },
						{ kind: 'action', label: 'Haiku', checked: model === 'haiku', onClick: () => selectedModel.set('haiku') }
					]
				},
				{ kind: 'panel', label: 'Agent behavior', panelKey: 'agentSettings' },
				{
					kind: 'submenu',
					label: 'Theme',
					items: themes.map((t) => ({
						kind: 'action' as const,
						label: t.label,
						checked: themeName === t.name,
						onClick: () => setTheme(t.name)
					}))
				},
				{
					kind: 'submenu',
					label: 'Font size',
					items: FONT_PRESETS.map((p) => ({
						kind: 'action' as const,
						label: p.label,
						checked: Math.abs(fontScale - p.scale) < 0.01,
						onClick: () => editorFontScale.set(p.scale)
					}))
				},
				{ kind: 'panel', label: 'Writing rules', panelKey: 'rules' },
				{ kind: 'panel', label: 'Hooks', panelKey: 'hooks' },
				{ kind: 'divider' },
				{
					kind: 'submenu',
					label: 'History detail',
					items: [
						{
							kind: 'action',
							label: 'Verbose',
							checked: currentVerbosity === 'verbose',
							onClick: () => historyVerbosity.set('verbose')
						},
						{
							kind: 'action',
							label: 'Minimal',
							checked: currentVerbosity === 'minimal',
							onClick: () => historyVerbosity.set('minimal')
						}
					]
				},
				{
					kind: 'action',
					label: historyVisible ? 'Hide history pane' : 'Show history pane',
					onClick: () => showHistory.set(!historyVisible)
				},
				{ kind: 'action', label: 'New session', onClick: () => void newSession() }
			]
		}
	]);

	// Pane widths (resizable)
	let leftWidth = $state(260);
	let rightWidth = $state(340);
	const MIN_PANE_WIDTH = 180;
	const MAX_PANE_WIDTH = 560;
	function resizeLeft(delta: number) {
		leftWidth = Math.max(MIN_PANE_WIDTH, Math.min(MAX_PANE_WIDTH, leftWidth + delta));
	}
	function resizeRight(delta: number) {
		rightWidth = Math.max(MIN_PANE_WIDTH, Math.min(MAX_PANE_WIDTH, rightWidth - delta));
	}

	let docLoaded = $state(false);
	let currentTabKind = $state<'markdown' | 'plain'>('markdown');
	activeTabKind.subscribe((v) => (currentTabKind = v));

	/**
	 * Load the persisted selection-toolbar state (recent actions + LRU usage
	 * counts) from /api/session and hydrate the stores. Refresh would
	 * otherwise wipe both back to empty arrays/objects.
	 */
	async function restoreSessionState() {
		try {
			const res = await fetch('/api/session');
			if (!res.ok) return;
			const data = await res.json();
			if (Array.isArray(data.recentActions)) recentActions.set(data.recentActions);
			if (data.actionUsageCounts && typeof data.actionUsageCounts === 'object') {
				actionUsageCounts.set(data.actionUsageCounts);
			}
		} catch (e) {
			console.error('Failed to restore session state:', e);
		}
	}

	/**
	 * Persist selection-toolbar state to the server. Debounced so rapid
	 * action clicks coalesce into one write. Called from the store
	 * subscriptions below.
	 */
	let persistTimer: ReturnType<typeof setTimeout> | null = null;
	function schedulePersistSession() {
		if (persistTimer) clearTimeout(persistTimer);
		persistTimer = setTimeout(async () => {
			persistTimer = null;
			let recent: unknown[] = [];
			recentActions.subscribe((v) => (recent = v))();
			let counts: Record<string, number> = {};
			actionUsageCounts.subscribe((v) => (counts = v))();
			try {
				await fetch('/api/session', {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ recentActions: recent, actionUsageCounts: counts })
				});
			} catch (e) {
				console.error('Failed to persist session state:', e);
			}
		}, 400);
	}

	onMount(async () => {
		const initialTheme = themes.find((t) => t.name === themeName) || themes[0];
		applyTheme(initialTheme);
		// HMR safety: if the module was hot-reloaded during a render, the
		// store could still say we're rendering. Clamp it to false so the
		// submit button unlocks.
		isRendering.set(false);

		// Load the tab list, pick or create an active tab, bind its Y.Doc
		// as current, then hydrate its content. TiptapEditor mounts after
		// docLoaded flips true, so by then the right Y.Doc is registered.
		const active = await loadTabs();
		if (active) {
			setCurrentTab(active);
			await loadTab(active);
		}
		docLoaded = true;

		// Rehydrate the Agent History pane from the SDK's persisted session
		// transcript so refresh doesn't wipe the activity log. The SDK
		// writes every session to disk keyed by sessionId; we just read it
		// back and convert to our HistoryEntry format.
		void restoreAgentHistory();

		// Restore the selection-toolbar recents + LRU usage counts from
		// state.json so refresh doesn't wipe the cached-pill feedback list.
		// Must complete BEFORE we attach the persist subscribers, otherwise
		// the initial `set([])` would persist empty arrays over the real data.
		await restoreSessionState();

		// Now that stores are populated, attach persist-on-change subscribers.
		// The debounced write coalesces bursts of clicks into one PUT.
		recentActions.subscribe(() => schedulePersistSession());
		actionUsageCounts.subscribe(() => schedulePersistSession());

		// Subscribe to the file-watcher event bus (used by `docwriter --watch`).
		// When the bin's fs.watch sees external changes it POSTs to /api/live,
		// which streams a `reload` event here and we refresh the active tab.
		void connectLive();

		// Dev-only test seam: lets Playwright simulate an agent edit without
		// hitting the Claude SDK. Mirrors what the /api/render result handler
		// does locally — capture baseline, apply markdown, set review state.
		if (import.meta.env.DEV && typeof window !== 'undefined') {
			(window as any).__docwriterTest = {
				fakeAgentEdit(content: string) {
					const tabId = getCurrentActiveTab();
					if (!tabId) return;
					const ed = editorRef?.getEditor();
					const before = getEditorMarkdownNow();
					captureBaselineForAgent(tabId);
					applyAgentMarkdown(tabId, content, true, ed, getTabKind(tabId));
					const existing = getReviewMapForTab(tabId).get('pendingRounds');
					const prior: PendingReviewRound[] = Array.isArray(existing)
						? (existing as PendingReviewRound[])
						: [];
					const newRound: PendingReviewRound = {
						id: 'rr_fake_' + Date.now().toString(36),
						beforeMd: before,
						afterMd: content,
						timestamp: Date.now(),
						kind: classifyRoundKind(before, content)
					};
					writeTabRounds(tabId, [...prior, newRound]);
					// Mirror the result handler: stash this as the "last agent
					// saw" snapshot, both in memory and persisted to the
					// per-tab review map so it survives a refresh.
					lastRenderMarkdownByTab[tabId] = content;
					lastRenderMarkdownByTab = { ...lastRenderMarkdownByTab };
					getReviewMapForTab(tabId).set('lastAgentMd', content);
				},
				accept: acceptAgentEdit,
				reject: rejectAgentEdit,
				/** Read in-memory state for assertions. */
				inspectLastRenderMap: () => ({ ...lastRenderMarkdownByTab }),
				/** Mark the current tab's content as "what the agent last saw"
				 * without going through fakeAgentEdit (which no-ops when the
				 * passed content equals the live content). Mirrors only the
				 * lastAgentMd half of the result handler — useful for tests
				 * that just need a baseline for the next submit's diff. */
				seedLastAgentMd(content: string) {
					const tabId = getCurrentActiveTab();
					if (!tabId) return;
					lastRenderMarkdownByTab[tabId] = content;
					lastRenderMarkdownByTab = { ...lastRenderMarkdownByTab };
					getReviewMapForTab(tabId).set('lastAgentMd', content);
				}
			};
		}
	});

	/**
	 * Subscribe to /api/live (the CLI file-watcher event bus). Reconnects
	 * automatically every 5 s if the connection drops. Each `reload` event
	 * re-fetches the active tab from disk so externally-edited files appear
	 * immediately without a manual browser refresh.
	 */
	async function connectLive() {
		const connect = () => {
			let es: EventSource;
			try {
				es = new EventSource('/api/live');
			} catch {
				return;
			}
			es.addEventListener('reload', async () => {
				const tabId = getCurrentActiveTab();
				if (!tabId) return;
				await loadTab(tabId);
				// If the editor is already mounted, force it to pick up the new
				// userMd by doing a brief unmount/remount cycle.
				docLoaded = false;
				await new Promise((r) => setTimeout(r, 0));
				docLoaded = true;
			});
			es.onerror = () => {
				es.close();
				// Reconnect after 5 s.
				setTimeout(connect, 5_000);
			};
		};
		connect();
	}

	/** Read the *current* on-disk markdown for the active tab. Used by the
	 * dev test seam to capture a baseline before faking an agent edit. */
	function getEditorMarkdownNow(): string {
		let md = '';
		userMd.subscribe((v) => (md = v))();
		return md;
	}

	/** Pull the last session's messages from the SDK and convert them into
	 * HistoryEntry rows matching what we show live. Best-effort: if the
	 * endpoint fails or the session is empty, we leave the pane empty. */
	async function restoreAgentHistory() {
		try {
			const res = await fetch('/api/history');
			const data = await res.json();
			if (!Array.isArray(data.messages) || data.messages.length === 0) return;
			const restored: HistoryEntry[] = [];
			for (const m of data.messages) {
				const msg = m?.message;
				if (!msg) continue;
				if (m.type === 'user') {
					// User messages can be strings or arrays of content blocks.
					// The agent's prompt lives here as free text.
					const content = msg.content;
					let text = '';
					if (typeof content === 'string') {
						text = content;
					} else if (Array.isArray(content)) {
						for (const block of content) {
							if (block?.type === 'text' && typeof block.text === 'string') {
								text += block.text;
							}
						}
					}
					if (!text.trim()) continue;
					// The full prompt is huge; surface a single "Submitted"-style line
					// with the raw prompt tucked behind an expand for parity with
					// live submits. The "What the user wants" section is the useful bit.
					const wantIdx = text.indexOf('## What the user wants');
					const rulesIdx = text.indexOf('## Rules to obey');
					let trigger = text.trim().slice(0, 200);
					if (wantIdx >= 0 && rulesIdx > wantIdx) {
						trigger = text
							.slice(wantIdx + '## What the user wants'.length, rulesIdx)
							.trim();
					}
					restored.push({
						type: 'user_action',
						timestamp: 0,
						description: shortDescription(trigger || undefined)
					});
				} else if (m.type === 'assistant' && Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
							restored.push({
								type: 'assistant_text',
								timestamp: 0,
								text: block.text
							});
						} else if (block?.type === 'tool_use' && typeof block.name === 'string') {
							restored.push({
								type: 'tool_call',
								timestamp: 0,
								tool_name: block.name,
								input: (block.input as Record<string, unknown>) || {}
							});
						}
					}
				}
			}
			// The SDK transcript can contain hundreds of messages from every
			// resumed session. Trim to the tail — most users care about "what
			// did the agent just do" not "everything ever." If they want more
			// they can scroll up in the SDK's raw files.
			const MAX_RESTORED = 20;
			const tail = restored.slice(-MAX_RESTORED);
			if (tail.length > 0) agentHistory.set(tail);
		} catch (e) {
			console.error('Failed to restore agent history:', e);
		}
	}
</script>

<div class="app">
	<header class="header">
		<div class="header-left">
			<span class="logo" aria-hidden="true">
				<ScrollText size={22} strokeWidth={1.8} color="#7c3aed" />
			</span>
			<div class="app-title">DocWriter</div>
			<MenuBar
				{menus}
				panels={{
					chat: chatPanelSnippet,
					rules: rulesPanelSnippet,
					agentSettings: agentSettingsSnippet,
					hooks: hooksPanelSnippet
				}}
			/>
		</div>
		<div class="header-right"></div>
	</header>

	{#snippet rulesPanelSnippet()}
		<RulesPanel onSubmit={(trigger) => void submit(trigger)} />
	{/snippet}

	{#snippet agentSettingsSnippet()}
		<AgentSettingsPanel onSettingsChange={persistAgentSettings} />
	{/snippet}

	{#snippet hooksPanelSnippet()}
		<HooksPanel />
	{/snippet}

	{#snippet chatPanelSnippet()}
		<ChatPanel onSend={(msg) => void submit(msg)} />
	{/snippet}

	<div class="body">
		<aside class="left-pane" style:width="{leftWidth}px">
			<div class="left-pane-inner">
				<OutlinePane
					onAccept={acceptAgentEdit}
					onReject={rejectAgentEdit}
					onAcceptRule={acceptProposedRule}
					onRejectRule={rejectProposedRule}
					onAcceptHook={acceptProposedHook}
					onRejectHook={rejectProposedHook}
					onAnswer={answerUserQuestion}
				/>
				<div class="file-tree-wrap">
					<FileTree
						activePath={activeTabFilePath}
						onOpenFile={onFileOpened}
						onRenamed={onFileTreeRenamed}
						onDeleted={onFileTreeDeleted}
					/>
				</div>
			</div>
		</aside>
		<PanelResizer onResize={resizeLeft} />
		<main class="center-pane">
			<TabBar
				onSwitch={switchTab}
				onCreate={createTab}
				onClose={closeTab}
				onDelete={deleteTab}
				onRename={renameTabAction}
				pendingTabs={pendingReviewTabs}
			/>
			{#if docLoaded}
				<AgentDock onSubmit={() => submit()} />
				<TiptapEditor
					bind:this={editorRef}
					onSubmit={(trigger) => submit(trigger)}
					kind={currentTabKind}
				/>
			{/if}
		</main>
		{#if historyVisible}
			<PanelResizer onResize={resizeRight} />
			<aside class="right-pane" style:width="{rightWidth}px">
				<HistoryPane onNewSession={newSession} />
			</aside>
		{/if}
	</div>
</div>

<style>
	/* ── Typography ──
	   - Inter for all UI chrome (header, panes, buttons, dropdowns)
	   - Lora for the editor prose only (set in TiptapEditor.svelte)
	   Font scale:
	   - 13px  = UI controls, buttons, dropdowns, outline items
	   - 12px  = section headers (uppercase), secondary info
	   - 15px  = app title
	*/
	.app {
		display: flex;
		flex-direction: column;
		height: 100vh;
		background: var(--bg);
		color: var(--text);
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
		font-size: 13px;
	}
	:global(body) {
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
	}
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 16px;
		border-bottom: 1px solid var(--border-light);
		background: var(--header-bg);
	}
	.header-left, .header-right {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
	}
	.header-right {
		justify-content: flex-end;
	}
	.logo {
		flex-shrink: 0;
	}
	.app-title {
		font-size: 15px;
		font-weight: 600;
		letter-spacing: -0.2px;
		color: var(--text);
	}
	/* Submit button, mascot, and settings popover styles moved to
	 * src/lib/components/AgentDock.svelte. */

	.body {
		display: flex;
		flex: 1;
		min-height: 0;
	}
	.left-pane {
		border-right: 1px solid var(--border-light);
		background: var(--pane-bg);
		overflow: hidden;
		flex-shrink: 0;
	}
	.left-pane-inner {
		height: 100%;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
	}
	.file-tree-wrap {
		padding: 12px 16px 16px;
		border-top: 1px solid var(--border-light);
		margin-top: 8px;
	}
	.center-pane {
		position: relative;
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		background: var(--bg);
	}
	.right-pane {
		border-left: 1px solid var(--border-light);
		background: var(--pane-bg);
		overflow: hidden;
		flex-shrink: 0;
	}
</style>
