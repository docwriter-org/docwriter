<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import ReviewerMascot from './ReviewerMascot.svelte';
	import { REVIEWER_ICONS, REVIEWER_COLORS, type Reviewer } from '$lib/shared/reviewers';
	import { isModEnter } from '$lib/keyboard';

	interface Props {
		open: boolean;
		onClose: () => void;
		onCreated: (reviewer: Reviewer) => void;
	}
	let { open, onClose, onCreated }: Props = $props();

	let name = $state('');
	let icon = $state<string>('owl');
	let color = $state<string>(REVIEWER_COLORS[0]);
	let prompt = $state('');
	let saving = $state(false);
	let saveError = $state('');

	let canSave = $derived(!saving && name.trim().length > 0 && prompt.trim().length > 0);

	function reset() {
		name = '';
		icon = 'owl';
		color = REVIEWER_COLORS[0];
		prompt = '';
		saving = false;
		saveError = '';
	}

	function close() {
		reset();
		onClose();
	}

	async function save() {
		if (!canSave) return;
		saving = true;
		saveError = '';
		try {
			const res = await fetch('/api/reviewers', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: name.trim(), icon, color, prompt: prompt.trim() })
			});
			if (!res.ok) {
				const detail = await res.json().catch(() => null);
				throw new Error(detail?.message ?? `Save failed (${res.status})`);
			}
			const { reviewer } = (await res.json()) as { reviewer: Reviewer };
			onCreated(reviewer);
			reset();
			onClose();
		} catch (e) {
			saveError = e instanceof Error ? e.message : String(e);
			saving = false;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
		} else if (isModEnter(e)) {
			e.preventDefault();
			void save();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div class="backdrop" transition:fade={{ duration: 120 }}>
		<div
			class="dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="reviewer-dialog-title"
			transition:fly={{ y: 14, duration: 180, easing: cubicOut }}
		>
			<div class="dialog-header">
				<span id="reviewer-dialog-title">New reviewer</span>
			</div>
			<div class="dialog-body">
				<label class="field">
					<span class="field-label">Name</span>
					<!-- svelte-ignore a11y_autofocus -->
					<input type="text" bind:value={name} placeholder="Reviewer #2" autofocus />
				</label>

				<div class="field">
					<span class="field-label">Mascot</span>
					<div class="mascot-row">
						<div class="icons">
							{#each REVIEWER_ICONS as ic (ic)}
								<button
									type="button"
									class="icon-opt"
									class:selected={icon === ic}
									style:color={icon === ic ? color : undefined}
									aria-label={ic}
									aria-pressed={icon === ic}
									onclick={() => (icon = ic)}
								>
									<ReviewerMascot icon={ic} size={17} />
								</button>
							{/each}
						</div>
						<div class="swatches">
							{#each REVIEWER_COLORS as c (c)}
								<button
									type="button"
									class="swatch"
									class:selected={color === c}
									style:background={c}
									aria-label="Color {c}"
									aria-pressed={color === c}
									onclick={() => (color = c)}
								></button>
							{/each}
						</div>
					</div>
				</div>

				<label class="field">
					<span class="field-label">Prompt</span>
					<textarea
						bind:value={prompt}
						rows="7"
						placeholder="You are Reviewer #2, the peer reviewer every author dreads. For every claim, ask where the evidence is…"
					></textarea>
					<span class="field-hint">This is the system prompt for the reviewer agent.</span>
				</label>

				{#if saveError}
					<div class="save-error">{saveError}</div>
				{/if}
			</div>
			<div class="dialog-footer">
				<button class="btn" onclick={close}>Cancel</button>
				<button class="btn primary" disabled={!canSave} onclick={() => void save()}>
					{saving ? 'Saving…' : 'Save'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(15, 15, 20, 0.28);
		backdrop-filter: blur(2px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 210;
		padding: 16px;
	}
	.dialog {
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 10px;
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.2), 0 4px 12px rgba(0, 0, 0, 0.08);
		width: min(480px, 100%);
		display: flex;
		flex-direction: column;
		font-family: 'Inter', -apple-system, sans-serif;
		color: var(--text);
	}
	.dialog-header {
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
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.field-label {
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	input[type='text'],
	textarea {
		font-family: inherit;
		font-size: 13px;
		color: var(--text);
		background: var(--bg);
		border: 1px solid var(--border-light);
		border-radius: 7px;
		padding: 7px 10px;
	}
	textarea {
		resize: vertical;
		line-height: 1.55;
		min-height: 110px;
	}
	input:focus,
	textarea:focus {
		outline: none;
		border-color: var(--accent);
	}
	.field-hint {
		font-size: 11.5px;
		color: var(--text-muted);
	}
	.mascot-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.icons {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.icon-opt {
		width: 32px;
		height: 32px;
		border-radius: 999px;
		border: 1.5px solid var(--border-light);
		background: var(--bg);
		color: var(--text-muted);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}
	.icon-opt:hover {
		border-color: var(--border);
	}
	.icon-opt.selected {
		border-color: currentColor;
		box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 18%, transparent);
	}
	.swatches {
		display: flex;
		gap: 6px;
		padding-left: 10px;
		border-left: 1px solid var(--border-light);
	}
	.swatch {
		width: 16px;
		height: 16px;
		border-radius: 999px;
		border: none;
		cursor: pointer;
	}
	.swatch.selected {
		box-shadow: 0 0 0 2px var(--bg-elevated), 0 0 0 3.5px var(--text-faint);
	}
	.save-error {
		font-size: 12px;
		color: var(--diff-removed-color);
	}
	.dialog-footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 10px 16px;
		border-top: 1px solid var(--border-light);
	}
	.btn {
		font-family: inherit;
		font-size: 12.5px;
		font-weight: 500;
		padding: 6px 14px;
		border-radius: 7px;
		border: 1px solid var(--border-light);
		background: var(--bg-elevated);
		color: var(--text-secondary);
		cursor: pointer;
	}
	.btn:hover {
		background: var(--bg-hover);
	}
	.btn.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.btn.primary:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
