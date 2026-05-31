<script lang="ts">
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { Check, X, Sparkles, Terminal } from 'lucide-svelte';
	import { toastQueue, type ToastSpec } from '$lib/toasts';

	interface Props {
		/** Accept the proposal this toast represents. */
		onAccept: (toast: ToastSpec) => void;
		/** Reject / dismiss the proposal this toast represents. */
		onDismiss: (toast: ToastSpec) => void;
	}
	let { onAccept, onDismiss }: Props = $props();

	let toasts = $state<ToastSpec[]>([]);
	toastQueue.subscribe((v) => (toasts = v));
</script>

{#if toasts.length > 0}
	<div class="toast-stack" role="region" aria-label="Agent proposals">
		{#each toasts as toast (toast.id)}
			<div class="toast" transition:fly={{ x: 16, duration: 220, easing: cubicOut }}>
				<div class="toast-header">
					<span class="toast-avatar">
						{#if toast.kind === 'rule'}
							<Sparkles size={12} strokeWidth={1.9} />
						{:else}
							<Terminal size={12} strokeWidth={1.9} />
						{/if}
					</span>
					<span class="toast-kicker">Proposed {toast.kind}</span>
				</div>
				<div class="toast-body">{toast.body}</div>
				<div class="toast-footer">
					<button class="toast-btn dismiss" onclick={() => onDismiss(toast)}>
						<X size={12} /> Dismiss
					</button>
					<button class="toast-btn accept" onclick={() => onAccept(toast)}>
						<Check size={12} /> Accept
					</button>
				</div>
			</div>
		{/each}
	</div>
{/if}

<style>
	/* Sits at the top of the right gutter (below the header), styled to match
	 * the gutter's comment/edit cards rather than a heavy floating popover. */
	.toast-stack {
		position: fixed;
		top: 92px;
		right: 32px;
		z-index: 140;
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 280px;
		max-width: calc(100vw - 48px);
		font-family: 'Inter', -apple-system, sans-serif;
		pointer-events: none;
	}
	.toast {
		pointer-events: auto;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 10px;
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
		display: flex;
		flex-direction: column;
		color: var(--text);
		overflow: hidden;
	}
	.toast-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 11px 6px;
	}
	.toast-avatar {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: color-mix(in srgb, var(--accent) 16%, transparent);
		color: var(--accent);
	}
	.toast-kicker {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.toast-body {
		padding: 0 11px 10px;
		font-size: 12.5px;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.toast-footer {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
		padding: 8px 11px;
		border-top: 1px solid var(--border-light);
	}
	.toast-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 10px;
		border-radius: 5px;
		border: 1px solid var(--border-light);
		background: var(--bg-surface);
		color: var(--text);
		font-size: 11.5px;
		font-weight: 500;
		cursor: pointer;
	}
	.toast-btn:hover {
		background: var(--bg-hover, rgba(0, 0, 0, 0.04));
	}
	.toast-btn.accept {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.toast-btn.accept:hover {
		filter: brightness(1.05);
	}
</style>
