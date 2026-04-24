<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { AlertTriangle } from 'lucide-svelte';
	import { dialogQueue, resolveDialog, type DialogSpec } from '$lib/dialogs';

	let queue = $state<DialogSpec[]>([]);
	dialogQueue.subscribe((v) => (queue = v));

	let active = $derived<DialogSpec | null>(queue[0] ?? null);

	let confirmBtn: HTMLButtonElement | null = $state(null);
	$effect(() => {
		if (active) {
			requestAnimationFrame(() => confirmBtn?.focus());
		}
	});

	function onConfirm() {
		if (!active) return;
		resolveDialog(active.id, true);
	}

	function onCancel() {
		if (!active) return;
		resolveDialog(active.id, false);
	}

	function onKeydown(e: KeyboardEvent) {
		if (!active) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			// Alert-style dialogs (no cancel) resolve true on Escape — the
			// user is just dismissing the notice.
			resolveDialog(active.id, !active.cancelLabel);
		} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !active.cancelLabel)) {
			e.preventDefault();
			resolveDialog(active.id, true);
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if active}
	<div class="dialog-backdrop" transition:fade={{ duration: 120 }}>
		<div
			class="dialog"
			role="alertdialog"
			aria-modal="true"
			aria-labelledby={active.title ? 'dialog-title' : undefined}
			transition:fly={{ y: 14, duration: 180, easing: cubicOut }}
		>
			<div class="dialog-header">
				{#if active.danger}
					<AlertTriangle size={14} />
				{/if}
				<span id="dialog-title">{active.title ?? (active.danger ? 'Confirm' : 'Notice')}</span>
			</div>
			<div class="dialog-body">
				{active.message}
			</div>
			<div class="dialog-footer">
				{#if active.cancelLabel}
					<button class="btn-secondary" onclick={onCancel}>{active.cancelLabel}</button>
				{/if}
				<button
					bind:this={confirmBtn}
					class="btn-primary"
					class:danger={active.danger}
					onclick={onConfirm}
				>
					{active.confirmLabel ?? 'OK'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.dialog-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(15, 15, 20, 0.28);
		backdrop-filter: blur(2px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 210;
		padding: 24px;
	}
	.dialog {
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 10px;
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.2), 0 4px 12px rgba(0, 0, 0, 0.08);
		width: min(440px, 100%);
		display: flex;
		flex-direction: column;
		font-family: 'Inter', -apple-system, sans-serif;
		color: var(--text);
	}
	.dialog-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border-light);
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.dialog-body {
		padding: 14px 16px;
		font-size: 13px;
		line-height: 1.55;
		white-space: pre-wrap;
	}
	.dialog-footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 10px 16px;
		border-top: 1px solid var(--border-light);
	}
	.btn-primary,
	.btn-secondary {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 6px 14px;
		font-family: inherit;
		font-size: 12.5px;
		font-weight: 500;
		border-radius: 5px;
		cursor: pointer;
	}
	.btn-primary {
		background: var(--accent);
		color: white;
		border: 1px solid var(--accent);
	}
	.btn-primary:hover {
		filter: brightness(0.94);
	}
	.btn-primary.danger {
		background: #c53030;
		border-color: #c53030;
	}
	.btn-primary.danger:hover {
		filter: brightness(0.94);
	}
	.btn-secondary {
		background: var(--bg-surface);
		color: var(--text);
		border: 1px solid var(--border-light);
	}
	.btn-secondary:hover {
		background: var(--bg);
	}
</style>
