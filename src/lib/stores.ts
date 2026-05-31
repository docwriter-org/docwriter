import { writable } from 'svelte/store';
import type {
	Rule,
	Action,
	Annotation,
	HistoryEntry,
	AgentSettings,
	ProposedRule,
	ProposedHook,
	CommentThread
} from './types';
import type { MaterializedPendingReviewRound } from './review-rounds';

// ── Document state ────────────────────────────────────────────────────
// The canonical client state is a Y.Doc (see src/lib/yjs-doc.ts) bound into
// the Tiptap editor via @tiptap/extension-collaboration.

/** Baseline text for the active tab's pending review stack. The diff overlay
 * compares the live editor content against this string. Null when no review
 * is pending. */
export const reviewBaseline = writable<string | null>(null);

/** Pending agent-edit rounds for the ACTIVE tab, oldest first. Each round
 * shows as its own card in the OutlinePane; the editor's diff overlay
 * composes them all (anchored at rounds[0].beforeMd). Accepting a round
 * removes just that round; rejecting a round rewinds to its beforeMd
 * (also dropping all later rounds). */
export const pendingReviewRounds = writable<MaterializedPendingReviewRound[]>([]);

/** Pending agent-edit rounds for EVERY open tab. Each entry contains a
 * tabId and the materialized rounds for that tab, sorted oldest-first.
 * Tabs with zero pending rounds are omitted. Used by OutlinePane to show
 * cross-tab review cards without requiring the user to switch tabs. */
export const allTabPendingRounds = writable<Array<{ tabId: string; rounds: MaterializedPendingReviewRound[] }>>([]);

/** Agent comment threads for EVERY open tab. Each entry contains a tabId
 * and the unresolved threads that have at least one agent message.
 * Used by OutlinePane's cross-tab comment section. */
export const allTabCommentThreads = writable<Array<{ tabId: string; threads: CommentThread[] }>>([]);

/** Set of comment thread IDs the user has already seen (opened or clicked).
 * Persisted to localStorage so it survives page reloads. A thread absent
 * from this set that has an agent message is shown with an unread dot. */
const SEEN_COMMENTS_KEY = 'docwriter.seenCommentIds';
function readSeenCommentIds(): Set<string> {
	if (typeof window === 'undefined') return new Set();
	try {
		const raw = window.localStorage.getItem(SEEN_COMMENTS_KEY);
		return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
	} catch {
		return new Set();
	}
}
export const seenCommentIds = writable<Set<string>>(readSeenCommentIds());
if (typeof window !== 'undefined') {
	seenCommentIds.subscribe((s) =>
		window.localStorage.setItem(SEEN_COMMENTS_KEY, JSON.stringify([...s]))
	);
}
export function markCommentSeen(id: string) {
	seenCommentIds.update((s) => { const n = new Set(s); n.add(id); return n; });
}

/** Comment threads for the ACTIVE tab, sorted by createdAt. Threaded
 * Google-Docs-style comments. Each thread is anchored to a passage via
 * a stored `quote`; the editor's comment-overlay plugin renders an
 * inline underline + a gutter comment button per unresolved thread. */
export const commentThreads = writable<CommentThread[]>([]);

/** Which thread id (if any) is currently open in the popover. Null when
 * the popover is closed. */
export const openCommentThreadId = writable<string | null>(null);

/** Writing rules (mirror of document.meta.json rules). */
export const rules = writable<Rule[]>([]);

/** Rules the agent has proposed during a render, awaiting user Accept/Reject.
 * Accepted proposals are appended to `rules` and persisted; rejected ones
 * are simply removed from this list. */
export const proposedRules = writable<ProposedRule[]>([]);

/** Shell hooks the agent has proposed during a render, awaiting user
 * Accept/Reject. Accepted proposals are appended to `.docwriter/hooks.json`
 * via /api/hooks; rejected ones are removed. */
export const proposedHooks = writable<ProposedHook[]>([]);

/** The agent's built-in AskUserQuestion tool call — a multiple-choice
 * clarifying question it paused to ask. Shape matches the SDK's
 * AskUserQuestionInput.questions. Each card renders in the OutlinePane;
 * answering POSTs to /api/ask-user-reply and unblocks the agent. */
export interface PendingUserQuestion {
	id: string;
	questions: Array<{
		question: string;
		header: string;
		options: Array<{ label: string; description?: string }>;
		multiSelect?: boolean;
	}>;
}
export const pendingUserQuestions = writable<PendingUserQuestion[]>([]);

/** A plan the agent produced while running in `permissionMode: 'plan'`.
 * Surfaces as a blocking modal over the editor — the user either runs
 * it (which re-submits the original prompt without plan mode) or
 * dismisses. */
export interface PendingPlanProposal {
	id: string;
	plan: string;
	/** The original user message that produced this plan — replayed on
	 * "Run it" so the agent executes the plan for real. */
	originalMessage: string;
}
export const pendingPlanProposals = writable<PendingPlanProposal[]>([]);

// ── UI state ──────────────────────────────────────────────────────────

export const isRendering = writable(false);
export const annotations = writable<Annotation[]>([]);
export const showHistory = writable(true);

/** Seconds remaining until the editor auto-submits after user stops typing.
 * 0 means no countdown active. Updated by the editor's idle timer. */
export const submitCountdown = writable<number>(0);

/** User preference: editor font size scale (1.0 = default 17px). */
export const editorFontScale = writable<number>(1.0);
/** User preference: wrap long lines in the editor while keeping logical line
 * numbers aligned in the gutter and continuation rows blank. Default on so
 * long lines don't silently clip off the right edge of the editor; the
 * server mirrors this default in `runtime-state.ts`. */
export const editorSoftWrap = writable<boolean>(true);

// ── Actions toolbar ───────────────────────────────────────────────────

export const pinnedActions: Action[] = [
	{ id: 'a_verbose', label: 'Too verbose', icon: 'scissors', pinned: true, color: '#8b5cf6' },
	{ id: 'a_ai', label: 'AI smell', icon: 'bot', pinned: true, color: '#d97706' },
	{ id: 'a_incorrect', label: 'Incorrect', icon: 'circle-x', pinned: true, color: '#dc2626' }
];
export const recentActions = writable<Action[]>([]);
export const selectedAction = writable<Action | null>(null);
export const actionUsageCounts = writable<Record<string, number>>({});

export function trackActionUsage(actionLabel: string) {
	actionUsageCounts.update((counts) => ({
		...counts,
		[actionLabel]: (counts[actionLabel] || 0) + 1
	}));
}

// ── Agent activity log ────────────────────────────────────────────────

export const agentHistory = writable<HistoryEntry[]>([]);

/** Monotonic counter used to give every history entry a stable per-row
 * key. Without it the HistoryPane's `{#each}` keyed-block falls back to
 * an index-based key and every entry gets torn down + replaced when a
 * new one prepends, causing the whole pane to fly-in cascade on every
 * tick. Exported so the few direct `agentHistory.update(...)` push
 * sites in +page.svelte can stamp `_key` too. */
let historyKeyCounter = 0;
export function nextHistoryKey(): number {
	historyKeyCounter += 1;
	return historyKeyCounter;
}

/** Submissions waiting for the current render to finish. Updated by
 * `submit()` in +page.svelte; read by AgentDock so the dock can show a
 * queued-message badge during a render. */
export const queuedSubmissionCount = writable<number>(0);

/** Session-wide cost + usage accumulator. The SDK reports per-round via a
 * `result` message; we sum into this store. Reset when the user starts a
 * new session. See https://code.claude.com/docs/en/agent-sdk/cost-tracking
 */
export interface SessionCost {
	totalCostUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	rounds: number;
}
const EMPTY_COST: SessionCost = {
	totalCostUsd: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheCreationTokens: 0,
	cacheReadTokens: 0,
	rounds: 0
};
const SESSION_COST_KEY = 'docwriter.sessionCost';
function readPersistedCost(): SessionCost {
	if (typeof window === 'undefined') return { ...EMPTY_COST };
	try {
		const raw = window.localStorage.getItem(SESSION_COST_KEY);
		if (!raw) return { ...EMPTY_COST };
		const parsed = JSON.parse(raw);
		return {
			totalCostUsd: Number(parsed.totalCostUsd) || 0,
			inputTokens: Number(parsed.inputTokens) || 0,
			outputTokens: Number(parsed.outputTokens) || 0,
			cacheCreationTokens: Number(parsed.cacheCreationTokens) || 0,
			cacheReadTokens: Number(parsed.cacheReadTokens) || 0,
			rounds: Number(parsed.rounds) || 0
		};
	} catch {
		return { ...EMPTY_COST };
	}
}
export const sessionCost = writable<SessionCost>(readPersistedCost());
if (typeof window !== 'undefined') {
	sessionCost.subscribe((v) =>
		window.localStorage.setItem(SESSION_COST_KEY, JSON.stringify(v))
	);
}
export function resetSessionCost() {
	sessionCost.set({ ...EMPTY_COST });
}
export function addRoundCost(delta: {
	totalCostUsd?: number;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	};
}) {
	const u = delta.usage ?? {};
	sessionCost.update((prev) => ({
		totalCostUsd: prev.totalCostUsd + (delta.totalCostUsd ?? 0),
		inputTokens: prev.inputTokens + (u.input_tokens ?? 0),
		outputTokens: prev.outputTokens + (u.output_tokens ?? 0),
		cacheCreationTokens: prev.cacheCreationTokens + (u.cache_creation_input_tokens ?? 0),
		cacheReadTokens: prev.cacheReadTokens + (u.cache_read_input_tokens ?? 0),
		rounds: prev.rounds + 1
	}));
}
export function pushHistory(entry: HistoryEntry) {
	agentHistory.update((h) => {
		if (entry.type === 'render_end' && h.length > 0 && h[h.length - 1].type === 'render_end') {
			return h;
		}
		const stamped = (entry as HistoryEntry & { _key?: number })._key
			? entry
			: ({ ...entry, _key: nextHistoryKey() } as unknown as HistoryEntry);
		return [...h, stamped];
	});
}

// ── Tabs ──────────────────────────────────────────────────────────────
//
// Each tab is a workspace-relative text file. The active tab's Y.Doc is
// bound into the editor; switching tabs tears down the editor and rebuilds
// it against the new tab's Y.Doc (with its own Yjs state, undo
// history, and review state).
/** Ordered list of workspace-relative tab paths. */
export const tabs = writable<string[]>([]);
/** Which tab the editor is currently showing. null on a fresh install with
 * no tabs yet — the bootstrap flow creates a default tab. */
export const activeTab = writable<string | null>(null);

// ── Preferences ───────────────────────────────────────────────────────

/** One selectable model in the Settings → Model menu. `id` is the full Claude
 * API model ID sent to the agent; `label` is the human-readable name. */
export type ModelOption = { id: string; label: string };

/** Newest-first static list, shown immediately on load and used as the
 * fallback whenever the live Models API can't be reached. Mirrors the server
 * fallback in `/api/models`. */
export const FALLBACK_MODELS: ModelOption[] = [
	{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
	{ id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
	{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
	{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
	{ id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
	{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
	{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }
];

/** Live model catalog populated by `loadAvailableModels()`. Starts on the
 * static fallback so the menu is never empty. */
export const availableModels = writable<ModelOption[]>(FALLBACK_MODELS);

// `selectedModel` persists only on an EXPLICIT user pick (via
// `setSelectedModel`). The bare initial default ('opus') is NOT written, so we
// can tell "user hasn't chosen" apart from "user picked Opus" and keep
// defaulting to the latest Opus as new models ship.
const SELECTED_MODEL_KEY = 'docwriter.selectedModel';
const storedModel = typeof window === 'undefined' ? null : window.localStorage.getItem(SELECTED_MODEL_KEY);
export const selectedModel = writable<string>(storedModel ?? 'opus');

/** Set the model in response to an explicit user choice and persist it. */
export function setSelectedModel(id: string) {
	selectedModel.set(id);
	if (typeof window !== 'undefined') window.localStorage.setItem(SELECTED_MODEL_KEY, id);
}

/** Fetch the live model list from `/api/models`. If the user hasn't explicitly
 * pinned a model yet, adopt the server's default (latest Opus). Silently keeps
 * the fallback list on any error. */
export async function loadAvailableModels() {
	if (typeof window === 'undefined') return;
	try {
		const res = await fetch('/api/models');
		if (!res.ok) return;
		const data = (await res.json()) as { models?: ModelOption[]; defaultModel?: string };
		if (data.models?.length) availableModels.set(data.models);
		// Only auto-adopt the default when the user has made no explicit pick.
		if (!storedModel && data.defaultModel) selectedModel.set(data.defaultModel);
	} catch {
		// Keep the fallback list / current selection.
	}
}

export const selectedTheme = writable<string>('light');

/** History pane verbosity. `verbose` = every tool call, assistant monologue,
 * render marker. `minimal` = just user prompts + actual edits + hook runs.
 * Persisted to localStorage so it survives reloads. */
export type HistoryVerbosity = 'verbose' | 'minimal';
const HISTORY_VERBOSITY_KEY = 'docwriter.historyVerbosity';
function readVerbosity(): HistoryVerbosity {
	if (typeof window === 'undefined') return 'verbose';
	const v = window.localStorage.getItem(HISTORY_VERBOSITY_KEY);
	return v === 'minimal' ? 'minimal' : 'verbose';
}
export const historyVerbosity = writable<HistoryVerbosity>(readVerbosity());
if (typeof window !== 'undefined') {
	historyVerbosity.subscribe((v) => window.localStorage.setItem(HISTORY_VERBOSITY_KEY, v));
}

const SHOW_FILES_PANE_KEY = 'docwriter.showFilesPane';
function readShowFilesPane(): boolean {
	if (typeof window === 'undefined') return true;
	const raw = window.localStorage.getItem(SHOW_FILES_PANE_KEY);
	return raw === null ? true : raw !== 'false';
}
export const showFilesPane = writable<boolean>(readShowFilesPane());
if (typeof window !== 'undefined') {
	showFilesPane.subscribe((v) => window.localStorage.setItem(SHOW_FILES_PANE_KEY, String(v)));
}

/** Whether the floating agent dock is expanded into a panel (showing the
 * history log + dock controls) or collapsed to a pill in the bottom-right.
 * Persisted so it survives reloads. Default collapsed. */
const DOCK_EXPANDED_KEY = 'docwriter.dockExpanded';
function readDockExpanded(): boolean {
	if (typeof window === 'undefined') return false;
	return window.localStorage.getItem(DOCK_EXPANDED_KEY) === 'true';
}
export const dockExpanded = writable<boolean>(readDockExpanded());
if (typeof window !== 'undefined') {
	dockExpanded.subscribe((v) => window.localStorage.setItem(DOCK_EXPANDED_KEY, String(v)));
}

/** Agent behavior settings. Persisted through the server runtime-state
 * layer (SQLite-backed) whenever the user changes them via the settings UI. */
export const agentSettings = writable<AgentSettings>({
	agency: 'conservative',
	muted: false
});

/** When the agent is muted, the editor's diff overlay stays hidden by
 * default. Clicking a pending-review card sets this id; the overlay then
 * renders only that round's decorations. Cleared on accept/reject and
 * tab switch. Null otherwise. Has no effect when muted is false. */
export const expandedReviewRoundId = writable<string | null>(null);

/** Round ids the user has pinned "keep diff visible" on. Their proposed
 * (green) lines stay revealed in the doc even when the round's gutter card
 * isn't focused — independent of `expandedReviewRoundId`. Toggled by the
 * switch on each edit card. */
export const pinnedDiffRounds = writable<Set<string>>(new Set());
export function togglePinnedDiffRound(id: string) {
	pinnedDiffRounds.update((s) => {
		const n = new Set(s);
		if (n.has(id)) n.delete(id);
		else n.add(id);
		return n;
	});
}
