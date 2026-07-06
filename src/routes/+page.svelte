<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { PageData } from './$types';
	import type * as Y from 'yjs';
	import MenuBar, { type MenuSpec } from '$lib/components/MenuBar.svelte';
	import OutlinePane from '$lib/components/OutlinePane.svelte';
	import FileTree from '$lib/components/FileTree.svelte';
	import type { FileEntry } from '$lib/components/FileTree.svelte';
	import TiptapEditor from '$lib/editor/TiptapEditor.svelte';
	import PdfViewerPane from '$lib/components/PdfViewerPane.svelte';
	import { isPdfPath } from '$lib/shared/file-kinds';
	import AgentDockShell from '$lib/components/AgentDockShell.svelte';
	import ToastStack from '$lib/components/ToastStack.svelte';
	import { pushToast, dismissToast, toastQueue, type ToastSpec } from '$lib/toasts';
	import RulesPanel from '$lib/components/RulesPanel.svelte';
	import RulesPillBar from '$lib/components/RulesPillBar.svelte';
	import ReferencesPanel from '$lib/components/ReferencesPanel.svelte';
	import PanelResizer from '$lib/components/PanelResizer.svelte';
	import HorizontalPanelResizer from '$lib/components/HorizontalPanelResizer.svelte';
	import AgentDock from '$lib/components/AgentDock.svelte';
	import AgentModal from '$lib/components/AgentModal.svelte';
	import Dialog from '$lib/components/Dialog.svelte';
	import AgentSettingsPanel from '$lib/components/AgentSettingsPanel.svelte';
	import HooksPanel from '$lib/components/HooksPanel.svelte';
	import SkillsPanel from '$lib/components/SkillsPanel.svelte';
	import ApiKeysPanel from '$lib/components/ApiKeysPanel.svelte';
	import HostedAccountButton from '$lib/components/HostedAccountButton.svelte';
	import CustomModelDialog from '$lib/components/CustomModelDialog.svelte';
	import SessionBrowser from '$lib/components/SessionBrowser.svelte';
	import { themes, applyTheme } from '$lib/themes';
	import { unifiedLineDiff } from '$lib/diff';
	import { materializePendingReviewRounds } from '$lib/review-rounds';
	import { serializeFragment as plainTextFromFragment } from '$lib/shared/ydoc-codec';
	import { HOSTED_CLAUDE_MODEL_NOTE } from '$lib/shared/claude-models';
	import { IS_HOSTED } from '$lib/hosted';
	import { authFetch } from '$lib/auth-recovery';

	/** Turn a submit trigger into a compact description for the history
	 * pane. Full text of long prompts (including feedback-on-passage quotes)
	 * becomes a single-line label; the agent still gets the full prompt.
	 * When no trigger is given, describe the default "review and improve"
	 * prompt the agent actually receives, not a vague "Submitted". */
	function shortDescription(trigger: string | undefined): string {
		if (!trigger) return 'Review documents & see if there’s anything to do';
		// `The user flagged this passage as|with feedback "…"` — show the
		// feedback text itself, quoted (U+201C/U+201D), and ellipsized when
		// long. The HistoryPane italicizes descriptions that start with the
		// curly-open-quote so user-voiced turns read as the user's words,
		// not a framework label.
		const feedbackMatch = trigger.match(
			/^The user flagged this passage (?:as|with feedback) "([^"]+)"/
		);
		if (feedbackMatch) {
			const text = feedbackMatch[1];
			const truncated = text.length > 80 ? text.slice(0, 77) + '…' : text;
			return `“${truncated}”`;
		}
		// Apply-rules trigger: "Review the open files against the following rules…"
		if (/^Review the open files? against the following rules/.test(trigger)) {
			return 'Apply rules';
		}
		// Reject-and-reconsider trigger starts with "The user just rejected"
		if (/^The user just rejected/.test(trigger)) {
			const retryFeedbackMatch = trigger.match(
				/The user explained why they rejected it:\n\n```text\n([\s\S]*?)\n```/
			);
			if (retryFeedbackMatch) {
				const feedback = retryFeedbackMatch[1].trim().replace(/\s+/g, ' ');
				if (feedback) {
					return `Retry: ${feedback.length > 72 ? feedback.slice(0, 69) + '…' : feedback}`;
				}
			}
			return 'Reconsider after rejection';
		}
		if (trigger.length > 80) return trigger.slice(0, 77) + '…';
		return trigger;
	}

	import {
		getYDocForTab,
		getReviewArrayForTab,
		getCommentsMapForTab,
		whenYDocReadyForTab,
		destroyTab,
		renameTab,
		reconcileServerInstance,
		applyUpdateToTab,
		pauseTabSync,
		setYDocUserId
	} from '$lib/yjs-doc';
	import type { Editor } from '@tiptap/core';
	import {
		reviewBaseline,
		pendingReviewRounds,
		rules,
		proposedRules,
		proposedHooks,
		pendingUserQuestions,
		pendingPlanProposals,
		isRendering,
		agentHistory,
		pushHistory,
		nextHistoryKey,
		selectedModel,
		setSelectedModel,
		setCustomModel,
		selectedProvider,
		setSelectedProvider,
		ALL_PROVIDERS,
		AVAILABLE_PROVIDERS,
		PROVIDER_LOCKED_TO_CLAUDE,
		availableModels,
		loadAvailableModels,
		type ModelOption,
		selectedTheme,
		submitCountdown,
		editorFontScale,
		editorSoftWrap,
		historyVerbosity,
		showFilesPane,
		showSidebar,
		agentSettings,
		expandedReviewRoundId,
		tabs,
		activeTab,
		recentActions,
		addRoundCost,
		resetSessionCost,
		actionUsageCounts,
		commentThreads,
		allTabPendingRounds,
		allTabCommentThreads,
		openCommentThreadId,
		queuedSubmissionCount
	} from '$lib/stores';
	import TabBar from '$lib/components/TabBar.svelte';
	import type { AgentSettings, CommentThread, HistoryEntry, ImageAttachment, PendingReviewRound, ProposedRule, ProposedHook } from '$lib/types';
	import type { MaterializedPendingReviewRound } from '$lib/review-rounds';

	let { data }: { data: PageData } = $props();

	// Hosted Y.Doc names are `<userId>:<tabId>`; the server delivers the
	// Clerk userId via load data so it's available synchronously, before any
	// getYDocForTab call. Must run before onMount wires providers. The
	// initial value is exactly what we want -- identity doesn't change
	// without a full page load.
	// svelte-ignore state_referenced_locally
	setYDocUserId(data.userId ?? null);

	type AgentSettingsChange = {
		type: 'agency';
		from: AgentSettings['agency'];
		to: AgentSettings['agency'];
	};

	type AgentSessionForSwitch = {
		id: string;
		provider: string;
		model: string;
		isCurrent?: boolean;
	};

	type EditorRef = {
		getEditor: () => Editor | undefined;
		flushAutosave: () => Promise<boolean>;
		cancelIdleTimer: () => void;
		getScrollTop: () => number;
		focusEditor: () => void;
		flashAcceptedRange: (text: string) => void;
	};

	let rendering = $state(false);
	isRendering.subscribe((v) => (rendering = v));

	// Synchronous guard: set to true the moment submit() is entered, before any
	// await. Prevents two concurrent calls from the same event loop tick (e.g.
	// a button click firing just as the idle timer callback is about to run).
	let submitInFlight = false;
	let queuedSubmissions: Array<{ trigger?: string; planMode?: boolean }> = [];

	let currentAbort: AbortController | null = null;
	/** Which tabs currently have a pending review (drives the tab dot badges
	 * and gates the Accept/Reject UI in the OutlinePane). */
	/** Map tabId → pending round count. Drives the numbered badge on
	 * each tab. 0 / absent means no pending review on that tab. */
	let pendingReviewTabs: Map<string, number> = $state(new Map());
	/** Tabs the agent just created (write_doc on a non-existent path). No
	 * review round exists — there's nothing to compare against — but we
	 * still want the pulsing "new content" dot so the user notices the
	 * new file appeared. Cleared when the user switches to that tab. */
	let freshAgentTabs: Set<string> = $state(new Set());
	// Local mirror of the cross-tab comment aggregate. The merged gutter only
	// renders the active tab's cards, so awareness of comments on background
	// tabs rides on the TabBar dots derived from this.
	let allCommentsAgg = $state<Array<{ tabId: string; threads: CommentThread[] }>>([]);
	allTabCommentThreads.subscribe((v) => (allCommentsAgg = v));

	/** Combined map for the TabBar dot: real pending-review counts, a
	 * sentinel count of 1 for brand-new agent tabs (which have no review
	 * round), and a dot for tabs that have only unresolved agent comments.
	 * Real pending-edit counts win when both are present. */
	let mergedPendingTabs: Map<string, number> = $derived.by(() => {
		const map = new Map(pendingReviewTabs);
		for (const id of freshAgentTabs) {
			if (!map.has(id)) map.set(id, 1);
		}
		for (const { tabId, threads } of allCommentsAgg) {
			if (threads.length > 0 && !map.has(tabId)) map.set(tabId, threads.length);
		}
		return map;
	});

	// Surface proposed rules/hooks as sticky toasts (the showReview sidebar
	// used to render them as cards). The toast queue is reconciled against
	// the proposal stores: push one per proposal, dismiss when the proposal
	// is gone (accepted/rejected via the toast clears it from the store).
	let proposedRulesList = $state<ProposedRule[]>([]);
	proposedRules.subscribe((v) => (proposedRulesList = v));
	let proposedHooksList = $state<ProposedHook[]>([]);
	proposedHooks.subscribe((v) => (proposedHooksList = v));

	$effect(() => {
		const ruleIds = new Set(proposedRulesList.map((r) => r.id));
		const hookIds = new Set(proposedHooksList.map((h) => h.id));
		for (const r of proposedRulesList) {
			pushToast({ kind: 'rule', title: 'Agent proposed a rule', body: r.text, refId: r.id });
		}
		for (const h of proposedHooksList) {
			pushToast({
				kind: 'hook',
				title: 'Agent proposed a hook',
				body: `${h.event}${h.matcher ? ` · ${h.matcher}` : ''} → ${h.command}`,
				refId: h.id
			});
		}
		// Drop toasts whose proposal no longer exists. Reading the queue via a
		// one-shot subscribe doesn't register a rune dependency, so this effect
		// only re-runs on proposal changes (no write-read loop).
		let current: ToastSpec[] = [];
		toastQueue.subscribe((v) => (current = v))();
		for (const t of current) {
			if (t.kind === 'rule' && !ruleIds.has(t.refId)) dismissToast(t.id);
			if (t.kind === 'hook' && !hookIds.has(t.refId)) dismissToast(t.id);
		}
	});

	function getCurrentTabList(): string[] {
		let v: string[] = [];
		tabs.subscribe((x) => (v = x))();
		return v;
	}

	function currentTabText(tabId: string): string {
		return plainTextFromFragment(getYDocForTab(tabId).getXmlFragment('default'));
	}

	/** Whether a thread anchor still maps to text in the doc — mirrors the
	 * comment overlay's resolver (full quote, else its first non-empty line,
	 * so multi-line anchors aren't falsely treated as detached). Used to keep
	 * detached threads out of the tab count without mutating them. */
	function anchorPresentInText(quote: string, text: string): boolean {
		if (!quote) return false;
		if (text.includes(quote)) return true;
		const firstLine = quote.split('\n').find((l) => l.trim());
		return !!firstLine && text.includes(firstLine);
	}

	function materializedRoundsForTab(
		tabId: string,
		rawRounds: PendingReviewRound[]
	): MaterializedPendingReviewRound[] {
		return materializePendingReviewRounds(currentTabText(tabId), rawRounds);
	}

	function syncActiveReviewState(tabId: string, rawRounds: PendingReviewRound[]) {
		const rounds = materializedRoundsForTab(tabId, rawRounds);
		pendingReviewRounds.set(rounds);
		reviewBaseline.set(rounds.length > 0 ? rounds[0].beforeMd : null);
		const nextPending = new Map(pendingReviewTabs);
		// Stale rounds (no longer match the doc) render no diff — don't let them
		// pulse the tab dot. They stay in the array and re-activate if the text
		// returns; see refreshPendingReviewTabs.
		const actionable = rounds.filter((r) => !r.stale).length;
		if (actionable > 0) nextPending.set(tabId, actionable);
		else nextPending.delete(tabId);
		pendingReviewTabs = nextPending;
		syncAllTabsState();
	}


	let currentActiveTabId = $state<string | null>(null);
	activeTab.subscribe((value) => {
		currentActiveTabId = value;
	});

	let editorRef: EditorRef | undefined = $state();
	// FileTree instance handle. Used to nudge the sidebar to re-fetch when
	// the agent creates a workspace file via write_doc — the new file ends
	// up in `tabs.order` (which we observe below) but FileTree caches its
	// own listing per folder and would otherwise stay stale.
	let fileTreeRef: { refresh: () => Promise<void> } | undefined = $state();

	// When the tab list grows (agent created a file via write_doc, or any
	// other path that opens a new tab), refresh the file tree so the new
	// file appears in the sidebar. Compare lengths rather than diffing —
	// shrinks (close/delete) flow through the FileTree's own onDeleted /
	// onRenamed callbacks, which already refresh.
	let lastKnownTabCount = -1;
	tabs.subscribe((list) => {
		if (lastKnownTabCount >= 0 && list.length > lastKnownTabCount) {
			void fileTreeRef?.refresh();
		}
		lastKnownTabCount = list.length;
	});
	// One-shot scroll restore for the next TiptapEditor mount. Captured
	// before disconnect/remount so Accept / Reject / file reload preserves
	// the user's scroll position. Cleared on tab switch (the new tab's
	// scroll is independent).
	let pendingScrollRestore = $state(0);

	/** Load the tab list from the server. Existing repos should start with no
	 * open tab rather than creating a synthetic default file. */
	function refreshPendingReviewTabs(tabIds: string[]) {
		const pending = new Map<string, number>();
		for (const id of tabIds) {
			if (isPdfPath(id)) continue;
			const raw = getReviewArrayForTab(id).toArray();
			if (raw.length === 0) continue;
			// Count only actionable rounds. A stale round (its old_string no
			// longer matches the doc, e.g. superseded by later edits) renders
			// no diff and can't be reviewed — counting it would pulse the tab
			// dot with nothing to act on. Like detached comments, it stays in
			// the array (re-activates if the text returns) but doesn't nag.
			const actionable = materializedRoundsForTab(id, raw).filter((r) => !r.stale).length;
			if (actionable > 0) pending.set(id, actionable);
		}
		pendingReviewTabs = pending;
	}

	async function loadTabs(): Promise<string | null> {
		try {
			const res = await authFetch('/api/tabs');
			const data = await res.json();
			const tabIds: string[] = Array.isArray(data.tabs)
				? data.tabs
				: Array.isArray(data.order)
					? data.order
					: [];
			let active: string | null = data.active ?? null;
			tabs.set(tabIds);
			activeTab.set(active);
			if (active && !isPdfPath(active)) getYDocForTab(active);
			refreshPendingReviewTabs(tabIds);
			// Attach background observers for every non-active tab so their
			// round/comment changes keep the all-tab pane current.
			for (const id of tabIds) {
				if (id !== active && !isPdfPath(id)) attachBgTabObserver(id);
			}
			syncAllTabsState();
			return active;
		} catch (e) {
			console.error('Failed to load tabs:', e);
			return null;
		}
	}

	/** Load a single tab's meta and hydrate review state from its Y.Doc. */
	async function loadTab(tabId: string) {
		if (isPdfPath(tabId)) {
			detachActiveReviewObservers(
				activeReviewObserver?.tabId ?? activeReviewTextObserver?.tabId ?? tabId
			);
			return;
		}
		try {
			getYDocForTab(tabId);
			const res = await authFetch(`/api/document?tab=${encodeURIComponent(tabId)}`);
			const data = await res.json();
			rules.set(data.meta?.rules || []);
			if (data.meta?.agentSettings) {
				agentSettings.set(data.meta.agentSettings);
			}
			await whenYDocReadyForTab(tabId);
			const rounds = getReviewArrayForTab(tabId).toArray();
			syncActiveReviewState(tabId, rounds);
			attachActiveReviewObserver(tabId);
		} catch (e) {
			console.error(`Failed to load tab "${tabId}":`, e);
		}
	}

	let activeReviewObserver: {
		tabId: string;
		arr: Y.Array<PendingReviewRound>;
		handler: () => void;
	} | null = null;
	let activeReviewTextObserver: {
		tabId: string;
		fragment: Y.XmlFragment;
		handler: () => void;
	} | null = null;
	let activeCommentsObserver: {
		tabId: string;
		map: Y.Map<CommentThread>;
		handler: () => void;
	} | null = null;

	function syncActiveCommentThreads(tabId: string) {
		if (tabId !== getCurrentActiveTab()) return;
		const list: CommentThread[] = [];
		getCommentsMapForTab(tabId).forEach((thread) => list.push(thread));
		list.sort((a, b) => a.createdAt - b.createdAt);
		commentThreads.set(list);
		syncAllTabsState();
	}

	/** Refresh the all-tab aggregates: pending rounds + agent comment threads
	 * for every currently open tab. Called after any per-tab review or
	 * comment change so the OutlinePane cross-tab view stays current. */
	function syncAllTabsState() {
		const tabIds = getCurrentTabList();
		const roundsAgg: Array<{ tabId: string; rounds: MaterializedPendingReviewRound[] }> = [];
		const commentsAgg: Array<{ tabId: string; threads: CommentThread[] }> = [];
		for (const id of tabIds) {
			if (isPdfPath(id)) continue;
			const rawRounds = getReviewArrayForTab(id).toArray();
			if (rawRounds.length > 0) {
				roundsAgg.push({ tabId: id, rounds: materializedRoundsForTab(id, rawRounds) });
			}
			// Count only threads still anchored to text that exists. A thread
			// whose passage was deleted is "detached": it doesn't render in the
			// gutter, so it must not inflate the tab count either. It isn't
			// removed — if the text comes back (Ctrl+Z), the thread re-attaches
			// and counts/renders again.
			const tabText = currentTabText(id);
			const threads: CommentThread[] = [];
			getCommentsMapForTab(id).forEach((t) => {
				if (t.resolved) return;
				if (!t.messages.some((m) => m.author === 'agent')) return;
				if (!anchorPresentInText(t.anchor?.quote ?? '', tabText)) return;
				threads.push(t);
			});
			if (threads.length > 0) {
				threads.sort((a, b) => a.createdAt - b.createdAt);
				commentsAgg.push({ tabId: id, threads });
			}
		}
		allTabPendingRounds.set(roundsAgg);
		allTabCommentThreads.set(commentsAgg);
	}

	async function remountActiveTabFromServer(tabId: string) {
		if (tabId !== getCurrentActiveTab()) return;
		// Reload-from-disk path skips disconnect, so capture scroll here too
		// while the editor is still alive. Accept/Reject paths will have
		// already populated pendingScrollRestore via disconnect; in that
		// case editorRef is already undefined and this no-ops.
		if (editorRef) {
			pendingScrollRestore = editorRef.getScrollTop();
		}
		docLoaded = false;
		await destroyTab(tabId);
		await loadTab(tabId);
		docLoaded = true;
	}

	function detachActiveReviewObservers(tabId: string) {
		if (activeReviewObserver?.tabId === tabId) {
			activeReviewObserver.arr.unobserve(activeReviewObserver.handler);
			activeReviewObserver = null;
		}
		if (activeCommentsObserver?.tabId === tabId) {
			activeCommentsObserver.map.unobserve(activeCommentsObserver.handler);
			activeCommentsObserver = null;
			commentThreads.set([]);
			openCommentThreadId.set(null);
		}
		if (activeReviewTextObserver?.tabId === tabId) {
			activeReviewTextObserver.fragment.unobserve(activeReviewTextObserver.handler);
			activeReviewTextObserver = null;
		}
	}

	function attachActiveReviewObserver(tabId: string) {
		detachActiveReviewObservers(activeReviewObserver?.tabId ?? activeReviewTextObserver?.tabId ?? tabId);
		const arr = getReviewArrayForTab(tabId);
		const handler = () => {
			if (tabId !== getCurrentActiveTab()) return;
			syncActiveReviewState(tabId, arr.toArray());
		};
		arr.observe(handler);
		activeReviewObserver = { tabId, arr, handler };
		const fragment = getYDocForTab(tabId).getXmlFragment('default');
		const textHandler = () => {
			if (tabId !== getCurrentActiveTab()) return;
			const rounds = arr.toArray();
			// Use syncActiveReviewState for both paths to ensure consistent
			// store updates (including pendingReviewTabs). This guards against
			// timing issues where the fragment observer fires but the array
			// observer hasn't yet, leaving pendingReviewRounds stale.
			syncActiveReviewState(tabId, rounds);
		};
		fragment.observe(textHandler);
		activeReviewTextObserver = { tabId, fragment, handler: textHandler };

		const commentsMap = getCommentsMapForTab(tabId);
		const commentsHandler = () => syncActiveCommentThreads(tabId);
		commentsMap.observe(commentsHandler);
		activeCommentsObserver = { tabId, map: commentsMap, handler: commentsHandler };
		syncActiveCommentThreads(tabId);
	}

	/** Lightweight observers for background tabs: any rounds/comment change
	 * triggers syncAllTabsState so the OutlinePane cross-tab list stays
	 * current without touching the active-tab diff overlay state. */
	const bgTabObservers = new Map<string, { arr: ReturnType<typeof getReviewArrayForTab>; commentsMap: ReturnType<typeof getCommentsMapForTab>; arrHandler: () => void; commentsHandler: () => void }>();

	function attachBgTabObserver(tabId: string) {
		if (bgTabObservers.has(tabId)) return;
		const arr = getReviewArrayForTab(tabId);
		const commentsMap = getCommentsMapForTab(tabId);
		const handler = () => syncAllTabsState();
		arr.observe(handler);
		commentsMap.observe(handler);
		bgTabObservers.set(tabId, { arr, commentsMap, arrHandler: handler, commentsHandler: handler });
	}

	function detachBgTabObserver(tabId: string) {
		const obs = bgTabObservers.get(tabId);
		if (!obs) return;
		obs.arr.unobserve(obs.arrHandler);
		obs.commentsMap.unobserve(obs.commentsHandler);
		bgTabObservers.delete(tabId);
	}

	/** Switch the editor to a different tab. Tears down the editor, sets
	 * the current tab on the Y.Doc layer, loads the new tab's content, then
	 * remounts the editor against the new Y.Doc. */
	async function switchTab(tabId: string) {
		const current = getCurrentActiveTab();
		if (tabId === current) return;
		if (freshAgentTabs.has(tabId)) {
			freshAgentTabs.delete(tabId);
			freshAgentTabs = new Set(freshAgentTabs);
		}
		// Drop any peeked round id — it belonged to the prior tab's pending
		// list and would be a stale match (or a no-op) after the switch.
		expandedReviewRoundId.set(null);
		// Move the old active tab to a bg observer and drop the bg observer
		// for the new active tab (the active observer takes over after loadTab).
		if (current && !isPdfPath(current)) attachBgTabObserver(current);
		detachBgTabObserver(tabId);
		// New tab gets its own scroll position (top); don't carry the
		// previous tab's pendingScrollRestore over.
		pendingScrollRestore = 0;
		docLoaded = false; // unmounts TiptapEditor
		activeTab.set(tabId);
		try {
			await authFetch('/api/tabs', {
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
		const res = await authFetch('/api/tabs', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id })
		});
		if (!res.ok) {
			const err = await res.text();
			throw new Error(err || 'Failed to create tab');
		}
		const data = await res.json();
		const listRes = await authFetch('/api/tabs');
		const listData = await listRes.json();
		tabs.set(listData.tabs || []);
		await switchTab(data.active);
	}

	/** Copy files dropped from Finder / the filesystem into the workspace
	 * and open each as a tab. `targetFolder` is the workspace-relative
	 * folder path, or '' for the root. Files that already exist are opened
	 * without overwriting. */
	async function importFilesIntoWorkspace(files: File[], targetFolder: string) {
		for (const file of files) {
			const path = targetFolder ? `${targetFolder}/${file.name}` : file.name;
			const content = await readFileAsBase64(file);
			const createRes = await authFetch('/api/files', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, content, encoding: 'base64' })
			});
			if (!createRes.ok && createRes.status !== 409) continue;
			const existing = getCurrentTabList();
			if (existing.includes(path)) {
				await switchTab(path);
			} else {
				await createTab(path);
			}
			fileTreeRef?.refresh();
		}
	}

	async function readFileAsBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result as string;
				resolve(result.split(',')[1] ?? '');
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	async function handleDropFiles(files: File[]) {
		await importFilesIntoWorkspace(files, '');
	}

	async function handleTreeDropFiles(files: File[], targetFolder: string) {
		await importFilesIntoWorkspace(files, targetFolder);
	}

	async function closeTab(id: string) {
		// Just drop the tab from the registry. File stays on disk; the
		// user can reopen it from the FileTree later.
		await removeTab(id, /* deleteFile */ false);
	}

	async function deleteTab(id: string) {
		// Destructive: close the tab AND unlink the file.
		await removeTab(id, /* deleteFile */ true);
		// Wake the agent so it can react — e.g. drop references to the
		// deleted file from whatever's still open.
		void submit(`The user deleted the file "${id}". Update any open files that referenced it.`);
	}

	/** No open tabs: tear down review/editor state and show the empty pane. */
	function showEmptyEditor() {
		const activeId = getCurrentActiveTab();
		if (activeId) detachActiveReviewObservers(activeId);
		expandedReviewRoundId.set(null);
		pendingReviewRounds.set([]);
		reviewBaseline.set(null);
		commentThreads.set([]);
		openCommentThreadId.set(null);
		activeTab.set(null);
		docLoaded = true;
	}

	async function removeTab(id: string, deleteFile: boolean) {
		const qs = new URLSearchParams({ id });
		if (deleteFile) qs.set('deleteFile', 'true');
		const closedWasActive = getCurrentActiveTab() === id;
		const res = await authFetch(`/api/tabs?${qs.toString()}`, { method: 'DELETE' });
		if (!res.ok) throw new Error(await res.text());
		const data = await res.json();
		detachBgTabObserver(id);
		if (closedWasActive) detachActiveReviewObservers(id);
		// Destroy this tab's Y.Doc binding regardless of whether the file
		// was unlinked — we don't want a stale in-memory doc if the tab
		// gets re-opened.
		await destroyTab(id);
		const listData = await authFetch('/api/tabs').then((r) => r.json());
		const tabIds: string[] = listData.tabs ?? data.order ?? [];
		tabs.set(tabIds);
		const nextActive =
			typeof data.active === 'string' && tabIds.includes(data.active)
				? data.active
				: tabIds[0] ?? null;
		if (!nextActive) {
			showEmptyEditor();
		} else if (closedWasActive || nextActive !== getCurrentActiveTab()) {
			await switchTab(nextActive);
		}
	}

	async function renameTabAction(oldId: string, newId: string) {
		const res = await authFetch('/api/tabs', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: oldId, newId })
		});
		if (!res.ok) throw new Error(await res.text());
		const data = await res.json();
		await renameTab(oldId, newId);
		const listData = await authFetch('/api/tabs').then((r) => r.json());
		tabs.set(listData.tabs || []);
		if (getCurrentActiveTab() === oldId) {
			activeTab.set(newId);
		}
	}

	function getCurrentActiveTab(): string | null {
		return currentActiveTabId;
	}

	/** Path of the currently active tab — same as its id. Used by the
	 * FileTree to highlight the active file. */
	let activeTabFilePath = $state<string | null>(null);
	let activeTabIsPdf = $state(false);
	$effect(() => {
		activeTabFilePath = currentActiveTabId;
		activeTabIsPdf = activeTabFilePath ? isPdfPath(activeTabFilePath) : false;
	});

	let splitPreviewPath = $state<string | null>(null);
	let splitPreviewSourcePath = $state<string | null>(null);
	let splitPreviewOpen = $derived(!!splitPreviewPath && !activeTabIsPdf);
	let splitPreviewWidth = $state(820);
	let splitLayoutEl: HTMLDivElement | null = $state(null);
	const MIN_SPLIT_PREVIEW_WIDTH = 480;
	const MIN_SPLIT_SOURCE_WIDTH = 620;

	function maxSplitPreviewWidth() {
		const layoutWidth =
			splitLayoutEl?.clientWidth ??
			(typeof window === 'undefined' ? 1440 : Math.max(0, window.innerWidth - leftWidth));
		return Math.max(MIN_SPLIT_PREVIEW_WIDTH, layoutWidth - MIN_SPLIT_SOURCE_WIDTH);
	}

	function clampSplitPreviewWidth(width: number) {
		return Math.max(MIN_SPLIT_PREVIEW_WIDTH, Math.min(maxSplitPreviewWidth(), width));
	}

	function resizeSplitPreview(deltaX: number) {
		splitPreviewWidth = clampSplitPreviewWidth(splitPreviewWidth - deltaX);
	}

	async function resolvePreviewOutputForTab(tabPath: string | null): Promise<string | null> {
		if (!tabPath) return null;
		try {
			const res = await authFetch(
				`/api/hooks/preview-match?file=${encodeURIComponent(tabPath)}`
			);
			if (!res.ok) return null;
			const data = await res.json();
			return typeof data?.outputPath === 'string' ? data.outputPath : null;
		} catch {
			return null;
		}
	}

	function openSplitPreview(path: string) {
		splitPreviewPath = path;
		splitPreviewSourcePath = activeTabFilePath;
	}

	function closeSplitPreview() {
		splitPreviewPath = null;
		splitPreviewSourcePath = null;
	}

	async function refreshSplitPreviewForTab(tabPath: string) {
		const nextPath = await resolvePreviewOutputForTab(tabPath);
		if (activeTabFilePath !== tabPath) return;
		splitPreviewPath = nextPath;
		splitPreviewSourcePath = nextPath ? tabPath : null;
	}

	$effect(() => {
		const tabPath = activeTabFilePath;
		if (!splitPreviewPath) return;
		if (!tabPath || activeTabIsPdf) {
			closeSplitPreview();
			return;
		}
		if (tabPath !== splitPreviewSourcePath) {
			void refreshSplitPreviewForTab(tabPath);
		}
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


	/** Clear the peeked round id when the underlying round is going away
	 * (accept/reject). When `roundId` is undefined the caller is doing a
	 * batch op, so clear unconditionally. */
	function clearPeekIfMatches(roundId?: string) {
		let current: string | null = null;
		expandedReviewRoundId.subscribe((v) => (current = v))();
		if (!current) return;
		if (!roundId || current === roundId) expandedReviewRoundId.set(null);
	}

	/** Flip the agent's muted flag. Muted: pending edits land as cards but
	 * the editor's diff overlay stays hidden until the user clicks a card.
	 * Also clears any currently-expanded round so unmuting doesn't leave
	 * one round selected when the full overlay returns. */
	function toggleMuted() {
		let next: AgentSettings | null = null;
		agentSettings.update((prev) => {
			next = { ...prev, muted: !prev.muted };
			return next;
		});
		if (next) {
			expandedReviewRoundId.set(null);
			void persistAgentSettings(next);
		}
	}

	/** Persist agent settings through `/api/document` so the server can read
	 * them at render time (for agency-level prompt injection). */
	async function persistAgentSettings(next: AgentSettings) {
		try {
			const tabId = getCurrentActiveTab();
			if (!tabId) return;
			const q = tabId ? `?tab=${encodeURIComponent(tabId)}` : '';
			await authFetch(`/api/document${q}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ meta: { agentSettings: next } })
			});
		} catch (e) {
			console.error('Failed to persist agent settings:', e);
		}
	}

	const autonomyChangeCopy: Record<
		AgentSettings['agency'],
		{ label: string; instruction: string }
	> = {
		conservative: {
			label: 'Low',
			instruction:
				'Low autonomy means you should act only when the user asks, or when something is clearly broken. Do not create proactive comments or edits.'
		},
		balanced: {
			label: 'Medium',
			instruction:
				'Medium autonomy means you may proactively create new comment threads. Do not edit unless the user asks.'
		},
		aggressive: {
			label: 'High',
			instruction:
				'High autonomy means you may proactively create new comment threads and propose reviewable edits when you see a meaningful improvement.'
		}
	};

	const autonomyRank: Record<AgentSettings['agency'], number> = {
		conservative: 0,
		balanced: 1,
		aggressive: 2
	};

	function buildAutonomyChangeMessage(change: AgentSettingsChange): string {
		const copy = autonomyChangeCopy[change.to];
		const wentUp = autonomyRank[change.to] > autonomyRank[change.from];
		if (wentUp) {
			return `Autonomy changed to ${copy.label}. ${copy.instruction} Review the current open document under this new policy now. If this policy allows a useful comment or edit, create it in the document. If there is nothing useful to do, keep the response brief.`;
		}
		return `Autonomy changed to ${copy.label}. ${copy.instruction} Use this policy from now on. Do not start new proactive work solely because autonomy was lowered.`;
	}

	async function handleAgentSettingsChange(next: AgentSettings, change?: AgentSettingsChange) {
		await persistAgentSettings(next);
		if (change?.type === 'agency') {
			void submit(buildAutonomyChangeMessage(change));
		}
	}

	function isAcceptedEditsMessage(trigger?: string): boolean {
		return /^Accepted (?:all )?\d+ agent edit/.test(trigger ?? '');
	}

	/** Implicit wakeup = the user clicked Wake up with no specific prompt,
	 * so the agent gets the generic "review the docs and see if there's
	 * anything to do" message. If a real user message is already queued
	 * behind it, the wakeup is redundant — the real message implies the
	 * same review pass — so we drop it. */
	function isImplicitWakeupTrigger(trigger?: string): boolean {
		return !trigger;
	}

	/** True when the dequeued message can be safely skipped because there's
	 * a more specific user message right behind it. */
	function isSkippableWhenQueued(trigger?: string): boolean {
		return isAcceptedEditsMessage(trigger) || isImplicitWakeupTrigger(trigger);
	}

	async function submit(trigger?: string, opts?: { planMode?: boolean; images?: ImageAttachment[] }) {
		const planMode = opts?.planMode ?? false;
		const images = opts?.images ?? [];
		if (rendering || submitInFlight) {
			// An implicit "review the docs" wakeup carries no specific intent,
			// so while the agent is already busy it's always redundant — the
			// in-flight render is itself a review pass. Drop it outright rather
			// than queuing it; otherwise each finished render dequeues one and
			// the next keystroke queues another, a never-ending treadmill of
			// re-reviews. An implicit wakeup only fires when the agent is idle
			// (handled below), in which case it runs immediately, never queued.
			if (isImplicitWakeupTrigger(trigger)) return;
			// The accepted-edits auto-wake carries real state ("the user
			// accepted your edits"), so we keep one queued — but collapse
			// duplicates when there's already something behind it.
			if (isSkippableWhenQueued(trigger) && queuedSubmissions.length > 0) return;
			queuedSubmissions = [...queuedSubmissions, { trigger, planMode }];
			queuedSubmissionCount.set(queuedSubmissions.length);
			return;
		}
		// With no open tabs, only typed-message sends make sense; Wake Up /
		// implicit triggers have nothing to anchor to.
		if (!getCurrentActiveTab() && !trigger) return;
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
		// server-side shadow diff can come back empty.
		try {
			const synced = await editorRef?.flushAutosave();
			if (synced === false) {
				pushHistory({
					type: 'notification',
					timestamp: Date.now(),
					text: 'Latest local edits are still syncing to the server. Try again in a moment.',
					priority: 'high'
				});
				return;
			}
		} catch (e) {
			console.error('flushAutosave failed:', e);
		}

		// If this is a feedback trigger, pull out the passage so the history
		// entry shows both the label and what it was applied to.
		const feedbackQuoteMatch = trigger?.match(
			/^The user flagged this passage (?:as|with feedback) "[^"]+"\. Rewrite it to address that: "([\s\S]+)"$/
		);
		pushHistory({
			type: 'user_action',
			timestamp: Date.now(),
			description: shortDescription(trigger),
			quote: feedbackQuoteMatch?.[1]
		});

		isRendering.set(true);
		const renderStart = Date.now();

		currentAbort = new AbortController();
		let success = true;
		// Snapshot of `pendingRounds` per tab BEFORE this render started.
		// The agent's custom `edit_doc` / `write_doc` tools append rounds
		// directly into each tab's `Y.Map('review')` on the server; those
		// rounds stream to the browser over Hocuspocus sync, so by the
		// time `result` fires the Y.Doc already has the new rounds. Diffing
		// against this snapshot lets us count rounds added this render
		// (for the zero-edit message).
		const priorRoundIdsByTab = new Map<string, Set<string>>();
		for (const id of getCurrentTabList()) {
			const rounds = getReviewArrayForTab(id).toArray();
			priorRoundIdsByTab.set(id, new Set(rounds.map((r) => r.id)));
		}

		try {
			let model = 'opus';
			selectedModel.subscribe((v) => (model = v))();
			let provider = 'claude';
			selectedProvider.subscribe((v) => (provider = v))();

			const tabId = getCurrentActiveTab();
			const res = await authFetch('/api/render', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					userMessage: trigger,
					model,
					planMode,
					tab: tabId,
					images: images.length > 0 ? images : undefined,
					provider
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
							tool_use_id: parsed.tool_use_id,
							subagent: parsed.subagent
						});
					} else if (event === 'tool_call') {
						agentHistory.update((h) => {
							// Match the pending start entry by tool_use_id (the
							// tool_call_start pushed it). Fall back to the last
							// same-named entry only if no id match — avoids
							// attaching input to the wrong card when the same
							// tool is called repeatedly (common with edit_doc).
							const targetId = parsed.tool_use_id;
							if (targetId) {
								for (let i = h.length - 1; i >= 0; i--) {
									const e = h[i];
									if (e.type === 'tool_call' && e.tool_use_id === targetId) {
										return [...h.slice(0, i), { ...e, input: parsed.input }, ...h.slice(i + 1)];
									}
								}
							}
							const last = h[h.length - 1];
							if (last && last.type === 'tool_call' && last.tool_name === parsed.tool_name) {
								return [...h.slice(0, -1), { ...last, input: parsed.input, tool_use_id: parsed.tool_use_id ?? last.tool_use_id }];
							}
							return h;
						});
					} else if (event === 'tool_result') {
						// The SDK surfaces a tool's MCP return value here; find
						// the matching tool_call entry by tool_use_id and
						// attach the text + isError so HistoryPane can render
						// the reason a failed edit_doc / write_doc didn't land.
						let matchedToolName: string | null = null;
						agentHistory.update((h) => {
							const targetId = parsed.tool_use_id;
							if (!targetId) return h;
							// Walk from newest to oldest to catch the latest
							// pending entry with this id.
							for (let i = h.length - 1; i >= 0; i--) {
								const entry = h[i];
								if (entry.type === 'tool_call' && entry.tool_use_id === targetId) {
									matchedToolName = entry.tool_name || null;
									const updated = {
										...entry,
										result: typeof parsed.text === 'string' ? parsed.text : '',
										isError: !!parsed.is_error
									};
									return [...h.slice(0, i), updated, ...h.slice(i + 1)];
								}
							}
							return h;
						});
						// edit_doc / write_doc can auto-open a new tab (or create
						// a brand-new file and open it). Re-sync tab list on any
						// successful call so the new tab appears without a page
						// refresh. Match MCP-prefixed names too.
						if (
							!parsed.is_error &&
							matchedToolName &&
							/(?:^|__)(edit_doc|write_doc)$/.test(matchedToolName)
						) {
							const before = new Set(getCurrentTabList());
							loadTabs()
								.then(() => {
									const after = getCurrentTabList();
									for (const id of after) {
										if (!before.has(id) && id !== currentActiveTabId) {
											freshAgentTabs.add(id);
										}
									}
									freshAgentTabs = new Set(freshAgentTabs);
									refreshPendingReviewTabs(after);
								})
								.catch(() => {});
						}
					} else if (event === 'assistant_text') {
						agentHistory.update((h) => {
							const last = h[h.length - 1];
							if (last && last.type === 'assistant_text') {
								return [...h.slice(0, -1), { ...last, text: last.text + parsed.text }];
							}
							return [...h, { type: 'assistant_text', timestamp: Date.now(), text: parsed.text, _key: nextHistoryKey() } as HistoryEntry];
						});
					} else if (event === 'assistant_thinking') {
						const text = typeof parsed.text === 'string' ? parsed.text : '';
						if (!text) {
							continue;
						}
						agentHistory.update((h) => {
							const last = h[h.length - 1];
							if (last && last.type === 'assistant_thinking') {
								return [...h.slice(0, -1), { ...last, text: last.text + text }];
							}
							if (!text.trim()) return h;
							return [...h, { type: 'assistant_thinking', timestamp: Date.now(), text, _key: nextHistoryKey() } as HistoryEntry];
						});
					} else if (event === 'sdk_status') {
						if (parsed.status !== 'compacting' && !parsed.compactResult && !parsed.error) {
							continue;
						}
						pushHistory({
							type: 'status',
							timestamp: Date.now(),
							status: parsed.status ?? null,
							compactResult: parsed.compactResult,
							error: parsed.error
						});
					} else if (event === 'sdk_notification') {
						pushHistory({
							type: 'notification',
							timestamp: Date.now(),
							text: parsed.text,
							priority: parsed.priority
						});
					} else if (event === 'directive_retry') {
						agentHistory.update((h) => {
							const next = [...h];
							while (next.length > 0) {
								const last = next[next.length - 1];
								if (last.type === 'assistant_text' && last.text.trim() === 'No response requested.') {
									next.pop();
									continue;
								}
								if (last.type === 'assistant_thinking' && !last.text.trim()) {
									next.pop();
									continue;
								}
								break;
							}
							return next;
						});
					} else if (event === 'task_event') {
						pushHistory({
							type: 'task',
							timestamp: Date.now(),
							taskId: parsed.taskId,
							phase: parsed.phase,
							description: parsed.description,
							summary: parsed.summary,
							taskType: parsed.taskType,
							lastToolName: parsed.lastToolName
						});
					} else if (event === 'tool_progress') {
						agentHistory.update((h) => {
							const last = h[h.length - 1];
							if (
								last &&
								last.type === 'tool_progress' &&
								last.tool_name === parsed.tool_name &&
								last.taskId === parsed.taskId
							) {
								return [
									...h.slice(0, -1),
									{
										...last,
										elapsedSeconds: parsed.elapsedSeconds
									}
								];
							}
							return [
								...h,
								{
									type: 'tool_progress',
									timestamp: Date.now(),
									tool_name: parsed.tool_name,
									elapsedSeconds: parsed.elapsedSeconds,
									taskId: parsed.taskId,
									_key: nextHistoryKey()
								} as HistoryEntry
							];
						});
					} else if (event === 'result') {
						if (!success) continue;
						// Agent-applied edits arrive over Hocuspocus WebSocket
						// sync: `mcp__docwriter-doc__edit_doc` and `write_doc`
						// on the server transact directly against the live
						// Y.Doc (content + a new entry in `pendingRounds` in
						// one atomic op), and the client's Y.Doc picks both up
						// via the provider. By the time `result` fires, the
						// per-tab review rounds and the editor content are
						// already in their final state — the browser doesn't
						// need to apply anything.
						//
						// Derive whether the agent actually touched any tab by
						// comparing the current `pendingRounds` to the pre-
						// render snapshot captured before `/api/render`.
						let anyRoundAdded = false;
						for (const id of getCurrentTabList()) {
							const priorIds = priorRoundIdsByTab.get(id) ?? new Set<string>();
							const rounds = getReviewArrayForTab(id).toArray();
							const added = rounds.filter((r) => !priorIds.has(r.id));
							if (added.length > 0) {
								anyRoundAdded = true;
							}
						}
						if (!anyRoundAdded) {
							pushHistory({
								type: 'user_action',
								timestamp: Date.now(),
								description: 'Agent ran and made no edits'
							});
						} else {
							agentHistory.update((h) => {
								const next = [...h];
								while (next.length > 0) {
									const last = next[next.length - 1];
									if (last.type === 'assistant_text' && last.text.trim() === 'No response requested.') {
										next.pop();
										continue;
									}
									break;
								}
								return next;
							});
						}
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
									status: 'running',
									_key: nextHistoryKey()
								} as HistoryEntry];
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
								durationMs: parsed.durationMs,
								_key: nextHistoryKey()
							} as HistoryEntry];
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
					} else if (event === 'plan_proposed') {
						// Agent ran in plan mode and produced a plan. Surface
						// it as a blocking modal; Run it re-submits the same
						// prompt without plan mode, Dismiss drops it.
						if (typeof parsed.id === 'string' && typeof parsed.plan === 'string') {
							pendingPlanProposals.update((list) => [
								...list,
								{
									id: parsed.id,
									plan: parsed.plan,
									originalMessage:
										typeof parsed.originalMessage === 'string'
											? parsed.originalMessage
											: ''
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
			const isAbort = e instanceof Error && e.name === 'AbortError';
			if (!isAbort) {
				console.error('Render failed:', e);
				success = false;
			}
		} finally {
			currentAbort = null;
			submitInFlight = false;
			isRendering.set(false);
			// Agent shell tools can create folders/files without opening tabs.
			// Refresh visible file-tree nodes at the end of each run so those
			// filesystem changes show up even without a tab-count change.
			void fileTreeRef?.refresh();
			// If the render failed, push one visible error entry. Otherwise
			// the mascot already tells the user it's done.
			if (!success) {
				pushHistory({
					type: 'assistant_text',
					timestamp: Date.now(),
					text: `Render failed after ${Math.round((Date.now() - renderStart) / 100) / 10}s.`
				});
			}
			let next = queuedSubmissions[0];
			if (next) {
				queuedSubmissions = queuedSubmissions.slice(1);
				queuedSubmissionCount.set(queuedSubmissions.length);
				// Skip generic auto-wakeups (accepted-edits, implicit "review
				// docs" wakeup) when more specific user messages are queued
				// behind them — they'd just duplicate the work.
				while (isSkippableWhenQueued(next.trigger) && queuedSubmissions.length > 0) {
					next = queuedSubmissions[0];
					queuedSubmissions = queuedSubmissions.slice(1);
					queuedSubmissionCount.set(queuedSubmissions.length);
				}
				if (!isSkippableWhenQueued(next.trigger) || queuedSubmissions.length === 0) {
					setTimeout(() => void submit(next.trigger, { planMode: next.planMode }), 0);
				}
			} else {
				queuedSubmissionCount.set(0);
			}
		}
	}

	/** Read the pending-rounds array for the active tab from the store. */
	function currentRounds(): MaterializedPendingReviewRound[] {
		let rounds: MaterializedPendingReviewRound[] = [];
		pendingReviewRounds.subscribe((v) => (rounds = v))();
		return rounds;
	}

	function buildStaleAcceptFollowup(
		tabId: string,
		stale: MaterializedPendingReviewRound,
		reason: string
	): string {
		const staleDiff = unifiedLineDiff(stale.beforeMd, stale.afterMd, 1);
		return [
			`The user clicked Accept on your previous edit to \`${tabId}\`, but it could not be applied because it became stale:`,
			'',
			`> ${reason}`,
			'',
			'Your previous proposal (for reference) was:',
			'',
			'```diff',
			staleDiff,
			'```',
			'',
			'The user still wants this change applied. Re-read the current state of the file with `read_doc` and propose a fresh edit that reflects whatever the document looks like now.'
		].join('\n');
	}

	type ReviewAction = 'accept_rounds' | 'reject_rounds';
	type ReviewActionResponse = {
		ok?: boolean;
		rounds?: PendingReviewRound[];
		yjsUpdate?: string | null;
		acceptedCount?: number;
		rejectedCount?: number;
		error?: string;
		stale?: boolean;
		staleRoundId?: string | null;
		staleRoundKind?: string | null;
	};

	/** Shared accept/reject transport. The ordering here is the undo contract:
	 * pause WebSocket sync, let the server mutate, apply the returned delta
	 * locally with USER_ORIGIN, then reconnect. That guarantees the browser's
	 * UndoManager sees Accept/Reject as a local user action instead of a
	 * provider-origin remote update. */
	async function postReviewAction(
		tabId: string,
		action: ReviewAction,
		roundId?: string | string[]
	): Promise<{ res: Response; data: ReviewActionResponse }> {
		const synced = await editorRef?.flushAutosave();
		if (synced === false) {
			throw new Error('Latest local edits are still syncing to the server. Try again in a moment.');
		}

		const resumeTabSync = pauseTabSync(tabId);
		try {
			const body = Array.isArray(roundId)
				? { action, roundIds: roundId }
				: { action, roundId };
			const res = await authFetch(`/api/document?tab=${encodeURIComponent(tabId)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const data = (await res.json().catch(() => ({}))) as ReviewActionResponse;
			if (res.ok && data?.ok && Array.isArray(data.rounds) && typeof data.yjsUpdate === 'string') {
				applyUpdateToTab(tabId, data.yjsUpdate);
				editorRef?.focusEditor();
			}
			return { res, data };
		} finally {
			resumeTabSync();
		}
	}

	/** Resolve / reopen a thread through the same undo-friendly transport as
	 * Accept/Reject: pause sync, let the server resolve the thread AND drop its
	 * pending edits in one transaction, apply the delta locally with
	 * USER_ORIGIN. ctrl+z then reopens the thread and resurrects its edits in a
	 * single step. */
	async function resolveThread(threadId: string, resolved: boolean) {
		const tabId = getCurrentActiveTab();
		if (!tabId) return;
		const resumeTabSync = pauseTabSync(tabId);
		try {
			const res = await authFetch(`/api/document?tab=${encodeURIComponent(tabId)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'set_thread_resolution', threadId, resolved })
			});
			const data = (await res.json().catch(() => ({}))) as {
				ok?: boolean;
				yjsUpdate?: string | null;
			};
			if (res.ok && data?.ok && typeof data.yjsUpdate === 'string') {
				applyUpdateToTab(tabId, data.yjsUpdate);
				if (resolved) clearPeekIfMatches(undefined);
				editorRef?.focusEditor();
			}
		} catch (e) {
			console.error('Failed to set thread resolution:', e);
		} finally {
			resumeTabSync();
		}
	}


	/** Accept a single pending round by id (or all rounds if no id is
	 * given — used by the "Accept all" path). Rounds are independent: the
	 * server applies just this round's edit op against the current live
	 * doc. If the round became stale (its `old_string` no longer matches
	 * because a prior pending round changed the same text), the server
	 * returns 409 and we re-queue it with a follow-up prompt asking the
	 * agent to regenerate against the now-current text. */
	async function acceptAgentEdit(roundId?: string | string[]) {
		const tabId = getCurrentActiveTab();
		if (!tabId) return;
		const rounds = currentRounds();
		const single = typeof roundId === 'string' ? roundId : undefined;
		const ids = Array.isArray(roundId) ? roundId : single ? [single] : null;
		if (single && rounds.findIndex((r) => r.id === single) < 0) return;
		if (Array.isArray(roundId) && !rounds.some((r) => roundId.includes(r.id))) return;
		clearPeekIfMatches(single);
		editorRef?.cancelIdleTimer();
		try {
			const { res, data } = await postReviewAction(tabId, 'accept_rounds', roundId);
			if (res.status === 409 && data?.stale) {
				const staleRoundId: string | null = data.staleRoundId ?? single ?? null;
				const reason: string = typeof data.error === 'string' && data.error
					? data.error
					: 'The proposal no longer fits the current text.';
				const staleRound =
					staleRoundId != null ? rounds.find((r) => r.id === staleRoundId) : rounds[0];
				if (staleRoundId) {
					await rejectAgentEdit(staleRoundId);
				}
				pushHistory({
					type: 'notification',
					timestamp: Date.now(),
					text: `Proposal was stale (${reason}) — re-queuing the agent with the current text.`,
					priority: 'medium'
				});
				if (staleRound) {
					const followup = buildStaleAcceptFollowup(tabId, staleRound, reason);
					setTimeout(() => void submit(followup), 50);
				}
				return;
			}
			if (!res.ok || !data?.ok || !Array.isArray(data.rounds)) {
				throw new Error(data?.error || `HTTP ${res.status}`);
			}
			const acceptedCount =
				typeof data.acceptedCount === 'number'
					? data.acceptedCount
					: rounds.length - (data.rounds as PendingReviewRound[]).length;
			if (acceptedCount <= 0) return;
			// Small-win celebration: flash a sage halo on the accepted range.
			// Skip 'write' ops — a full-doc rewrite would paint everything green.
			const justAccepted = ids
				? rounds.filter((r) => ids.includes(r.id))
				: rounds.slice(0, acceptedCount);
			for (const r of justAccepted) {
				const op = r.operation;
				if (op?.type !== 'edit') continue;
				if (!op.newString) continue;
				editorRef?.flashAcceptedRange(op.newString);
			}
			const acceptedMsg =
				acceptedCount === rounds.length
					? `Accepted all ${rounds.length} agent edit${rounds.length === 1 ? '' : 's'}`
					: `Accepted ${acceptedCount} agent edit${acceptedCount === 1 ? '' : 's'}`;
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description: acceptedMsg
			});
			void submit(acceptedMsg);
		} catch (e) {
			console.error('Failed to accept agent edit:', e);
			pushHistory({
				type: 'notification',
				timestamp: Date.now(),
				text: `Accept failed: ${(e as Error).message}`,
				priority: 'high'
			});
		}
	}

	/**
	 * Reject one round by id. Drops just that round; later rounds stay and
	 * will surface as stale if their `oldString` no longer matches the
	 * current text (the materializer flags them). Reject with no id drops
	 * everything.
	 *
	 * Optional retry feedback re-submits with the rejection as context so
	 * the agent can try again.
	 */
	function buildRejectedEditFollowup(
		tabId: string,
		rejected: MaterializedPendingReviewRound,
		feedback?: string
	): string {
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
		if (feedback) {
			lines.push(
				'',
				'User provided this feedback:',
				'',
				'```text',
				feedback,
				'```',
				'',
				'If the feedback sounds like a standing preference rather than a one-off request, you may also propose a rule.'
			);
		}
		lines.push('', 'Propose a new edit that takes the feedback into account.');
		return lines.join('\n');
	}

	async function rejectAgentEdit(
		roundId?: string,
		options?: { retryFeedback?: string }
	) {
		const tabId = getCurrentActiveTab();
		if (!tabId) return;
		const rounds = currentRounds();
		const retryFeedback = options?.retryFeedback?.trim();
		const rejectedIdx = roundId ? rounds.findIndex((r) => r.id === roundId) : -1;
		if (roundId && rejectedIdx < 0) return;
		clearPeekIfMatches(roundId);
		editorRef?.cancelIdleTimer();
		try {
			const { res, data } = await postReviewAction(tabId, 'reject_rounds', roundId);
			if (!res.ok || !data?.ok || !Array.isArray(data.rounds)) {
				throw new Error(data?.error || `HTTP ${res.status}`);
			}
			const rejectedCount =
				typeof data.rejectedCount === 'number'
					? data.rejectedCount
					: Math.max(0, rounds.length - (data.rounds as PendingReviewRound[]).length);
			pushHistory({
				type: 'user_action',
				timestamp: Date.now(),
				description:
					!roundId
						? `Rejected all ${rounds.length} agent edit${rounds.length === 1 ? '' : 's'}`
						: `Rejected ${rejectedCount} agent edit${rejectedCount === 1 ? '' : 's'}`
			});
		} catch (e) {
			console.error('reject failed:', e);
			pushHistory({
				type: 'notification',
				timestamp: Date.now(),
				text: `Reject failed: ${(e as Error).message}`,
				priority: 'high'
			});
			return;
		}

		// Retry-with-feedback re-runs the agent with the rejection quoted.
		if (retryFeedback && rejectedIdx >= 0) {
			const followup = buildRejectedEditFollowup(tabId, rounds[rejectedIdx], retryFeedback);
			setTimeout(() => void submit(followup), 50);
		}
	}

	async function retryRejectedEditWithFeedback(roundId: string, feedback: string) {
		await rejectAgentEdit(roundId, { retryFeedback: feedback });
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
			await authFetch('/api/document', {
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
			const current = await authFetch('/api/hooks').then((r) => r.json());
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
			await authFetch('/api/hooks', {
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
			await authFetch('/api/ask-user-reply', {
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

	/** User approved a plan — pop it from the modal and re-submit the
	 * original prompt without plan mode so the agent executes it. */
	function runPlanProposal(id: string) {
		let proposal: { id: string; originalMessage: string } | undefined;
		pendingPlanProposals.update((list) => {
			proposal = list.find((p) => p.id === id);
			return list.filter((p) => p.id !== id);
		});
		if (!proposal) return;
		pushHistory({
			type: 'user_action',
			timestamp: Date.now(),
			description: 'Approved plan — running it'
		});
		void submit(proposal.originalMessage || undefined, { planMode: false });
	}

	function dismissPlanProposal(id: string) {
		pendingPlanProposals.update((list) => list.filter((p) => p.id !== id));
		pushHistory({
			type: 'user_action',
			timestamp: Date.now(),
			description: 'Dismissed plan'
		});
	}

	/** User rejected the plan with written feedback. Kick off a fresh
	 * plan-mode round so the agent produces a revised plan that
	 * addresses the feedback. */
	function rejectPlanProposal(id: string, feedback: string) {
		let proposal: { id: string; originalMessage: string; plan: string } | undefined;
		pendingPlanProposals.update((list) => {
			proposal = list.find((p) => p.id === id);
			return list.filter((p) => p.id !== id);
		});
		if (!proposal) return;
		pushHistory({
			type: 'user_action',
			timestamp: Date.now(),
			description: `Rejected plan with feedback: ${feedback}`
		});
		const revisedMessage = [
			proposal.originalMessage || 'Propose a plan.',
			'',
			'You previously proposed this plan:',
			'',
			proposal.plan,
			'',
			'The user rejected it with this feedback:',
			'',
			feedback,
			'',
			'Produce a revised plan that addresses the feedback.'
		].join('\n');
		void submit(revisedMessage, { planMode: true });
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
		queuedSubmissions = [];
		queuedSubmissionCount.set(0);
		// Defensive: if the controller is gone (HMR re-instantiated this
		// component while a render was in flight, leaving the store true
		// but the closure orphaned), the abort above no-ops and the
		// submit() finally never runs. Clear the store directly so
		// Restart always unsticks the UI.
		isRendering.set(false);
		submitInFlight = false;
	}

	async function newSession() {
		if (rendering) cancelRender();
		// Drop any queued submissions before they can fire from
		// submitDocument's finally block and re-populate cost after reset.
		queuedSubmissions = [];
		queuedSubmissionCount.set(0);
		// Zero the dock immediately so a buffered SSE cost event from the
		// aborted render can't land between awaits and the final reset.
		resetSessionCost();
		try {
			await authFetch('/api/session', { method: 'DELETE' });
			agentHistory.set([]);
			// Reject any pending agent edits — fresh start across all tabs.
			// Must go through the server; see rejectAgentEdit for why.
			for (const id of getCurrentTabList()) {
				const list = getReviewArrayForTab(id).toArray();
				if (list.length === 0) continue;
				try {
					await authFetch(`/api/document?tab=${encodeURIComponent(id)}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ action: 'reject_rounds' })
					});
				} catch {
					// best-effort; local observers + badge map clear below
				}
			}
			pendingReviewTabs = new Map();
			proposedRules.set([]);
			proposedHooks.set([]);
			pendingUserQuestions.set([]);
			pendingPlanProposals.set([]);
			recentActions.set([]);
			actionUsageCounts.set({});
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

	let currentProvider = $state('claude');
	selectedProvider.subscribe((v) => (currentProvider = v));

	let modelOptions = $state<ModelOption[]>([]);
	availableModels.subscribe((v) => (modelOptions = v));

	/** Models filtered to the currently selected provider. */
	const providerModels = $derived(
		modelOptions.filter((m) => !m.provider || m.provider === currentProvider)
	);

	/** Custom-model dialog (replaces the old window.prompt). */
	let customModelOpen = $state(false);
	let sessionsOpen = $state(false);

	let themeName = $state('light');
	selectedTheme.subscribe((v) => (themeName = v));

	let filesVisible = $state(true);
	showFilesPane.subscribe((v) => (filesVisible = v));

	let sidebarVisible = $state(true);
	showSidebar.subscribe((v) => (sidebarVisible = v));

	// Mirror of agentSettings.muted for class binding on the right pane.
	// When true, everything in the right sidebar except the agent dock
	// gets a translucent veil so the user isn't distracted by inflight
	// activity. They unmute via the bell icon in the dock.
	let muted = $state(false);
	agentSettings.subscribe((v) => (muted = v.muted));

	let pendingRoundCount = $state(0);
	pendingReviewRounds.subscribe((v) => (pendingRoundCount = v.length));

	let currentVerbosity = $state<'verbose' | 'minimal'>('verbose');
	historyVerbosity.subscribe((v) => (currentVerbosity = v));

	let countdown = $state(0);
	submitCountdown.subscribe((v) => (countdown = v));

	let fontScale = $state(1.0);
	editorFontScale.subscribe((v) => (fontScale = v));

	let softWrap = $state(false);
	editorSoftWrap.subscribe((v) => (softWrap = v));

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
				{
					kind: 'submenu',
					label: 'Provider',
					items: [
						// When not locked, AVAILABLE_PROVIDERS === ALL_PROVIDERS,
						// so one map covers both modes.
						...ALL_PROVIDERS.map((p) => ({
							kind: 'action' as const,
							label: p.label,
							checked: currentProvider === p.id,
							disabled: PROVIDER_LOCKED_TO_CLAUDE && p.id !== 'claude',
							onClick: () => setSelectedProvider(p.id)
						})),
						...(PROVIDER_LOCKED_TO_CLAUDE
							? [
									{ kind: 'divider' as const },
									{
										kind: 'action' as const,
										label: 'Other providers are available when self-hosting.',
										disabled: true,
										onClick: () => {}
									}
								]
							: [])
					]
				},
				{
					kind: 'submenu',
					label: 'Model',
					items: [
						// Hosted mode: /api/models already filters to the allowed
						// set, so entries need no disabled logic — the store
						// setters remain the enforcement point.
						...(providerModels.length > 0 ? providerModels : modelOptions).map((m) => ({
							kind: 'action' as const,
							label: m.label,
							checked: model === m.id,
							onClick: () => setSelectedModel(m.id)
						})),
						{ kind: 'divider' as const },
						PROVIDER_LOCKED_TO_CLAUDE
							? {
									kind: 'action' as const,
									label: HOSTED_CLAUDE_MODEL_NOTE,
									disabled: true,
									onClick: () => {}
								}
							: {
									kind: 'action' as const,
									label: 'Custom model…',
									checked: false,
									onClick: () => {
										customModelOpen = true;
									}
								}
					]
				},
				{ kind: 'panel', label: 'API keys', panelKey: 'apiKeys' },
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
				{
					kind: 'action',
					label: 'Wrap long lines',
					checked: softWrap,
					onClick: () => editorSoftWrap.update((v) => !v)
				},
				{ kind: 'panel', label: 'Writing references', panelKey: 'references' },
				{ kind: 'panel', label: 'Skills', panelKey: 'skills' },
				{ kind: 'panel', label: 'Hooks', panelKey: 'hooks' },
				{ kind: 'divider' },
				{
					kind: 'action',
					label: 'Sessions',
					onClick: () => {
						sessionsOpen = true;
					}
				},
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
					label: 'Sidebar',
					checked: sidebarVisible,
					onClick: () => showSidebar.set(!sidebarVisible)
				},
				{
					kind: 'action',
					label: 'Files pane',
					checked: filesVisible,
					onClick: () => showFilesPane.set(!filesVisible)
				}
			]
		}
	]);

	// Pane widths (resizable)
	let leftWidth = $state(240);
	const MIN_PANE_WIDTH = 180;
	const MAX_PANE_WIDTH = 560;
	function resizeLeft(delta: number) {
		leftWidth = Math.max(MIN_PANE_WIDTH, Math.min(MAX_PANE_WIDTH, leftWidth + delta));
	}

	const MIN_FILE_TREE_HEIGHT = 160;
	let fileTreeHeight = $state(280);
	let leftPaneInnerEl: HTMLDivElement | null = $state(null);
	let removeSidebarResizeListener = () => {};
	let didInitFileTreeHeight = false;

	function maxFileTreeHeight() {
		const paneHeight = leftPaneInnerEl?.clientHeight ?? 0;
		if (paneHeight <= 0) return 360;
		return Math.max(MIN_FILE_TREE_HEIGHT, Math.floor(paneHeight * 0.66));
	}

	function clampFileTreeHeight(next: number) {
		return Math.max(MIN_FILE_TREE_HEIGHT, Math.min(maxFileTreeHeight(), next));
	}

	function resizeFileTree(deltaY: number) {
		fileTreeHeight = clampFileTreeHeight(fileTreeHeight - deltaY);
	}

	let docLoaded = $state(false);

	/**
	 * Load the persisted selection-toolbar state (recent actions + LRU usage
	 * counts) from /api/session and hydrate the stores. Refresh would
	 * otherwise wipe both back to empty arrays/objects.
	 *
	 * Also acts as the preflight for Y.Doc reconciliation: if the server's
	 * `serverInstanceId` doesn't match the one this browser tab last synced
	 * with, destroy every in-memory Y.Doc before the WebSocket provider can
	 * attach. Otherwise stale Yjs ops from the previous server instance
	 * would sync up into the freshly-seeded server doc and the debounced
	 * markdown flush would clobber disk edits made while the server was
	 * down. Must run BEFORE any `getYDocForTab` call.
	 */
	async function restoreSessionState() {
		try {
			const res = await authFetch('/api/session');
			if (!res.ok) return;
			const data = await res.json();
			if (typeof data.serverInstanceId === 'string') {
				const prior =
					typeof window !== 'undefined'
						? sessionStorage.getItem('docwriter.serverInstanceId')
						: null;
				await reconcileServerInstance(data.serverInstanceId);
				// Server-instance change means a different docwriter process
				// (restart, --new-session, different workspace). Any cost
				// accumulated under the previous process belongs to a
				// different conversation; drop it so the agent dock starts
				// at 0¢ for the new session.
				if (prior && prior !== data.serverInstanceId) {
					resetSessionCost();
				}
			}
			if (Array.isArray(data.recentActions)) recentActions.set(data.recentActions);
			if (data.actionUsageCounts && typeof data.actionUsageCounts === 'object') {
				actionUsageCounts.set(data.actionUsageCounts);
			}
			if (typeof data.editorSoftWrap === 'boolean') {
				editorSoftWrap.set(data.editorSoftWrap);
			}
			if (typeof data.theme === 'string') {
				selectedTheme.set(data.theme);
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
			let wrapLongLines = false;
			editorSoftWrap.subscribe((v) => (wrapLongLines = v))();
			let theme = 'light';
			selectedTheme.subscribe((v) => (theme = v))();
			try {
				await authFetch('/api/session', {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						recentActions: recent,
						actionUsageCounts: counts,
						editorSoftWrap: wrapLongLines,
						theme
					})
				});
			} catch (e) {
				console.error('Failed to persist session state:', e);
			}
		}, 400);
	}

	onMount(async () => {
		function clampSidebarPanels() {
			if (filesVisible) {
				if (!didInitFileTreeHeight) {
					fileTreeHeight = maxFileTreeHeight();
					didInitFileTreeHeight = true;
				} else {
					fileTreeHeight = clampFileTreeHeight(fileTreeHeight);
				}
			}
		}
		window.addEventListener('resize', clampSidebarPanels);
		removeSidebarResizeListener = () => {
			window.removeEventListener('resize', clampSidebarPanels);
		};

		// HMR safety: if the module was hot-reloaded during a render, the
		// store could still say we're rendering. Clamp it to false so the
		// submit button unlocks.
		isRendering.set(false);

		// Load the tab list, pick or create an active tab, bind its Y.Doc
		// as current, then hydrate its content. TiptapEditor mounts after
		// docLoaded flips true, so by then the right Y.Doc is registered.
		// Restore the selection-toolbar recents + LRU usage counts from
		// server state so refresh doesn't wipe cached feedback pills or editor
		// view prefs like soft wrap and theme. Must complete BEFORE the editor
		// mounts and before we attach the persist subscribers, otherwise
		// defaults could overwrite the real values.
		await restoreSessionState();

		const initialTheme = themes.find((t) => t.name === themeName) || themes[0];
		applyTheme(initialTheme);

		const active = await loadTabs();
		if (active) await loadTab(active);
		docLoaded = true;

		// Rehydrate the Agent History pane from the SDK's persisted session
		// transcript so refresh doesn't wipe the activity log. The SDK
		// writes every session to disk keyed by sessionId; we just read it
		// back and convert to our HistoryEntry format.
		void restoreAgentHistory();

		// Pull the live model catalog for the Settings → Model menu and adopt
		// the latest-Opus default if the user hasn't pinned a model.
		void loadAvailableModels();

		// Now that stores are populated, attach persist-on-change subscribers.
		// The debounced write coalesces bursts of clicks into one PUT.
		recentActions.subscribe(() => schedulePersistSession());
		actionUsageCounts.subscribe(() => schedulePersistSession());
		editorSoftWrap.subscribe(() => schedulePersistSession());
		selectedTheme.subscribe(() => schedulePersistSession());

		// Subscribe to the file-watcher event bus (used by `docwriter --watch`).
		// When the bin's fs.watch sees external changes it POSTs to /api/live,
		// which streams a `reload` event here and we refresh the active tab
		// plus the visible file tree.
		void connectLive();

		// Listen for SyncTeX jump messages from the preview popup so a
		// double-click in the rendered PDF opens the source location here.
		attachSynctexJumpListener();

		// Dev-only test seam: lets Playwright simulate an agent edit without
		// hitting the Claude SDK. Route it through the server so tests
		// exercise the same write/review/undo path as production.
		if (import.meta.env.DEV && typeof window !== 'undefined') {
			(window as any).__docwriterTest = {
				async fakeAgentEdit(content: string) {
					const tabId = getCurrentActiveTab();
					if (!tabId) return;
					const res = await authFetch(`/api/document?tab=${encodeURIComponent(tabId)}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							action: 'dev_fake_agent_write',
							content
						})
					});
					const data = await res.json().catch(() => ({}));
					if (!res.ok || !data?.ok) {
						throw new Error(data?.error || `HTTP ${res.status}`);
					}
				},
				async fakeAgentReplace(oldString: string, newString: string) {
					const tabId = getCurrentActiveTab();
					if (!tabId) return;
					const res = await authFetch(`/api/document?tab=${encodeURIComponent(tabId)}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							action: 'dev_fake_agent_edit',
							oldString,
							newString
						})
					});
					const data = await res.json().catch(() => ({}));
					if (!res.ok || !data?.ok) {
						throw new Error(data?.error || `HTTP ${res.status}`);
					}
				},
				accept: acceptAgentEdit,
				reject: rejectAgentEdit
			};
		}

		clampSidebarPanels();
	});

	onDestroy(() => {
		if (activeReviewObserver) {
			activeReviewObserver.arr.unobserve(activeReviewObserver.handler);
			activeReviewObserver = null;
		}
		if (activeReviewTextObserver) {
			activeReviewTextObserver.fragment.unobserve(activeReviewTextObserver.handler);
			activeReviewTextObserver = null;
		}
		removeSidebarResizeListener();
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
				void fileTreeRef?.refresh();
				const tabId = getCurrentActiveTab();
				if (!tabId) return;
				await remountActiveTabFromServer(tabId);
			});
			// When a hook produces an output file (e.g. pdflatex → main.pdf),
			// the file may be NEW on disk — refresh the file tree so it
			// appears in the sidebar without the user having to expand /
			// collapse the folder. The preview window also listens for this
			// event to reload its iframe.
			es.addEventListener('preview_ready', () => {
				void fileTreeRef?.refresh();
			});
			es.onerror = () => {
				es.close();
				// Reconnect after 5 s.
				setTimeout(connect, 5_000);
			};
		};
		connect();
	}

	/** Scroll the editor to a specific 1-based line number. Plain-text mode
	 * means each line is one direct `<p>` child of .tiptap-content, so the
	 * line number IS the paragraph index (1-based). Flashes the target so
	 * the user sees where they landed. */
	function scrollEditorToLine(line: number) {
		if (line < 1) return;
		const editor = document.querySelector('.tiptap-content') as HTMLElement | null;
		if (!editor) return;
		const paragraphs = Array.from(editor.querySelectorAll(':scope > p')) as HTMLElement[];
		const target = paragraphs[line - 1];
		if (!target) return;
		target.scrollIntoView({ behavior: 'smooth', block: 'center' });
		const text = (target.textContent ?? '').trim();
		if (text) {
			// Best-effort celebration so the eye lands on the target after
			// the smooth scroll completes. Uses the same overlay as Accept.
			setTimeout(() => editorRef?.flashAcceptedRange(text.slice(0, 80)), 300);
		}
	}

	/** Listen for synctex jump messages from the preview popup. Origin is
	 * checked because postMessage is wildcard-broadcastable; we only honor
	 * messages from our own origin (the preview window runs at the same
	 * SvelteKit origin). After verifying, open the file as a tab (or
	 * switch to it) and scroll to the line. */
	function attachSynctexJumpListener() {
		if (typeof window === 'undefined') return;
		const handler = async (ev: MessageEvent) => {
			if (ev.origin !== window.location.origin) return;
			const data = ev.data as { kind?: string; file?: string; line?: number } | null;
			if (!data) return;
			if (data.kind === 'docwriter-close-preview-pane') {
				closeSplitPreview();
				return;
			}
			if (data.kind !== 'docwriter-synctex-jump') return;
			if (typeof data.file !== 'string' || typeof data.line !== 'number') return;
			const tabId = data.file;
			const line = data.line;
			try {
				const existing = getCurrentTabList();
				if (existing.includes(tabId)) {
					await switchTab(tabId);
				} else {
					await createTab(tabId);
				}
				// Wait for the editor to render the tab's content before
				// scrolling. Two RAFs to be safe across slow paints.
				requestAnimationFrame(() =>
					requestAnimationFrame(() => scrollEditorToLine(line))
				);
			} catch (e) {
				console.error('synctex jump failed:', e);
			}
		};
		window.addEventListener('message', handler);
	}

	function textFromMessageContent(content: unknown): string {
		if (typeof content === 'string') return content;
		if (!Array.isArray(content)) return '';
		let text = '';
		for (const block of content) {
			if (
				block &&
				typeof block === 'object' &&
				'type' in block &&
				(block as { type?: unknown }).type === 'text' &&
				typeof (block as { text?: unknown }).text === 'string'
			) {
				text += (block as { text: string }).text;
			}
		}
		return text;
	}

	function descriptionFromPrompt(text: string): string {
		const trimmed = text.trim();
		if (!trimmed) return shortDescription(undefined);
		const wantIdx = trimmed.indexOf('## What the user wants');
		const rulesIdx = trimmed.indexOf('## Rules to obey');
		let trigger = trimmed.slice(0, 200);
		if (wantIdx >= 0 && rulesIdx > wantIdx) {
			trigger = trimmed
				.slice(wantIdx + '## What the user wants'.length, rulesIdx)
				.trim();
		}
		return shortDescription(trigger || undefined);
	}

	function attachRestoredToolResult(
		entries: HistoryEntry[],
		toolUseId: string,
		result: string,
		isError: boolean
	): boolean {
		if (!toolUseId) return false;
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry.type === 'tool_call' && entry.tool_use_id === toolUseId) {
				entries[i] = { ...entry, result, isError };
				return true;
			}
		}
		return false;
	}

	function attachRestoredToolInput(
		entries: HistoryEntry[],
		toolUseId: string,
		input: Record<string, unknown>
	): boolean {
		if (!toolUseId) return false;
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry.type === 'tool_call' && entry.tool_use_id === toolUseId) {
				entries[i] = { ...entry, input };
				return true;
			}
		}
		return false;
	}

	function extractToolResultBlock(block: Record<string, unknown>): {
		toolUseId: string;
		result: string;
		isError: boolean;
	} {
		const content = block.content;
		let result = '';
		if (typeof content === 'string') {
			result = content;
		} else if (Array.isArray(content)) {
			for (const item of content) {
				if (
					item &&
					typeof item === 'object' &&
					(item as { type?: unknown }).type === 'text' &&
					typeof (item as { text?: unknown }).text === 'string'
				) {
					result += (item as { text: string }).text;
				}
			}
		}
		return {
			toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
			result,
			isError: block.is_error === true
		};
	}

	function restoreFromClaudeRaw(raw: unknown[]): HistoryEntry[] {
		const restored: HistoryEntry[] = [];
		for (const entry of raw) {
			if (!entry || typeof entry !== 'object') continue;
			const e = entry as Record<string, unknown>;
			const msg = e.message as Record<string, unknown> | undefined;
			if (e.type === 'user' && msg) {
				const content = msg.content;
				const text = textFromMessageContent(content);
				if (text.trim()) {
					restored.push({
						type: 'user_action',
						timestamp: 0,
						description: descriptionFromPrompt(text)
					});
				}
				if (Array.isArray(content)) {
					for (const block of content) {
						if (
							block &&
							typeof block === 'object' &&
							(block as { type?: unknown }).type === 'tool_result'
						) {
							const toolResult = extractToolResultBlock(block as Record<string, unknown>);
							attachRestoredToolResult(
								restored,
								toolResult.toolUseId,
								toolResult.result,
								toolResult.isError
							);
						}
					}
				}
				continue;
			}
			if (e.type !== 'assistant' || !msg || !Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (!block || typeof block !== 'object') continue;
				const b = block as Record<string, unknown>;
				if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
					restored.push({
						type: 'assistant_text',
						timestamp: 0,
						text: b.text
					});
				} else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
					restored.push({
						type: 'assistant_thinking',
						timestamp: 0,
						text: b.thinking
					});
				} else if (b.type === 'tool_use' && typeof b.name === 'string') {
					restored.push({
						type: 'tool_call',
						timestamp: 0,
						tool_name: b.name,
						tool_use_id: typeof b.id === 'string' ? b.id : undefined,
						input: (b.input as Record<string, unknown>) || {}
					});
				}
			}
		}
		return restored;
	}

	function restoreFromProviderEvents(raw: unknown[]): HistoryEntry[] {
		const restored: HistoryEntry[] = [];
		const flushText = (() => {
			let current:
				| { type: 'assistant_text' | 'assistant_thinking'; text: string }
				| null = null;
			return {
				add(type: 'assistant_text' | 'assistant_thinking', text: string) {
					if (!text) return;
					if (current?.type === type) {
						current.text += text;
						return;
					}
					this.flush();
					current = { type, text };
				},
				flush() {
					if (current && current.text.trim()) {
						restored.push({
							type: current.type,
							timestamp: 0,
							text: current.text
						});
					}
					current = null;
				}
			};
		})();

		for (const entry of raw) {
			if (!entry || typeof entry !== 'object') continue;
			const e = entry as Record<string, unknown>;
			const type = typeof e.type === 'string' ? e.type : '';
			if (type === 'assistant_text' || type === 'assistant_thinking') {
				flushText.add(
					type === 'assistant_text' ? 'assistant_text' : 'assistant_thinking',
					typeof e.text === 'string' ? e.text : ''
				);
				continue;
			}
			flushText.flush();
			if (type === 'user_message') {
				const text = typeof e.text === 'string' ? e.text : '';
				if (text.trim()) {
					restored.push({
						type: 'user_action',
						timestamp: 0,
						description: shortDescription(text)
					});
				}
			} else if (type === 'tool_call') {
				const toolUseId = typeof e.tool_use_id === 'string' ? e.tool_use_id : '';
				const input = (e.input as Record<string, unknown>) || {};
				if (!attachRestoredToolInput(restored, toolUseId, input)) {
					restored.push({
						type: 'tool_call',
						timestamp: 0,
						tool_name: typeof e.tool_name === 'string' ? e.tool_name : 'unknown',
						tool_use_id: toolUseId || undefined,
						input
					});
				}
			} else if (type === 'tool_call_start') {
				restored.push({
					type: 'tool_call',
					timestamp: 0,
					tool_name: typeof e.tool_name === 'string' ? e.tool_name : 'unknown',
					tool_use_id: typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined,
					input: {}
				});
			} else if (type === 'tool_result') {
				const toolUseId = typeof e.tool_use_id === 'string' ? e.tool_use_id : '';
				const result = typeof e.text === 'string' ? e.text : '';
				const isError = e.is_error === true;
				if (!attachRestoredToolResult(restored, toolUseId, result, isError)) {
					restored.push({
						type: 'tool_call',
						timestamp: 0,
						tool_name: 'tool_result',
						tool_use_id: toolUseId || undefined,
						input: {},
						result,
						isError
					});
				}
			} else if (type === 'error') {
				const text = typeof e.error === 'string' ? e.error : 'Agent error';
				restored.push({
					type: 'notification',
					timestamp: 0,
					text,
					priority: 'high'
				});
			}
		}
		flushText.flush();
		return restored;
	}

	function restoreFromSdkMessages(messages: unknown[]): HistoryEntry[] {
		const restored: HistoryEntry[] = [];
		for (const m of messages) {
			if (!m || typeof m !== 'object') continue;
			const entry = m as Record<string, unknown>;
			const msg = entry.message as Record<string, unknown> | undefined;
			if (!msg) continue;
			if (entry.type === 'user') {
				const text = textFromMessageContent(msg.content);
				if (!text.trim()) continue;
				restored.push({
					type: 'user_action',
					timestamp: 0,
					description: descriptionFromPrompt(text)
				});
			} else if (entry.type === 'assistant' && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (!block || typeof block !== 'object') continue;
					const b = block as Record<string, unknown>;
					if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
						restored.push({
							type: 'assistant_text',
							timestamp: 0,
							text: b.text
						});
					} else if (b.type === 'tool_use' && typeof b.name === 'string') {
						restored.push({
							type: 'tool_call',
							timestamp: 0,
							tool_name: b.name,
							input: (b.input as Record<string, unknown>) || {}
						});
					}
				}
			}
		}
		return restored;
	}

	/** Pull the last session's messages from durable history and convert them
	 * into HistoryEntry rows matching what we show live. Best-effort: if the
	 * endpoint fails or the session is empty, we leave the pane empty. */
	async function restoreAgentHistory() {
		try {
			const res = await authFetch('/api/history');
			const data = await res.json();
			const provider = typeof data.provider === 'string' ? data.provider : 'claude';
			const raw = Array.isArray(data.raw) ? data.raw : [];
			const messages = Array.isArray(data.messages) ? data.messages : [];
			const restored =
				raw.length > 0
					? provider === 'claude'
						? restoreFromClaudeRaw(raw)
						: restoreFromProviderEvents(raw)
					: restoreFromSdkMessages(messages);

			// The transcript can contain hundreds of messages from every
			// resumed session. Trim to the tail — most users care about "what
			// did the agent just do" not "everything ever." If they want more
			// they can open the session transcript.
			const MAX_RESTORED = 20;
			const tail = restored.slice(-MAX_RESTORED);
			if (tail.length > 0) agentHistory.set(tail);
		} catch (e) {
			console.error('Failed to restore agent history:', e);
		}
	}

	function adoptSessionSelection(session: AgentSessionForSwitch) {
		if (!session.provider || !AVAILABLE_PROVIDERS.some((p) => p.id === session.provider)) {
			return;
		}
		if (currentProvider !== session.provider) {
			setSelectedProvider(session.provider);
		}
		if (!session.model) return;
		// The store setters are the enforcement point for the hosted model
		// policy — a blocked model is silently rejected there.
		const knownModel = modelOptions.some(
			(m) => m.id === session.model && (!m.provider || m.provider === session.provider)
		);
		if (knownModel) {
			setSelectedModel(session.model);
		} else if (!PROVIDER_LOCKED_TO_CLAUDE) {
			setCustomModel(session.model, session.provider);
		}
	}

	async function switchAgentSession(session: AgentSessionForSwitch) {
		if (session.isCurrent) return;
		if (rendering) cancelRender();
		const res = await authFetch('/api/sessions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId: session.id })
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || !data?.ok) {
			throw new Error(data?.message || `HTTP ${res.status}`);
		}
		agentHistory.set([]);
		resetSessionCost();
		proposedRules.set([]);
		proposedHooks.set([]);
		pendingUserQuestions.set([]);
		pendingPlanProposals.set([]);
		adoptSessionSelection(data.session ?? session);
		await restoreAgentHistory();
	}
</script>

<div class="app">
	<header class="header">
		<div class="header-left">
			<span class="logo" aria-hidden="true">
				<img src="/docwriter-mark.svg" alt="" />
			</span>
			<div class="app-title">DocWriter</div>
			<MenuBar
				{menus}
				panels={{
					references: referencesPanelSnippet,
					rules: rulesPanelSnippet,
					agentSettings: agentSettingsSnippet,
					hooks: hooksPanelSnippet,
					skills: skillsPanelSnippet,
					apiKeys: apiKeysPanelSnippet
				}}
			/>
		</div>
		{#if IS_HOSTED}
			<div class="header-right">
				<HostedAccountButton />
			</div>
		{/if}
	</header>

	{#snippet rulesPanelSnippet()}
		<RulesPanel onSubmit={(trigger) => void submit(trigger)} />
	{/snippet}

	{#snippet referencesPanelSnippet()}
		<ReferencesPanel
			activeTabId={currentActiveTabId}
			onSubmit={(trigger) => void submit(trigger)}
		/>
	{/snippet}

	{#snippet agentSettingsSnippet()}
		<AgentSettingsPanel onSettingsChange={handleAgentSettingsChange} />
	{/snippet}

	{#snippet hooksPanelSnippet()}
		<HooksPanel />
	{/snippet}

	{#snippet skillsPanelSnippet()}
		<SkillsPanel onSubmit={(trigger) => void submit(trigger)} />
	{/snippet}

	{#snippet apiKeysPanelSnippet()}
		<ApiKeysPanel />
	{/snippet}

	<div class="toolbar">
		<RulesPillBar onSubmit={(trigger) => void submit(trigger)} />
	</div>

	<div class="body">
		{#if sidebarVisible}
		<aside class="left-pane" style:width="{leftWidth}px">
			<div class="left-pane-inner" bind:this={leftPaneInnerEl}>
				<div class="outline-wrap">
					<OutlinePane showOutline={true} showReview={false} />
				</div>
				{#if filesVisible}
					<HorizontalPanelResizer onResize={resizeFileTree} />
					<div class="file-tree-panel" style:height="{fileTreeHeight}px">
						<div class="file-tree-wrap">
							<FileTree
								bind:this={fileTreeRef}
								activePath={activeTabFilePath}
								onOpenFile={onFileOpened}
								onRenamed={onFileTreeRenamed}
								onDeleted={onFileTreeDeleted}
								onDropExternalFiles={handleTreeDropFiles}
							/>
						</div>
					</div>
				{/if}
			</div>
		</aside>
		<PanelResizer onResize={resizeLeft} />
		{/if}
		<main class="center-pane">
			<div class="source-preview-layout" class:split-preview-open={splitPreviewOpen} bind:this={splitLayoutEl}>
				<section class="source-workspace" aria-label="Source editor">
					<!-- Align the tab strip over the page column (same geometry as
					     `.plain-editor-shell`) so the active tab sits on the page. -->
					<div class="tab-align">
						<div class="tab-slot">
							<TabBar
								onSwitch={switchTab}
								onClose={closeTab}
								onDelete={deleteTab}
								onRename={renameTabAction}
								pendingTabs={mergedPendingTabs}
								onDropFile={handleDropFiles}
							/>
						</div>
					</div>
					{#if docLoaded && activeTabFilePath}
						{#key activeTabFilePath}
						<AgentModal
							onAnswerQuestion={(id, answers) => answerUserQuestion(id, answers)}
							onRunPlan={(id) => runPlanProposal(id)}
							onDismissPlan={(id) => dismissPlanProposal(id)}
							onRejectPlan={(id, feedback) => rejectPlanProposal(id, feedback)}
						/>
						{#if activeTabIsPdf}
							<PdfViewerPane path={activeTabFilePath} />
						{:else}
							<TiptapEditor
								tabId={activeTabFilePath}
								bind:this={editorRef}
								onSubmit={(trigger) => submit(trigger)}
								initialScrollTop={pendingScrollRestore}
								onAcceptInlineEdit={(roundId) => {
									const rounds = currentRounds();
									if (rounds.length === 0 || !roundId) return;
									void acceptAgentEdit(roundId);
								}}
								onRejectInlineEdit={(roundId) => {
									const rounds = currentRounds();
									if (rounds.length === 0 || !roundId) return;
									void rejectAgentEdit(roundId);
								}}
								onAcceptFeedbackEdits={(roundIds) => {
									if (roundIds.length > 0) void acceptAgentEdit(roundIds);
								}}
								onResolveThread={(threadId, resolved) => void resolveThread(threadId, resolved)}
								onOpenSplitPreview={openSplitPreview}
								splitPreviewOpen={splitPreviewOpen}
							/>
						{/if}
						{/key}
					{:else if docLoaded}
						<div class="empty-editor-state">
							<div class="empty-editor-title">No file open</div>
							<div class="empty-editor-copy">
								Open a file from the left sidebar, or create a new one there.
							</div>
						</div>
					{/if}
				</section>
				{#if splitPreviewOpen && splitPreviewPath}
					<PanelResizer onResize={resizeSplitPreview} />
					<aside
						class="split-preview-pane"
						aria-label="PDF preview"
						style:--split-preview-width="{splitPreviewWidth}px"
					>
						<PdfViewerPane path={splitPreviewPath} />
					</aside>
				{/if}
			</div>
		</main>
	</div>
</div>

{#if docLoaded}
	<AgentDockShell
		onNewSession={newSession}
		onWakeUp={docLoaded && activeTabFilePath && !activeTabIsPdf ? () => submit() : undefined}
		onCancel={cancelRender}
		onToggleMuted={toggleMuted}
	>
		{#snippet dock()}
			<AgentDock onSendMessage={(msg, opts) => void submit(msg, opts)} />
		{/snippet}
	</AgentDockShell>
{/if}

<ToastStack
	onAccept={(t) => (t.kind === 'rule' ? acceptProposedRule(t.refId) : acceptProposedHook(t.refId))}
	onDismiss={(t) => (t.kind === 'rule' ? rejectProposedRule(t.refId) : rejectProposedHook(t.refId))}
/>

<Dialog />

{#if sessionsOpen}
	<SessionBrowser
		onClose={() => (sessionsOpen = false)}
		onSwitchSession={switchAgentSession}
	/>
{/if}

<CustomModelDialog
	open={customModelOpen}
	provider={currentProvider}
	suggestions={providerModels.map((m) => m.id)}
	onClose={() => (customModelOpen = false)}
	onSubmit={(id) => {
		setCustomModel(id, currentProvider);
		customModelOpen = false;
	}}
/>

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
		/* One continuous canvas behind the whole workspace — the document is an
		 * elevated page floating on it, and the left sidebar + editor margins
		 * share this surface so nothing reads as a bolted-on panel. Each theme
		 * sets `--canvas-bg` to a tone recessed from its elevated page (a cool
		 * Google-Docs gray in Light); fall back to a derived recess. */
		--canvas: var(--canvas-bg, color-mix(in srgb, var(--text) 6%, var(--bg)));
		/* Page + comment-gutter widths — single source of truth; the editor
		 * grid and the tab-align grid both read these. */
		--paper-width: 900px;
		--gutter-width: 240px;
		--line-gutter-width: 52px;
		--editor-grid-gap: 18px;
		background: var(--canvas);
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
	.header-left {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
	}
	.header-right {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		flex: 0 0 auto;
	}
	.logo {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
	}
	.logo img {
		width: 22px;
		height: 22px;
		display: block;
	}
	.app-title {
		font-size: 15px;
		font-weight: 600;
		letter-spacing: -0.2px;
		color: var(--text);
	}
	/* Submit button, mascot, and settings popover styles moved to
	 * src/lib/components/AgentDock.svelte. */

	.toolbar {
		display: flex;
		align-items: center;
		padding: 4px 16px;
		border-bottom: 1px solid var(--border-light);
		background: var(--header-bg);
		flex-shrink: 0;
	}
	.body {
		display: flex;
		flex: 1;
		min-height: 0;
	}
	.left-pane-inner {
		height: 100%;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		min-height: 0;
		--sidebar-well-a: color-mix(in srgb, var(--bg-surface) 76%, var(--pane-bg));
		--sidebar-well-b: color-mix(in srgb, var(--bg-surface) 92%, var(--pane-bg));
		--sidebar-edge: color-mix(in srgb, var(--border-light) 78%, var(--pane-bg));
	}
	.left-pane {
		background: var(--canvas);
		overflow: hidden;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.outline-wrap {
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
		background: transparent;
	}
	.file-tree-panel {
		flex: 0 0 auto;
		min-height: 160px;
		max-height: 66%;
		overflow: hidden;
		min-width: 0;
		display: flex;
		flex-direction: column;
		border-top: 1px solid color-mix(in srgb, var(--text) 8%, transparent);
		background: transparent;
	}
	.file-tree-wrap {
		flex: 1 1 auto;
		height: 100%;
		min-height: 0;
		overflow: auto;
		padding: 12px 14px 14px;
		box-sizing: border-box;
	}
	.center-pane {
		position: relative;
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		background: var(--canvas);
	}
	.source-preview-layout {
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
		overflow: hidden;
	}
	.source-workspace {
		position: relative;
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.source-preview-layout.split-preview-open .source-workspace {
		flex: 1 1 auto;
		min-width: 620px;
		max-width: none;
		--line-gutter-width: 34px;
		--line-number-width: 28px;
		--line-number-pad-right: 6px;
		--editor-grid-gap: 10px;
	}
	.source-preview-layout.split-preview-open > :global(.resizer) {
		z-index: 30;
	}
	.split-preview-pane {
		position: relative;
		flex: 0 0 var(--split-preview-width, 820px);
		width: var(--split-preview-width, 820px);
		min-width: 520px;
		max-width: none;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg-surface);
		border-left: 0;
		box-shadow: -12px 0 28px rgba(15, 23, 42, 0.08);
	}
	.source-preview-layout.split-preview-open .tab-align {
		justify-content: start;
		padding-left: 12px;
	}
	.source-preview-layout.split-preview-open .source-workspace :global(.plain-editor-shell) {
		justify-content: start;
	}
	.source-preview-layout.split-preview-open .source-workspace :global(.tiptap-wrapper) {
		padding-left: 12px;
		padding-right: 16px;
	}
	/* Mirrors `.plain-editor-shell`'s columns + centering + horizontal padding
	 * so the tab strip lands directly over the page column below it. */
	.tab-align {
		display: grid;
		grid-template-columns: var(--line-gutter-width, 52px) minmax(0, var(--paper-width, 720px)) var(--gutter-width, 240px);
		gap: var(--editor-grid-gap, 18px);
		justify-content: center;
		padding: 10px 32px 0;
		flex-shrink: 0;
	}
	.tab-slot {
		grid-column: 2;
		min-width: 0;
	}
	.empty-editor-state {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 32px;
		text-align: center;
		gap: 10px;
		color: var(--text-secondary);
		font-family: 'Inter', -apple-system, sans-serif;
	}
	.empty-editor-title {
		font-size: 18px;
		font-weight: 600;
		color: var(--text);
	}
	.empty-editor-copy {
		max-width: 420px;
		font-size: 14px;
		line-height: 1.5;
		color: var(--text-faint);
	}
	@media (max-width: 1600px) {
		.source-preview-layout.split-preview-open {
			flex-direction: column;
		}
		.source-preview-layout.split-preview-open > :global(.resizer) {
			display: none;
		}
		.source-preview-layout.split-preview-open .source-workspace {
			min-width: 0;
			min-height: 50%;
			max-width: none;
		}
		.split-preview-pane {
			flex: 0 0 42vh;
			min-width: 0;
			max-width: none;
			min-height: 320px;
			border-left: 0;
			border-top: 1px solid var(--border-light);
			box-shadow: 0 -10px 24px rgba(15, 23, 42, 0.08);
		}
	}
</style>
