<script lang="ts">
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { FileEdit, User, Bot, Play, CheckCircle, XCircle, Eye, X, Terminal } from 'lucide-svelte';
	import type { HistoryEntry, Annotation } from '$lib/types';
	import { agentHistory, annotations, isRendering, historyVerbosity } from '$lib/stores';
	import type { HistoryVerbosity } from '$lib/stores';
	import { onMount, onDestroy } from 'svelte';

	interface Props {
		onNewSession?: () => void | Promise<void>;
	}
	let { onNewSession }: Props = $props();

	let entries: HistoryEntry[] = $state([]);
	agentHistory.subscribe((v) => (entries = v));

	let annos: Annotation[] = $state([]);
	annotations.subscribe((v) => (annos = v));

	let pendingOpCount = $state(0);

	let rendering = $state(false);
	isRendering.subscribe((v) => {
		rendering = v;
	});

	/** Tick 30s to recompute relative "Xs ago" labels. Driven by a reactive
	 * state var so `relativeTime()` recomputes when it bumps. */
	let nowTick = $state(Date.now());
	let tickHandle: ReturnType<typeof setInterval> | null = null;
	onMount(() => {
		tickHandle = setInterval(() => {
			nowTick = Date.now();
		}, 30_000);
	});
	onDestroy(() => {
		if (tickHandle) clearInterval(tickHandle);
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

	/** Minimal-mode filter: keep only user actions WITH an explicit trigger,
	 * actual file mutations (Edit/Write tool calls), hook runs, and
	 * render_end markers. Hide the intermediate noise (Read/Glob/Grep/Bash/
	 * Skill exploration, assistant prose, render_start) AND the implicit
	 * "Review document and improve" user_action that fires on bare Wake Up
	 * (it adds no information — the edit itself tells the story). */
	function keepInMinimal(e: HistoryEntry): boolean {
		if (e.type === 'user_action') {
			// Drop the default / housekeeping descriptions that are just
			// "agent woke up" signals with no real content.
			const d = e.description;
			if (
				d === 'Review document and improve' ||
				d === 'Accepted agent\'s edit' ||
				d === 'Rejected agent\'s edit' ||
				/^Accepted \d+ agent edit/.test(d) ||
				/^Rejected \d+ agent edit/.test(d)
			) {
				return false;
			}
			return true;
		}
		if (e.type === 'hook_run') return true;
		if (e.type === 'tool_call') {
			return /^(Edit|Write)$/.test(e.tool_name);
		}
		if (e.type === 'task') return e.phase === 'completed' || e.phase === 'failed' || e.phase === 'stopped';
		// Skip render_end / render_start / assistant_text in minimal.
		return false;
	}

	const displayed = $derived(
		verbosity === 'minimal'
			? [...entries].filter(keepInMinimal).reverse()
			: [...entries].reverse()
	);

	function removeAnnotation(id: string) {
		annotations.update((a) => a.filter((x) => x.id !== id));
	}

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
	<div class="pane-header">
		<span class="pane-title">Agent History</span>
		<button
			class="clear-btn"
			onclick={() => (onNewSession ? onNewSession() : agentHistory.set([]))}
			title="Start a fresh agent session — clears history and the SDK session id"
		>New agent session</button>
	</div>

	<div class="entries">
		{#if annos.length > 0}
			<div class="annotation-list">
				{#each annos as anno (anno.id)}
					<div class="annotation-card">
						<div class="annotation-card-head">
							<span class="annotation-label">{anno.comment}</span>
							<button class="annotation-dismiss" onclick={() => removeAnnotation(anno.id)}>
								<X size={12} />
							</button>
						</div>
						<div class="annotation-excerpt">"{anno.excerpt}"</div>
						<div class="annotation-meta">
							<span>{anno.tabId}</span>
							<span>{relativeTime(anno.timestamp)}</span>
						</div>
					</div>
				{/each}
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
		{#each displayed as entry, idx (entry.timestamp + '-' + idx)}
			{@const depth = Math.min(idx, 6)}
			<div
				class="entry-slot"
				style:--depth={depth}
				in:fly={{ y: -8, duration: 220, easing: cubicOut }}
			>
			{#if entry.type === 'user_action'}
				{#if entry.tabDiffs && Object.keys(entry.tabDiffs).length > 0}
					{@const changedCount = Object.keys(entry.tabDiffs).length}
					<details class="entry user-action expandable">
						<summary class="user-summary">
							<User size={11} color="#9ca3af" />
							<span class="user-text">{entry.description}</span>
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
							<span class="user-text">{entry.description}</span>
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
					<details class="entry tool-call">
						<summary class="tool-summary">
							<FileEdit size={11} color="#7c3aed" />
							<span class="tool-name">{entry.tool_name}</span>
							<span class="tool-hint">{summarizeToolInput(entry.input)}</span>
							<span class="entry-time">{relativeTime(entry.timestamp)}</span>
							{#if entry.durationMs}<span class="duration">{formatDuration(entry.durationMs)}</span>{/if}
						</summary>
						<pre class="tool-detail">{formatToolInput(entry.input)}</pre>
					</details>
				{/if}
			{:else if entry.type === 'assistant_text'}
				<details class="entry assistant-text">
					<summary class="assistant-summary">
						<Bot size={11} color="#16a34a" />
						<span class="assistant-preview">{assistantPreview(entry.text)}</span>
						<span class="entry-time">{relativeTime(entry.timestamp)}</span>
					</summary>
					<div class="assistant-body">{@html renderMarkdown(entry.text)}</div>
				</details>
			{:else if entry.type === 'assistant_thinking'}
				<details class="entry thinking-text">
					<summary class="assistant-summary">
						<Bot size={11} color="#6366f1" />
						<span class="assistant-preview">Thinking: {assistantPreview(entry.text)}</span>
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
						{/if}
						<span class="entry-time">{relativeTime(entry.timestamp)}</span>
						{#if entry.durationMs}<span class="duration">{formatDuration(entry.durationMs)}</span>{/if}
					</summary>
					{#if entry.stdout || entry.stderr}
						<pre class="tool-detail">{entry.stdout || ''}{entry.stderr ? '\n[stderr]\n' + entry.stderr : ''}</pre>
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
	.pane-header {
		padding: 12px 14px 10px;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.pane-title {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.clear-btn {
		font-size: 12px;
		color: var(--text-faint);
		background: none;
		border: none;
		cursor: pointer;
		font-family: inherit;
	}
	.clear-btn:hover { color: var(--text-secondary); }

	/* Entries */
	.entries {
		flex: 1;
		overflow-y: auto;
		padding: 6px 8px;
	}
	.annotation-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 10px;
	}
	.annotation-card {
		padding: 9px 10px;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border-light));
		background: color-mix(in srgb, var(--accent) 4%, var(--bg-surface));
	}
	.annotation-card-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.annotation-label {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--accent);
		flex: 1;
		min-width: 0;
	}
	.annotation-dismiss {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 999px;
		border: none;
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
		flex-shrink: 0;
	}
	.annotation-dismiss:hover {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		color: var(--accent);
	}
	.annotation-excerpt {
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
	.annotation-meta {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		margin-top: 8px;
		font-size: 10.5px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
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
		/* Wrapper for the fly transition — gives each history row its own
		 * transition context without interfering with the entry's layout.
		 *
		 * MagicUI animated-list treatment: newest entry (depth 0) is full
		 * emphasis; older entries fade and shrink progressively. Capped at
		 * depth 6 so the stack stays readable instead of disappearing. */
		margin-bottom: 4px;
		opacity: calc(1 - var(--depth, 0) * 0.11);
		transform: scale(calc(1 - var(--depth, 0) * 0.018));
		transform-origin: center top;
		transition: opacity 0.25s ease, transform 0.25s ease;
	}
	/* Let hover/focus temporarily restore full emphasis so older entries
	 * stay readable when you interact with them. */
	.entry-slot:hover,
	.entry-slot:focus-within {
		opacity: 1;
		transform: none;
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
