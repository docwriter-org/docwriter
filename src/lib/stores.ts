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
		return [...h, entry];
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

export const selectedModel = writable<string>('opus');
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

/** Agent behavior settings. Persisted through the server runtime-state
 * layer (SQLite-backed) whenever the user changes them via the settings UI. */
export const agentSettings = writable<AgentSettings>({
	agency: 'conservative',
	trackChanges: true
});
