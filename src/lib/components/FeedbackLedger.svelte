<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Check, Edit3, HelpCircle, Circle, X } from 'lucide-svelte';
	import type { FeedbackImportState } from '$lib/types';

	interface Props {
		onOpenThread?: (threadId: string) => void;
		onDismiss?: () => void;
	}
	let { onOpenThread, onDismiss }: Props = $props();

	let importState = $state<FeedbackImportState | null>(null);
	let pollInterval: ReturnType<typeof setInterval> | undefined;

	async function fetchState() {
		try {
			const res = await fetch('/api/feedback-import');
			const data = await res.json();
			importState = data.import ?? null;
		} catch {
			/* ignore */
		}
	}

	onMount(() => {
		void fetchState();
		pollInterval = setInterval(fetchState, 2000);
	});

	onDestroy(() => {
		if (pollInterval) clearInterval(pollInterval);
	});

	let counts = $derived.by(() => {
		if (!importState) return null;
		const d = importState.dispositions;
		let applied = 0,
			discussed = 0,
			deferred = 0,
			untouched = 0;
		for (const v of Object.values(d)) {
			if (v === 'applied') applied++;
			else if (v === 'discussed') discussed++;
			else if (v === 'deferred') deferred++;
			else untouched++;
		}
		return {
			total: importState.comments.length,
			applied,
			discussed,
			deferred,
			untouched,
			addressed: applied + discussed + deferred
		};
	});

	async function dismiss() {
		await fetch('/api/feedback-import', { method: 'DELETE' });
		importState = null;
		onDismiss?.();
	}
</script>

{#if importState && counts}
	<div class="ledger">
		<div class="ledger-header">
			<span class="title">Feedback coverage</span>
			<button class="dismiss-btn" onclick={dismiss}><X size={12} /></button>
		</div>
		<div class="summary">
			{counts.addressed} of {counts.total} addressed
			{#if counts.untouched > 0}
				<span class="untouched-badge">{counts.untouched} remaining</span>
			{/if}
		</div>
		<div class="progress-bar">
			<div
				class="progress-fill"
				style:width={`${(counts.addressed / counts.total) * 100}%`}
			></div>
		</div>
		<div class="comment-rows">
			{#each importState.comments as c (c.id)}
				{@const disposition = importState.dispositions[c.id] ?? 'untouched'}
				{@const threadId = importState.commentToThread[c.id]}
				<button
					class="comment-row"
					class:clickable={!!threadId}
					onclick={() => threadId && onOpenThread?.(threadId)}
				>
					<span class="disposition-icon">
						{#if disposition === 'applied'}
							<Check size={12} />
						{:else if disposition === 'discussed'}
							<Edit3 size={12} />
						{:else if disposition === 'deferred'}
							<HelpCircle size={12} />
						{:else}
							<Circle size={12} />
						{/if}
					</span>
					<span class="row-author">{c.author}</span>
					<span class="row-text">{c.text.length > 50 ? c.text.slice(0, 47) + '...' : c.text}</span>
				</button>
			{/each}
		</div>
	</div>
{/if}

<style>
	.ledger {
		padding: 10px 12px;
		border-bottom: 1px solid var(--border-light);
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 12px;
	}
	.ledger-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 6px;
	}
	.title {
		font-weight: 600;
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
	}
	.dismiss-btn {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 2px;
		border-radius: 3px;
	}
	.dismiss-btn:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.summary {
		color: var(--text-secondary);
		margin-bottom: 6px;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.untouched-badge {
		font-size: 10px;
		background: var(--bg);
		border: 1px solid var(--border-light);
		border-radius: 8px;
		padding: 1px 6px;
		color: var(--text-muted);
	}
	.progress-bar {
		height: 4px;
		background: var(--bg);
		border-radius: 2px;
		overflow: hidden;
		margin-bottom: 8px;
	}
	.progress-fill {
		height: 100%;
		background: var(--accent);
		border-radius: 2px;
		transition: width 0.3s ease;
	}
	.comment-rows {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 160px;
		overflow-y: auto;
	}
	.comment-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 6px;
		border-radius: 4px;
		background: none;
		border: none;
		font: inherit;
		font-size: 11.5px;
		color: var(--text-secondary);
		text-align: left;
		cursor: default;
		width: 100%;
	}
	.comment-row.clickable {
		cursor: pointer;
	}
	.comment-row.clickable:hover {
		background: var(--bg-hover);
	}
	.disposition-icon {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		color: var(--text-muted);
	}
	.row-author {
		font-weight: 600;
		font-size: 10px;
		color: var(--text-faint);
		text-transform: uppercase;
		flex-shrink: 0;
	}
	.row-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
