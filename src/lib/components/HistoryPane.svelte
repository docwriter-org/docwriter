<script lang="ts">
	import { FileEdit, User, Bot, Play, CheckCircle, XCircle, Eye, X, Atom } from 'lucide-svelte';
	import type { HistoryEntry, Annotation } from '$lib/types';
	import { agentHistory, annotations, actionQueue, isRendering } from '$lib/stores';

	let entries: HistoryEntry[] = $state([]);
	agentHistory.subscribe((v) => (entries = v));

	let annos: Annotation[] = $state([]);
	annotations.subscribe((v) => (annos = v));

	let queueLength = $state(0);
	actionQueue.subscribe((q) => (queueLength = q.length));

	let rendering = $state(false);
	let renderStartTime = $state(0);
	let lastElapsed = $state('');
	isRendering.subscribe((v) => {
		rendering = v;
		if (v) {
			renderStartTime = Date.now();
			lastElapsed = '';
		} else if (renderStartTime > 0) {
			const ms = Date.now() - renderStartTime;
			lastElapsed = ms > 60000
				? `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
				: `${(ms / 1000).toFixed(1)}s`;
		}
	});

	let scrollContainer: HTMLDivElement | null = $state(null);

	$effect(() => {
		if (entries.length && scrollContainer) {
			requestAnimationFrame(() => {
				scrollContainer!.scrollTop = scrollContainer!.scrollHeight;
			});
		}
	});

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
		<button class="clear-btn" onclick={() => agentHistory.set([])}>Clear</button>
	</div>


	<div class="entries" bind:this={scrollContainer}>
		{#if entries.length === 0}
			<div class="empty">No activity yet. Edit an atom to see agent actions here.</div>
		{/if}
		{#each entries as entry}
			{#if entry.type === 'user_action'}
				<div class="entry user-action">
					<User size={11} color="#9ca3af" />
					<span class="user-text">{entry.description}</span>
				</div>
			{:else if entry.type === 'tool_call'}
				<details class="entry tool-call" class:subagent={entry.subagent}>
					<summary class="tool-summary">
						<FileEdit size={11} color="#7c3aed" />
						<span class="tool-name">{entry.tool_name}</span>
						<span class="tool-hint">{summarizeToolInput(entry.input)}</span>
						{#if entry.durationMs}<span class="duration">{formatDuration(entry.durationMs)}</span>{/if}
					</summary>
					<pre class="tool-detail">{formatToolInput(entry.input)}</pre>
				</details>
			{:else if entry.type === 'assistant_text'}
				<div class="entry assistant-text">
					<Bot size={11} color="#16a34a" />
					<div class="assistant-body">{@html renderMarkdown(entry.text)}</div>
				</div>
			{:else if entry.type === 'render_start'}
				<div class="entry render-line">
					<Play size={9} color="#6366f1" />
					<span>{entry.trigger}</span>
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
		{/each}

		{#if queueLength > 0}
			<div class="queue-status">
				<span>{queueLength} change{queueLength > 1 ? 's' : ''} queued...</span>
			</div>
		{/if}

		{#if rendering || queueLength > 0}
			<div class="bouncing-atom">
				<Atom size={14} />
			</div>
		{:else if lastElapsed}
			<div class="elapsed-footer">
				<CheckCircle size={12} color="#10b981" />
				<span>Done</span>
				<span class="elapsed-time">{lastElapsed}</span>
			</div>
		{/if}
	</div>
</div>

<style>
	.history-pane {
		width: 100%;
		height: 100%;
		border-left: 1px solid var(--border-light);
		background: var(--pane-bg);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
	}
	.pane-header {
		padding: 10px 12px 8px;
		border-bottom: 1px solid #f0f0f0;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.pane-title {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #9ca3af;
	}
	.clear-btn {
		font-size: 11px;
		color: #d1d5db;
		background: none;
		border: none;
		cursor: pointer;
		font-family: inherit;
	}
	.clear-btn:hover { color: #9ca3af; }

	/* Feedback section */
	.feedback-section {
		padding: 8px 10px;
		border-bottom: 1px solid var(--border-light);
		background: var(--feedback-bg);
	}
	.feedback-header {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: #b45309;
		margin-bottom: 4px;
	}
	.feedback-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 0;
		font-size: 11px;
	}
	.feedback-tag {
		padding: 1px 6px;
		border-radius: 4px;
		white-space: nowrap;
		font-size: 10px;
		font-weight: 500;
	}
	.feedback-text {
		color: #6b7280;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.feedback-remove {
		background: none;
		border: none;
		color: #d1d5db;
		cursor: pointer;
		flex-shrink: 0;
		padding: 2px;
	}

	/* Entries */
	.entries {
		flex: 1;
		overflow-y: auto;
		padding: 6px 8px;
	}
	.empty {
		font-size: 12px;
		color: #d1d5db;
		padding: 16px 4px;
		line-height: 1.5;
	}
	.entry {
		margin-bottom: 2px;
	}

	/* User actions */
	.user-action {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		padding: 4px 6px;
		background: #f9fafb;
		border-radius: 5px;
		font-size: 11px;
	}
	.user-text {
		color: var(--text-secondary);
		line-height: 1.4;
		font-size: 13px;
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
		gap: 5px;
		padding: 5px 8px;
		font-size: 11px;
		cursor: pointer;
		list-style: none;
	}
	.tool-summary::-webkit-details-marker { display: none; }
	.tool-summary::before {
		content: '▸';
		font-size: 9px;
		color: #c4b5fd;
		transition: transform 0.15s;
	}
	details[open] .tool-summary::before {
		transform: rotate(90deg);
	}
	.tool-name {
		font-weight: 600;
		color: #6d28d9;
		font-size: 11px;
	}
	.tool-hint {
		color: #a78bfa;
		font-size: 10px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}
	.tool-detail {
		padding: 6px 8px;
		font-size: 10px;
		color: #4b5563;
		background: #f5f3ff;
		border-top: 1px solid #ede9fe;
		white-space: pre-wrap;
		word-break: break-word;
		font-family: 'SF Mono', 'Menlo', monospace;
		line-height: 1.5;
		max-height: 200px;
		overflow-y: auto;
		margin: 0;
	}

	/* Assistant text */
	.assistant-text {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		padding: 5px 8px;
		background: var(--assistant-bg);
		border-radius: 5px;
		border: 1px solid var(--assistant-border);
		font-size: 11px;
	}
	.assistant-body {
		color: var(--text);
		line-height: 1.5;
		word-break: break-word;
		flex: 1;
		font-size: 13px;
	}
	.assistant-body :global(strong) {
		font-weight: 600;
		color: #111;
	}
	.assistant-body :global(code) {
		font-family: 'SF Mono', 'Menlo', monospace;
		font-size: 10px;
		background: #f3f4f6;
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
		color: #9ca3af;
	}

	.duration {
		font-size: 10px;
		color: #9ca3af;
		background: #f3f4f6;
		padding: 1px 5px;
		border-radius: 3px;
		margin-left: auto;
		flex-shrink: 0;
		font-family: 'SF Mono', 'Menlo', monospace;
	}

	.queue-status {
		padding: 6px 10px;
		font-size: 11px;
		color: var(--accent);
		background: var(--accent-bg);
		border-radius: 5px;
		text-align: center;
	}
	.bouncing-atom {
		display: flex;
		justify-content: center;
		padding: 8px;
		color: var(--accent);
		animation: bounce 1s ease-in-out infinite;
	}
	@keyframes bounce {
		0%, 100% { transform: translateY(0); }
		50% { transform: translateY(-4px); }
	}

	.tool-call.subagent {
		margin-left: 12px;
		border-left: 2px solid var(--accent-light);
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
	.elapsed-footer {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 10px 12px;
		font-size: 13px;
		color: #10b981;
		border-top: 1px solid var(--border-light);
	}
	.elapsed-footer .elapsed-time {
		margin-left: auto;
		color: var(--text-faint);
		font-size: 12px;
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
		margin-left: auto;
		color: var(--text-faint);
		font-size: 11px;
	}
</style>
