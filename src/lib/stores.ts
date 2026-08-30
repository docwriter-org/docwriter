import { get, writable } from 'svelte/store';
import {
	isHiddenClaudeModel
} from '$lib/shared/claude-models';
import type {
	Rule,
	Action,
	HistoryEntry,
	AgentSettings,
	ProposedRule,
	ProposedHook,
	CommentThread,
	ImageAttachment
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

/** Agent comment threads for EVERY open tab. Each entry contains a tabId
 * and the unresolved, still-anchored threads that have at least one agent
 * message — the same attachment test the comment gutter renders by
 * (`matchCommentAnchor`), so a tab never advertises threads that wouldn't
 * show. Drives the per-tab dot badges on the TabBar (via
 * `mergedPendingTabs` in +page.svelte). */
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

/** Stale-Accept in flight: the gutter keeps that card visible with a
 * pulsing border and an agent "thinking how to apply" note until the
 * rebased edit lands. */
export const staleAcceptUi = writable<{
	tabId: string;
	threadId?: string;
	staleRoundId: string;
} | null>(null);

/** Per-tab memory of which comment thread was open, so peeking at another
 * file and coming back re-expands the same thread. Session-only. */
export const openCommentThreadByTab = writable<Record<string, string | null>>({});

/** Unsent reply text keyed by comment thread id. Survives the editor
 * remount that happens on every tab switch. Session-only. */
export const commentReplyDrafts = writable<Record<string, string>>({});

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

// ── Critique passes (reviewer agents) ─────────────────────────────────

/** Display info for the reviewer whose critique pass is currently
 * rendering. While set, the agent pill hands itself to the reviewer:
 * mascot + name in the reviewer's color, in the dock and the pane header.
 * Cleared when the render ends. */
export interface ActiveReviewerInfo {
	id: string;
	name: string;
	icon: string;
	color: string;
}
export const activeReviewer = writable<ActiveReviewerInfo | null>(null);

/** User-created reviewers, loaded from /api/reviewers at boot and updated
 * when one is created. Built-ins come from $lib/shared/reviewers. */
export const customReviewers = writable<import('./shared/reviewers').Reviewer[]>([]);

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
/** User preference: show line numbers in the editor's left gutter. Default
 * OFF — the gutter column collapses and the reclaimed width goes to the
 * page + comment margin (Google-Docs-style). The server mirrors this
 * default in `runtime-state.ts`. */
export const editorLineNumbers = writable<boolean>(false);

// ── Actions toolbar ───────────────────────────────────────────────────

export const pinnedActions: Action[] = [
	{ id: 'a_verbose', label: 'Too verbose', icon: 'scissors', pinned: true, color: '#8b5cf6' },
	{ id: 'a_ai', label: 'AI smell', icon: 'bot', pinned: true, color: '#d97706' },
	{ id: 'a_incorrect', label: 'Incorrect', icon: 'circle-x', pinned: true, color: '#dc2626' }
];
export const recentActions = writable<Action[]>([]);
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

/** One selectable model in the Settings → Model menu. `id` is the full
 * API model ID sent to the agent; `label` is the human-readable name.
 * `provider` identifies which SDK backend to use. */
export type ModelOption = { id: string; label: string; provider?: string };

/** Available provider options. */
export type ProviderOption = { id: string; label: string };
export const AVAILABLE_PROVIDERS: ProviderOption[] = [
	{ id: 'claude', label: 'Claude' },
	{ id: 'openai', label: 'OpenAI' },
	{ id: 'codex', label: 'Codex' },
	{ id: 'cursor', label: 'Cursor' },
	{ id: 'pi', label: 'Pi' }
];

/** Newest-first static list, shown immediately on load and used as the
 * fallback whenever the live Models API can't be reached. Mirrors the server
 * fallback in `/api/models`. */
const ALL_FALLBACK_MODELS: ModelOption[] = [
	{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (1M context)', provider: 'claude' },
	{ id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'claude' },
	{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'claude' },
	{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (1M context)', provider: 'claude' },
	{ id: 'claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'claude' },
	{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'claude' },
	{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'claude' },
	{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai' },
	{ id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', provider: 'openai' },
	{ id: 'gpt-5.4', label: 'GPT-5.4', provider: 'openai' },
	{ id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'openai' },
	{ id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano', provider: 'openai' },
	{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'openai' },
	{ id: 'gpt-5.2', label: 'GPT-5.2', provider: 'openai' },
	{ id: 'o3', label: 'o3', provider: 'openai' },
	{ id: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai' },
	{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'codex' },
	{ id: 'gpt-5.4', label: 'GPT-5.4', provider: 'codex' },
	{ id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'codex' },
	{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'codex' },
	{ id: 'gpt-5.2', label: 'GPT-5.2', provider: 'codex' },
	{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'cursor' },
	{ id: 'gpt-4o', label: 'GPT-4o', provider: 'cursor' },
	{ id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'cursor' },
	{ id: 'claude-haiku-3-5', label: 'Claude Haiku 3.5', provider: 'cursor' },
	{ id: 'cursor-small', label: 'Cursor Small', provider: 'cursor' },
	{ id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'pi' },
	{ id: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'pi' },
	{ id: 'anthropic/claude-haiku-3-5', label: 'Claude Haiku 3.5', provider: 'pi' },
	{ id: 'openai/gpt-4o', label: 'GPT-4o', provider: 'pi' },
	{ id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini', provider: 'pi' },
	{ id: 'openai/o4-mini', label: 'o4-mini', provider: 'pi' },
	{ id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'pi' },
	{ id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'pi' },
	{ id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'pi' },
	{ id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'pi' },
	{ id: 'deepseek/deepseek-r1', label: 'DeepSeek R1', provider: 'pi' },
	{ id: 'ollama/llama3.1', label: 'Llama 3.1 (Ollama)', provider: 'pi' },
	{ id: 'ollama/qwen3', label: 'Qwen 3 (Ollama)', provider: 'pi' }
];
export const FALLBACK_MODELS: ModelOption[] = ALL_FALLBACK_MODELS;

const SELECTED_MODEL_KEY = 'docwriter.selectedModel';
const SELECTED_PROVIDER_KEY = 'docwriter.selectedProvider';
const SELECTED_MODELS_BY_PROVIDER_KEY = 'docwriter.selectedModelsByProvider';
const storedModel = typeof window === 'undefined' ? null : window.localStorage.getItem(SELECTED_MODEL_KEY);
const storedProvider = typeof window === 'undefined' ? null : window.localStorage.getItem(SELECTED_PROVIDER_KEY);
// Validate the persisted provider against the current list — a removed
// provider (e.g. a previously-selected 'opencode') must not stick around.
const validProvider =
	storedProvider && AVAILABLE_PROVIDERS.some((p) => p.id === storedProvider)
		? storedProvider
		: 'claude';

function readSelectedModelsByProvider(): Record<string, string> {
	if (typeof window === 'undefined') return {};
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(window.localStorage.getItem(SELECTED_MODELS_BY_PROVIDER_KEY) ?? '{}');
	} catch {
		parsed = null;
	}

	const out: Record<string, string> = {};
	if (parsed && typeof parsed === 'object') {
		for (const [provider, model] of Object.entries(parsed)) {
			if (
				AVAILABLE_PROVIDERS.some((p) => p.id === provider) &&
				typeof model === 'string' &&
				model.trim()
			) {
				out[provider] = model.trim();
			}
		}
	}

	// Migrate the legacy single-model preference into the provider it was
	// saved with. If no provider was saved, old installs only had Claude.
	const legacyProvider =
		storedProvider && AVAILABLE_PROVIDERS.some((p) => p.id === storedProvider)
			? storedProvider
			: storedProvider
				? null
				: 'claude';
	if (storedModel?.trim() && legacyProvider && !out[legacyProvider]) {
		out[legacyProvider] = storedModel.trim();
	}
	return out;
}

let selectedModelsByProvider = readSelectedModelsByProvider();

function modelKey(model: ModelOption): string {
	return `${model.provider ?? ''}:${model.id}`;
}

function addStoredSelections(models: ModelOption[]): ModelOption[] {
	const next = [...models];
	const seen = new Set(next.map(modelKey));
	for (const [provider, id] of Object.entries(selectedModelsByProvider)) {
		if (!AVAILABLE_PROVIDERS.some((p) => p.id === provider)) continue;
		if (provider === 'claude' && isHiddenClaudeModel(id)) continue;
		const option = { id, label: id, provider };
		const key = modelKey(option);
		if (!seen.has(key)) {
			seen.add(key);
			next.push(option);
		}
	}
	return next;
}

function fallbackModelForProvider(provider: string): string {
	const providerModels = FALLBACK_MODELS.filter((m) => m.provider === provider || !m.provider);
	return providerModels.find((m) => m.id.includes('opus'))?.id ?? providerModels[0]?.id ?? 'opus';
}

function defaultModelForProvider(provider: string, models: ModelOption[]): string {
	const providerModels = models.filter((m) => !m.provider || m.provider === provider);
	if (provider === 'claude') {
		return providerModels.find((m) => m.id.includes('opus'))?.id ?? providerModels[0]?.id ?? 'opus';
	}
	return providerModels[0]?.id ?? fallbackModelForProvider(provider);
}

function persistProviderModel(provider: string, id: string) {
	selectedModelsByProvider = { ...selectedModelsByProvider, [provider]: id };
	if (typeof window === 'undefined') return;
	window.localStorage.setItem(
		SELECTED_MODELS_BY_PROVIDER_KEY,
		JSON.stringify(selectedModelsByProvider)
	);
	// Keep the old key populated for backward compatibility with older builds.
	window.localStorage.setItem(SELECTED_MODEL_KEY, id);
}

/** Live model catalog populated by `loadAvailableModels()`. */
export const availableModels = writable<ModelOption[]>(addStoredSelections(FALLBACK_MODELS));

const initialModel =
	selectedModelsByProvider[validProvider] &&
	!(validProvider === 'claude' && isHiddenClaudeModel(selectedModelsByProvider[validProvider]))
		? selectedModelsByProvider[validProvider]
		: fallbackModelForProvider(validProvider);
export const selectedModel = writable<string>(initialModel);
export const selectedProvider = writable<string>(validProvider);

export function setSelectedModel(id: string) {
	const provider = get(selectedProvider);
	if (provider === 'claude' && isHiddenClaudeModel(id)) return;
	selectedModel.set(id);
	persistProviderModel(provider, id);
}

export function setCustomModel(id: string, provider: string) {
	if (!AVAILABLE_PROVIDERS.some((p) => p.id === provider)) return;
	if (provider === 'claude' && isHiddenClaudeModel(id)) return;
	let existing: ModelOption[] = [];
	availableModels.subscribe((v) => (existing = v))();
	if (!existing.some((m) => m.id === id && m.provider === provider)) {
		availableModels.set([...existing, { id, label: id, provider }]);
	}
	persistProviderModel(provider, id);
	selectedModel.set(id);
}

export function setSelectedProvider(id: string) {
	if (!AVAILABLE_PROVIDERS.some((p) => p.id === id)) return;
	selectedProvider.set(id);
	if (typeof window !== 'undefined') window.localStorage.setItem(SELECTED_PROVIDER_KEY, id);
	// Pick a valid model for the new provider synchronously from the models we
	// already have (fallback list + stored prefs), so header UI never briefly
	// shows the previous provider's model id while the live list loads.
	// loadAvailableModels refines the selection once it resolves.
	selectModelForProvider(id);
	loadAvailableModels(id).then(() => {
		if (get(selectedProvider) === id) selectModelForProvider(id);
	});
}

function selectModelForProvider(provider: string) {
	const preferred = selectedModelsByProvider[provider];
	if (
		preferred &&
		!(provider === 'claude' && isHiddenClaudeModel(preferred))
	) {
		selectedModel.set(preferred);
		persistProviderModel(provider, preferred);
		availableModels.update(addStoredSelections);
		return;
	}
	const next = defaultModelForProvider(provider, get(availableModels));
	selectedModel.set(next);
	persistProviderModel(provider, next);
}

/** Fetch the live model list from `/api/models`. */
export async function loadAvailableModels(providerId?: string) {
	if (typeof window === 'undefined') return;
	try {
		const url = providerId
			? `/api/models?provider=${encodeURIComponent(providerId)}`
			: '/api/models?all=true';
		const res = await fetch(url);
		if (!res.ok) return;
		const data = (await res.json()) as { models?: ModelOption[]; defaultModel?: string };
		if (data.models?.length) {
			if (providerId) {
				const existing = get(availableModels);
				const otherProviders = existing.filter((m) => m.provider !== providerId);
				availableModels.set(addStoredSelections([...otherProviders, ...data.models]));
			} else {
				availableModels.set(addStoredSelections(data.models));
			}
		}
		selectModelForProvider(providerId ?? get(selectedProvider));
	} catch {
		// Keep the fallback list / current selection.
	}
}

/** Active UI theme. Persisted through the server runtime-state layer
 * (SQLite-backed) via /api/session whenever the user changes it. */
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

const SHOW_SIDEBAR_KEY = 'docwriter.showSidebar';
function readShowSidebar(): boolean {
	if (typeof window === 'undefined') return true;
	const raw = window.localStorage.getItem(SHOW_SIDEBAR_KEY);
	return raw === null ? true : raw !== 'false';
}
export const showSidebar = writable<boolean>(readShowSidebar());
if (typeof window !== 'undefined') {
	showSidebar.subscribe((v) => window.localStorage.setItem(SHOW_SIDEBAR_KEY, String(v)));
}

/** AI-provenance view toggle: when true, text the agent wrote (tracked as
 * the `ai` Yjs format attribute, applied at accept time) is colored in the
 * editor so the user can see at a glance which prose is theirs and which is
 * the AI's. Pure view state — flipping it never touches the document.
 * Persisted to localStorage so it survives reloads. Default off. */
const SHOW_AI_PROVENANCE_KEY = 'docwriter.showAiProvenance';
function readShowAiProvenance(): boolean {
	if (typeof window === 'undefined') return false;
	return window.localStorage.getItem(SHOW_AI_PROVENANCE_KEY) === 'true';
}
export const showAiProvenance = writable<boolean>(readShowAiProvenance());
if (typeof window !== 'undefined') {
	showAiProvenance.subscribe((v) =>
		window.localStorage.setItem(SHOW_AI_PROVENANCE_KEY, String(v))
	);
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

/** In-progress Chat compose box. Lives in a store so switching tabs (which
 * remounts the editor, and used to remount the dock) cannot wipe the
 * draft, attachments, or whether the popover was open. Session-only —
 * not persisted across reloads. */
export interface ChatComposeDraft {
	open: boolean;
	message: string;
	planMode: boolean;
	images: ImageAttachment[];
}
export const chatCompose = writable<ChatComposeDraft>({
	open: false,
	message: '',
	planMode: false,
	images: []
});

/** Agent behavior settings. Persisted through the server runtime-state
 * layer (SQLite-backed) whenever the user changes them via the settings UI. */
export const agentSettings = writable<AgentSettings>({
	agency: 'conservative',
	muted: false,
	paused: false,
	intendedAudience: ''
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
