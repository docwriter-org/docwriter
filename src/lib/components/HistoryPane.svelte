<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { marked } from 'marked';
	import { FileEdit, User, Bot, Play, CheckCircle, XCircle, Eye, Terminal, Maximize2, X, RotateCcw, ScrollText, Cat, Sparkles, BellOff, Bell, ChevronDown, Pause } from 'lucide-svelte';
	import type { HistoryEntry } from '$lib/types';
	import { agentHistory, isRendering, historyVerbosity, sessionCost, agentSettings, pendingReviewRounds, submitCountdown, activeReviewer, type SessionCost } from '$lib/stores';
	import type { HistoryVerbosity } from '$lib/stores';
	import { onMount, onDestroy, type Snippet } from 'svelte';
	import SessionViewer from './SessionViewer.svelte';
	import ReviewerMascot from './ReviewerMascot.svelte';
	import ShineBorder from './ShineBorder.svelte';
	import { tooltip } from '$lib/actions/tooltip';
	import { modEnterLabel } from '$lib/keyboard';

	let transcriptOpen = $state(false);

	interface Props {
		onNewSession?: () => void | Promise<void>;
		onWakeUp?: () => void;
		onCancel?: () => void;
		/** Toggle the agent's "muted" mode: when on, agent edits still land
		 * in the pending-review array but the editor's inline diff overlay
		 * stays hidden until the user clicks a pending card. */
		onToggleMuted?: () => void;
		/** Fully pause / unpause the agent (double-click the Agent pill). */
		onTogglePaused?: () => void;
		/** When provided, a chevron-down button is shown that collapses the
		 * floating dock back to its pill (AgentDockShell). */
		onCollapse?: () => void;
		/** Optional slot for the remaining action buttons (Send, etc.). */
		dock?: Snippet;
	}
	let {
		onNewSession,
		onWakeUp,
		onCancel,
		onToggleMuted,
		onTogglePaused,
		onCollapse,
		dock
	}: Props = $props();

	let pendingCount = $state(0);
	pendingReviewRounds.subscribe((v) => (pendingCount = v.length));

	let entries: HistoryEntry[] = $state([]);
	agentHistory.subscribe((v) => (entries = v));

	let entriesEl: HTMLDivElement | null = $state(null);
	const fadingRows = new Set<HTMLElement>();
	let fadeRaf = 0;

	function clamp(n: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, n));
	}

	function updateRowFades() {
		fadeRaf = 0;
		if (!entriesEl) return;
		const container = entriesEl.getBoundingClientRect();
		if (container.height <= 0) return;
		const fullOpacityUntil = container.top + clamp(container.height * 0.46, 220, 360);
		const fadeDistance = clamp(container.height * 0.36, 180, 300);

		for (const row of fadingRows) {
			if (!entriesEl.contains(row)) continue;
			const rect = row.getBoundingClientRect();
			const center = rect.top + rect.height / 2;
			const fadeProgress = (center - fullOpacityUntil) / fadeDistance;
			const opacity = clamp(1 - fadeProgress, 0.24, 1);
			row.style.setProperty('--history-row-opacity', opacity.toFixed(3));
		}
	}

	function scheduleRowFadeUpdate() {
		if (typeof window === 'undefined' || fadeRaf) return;
		fadeRaf = window.requestAnimationFrame(updateRowFades);
	}

	function fadeHistoryRow(node: HTMLElement) {
		fadingRows.add(node);
		scheduleRowFadeUpdate();
		return {
			destroy() {
				fadingRows.delete(node);
				node.style.removeProperty('--history-row-opacity');
				scheduleRowFadeUpdate();
			}
		};
	}

	let cost = $state<SessionCost>({
		totalCostUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		rounds: 0
	});
	sessionCost.subscribe((v) => (cost = v));

	let rendering = $state(false);
	isRendering.subscribe((v) => (rendering = v));
	// Idle countdown surfaced from the editor's auto-submit timer (3s
	// after the last user keystroke). 0 = no countdown active.
	let countdown = $state(0);
	submitCountdown.subscribe((v) => (countdown = v));
	let muted = $state(false);
	let paused = $state(false);
	agentSettings.subscribe((v) => {
		muted = v.muted;
		paused = v.paused;
	});

	/** Delay single-click wake/cancel so a double-click can toggle pause
	 * without also firing Wake up. */
	let agentClickTimer: ReturnType<typeof setTimeout> | null = null;
	function handleAgentClick() {
		if (agentClickTimer) clearTimeout(agentClickTimer);
		agentClickTimer = setTimeout(() => {
			agentClickTimer = null;
			if (paused) return;
			if (rendering) onCancel?.();
			else onWakeUp?.();
		}, 280);
	}
	function handleAgentDblClick(e: MouseEvent) {
		e.preventDefault();
		if (agentClickTimer) {
			clearTimeout(agentClickTimer);
			agentClickTimer = null;
		}
		onTogglePaused?.();
	}

	/** Tooltip for the Agent pill. Always describes what the button does;
	 * folds in cost / token breakdown when the session has run at least
	 * one round, so the cost stays accessible without cluttering the pill. */
	let agentTooltip = $derived.by(() => {
		const pauseHint = 'Double-click to pause or resume the agent.';
		const action = paused
			? `Agent paused — no auto-wake, Wake up, or chat messages until you resume. ${pauseHint}`
			: rendering
				? `Click to stop the agent and cancel any queued messages. ${pauseHint}`
				: `Wake up the agent. It reviews the open files, reacts to any pending changes, and proposes edits or comments based on the current agency setting. ${pauseHint}`;
		if (cost.rounds === 0) return action;
		const costLine = `Session so far: ${formatCost(cost.totalCostUsd)} across ${cost.rounds} round${cost.rounds === 1 ? '' : 's'}. ${formatTokens(cost.inputTokens)} in, ${formatTokens(cost.outputTokens)} out, ${formatTokens(cost.cacheReadTokens)} cache read.`;
		return `${action}\n\n${costLine}`;
	});

	function formatCost(usd: number): string {
		if (usd === 0) return '$0';
		if (usd < 0.01) return `${(usd * 100).toFixed(2)}¢`;
		if (usd < 1) return `${(usd * 100).toFixed(1)}¢`;
		return `$${usd.toFixed(2)}`;
	}
	function formatTokens(n: number): string {
		if (n < 1000) return `${n}`;
		if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
		return `${(n / 1_000_000).toFixed(2)}M`;
	}

	let pendingOpCount = $state(0);

	/** Tick 30s to recompute relative "Xs ago" labels. Driven by a reactive
	 * state var so `relativeTime()` recomputes when it bumps. */
	let nowTick = $state(Date.now());
	let tickHandle: ReturnType<typeof setInterval> | null = null;
	onMount(() => {
		tickHandle = setInterval(() => {
			nowTick = Date.now();
		}, 30_000);

		const resizeObserver =
			typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleRowFadeUpdate);
		if (entriesEl) resizeObserver?.observe(entriesEl);
		window.addEventListener('resize', scheduleRowFadeUpdate);
		scheduleRowFadeUpdate();

		return () => {
			resizeObserver?.disconnect();
			window.removeEventListener('resize', scheduleRowFadeUpdate);
			if (fadeRaf) window.cancelAnimationFrame(fadeRaf);
		};
	});
	onDestroy(() => {
		if (tickHandle) clearInterval(tickHandle);
		if (agentClickTimer) clearTimeout(agentClickTimer);
	});

	function relativeTime(ts: number): string {
		// Restored-history entries carry ts=0 because the SDK transcript
		// doesn't include timestamps. Show nothing rather than "12/31/1969".
		if (!ts) return '';
		// Read nowTick so Svelte knows this function depends on it and
		// recomputes templates that call it when the tick changes.
		const elapsedMs = nowTick - ts;
		if (elapsedMs < 5_000) return 'just now';
		if (elapsedMs < 60_000) return `${Math.floor(elapsedMs / 1000)}s ago`;
		if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m ago`;
		if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h ago`;
		return new Date(ts).toLocaleDateString();
	}

	// Newest-first. The underlying store appends in chronological order;
	// we reverse for display so new entries slide in at the top and older
	// ones push down — matches the magicui animated-list vibe.
	let verbosity = $state<HistoryVerbosity>('verbose');
	historyVerbosity.subscribe((v) => (verbosity = v));

	/** Minimal-mode filter: keep user-facing conversation, actual file
	 * mutations (Edit/Write tool calls), hook runs, and important status.
	 * Hide intermediate tool noise and housekeeping actions. */
	function keepInMinimal(e: HistoryEntry): boolean {
		if (e.type === 'user_action') {
			// Drop the default / housekeeping descriptions that are just
			// "agent woke up" signals with no real content.
			const d = e.description;
			if (
				d === 'Review documents & see if there’s anything to do' ||
				d === 'Agent ran and made no edits' ||
				d === 'Accepted agent\'s edit' ||
				d === 'Rejected agent\'s edit' ||
				/^Accepted (?:all )?\d+ agent edit/.test(d) ||
				/^Rejected (?:all )?\d+ agent edit/.test(d)
			) {
				return false;
			}
			return true;
		}
		if (e.type === 'assistant_text') return e.text.trim() !== '';
		if (e.type === 'hook_run') return true;
		if (e.type === 'tool_call') {
			// Keep actual document mutations: the built-in Edit/Write tools and
			// DocWriter's edit_doc / write_doc (bare for OpenAI/Cursor, or
			// mcp__docwriter-doc__-prefixed for the Claude SDK). read_doc and
			// other lookups stay hidden as intermediate noise.
			return (
				/^(Edit|Write)$/.test(e.tool_name) ||
				/(?:^|__)(edit_doc|write_doc)$/.test(e.tool_name)
			);
		}
		if (e.type === 'task') return e.phase === 'completed' || e.phase === 'failed' || e.phase === 'stopped';
		// Surface compaction events even in minimal — they signal context
		// pressure (the user may want to close tabs / resolve threads) and
		// are rare enough not to be noise.
		if (e.type === 'status') {
			return e.status === 'compacting' || !!e.compactResult || !!e.error;
		}
		// Surface SDK notifications in minimal when they're high priority —
		// "context approaching limit" warnings and similar come through here.
		if (e.type === 'notification') {
			return e.priority === 'high' || e.priority === 'immediate';
		}
		// Skip render_end / render_start / assistant_thinking in minimal.
		return false;
	}

	const displayed = $derived(
		verbosity === 'minimal'
			? [...entries].filter(keepInMinimal).reverse()
			: [...entries].reverse()
	);

	/** While the agent is rendering, the most recent user_action entry is
	 * "what the agent is currently responding to" — pin it at the top as
	 * a highlighted card so the user always sees their in-flight prompt. */
	type ExpandedView =
		| { kind: 'assistant'; title: string; text: string; timestamp: number }
		| null;
	let expanded: ExpandedView = $state(null);

	function expandAssistant(kind: 'text' | 'thinking', text: string, timestamp: number) {
		expanded = {
			kind: 'assistant',
			title: kind === 'thinking' ? 'Agent thinking' : 'Agent message',
			text,
			timestamp
		};
	}
	function closeExpanded() {
		expanded = null;
	}
	function onExpandedKeydown(e: KeyboardEvent) {
		if (expanded && e.key === 'Escape') {
			e.preventDefault();
			closeExpanded();
		}
	}

	const pinnedTurn = $derived.by(() => {
		if (!rendering) return null;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === 'user_action') return e;
		}
		return null;
	});

	function formatTime(ts: number): string {
		return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function renderMarkdown(text: string): string {
		return text
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
			.replace(/\*(.+?)\*/g, '<em>$1</em>')
			.replace(/`(.+?)`/g, '<code>$1</code>')
			.replace(/^- (.+)$/gm, '<span class="md-bullet">$1</span>')
			.replace(/\n/g, '<br>');
	}

	marked.setOptions({ gfm: true, breaks: true, async: false });
	function escapeHtml(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
	function renderRichMarkdown(text: string): string {
		if (!text) return '';
		try {
			return marked.parse(text) as string;
		} catch {
			return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
		}
	}

	function formatDuration(ms?: number): string {
		if (!ms) return '';
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	/** Collapsed-state label for an assistant_text entry — one short line
	 * so long explanations don't visually drown the log. Expand to read
	 * the full content (markdown-rendered). */
	function assistantPreview(text: string): string {
		const trimmed = text.trim().replace(/\s+/g, ' ');
		if (trimmed.length <= 80) return trimmed;
		return trimmed.slice(0, 80) + '…';
	}

	function summarizeToolInput(input: Record<string, unknown>): string {
		if (input.new_string && typeof input.new_string === 'string') {
			const s = input.new_string as string;
			return s.length > 50 ? s.slice(0, 50) + '...' : s;
		}
		if (input.new_text && typeof input.new_text === 'string') {
			const s = input.new_text as string;
			return s.length > 50 ? s.slice(0, 50) + '...' : s;
		}
		if (input.file_path) return String(input.file_path).split('/').pop() || '';
		return '';
	}

	function formatToolInput(input: Record<string, unknown>): string {
		return Object.entries(input)
			.map(([k, v]) => {
				const val = typeof v === 'string' ? v : JSON.stringify(v);
				return `${k}: ${val}`;
			})
			.join('\n');
	}
</script>

<div class="history-pane">
	<!-- Floating dock bar: "Agent" label + live cost stat on the left,
	     all action buttons grouped on the right. The bar floats with a
	     soft shadow + rounded corners so it reads as a toolbar, not a
	     structural header. The dock snippet provides everything in
	     `.header-actions`; this component just adds the leading label
	     and the trailing "new session" reset. -->
	{#if transcriptOpen}
		<SessionViewer onClose={() => (transcriptOpen = false)} />
	{/if}
	<div class="pane-header">
		<ShineBorder
			active={rendering}
			radius={999}
			duration={2.5}
			borderWidth={1.5}
			size={45}
			thickness={10}
			color={['var(--accent)', 'var(--accent-subject)']}
		>
			{#snippet children()}
				<button
					class="header-agent-btn header-pill-btn"
					class:awake={rendering && !paused}
					class:pending={!rendering && !paused && pendingCount > 0}
					class:paused
					onclick={handleAgentClick}
					ondblclick={handleAgentDblClick}
					disabled={!paused && (rendering ? !onCancel : !onWakeUp)}
					aria-pressed={paused}
					use:tooltip={agentTooltip}
				>
					<span
						class="mascot-face"
						aria-hidden="true"
						style:color={$activeReviewer && !paused ? $activeReviewer.color : undefined}
					>
						{#if paused}
							<Pause size={13} strokeWidth={2.2} />
						{:else if $activeReviewer}
							<ReviewerMascot icon={$activeReviewer.icon} size={13} />
						{:else}
							<Cat size={13} strokeWidth={1.8} />
						{/if}
					</span>
					<span class="header-label">Agent</span>
					<span class="header-status" aria-hidden="true">
						{#if paused}
							<span class="paused-label">Paused</span>
						{:else if rendering}
							<span class="bounce-dots"><span>.</span><span>.</span><span>.</span></span>
						{:else if countdown > 0}
							<span class="countdown" title="Auto-wake in {countdown}s — click Wake up or press {modEnterLabel} in the editor to skip">{countdown}s</span>
						{:else}
							<span class="sleep-dots"><span>z</span><span>z</span><span>z</span></span>
						{/if}
					</span>
				</button>
			{/snippet}
		</ShineBorder>
		{#if dock}
			<div class="header-actions">
				{#if onToggleMuted}
					<button
						class="header-pill-btn icon-only"
						class:muted-on={muted}
						onclick={onToggleMuted}
						aria-pressed={muted}
						use:tooltip={muted
							? 'Unmute the agent. Pending edits will show inline in the editor again.'
							: 'Mute the agent. Pending edits remain in the comment gutter, but the green/red diff overlay stays hidden until you click a card.'}
					>
						{#if muted}
							<BellOff size={12} />
						{:else}
							<Bell size={12} />
						{/if}
					</button>
				{/if}
				<button
					class="header-pill-btn icon-only"
					onclick={() => (transcriptOpen = true)}
					aria-label="Transcript"
					use:tooltip={'Open the current session transcript. Shows user messages, agent responses, tool calls, and tool results.'}
				>
					<ScrollText size={12} />
				</button>
				{@render dock()}
				<button
					class="header-pill-btn icon-only"
					onclick={() => (onNewSession ? onNewSession() : agentHistory.set([]))}
					aria-label="New session"
					use:tooltip={"New agent session. Starts a fresh conversation with the agent. Workspace files, comment threads, rules, hooks, and settings all stay the same. Only the agent's conversation history resets."}
				>
					<RotateCcw size={12} />
				</button>
				{#if onCollapse}
					<button
						class="header-pill-btn icon-only"
						onclick={onCollapse}
						aria-label="Collapse dock"
						use:tooltip={'Collapse the agent dock to a pill.'}
					>
						<ChevronDown size={12} />
					</button>
				{/if}
			</div>
		{/if}
	</div>

	{#if $activeReviewer}
		<div class="reviewer-strip" style:--reviewer-color={$activeReviewer.color}>
			<span class="reviewer-strip-face">
				<ReviewerMascot icon={$activeReviewer.icon} size={13} />
			</span>
			<span><b>{$activeReviewer.name}</b> is reviewing the draft. Findings arrive as comments.</span>
		</div>
	{/if}

	<div
		class="entries"
		class:muted-veil={muted}
		aria-hidden={muted}
		bind:this={entriesEl}
		onscroll={scheduleRowFadeUpdate}
	>
		{#if pinnedTurn}
			<div class="pinned-turn-card">
				<div
					class="pinned-turn-label"
					class:quoted-desc={pinnedTurn.description.startsWith('“')}
				>{pinnedTurn.description}</div>
				{#if pinnedTurn.quote}
					<div class="pinned-turn-quote" title={pinnedTurn.quote}>"{pinnedTurn.quote}"</div>
				{/if}
				<div class="pinned-turn-meta">
					<span>you · agent is responding</span>
					<span>{relativeTime(pinnedTurn.timestamp)}</span>
				</div>
			</div>
		{/if}
		{#if rendering}
			<div class="thinking-indicator" aria-label="Agent is working">
				<span class="dot"></span>
				<span class="dot"></span>
				<span class="dot"></span>
			</div>
		{/if}
		{#if displayed.length === 0}
			<div class="empty">No activity yet. Wake up the agent to see what it does.</div>
		{/if}
		{#each displayed as entry, idx (((entry as { _key?: number })._key) ?? `${entry.timestamp}-${idx}`)}
			<div
				class="entry-slot"
				use:fadeHistoryRow
				in:fly|local={{ y: -4, duration: 180, easing: cubicOut }}
				animate:flip={{ duration: 220, easing: cubicOut }}
			>
			{#if entry.type === 'user_action'}
				{#if entry.tabDiffs && Object.keys(entry.tabDiffs).length > 0}
					{@const changedCount = Object.keys(entry.tabDiffs).length}
					<details class="entry user-action expandable">
						<summary class="user-summary">
							<User size={11} color="#9ca3af" />
							<span class="user-text" class:quoted-desc={entry.description.startsWith('“')}>{entry.description}</span>
							<span class="user-hint">
								{changedCount === 1
									? `1 file changed`
									: `${changedCount} files changed`}
							</span>
							<span class="entry-time">{relativeTime(entry.timestamp)}</span>
						</summary>
						{#if entry.quote}
							<div class="user-quote" title={entry.quote}>"{entry.quote}"</div>
						{/if}
						<div class="user-diffs">
							{#each Object.entries(entry.tabDiffs) as [tabId, diff]}
								<div class="user-diff">
									<div class="user-diff-tab">{tabId}</div>
									<pre class="user-diff-body">{diff}</pre>
								</div>
							{/each}
						</div>
					</details>
				{:else}
					<div class="entry user-action" class:has-quote={!!entry.quote}>
						<div class="user-row">
							<User size={11} color="#9ca3af" />
							<span class="user-text" class:quoted-desc={entry.description.startsWith('“')}>{entry.description}</span>
							<span class="entry-time">{relativeTime(entry.timestamp)}</span>
						</div>
						{#if entry.quote}
							<div class="user-quote" title={entry.quote}>"{entry.quote}"</div>
						{/if}
					</div>
				{/if}
			{:else if entry.type === 'tool_call'}
				{#if entry.subagent}
					<div class="entry subagent-call">
						<span class="subagent-icon">🤖</span>
						<span class="subagent-label">Subagent: {(entry.input as any)?.description || entry.tool_name}</span>
						<span class="entry-time">{relativeTime(entry.timestamp)}</span>
						{#if entry.durationMs}<span class="duration">{formatDuration(entry.durationMs)}</span>{/if}
					</div>
				{:else}
					<details class="entry tool-call" class:tool-failed={entry.isError}>
						<summary class="tool-summary">
							<FileEdit size={11} color={entry.isError ? '#dc2626' : '#7c3aed'} />
							<span class="tool-name">{entry.tool_name}</span>
							<span class="tool-hint">{summarizeToolInput(entry.input)}</span>
							{#if entry.isError}<span class="tool-error-badge">failed</span>{/if}
							<span class="entry-time">{relativeTime(entry.timestamp)}</span>
							{#if entry.durationMs}<span class="duration">{formatDuration(entry.durationMs)}</span>{/if}
						</summary>
						<pre class="tool-detail">{formatToolInput(entry.input)}</pre>
						{#if entry.result}
							<div class="tool-result-label">{entry.isError ? 'Error' : 'Result'}</div>
							<pre class="tool-result" class:tool-result-error={entry.isError}>{entry.result}</pre>
						{/if}
					</details>
				{/if}
			{:else if entry.type === 'assistant_text'}
				<details class="entry assistant-text">
					<summary class="assistant-summary">
						<Bot size={11} color="#16a34a" />
						<span class="assistant-preview">{assistantPreview(entry.text)}</span>
						<button
							type="button"
							class="expand-btn"
							title="View full message"
							aria-label="View full message"
							onclick={(e) => { e.preventDefault(); e.stopPropagation(); expandAssistant('text', entry.text, entry.timestamp); }}
						>
							<Maximize2 size={11} />
						</button>
						<span class="entry-time">{relativeTime(entry.timestamp)}</span>
					</summary>
					<div class="assistant-body">{@html renderMarkdown(entry.text)}</div>
				</details>
			{:else if entry.type === 'assistant_thinking' && entry.text.trim()}
				<details class="entry thinking-text">
					<summary class="assistant-summary">
						<Bot size={11} color="#6366f1" />
						<span class="assistant-preview">Thinking: {assistantPreview(entry.text)}</span>
						<button
							type="button"
							class="expand-btn"
							title="View full thinking"
							aria-label="View full thinking"
							onclick={(e) => { e.preventDefault(); e.stopPropagation(); expandAssistant('thinking', entry.text, entry.timestamp); }}
						>
							<Maximize2 size={11} />
						</button>
						<span class="entry-time">{relativeTime(entry.timestamp)}</span>
					</summary>
					<div class="assistant-body thinking-body">{@html renderMarkdown(entry.text)}</div>
				</details>
			{:else if entry.type === 'status'}
				<div class="entry status-line">
					<Eye size={10} color="#6366f1" />
					<span>
						{#if entry.status === 'compacting'}
							Compacting context
						{:else if entry.status === 'requesting'}
							Requesting model response
						{:else}
							Loop status updated
						{/if}
						{#if entry.compactResult} · {entry.compactResult}{/if}
						{#if entry.error} · {entry.error}{/if}
					</span>
					<span class="entry-time">{relativeTime(entry.timestamp)}</span>
				</div>
			{:else if entry.type === 'notification'}
				<div class="entry status-line notification-line">
					<Eye size={10} color="#0891b2" />
					<span>{entry.text}</span>
					<span class="entry-time">{relativeTime(entry.timestamp)}</span>
				</div>
			{:else if entry.type === 'task'}
				<div class="entry task-line" class:task-done={entry.phase === 'completed'} class:task-bad={entry.phase === 'failed'}>
					<span class="task-bullet"></span>
					<span class="task-copy">
						<span class="task-title">
							{#if entry.phase === 'started'}
								Subagent started
							{:else if entry.phase === 'progress'}
								Subagent progress
							{:else if entry.phase === 'updated'}
								Subagent updated
							{:else if entry.phase === 'completed'}
								Subagent completed
							{:else if entry.phase === 'failed'}
								Subagent failed
							{:else}
								Subagent stopped
							{/if}
						</span>
						{#if entry.description}<span class="task-detail">{entry.description}</span>{/if}
						{#if entry.summary}<span class="task-detail">{entry.summary}</span>{/if}
						{#if entry.lastToolName}<span class="task-detail">Last tool: {entry.lastToolName}</span>{/if}
					</span>
					<span class="entry-time">{relativeTime(entry.timestamp)}</span>
				</div>
			{:else if entry.type === 'tool_progress'}
				<div class="entry status-line tool-progress-line">
					<FileEdit size={10} color="#7c3aed" />
					<span>{entry.tool_name} running for {Math.max(1, Math.round(entry.elapsedSeconds))}s</span>
					<span class="entry-time">{relativeTime(entry.timestamp)}</span>
				</div>
			{:else if entry.type === 'hook_run'}
				<details class="entry hook-run" class:running={entry.status === 'running'} class:failed={entry.status === 'failed'}>
					<summary class="hook-summary" title={entry.command}>
						<Terminal size={11} color={entry.status === 'failed' ? '#ef4444' : '#0891b2'} />
						<span class="hook-tag">{entry.event}</span>
						<code class="hook-command">{entry.command}</code>
						{#if entry.status === 'running'}
							<span class="hook-running-tag">running…</span>
						{:else if entry.exitCode !== undefined && entry.exitCode !== 0}
							<span class="hook-exit-bad">exit {entry.exitCode}</span>
						{:else if entry.status === 'done'}
							<span class="hook-exit-ok">exit 0</span>
						{/if}
						<span class="entry-time">{relativeTime(entry.timestamp)}</span>
						{#if entry.durationMs}<span class="duration">{formatDuration(entry.durationMs)}</span>{/if}
					</summary>
					{#if entry.status !== 'running'}
						<pre class="tool-detail">{
							entry.stdout
								? entry.stdout
								: ''
						}{entry.stdout && entry.stderr ? '\n' : ''}{entry.stderr ? '[stderr]\n' + entry.stderr : ''}{!entry.stdout && !entry.stderr
							? '(no output captured — command produced nothing on stdout/stderr)'
							: ''}</pre>
					{/if}
				</details>
			{:else if entry.type === 'render_start'}
				<div class="entry render-line">
					<Play size={9} color="#6366f1" />
					<span>{entry.trigger}</span>
					<span class="entry-time">{relativeTime(entry.timestamp)}</span>
				</div>
			{:else if entry.type === 'render_end'}
				<div class="entry render-end-line" class:success={entry.success} class:failure={!entry.success}>
					{#if entry.success}
						<CheckCircle size={12} color="#10b981" />
						<span>Done</span>
					{:else}
						<XCircle size={12} color="#ef4444" />
						<span>Failed</span>
					{/if}
					<span class="entry-time">{relativeTime(entry.timestamp)}</span>
					{#if entry.durationMs}
						<span class="elapsed">
							{#if entry.durationMs > 60000}
								{Math.floor(entry.durationMs / 60000)}m {Math.floor((entry.durationMs % 60000) / 1000)}s
							{:else}
								{formatDuration(entry.durationMs)}
							{/if}
						</span>
					{/if}
				</div>
			{/if}
			</div>
		{/each}
	</div>
</div>

<svelte:window onkeydown={onExpandedKeydown} />

{#if expanded}
	<div
		class="expand-backdrop"
		onclick={closeExpanded}
		role="presentation"
		transition:fade={{ duration: 140 }}
	>
		<div
			class="expand-modal"
			class:thinking={expanded.title === 'Agent thinking'}
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			tabindex="-1"
			transition:fly={{ y: 16, duration: 220, easing: cubicOut }}
		>
			<div class="expand-header">
				{#if expanded.title === 'Agent thinking'}
					<Bot size={14} />
				{:else}
					<Sparkles size={14} />
				{/if}
				<span class="expand-title">{expanded.title}</span>
				<span class="expand-time">{relativeTime(expanded.timestamp)}</span>
				<button class="expand-close" onclick={closeExpanded} aria-label="Close">
					<X size={14} />
				</button>
			</div>
			<div class="expand-body">
				<div class="expand-body-inner">{@html renderRichMarkdown(expanded.text)}</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.history-pane {
		width: 100%;
		height: 100%;
		background: var(--pane-bg);
		color: var(--text);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
	}
	/* Floating dock bar — inset from the pane edges with a soft shadow
	 * so it reads as a toolbar, not a structural divider. Label on the
	 * left, button group flush right via margin-left:auto on the
	 * actions container. `position: relative` so descendants like the
	 * AgentDock's chat popover can anchor to the full toolbar width
	 * (spanning the pane) instead of the narrower button area. */
	.pane-header {
		position: relative;
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 8px;
		padding: 5px 6px 5px 12px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 10px;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.03);
	}
	/* Reviewer strip — shown under the header while a critique pass runs. */
	.reviewer-strip {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 8px 8px;
		padding: 6px 12px;
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--text-secondary);
		background: color-mix(in srgb, var(--reviewer-color, var(--accent)) 10%, var(--bg-elevated));
		border: 1px solid color-mix(in srgb, var(--reviewer-color, var(--accent)) 25%, var(--border-light));
		border-radius: 8px;
	}
	.reviewer-strip-face {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--reviewer-color, var(--accent));
	}
	.reviewer-strip b {
		font-weight: 600;
	}
	.header-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
		flex: 0 0 auto;
	}
	/* Status indicator — `zzz` while idle, bouncing dots while rendering.
	 * Sits adjacent to the "Agent" label since it describes the agent's
	 * state, not any one button. */
	.header-status {
		display: inline-flex;
		align-items: center;
		flex: 0 0 auto;
		min-width: 16px;
	}
	.sleep-dots,
	.bounce-dots {
		display: inline-flex;
		gap: 1px;
		font-family: 'SF Mono', 'Fira Code', 'Menlo', monospace;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-faint);
	}
	/* Countdown — same monospace + tabular nums so the digit shifting
	 * 3 → 2 → 1 doesn't make the row jitter horizontally. Accent color
	 * to signal "agent will wake in N seconds." */
	.countdown {
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 11px;
		font-weight: 600;
		color: var(--accent);
		font-variant-numeric: tabular-nums;
	}
	.paused-label {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.bounce-dots {
		color: var(--accent);
		font-weight: 700;
	}
	.sleep-dots span {
		opacity: 0;
		animation: header-sleep-z 2.4s ease-in-out infinite;
	}
	.sleep-dots span:nth-child(1) { animation-delay: 0s; }
	.sleep-dots span:nth-child(2) { animation-delay: 0.5s; }
	.sleep-dots span:nth-child(3) { animation-delay: 1.0s; }
	.bounce-dots span {
		display: inline-block;
		animation: header-dot-bounce 1.2s ease-in-out infinite;
	}
	.bounce-dots span:nth-child(1) { animation-delay: 0s; }
	.bounce-dots span:nth-child(2) { animation-delay: 0.2s; }
	.bounce-dots span:nth-child(3) { animation-delay: 0.4s; }
	@keyframes header-sleep-z {
		0% { opacity: 0; transform: translateY(2px) scale(0.8); }
		20% { opacity: 0.8; transform: translateY(-1px) scale(1); }
		60% { opacity: 0.8; transform: translateY(-3px) scale(1); }
		100% { opacity: 0; transform: translateY(-5px) scale(0.9); }
	}
	@keyframes header-dot-bounce {
		0%, 60%, 100% { transform: translateY(0); opacity: 0.6; }
		30% { transform: translateY(-2px); opacity: 1; }
	}
	.header-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 2px;
		flex: 0 0 auto;
	}
	/* Shared pill-button chrome — applied to all 3 action buttons in
	 * the trailing group (Wake from AgentDock, Chat from AgentDock,
	 * New session from this component). Icon + text label, ghost until
	 * hovered. :global() so the AgentDock's buttons inherit it. */
	/* ShineBorder (BorderBeam) inline so it sits flush in the flex row. */
	.pane-header :global(.bb-host) {
		display: inline-flex;
		align-items: center;
		flex: 0 0 auto;
	}
	/* Agent pill button — contains the cat, label, zzz/dots, and cost. */
	.header-agent-btn {
		gap: 4px !important;
	}
	.header-agent-btn.awake,
	.header-agent-btn.pending {
		border-color: transparent !important;
	}
	.header-agent-btn.paused {
		opacity: 0.5;
		filter: grayscale(1);
		color: var(--text-faint) !important;
		background: color-mix(in srgb, var(--text) 5%, var(--bg-elevated)) !important;
		border: 1px dashed color-mix(in srgb, var(--text) 22%, var(--border-light)) !important;
		box-shadow: none !important;
		cursor: default;
	}
	.header-agent-btn.paused .header-label,
	.header-agent-btn.paused .mascot-face,
	.header-agent-btn.paused .paused-label {
		color: var(--text-faint) !important;
		animation: none !important;
	}
	.header-agent-btn.paused:hover {
		background: color-mix(in srgb, var(--text) 7%, var(--bg-elevated)) !important;
	}
	.header-agent-btn:not(:disabled):hover .header-label {
		color: var(--text);
	}
	.mascot-face {
		display: inline-flex;
		align-items: center;
		color: var(--text-secondary);
		transform-origin: center bottom;
		animation: mascot-sleep-bob 3.2s ease-in-out infinite;
		transition: color 0.3s;
		flex-shrink: 0;
	}
	.header-agent-btn.awake .mascot-face {
		color: var(--accent);
		animation: mascot-run 0.6s ease-in-out infinite;
	}
	@keyframes mascot-sleep-bob {
		0%, 100% { transform: scaleY(1) translateY(0); }
		50% { transform: scaleY(1.04) translateY(-1px); }
	}
	@keyframes mascot-run {
		0% { transform: translateY(0) rotate(-4deg) scaleY(1); }
		25% { transform: translateY(-5px) rotate(3deg) scaleY(1.05); }
		50% { transform: translateY(0) rotate(4deg) scaleY(1); }
		75% { transform: translateY(-3px) rotate(-3deg) scaleY(1.05); }
		100% { transform: translateY(0) rotate(-4deg) scaleY(1); }
	}
	.pane-header :global(.header-pill-btn) {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 26px;
		padding: 0 10px 0 8px;
		font-size: 12px;
		font-family: inherit;
		font-weight: 500;
		color: var(--text-faint);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 999px;
		cursor: pointer;
		white-space: nowrap;
		transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
	}
	.pane-header :global(.header-pill-btn:hover:not(:disabled)) {
		color: var(--text);
		background: var(--bg-hover);
		border-color: var(--border-light);
	}
	.pane-header :global(.header-pill-btn:disabled) {
		cursor: default;
		opacity: 0.6;
	}
	.pane-header :global(.header-pill-btn.icon-only) {
		padding: 0 7px;
		gap: 0;
	}
	.pane-header :global(.header-pill-btn.muted-on) {
		color: var(--accent);
		background: var(--accent-bg);
		border-color: var(--accent-light);
	}

	/* Entries */
	.entries {
		flex: 1;
		overflow-y: auto;
		padding: 6px 8px;
		transition: opacity 240ms ease, filter 240ms ease;
	}
	.pinned-turn-card {
		padding: 9px 10px;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border-light));
		background: color-mix(in srgb, var(--accent) 4%, var(--bg-surface));
		margin-bottom: 10px;
	}
	.pinned-turn-label {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--accent);
		line-height: 1.35;
	}
	/* When the description is a quoted user turn (curly-quoted text,
	 * emitted by shortDescription for feedback/discuss triggers), render
	 * it in italics so it reads as the user's own words rather than a
	 * framework label. */
	.quoted-desc {
		font-style: italic;
	}
	.pinned-turn-quote {
		margin-top: 6px;
		font-size: 12px;
		line-height: 1.45;
		color: var(--text-secondary);
		font-style: italic;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.pinned-turn-meta {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		margin-top: 8px;
		font-size: 10.5px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.expand-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border: none;
		background: transparent;
		color: var(--text-faint);
		border-radius: 4px;
		cursor: pointer;
		flex-shrink: 0;
	}
	.expand-btn:hover {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		color: var(--accent);
	}
	.expand-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(15, 15, 20, 0.28);
		backdrop-filter: blur(2px);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
		z-index: 220;
	}
	.expand-modal {
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 12px;
		box-shadow: 0 28px 72px rgba(0, 0, 0, 0.22), 0 8px 20px rgba(0, 0, 0, 0.08);
		width: min(1120px, calc(100vw - 24px));
		max-height: min(92vh, 960px);
		display: flex;
		flex-direction: column;
		font-family: 'Inter', -apple-system, sans-serif;
		color: var(--text);
	}
	.expand-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 24px;
		border-bottom: 1px solid var(--border-light);
		background: linear-gradient(180deg, var(--accent-bg) 0%, var(--bg-elevated) 72%);
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.expand-modal.thinking .expand-header {
		background: linear-gradient(180deg, color-mix(in srgb, #6366f1 14%, transparent) 0%, var(--bg-elevated) 72%);
	}
	.expand-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.expand-time {
		font-size: 11px;
		font-weight: 500;
		text-transform: none;
		letter-spacing: 0;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.expand-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 5px;
		border: none;
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
	}
	.expand-close:hover {
		background: var(--bg-surface);
		color: var(--text);
	}
	.expand-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		background: var(--prose-bg);
		border-top: 1px solid var(--border-light);
	}
	.expand-body-inner {
		counter-reset: expand-ol-item;
		padding: 22px 28px 24px;
		max-width: 100%;
		box-sizing: border-box;
		font-family: 'Lora', Georgia, 'Times New Roman', serif;
		font-size: 15px;
		line-height: 1.55;
		color: var(--prose-text);
	}
	.expand-modal.thinking .expand-body-inner {
		font-style: italic;
		color: var(--text-secondary);
	}
	.expand-body-inner :global(h1),
	.expand-body-inner :global(h2),
	.expand-body-inner :global(h3) {
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-faint);
		margin: 18px 0 6px;
	}
	.expand-body-inner :global(h1:first-child),
	.expand-body-inner :global(h2:first-child),
	.expand-body-inner :global(h3:first-child) {
		margin-top: 0;
	}
	.expand-body-inner :global(h4),
	.expand-body-inner :global(h5),
	.expand-body-inner :global(h6) {
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
		font-size: 14px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--prose-text);
		margin: 14px 0 5px;
	}
	.expand-body-inner :global(p) {
		margin: 0 0 9px;
	}
	.expand-body-inner :global(p:last-child) {
		margin-bottom: 0;
	}
	.expand-body-inner :global(strong) {
		font-weight: 600;
		color: var(--prose-text);
	}
	.expand-body-inner :global(em) {
		font-style: italic;
	}
	.expand-body-inner :global(ul),
	.expand-body-inner :global(ol) {
		margin: 0 0 12px;
		padding-left: 1.25em;
	}
	.expand-body-inner :global(ul:last-child),
	.expand-body-inner :global(ol:last-child) {
		margin-bottom: 0;
	}
	.expand-body-inner :global(li) {
		margin: 3px 0;
		padding-left: 2px;
	}
	.expand-body-inner :global(ol) {
		list-style: none;
		padding-left: 0;
	}
	.expand-body-inner :global(ol > li) {
		position: relative;
		padding-left: 1.55em;
		counter-increment: expand-ol-item;
	}
	.expand-body-inner :global(ol > li::before) {
		content: counter(expand-ol-item) '.';
		position: absolute;
		left: 0;
		width: 1.3em;
		text-align: right;
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
		font-size: 13px;
		font-weight: 600;
		color: var(--accent-subject);
		top: 0.05em;
	}
	.expand-body-inner :global(ul > li::marker) {
		color: var(--accent-subject);
		font-weight: 600;
		font-size: 0.8em;
	}
	.expand-body-inner :global(code) {
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 0.84em;
		padding: 2px 6px;
		border-radius: 4px;
		color: var(--text-secondary);
		background: var(--accent-bg);
		border: 1px solid var(--border-light);
		vertical-align: 0.04em;
	}
	.expand-body-inner :global(pre) {
		margin: 10px 0 14px;
		padding: 12px 14px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 8px;
		overflow-x: auto;
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text);
	}
	.expand-body-inner :global(pre code) {
		background: transparent;
		border: none;
		padding: 0;
		font-size: inherit;
		color: inherit;
		vertical-align: baseline;
	}
	.expand-body-inner :global(blockquote) {
		margin: 8px 0;
		padding: 4px 12px;
		border-left: 3px solid var(--accent-light);
		color: var(--text-secondary);
		background: color-mix(in srgb, var(--accent) 4%, transparent);
		border-radius: 0 4px 4px 0;
	}
	.expand-body-inner :global(a) {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.expand-body-inner :global(hr) {
		border: none;
		border-top: 1px solid var(--border-light);
		margin: 14px 0;
	}
	.expand-body-inner :global(table) {
		border-collapse: collapse;
		margin: 10px 0;
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
	}
	.expand-body-inner :global(th),
	.expand-body-inner :global(td) {
		padding: 6px 10px;
		border: 1px solid var(--border-light);
		text-align: left;
	}
	.expand-body-inner :global(th) {
		background: var(--bg-surface);
		font-weight: 600;
	}
	.empty {
		font-size: 13px;
		color: var(--text-faint);
		padding: 16px 4px;
		line-height: 1.5;
	}
	.entry {
		margin-bottom: 4px;
	}

	/* User actions */
	.user-action {
		padding: 6px 8px;
		background: var(--bg-surface);
		border-radius: 5px;
		font-size: 13px;
	}
	.user-action:not(.expandable) {
		display: flex;
		align-items: flex-start;
		gap: 6px;
	}
	/* When a non-expandable user_action has a quote, switch the outer
	 * container to block so the .user-row flex line and the quote stack
	 * vertically. */
	.user-action.has-quote:not(.expandable) {
		display: block;
	}
	.user-row {
		display: flex;
		align-items: flex-start;
		gap: 6px;
	}
	.user-quote {
		margin-top: 4px;
		color: var(--text-muted);
		font-style: italic;
		font-size: 12px;
		line-height: 1.4;
		/* Truncate long quotes to 2 lines so a feedback entry with a long
		 * passage doesn't dominate the pane. Full text is available via the
		 * native title tooltip set on the element. */
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.user-text {
		color: var(--text-secondary);
		line-height: 1.4;
		font-size: 13px;
	}
	.user-summary {
		display: flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
		list-style: none;
	}
	.user-summary::-webkit-details-marker { display: none; }
	.user-summary::before {
		content: '▸';
		color: var(--text-faint);
		font-size: 9px;
		transition: transform 0.12s;
	}
	.user-action[open] .user-summary::before { transform: rotate(90deg); }
	.user-hint {
		margin-left: auto;
		color: var(--text-faint);
		font-size: 11px;
	}
	.entry-slot {
		/* Wrapper for the fly transition + flip animation. Just stacks
		 * the entries with consistent spacing. The previous version
		 * varied opacity/scale by stack depth and triggered a transition
		 * on every depth change — combined with a per-entry fly-in that
		 * was firing for every entry on every update (because the each
		 * key included idx), the pane felt chaotic. Both are gone now;
		 * `in:fly|local` handles entry, `animate:flip` handles smooth
		 * repositioning when older entries shift down. */
		margin-bottom: 4px;
		opacity: var(--history-row-opacity, 1);
		transition: opacity 160ms ease;
		will-change: opacity;
	}
	.entry-slot:hover,
	.entry-slot:focus-within {
		opacity: 1;
	}
	.entry-time {
		margin-left: 8px;
		color: var(--text-faint);
		font-size: 10.5px;
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}
	.user-hint + .entry-time {
		margin-left: 8px;
	}
	.user-action:not(.expandable) .entry-time {
		margin-left: auto;
	}
	.tool-summary .entry-time,
	.assistant-summary .entry-time,
	.hook-summary .entry-time,
	.subagent-call .entry-time,
	.render-line .entry-time,
	.render-end-line .entry-time {
		margin-left: auto;
	}
	.user-diffs {
		margin-top: 8px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.user-diff-tab {
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
		letter-spacing: 0.03em;
		margin-bottom: 4px;
	}
	.user-diff-body {
		font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
		font-size: 11px;
		line-height: 1.4;
		margin: 0;
		padding: 8px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 4px;
		white-space: pre-wrap;
		overflow-x: auto;
		color: var(--text-secondary);
	}

	/* Tool calls — collapsible */
	.tool-call {
		border-radius: 5px;
		border: 1px solid var(--tool-border);
		background: var(--tool-bg);
		overflow: hidden;
	}
	.tool-summary {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		font-size: 13px;
		cursor: pointer;
		list-style: none;
	}
	.tool-summary::-webkit-details-marker { display: none; }
	.tool-summary::before {
		content: '▸';
		font-size: 10px;
		color: var(--accent);
		opacity: 0.6;
		transition: transform 0.15s;
	}
	details[open] .tool-summary::before {
		transform: rotate(90deg);
	}
	.tool-name {
		font-weight: 600;
		color: var(--tool-accent);
		font-size: 13px;
	}
	.tool-hint {
		color: var(--text-muted);
		font-size: 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}
	.tool-detail {
		padding: 8px 10px;
		font-size: 12px;
		color: var(--text-secondary);
		background: var(--bg-surface);
		border-top: 1px solid var(--border-light);
		white-space: pre-wrap;
		word-break: break-word;
		font-family: 'SF Mono', 'Menlo', monospace;
		line-height: 1.5;
		max-height: 200px;
		overflow-y: auto;
		margin: 0;
	}
	/* Tool-call response (from MCP CallToolResult). Rendered as a second
	 * section below the args so you can see BOTH what the agent tried and
	 * how the tool replied — particularly the error text when a tool fails
	 * silently (e.g. "old_string not found" from edit_doc). */
	.tool-result-label {
		padding: 6px 10px 0;
		font-size: 10px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-secondary);
		background: var(--bg-surface);
	}
	.tool-result {
		padding: 4px 10px 10px;
		margin: 0;
		font-size: 12px;
		color: var(--text-primary);
		background: var(--bg-surface);
		white-space: pre-wrap;
		word-break: break-word;
		font-family: 'SF Mono', 'Menlo', monospace;
		line-height: 1.5;
		max-height: 200px;
		overflow-y: auto;
	}
	.tool-result-error {
		color: #b91c1c;
	}
	.tool-failed {
		border-color: color-mix(in srgb, #dc2626 35%, var(--tool-border));
		background: color-mix(in srgb, #dc2626 6%, var(--tool-bg));
	}
	.tool-error-badge {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 4px;
		background: color-mix(in srgb, #dc2626 15%, transparent);
		color: #b91c1c;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	/* Assistant text — collapsible <details>. Collapsed state shows a single
	 * preview line so the activity log stays scannable. Expand to read. */
	.assistant-text {
		padding: 6px 10px;
		background: var(--assistant-bg);
		border-radius: 5px;
		border: 1px solid var(--assistant-border);
		font-size: 13px;
	}
	.thinking-text {
		padding: 6px 10px;
		background: color-mix(in srgb, #6366f1 7%, var(--bg-surface));
		border-radius: 5px;
		border: 1px solid color-mix(in srgb, #6366f1 20%, var(--border-light));
		font-size: 13px;
	}
	.assistant-summary {
		display: flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
		list-style: none;
		min-width: 0;
	}
	.assistant-summary::-webkit-details-marker { display: none; }
	.assistant-summary::before {
		content: '▸';
		color: var(--text-faint);
		font-size: 9px;
		flex-shrink: 0;
		transition: transform 0.12s;
	}
	.assistant-text[open] .assistant-summary::before { transform: rotate(90deg); }
	.assistant-preview {
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.4;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		flex: 1;
	}
	.assistant-body {
		color: var(--text);
		line-height: 1.55;
		word-break: break-word;
		font-size: 13px;
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px solid var(--assistant-border);
	}
	.thinking-body {
		border-top-color: color-mix(in srgb, #6366f1 18%, var(--assistant-border));
		color: var(--text-secondary);
		font-style: italic;
	}
	.assistant-body :global(strong) {
		font-weight: 600;
		color: var(--text);
	}
	.assistant-body :global(code) {
		font-family: 'SF Mono', 'Menlo', monospace;
		font-size: 12px;
		background: var(--bg-surface);
		color: var(--text-secondary);
		padding: 1px 4px;
		border-radius: 3px;
	}
	.assistant-body :global(.md-bullet) {
		display: block;
		padding-left: 10px;
		position: relative;
	}
	.assistant-body :global(.md-bullet::before) {
		content: '•';
		position: absolute;
		left: 0;
		color: var(--text-faint);
	}

	.duration {
		font-size: 10px;
		color: var(--text-faint);
		background: var(--bg-surface);
		padding: 1px 5px;
		border-radius: 3px;
		margin-left: auto;
		flex-shrink: 0;
		font-family: 'SF Mono', 'Menlo', monospace;
	}
	.tool-summary .duration,
	.hook-summary .duration,
	.subagent-call .duration,
	.render-end-line .elapsed {
		margin-left: 8px;
	}

	/* Hook runs are background signals (user's own shell commands firing on
	 * agent events) — they shouldn't compete visually with agent output.
	 * No box, just a subtle left accent to mark the row. */
	.hook-run {
		border: none;
		background: transparent;
		border-left: 2px solid color-mix(in srgb, #0891b2 60%, var(--border-light));
		padding-left: 4px;
	}
	.hook-run.failed {
		border-left-color: color-mix(in srgb, #ef4444 70%, var(--border-light));
	}
	/* Hook summary — let the command wrap instead of ellipsizing so the
	 * user can read it inline without having to hover. */
	.hook-summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 4px 6px;
		font-size: 12px;
		cursor: pointer;
		list-style: none;
		line-height: 1.4;
	}
	.hook-summary::-webkit-details-marker { display: none; }
	.hook-summary::before {
		content: '▸';
		font-size: 10px;
		color: var(--text-faint);
		transition: transform 0.15s;
	}
	details[open] .hook-summary::before { transform: rotate(90deg); }
	.hook-tag {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		color: #0891b2;
		text-transform: uppercase;
	}
	.hook-run.failed .hook-tag {
		color: #ef4444;
	}
	.hook-command {
		flex: 1 1 100%;
		min-width: 0;
		font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
		font-size: 11.5px;
		color: var(--text-secondary);
		background: transparent;
		padding: 0;
		line-height: 1.35;
		word-break: break-word;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	.hook-running-tag {
		font-size: 10px;
		color: #0891b2;
		font-family: 'SF Mono', 'Menlo', monospace;
		padding: 1px 6px;
		border: 1px solid color-mix(in srgb, #0891b2 40%, transparent);
		border-radius: 3px;
		flex-shrink: 0;
	}
	.hook-exit-bad {
		font-size: 10px;
		color: #ef4444;
		font-family: 'SF Mono', 'Menlo', monospace;
		padding: 1px 6px;
		border: 1px solid color-mix(in srgb, #ef4444 40%, transparent);
		border-radius: 3px;
		flex-shrink: 0;
	}
	.hook-exit-ok {
		font-size: 10px;
		color: #10b981;
		font-family: 'SF Mono', 'Menlo', monospace;
		padding: 1px 6px;
		border: 1px solid color-mix(in srgb, #10b981 40%, transparent);
		border-radius: 3px;
		flex-shrink: 0;
	}

	.subagent-call {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		background: color-mix(in srgb, #0891b2 8%, transparent);
		border-radius: 6px;
		border-left: 3px solid #0891b2;
	}
	.status-line,
	.task-line {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		padding: 6px 8px;
		font-size: 12px;
		color: var(--text-muted);
		background: color-mix(in srgb, var(--bg-surface) 86%, transparent);
		border-radius: 5px;
	}
	.notification-line {
		background: color-mix(in srgb, #0891b2 8%, transparent);
	}
	.tool-progress-line {
		background: color-mix(in srgb, #7c3aed 7%, transparent);
	}
	.task-line {
		background: color-mix(in srgb, #6366f1 7%, transparent);
	}
	.task-line.task-done {
		background: color-mix(in srgb, #10b981 8%, transparent);
	}
	.task-line.task-bad {
		background: color-mix(in srgb, #ef4444 8%, transparent);
	}
	.task-bullet {
		width: 7px;
		height: 7px;
		border-radius: 999px;
		background: #6366f1;
		margin-top: 4px;
		flex-shrink: 0;
	}
	.task-done .task-bullet { background: #10b981; }
	.task-bad .task-bullet { background: #ef4444; }
	.task-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}
	.task-title {
		font-weight: 600;
		color: var(--text-secondary);
	}
	.task-detail {
		color: var(--text-muted);
		line-height: 1.35;
		word-break: break-word;
	}
	.subagent-icon { font-size: 13px; }
	.subagent-label {
		flex: 1;
		font-size: 12px;
		color: #0891b2;
		font-weight: 500;
	}

	/* Render markers */
	.render-line {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 3px 6px;
		font-size: 10px;
		color: #9ca3af;
	}
	.render-end-line {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 10px;
		font-size: 12px;
		color: var(--text-muted);
		border-top: 1px solid var(--border-light);
		margin-top: 4px;
	}
	.render-end-line.success { color: #10b981; }
	.render-end-line.failure { color: #ef4444; }
	.render-end-line .elapsed {
		color: var(--text-faint);
		font-size: 11px;
	}

	/* Bouncing-dots "thinking" indicator, rendered at the bottom of the log
	 * while a render is in progress. Gives the user a visual heartbeat even
	 * when the agent hasn't emitted any text or tool calls yet. */
	.thinking-indicator {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 10px 14px;
	}
	.thinking-indicator .dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--text-muted);
		opacity: 0.6;
		animation: dot-bounce 1.2s infinite ease-in-out;
	}
	.thinking-indicator .dot:nth-child(2) { animation-delay: 0.15s; }
	.thinking-indicator .dot:nth-child(3) { animation-delay: 0.3s; }

	@keyframes dot-bounce {
		0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
		30% { transform: translateY(-4px); opacity: 0.9; }
	}
</style>
