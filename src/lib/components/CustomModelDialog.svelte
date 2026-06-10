<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	interface Props {
		open: boolean;
		provider: string;
		/** Suggestions to show as a datalist (e.g. the provider's known models). */
		suggestions?: string[];
		onSubmit: (id: string) => void;
		onClose: () => void;
	}
	let { open, provider, suggestions = [], onSubmit, onClose }: Props = $props();

	let value = $state('');
	let inputEl: HTMLInputElement | null = $state(null);

	// Focus + clear whenever the dialog opens.
	$effect(() => {
		if (open) {
			value = '';
			requestAnimationFrame(() => inputEl?.focus());
		}
	});

	const placeholder = $derived(
		provider === 'openai'
			? 'e.g. gpt-5.5, gpt-5.4-mini'
			: provider === 'codex'
				? 'e.g. gpt-5.5, gpt-5.3-codex'
			: provider === 'claude'
				? 'e.g. claude-opus-4-8, claude-sonnet-4-6'
				: provider === 'cursor'
					? 'e.g. composer-2.5'
					: 'e.g. ollama/llama3.1'
	);

	function submit() {
		const id = value.trim();
		if (!id) return;
		onSubmit(id);
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			submit();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="dialog-backdrop" role="presentation" transition:fade={{ duration: 120 }} onclick={onClose}>
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
		<div
			class="dialog"
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-labelledby="custom-model-title"
			transition:fly={{ y: 14, duration: 180, easing: cubicOut }}
			onclick={(e) => e.stopPropagation()}
		>
			<div class="dialog-header">
				<span id="custom-model-title">Custom model</span>
			</div>
			<div class="dialog-body">
				<p class="hint">
					Enter a model ID for the <strong>{provider}</strong> provider. It’s added to the menu and selected.
				</p>
				<input
					bind:this={inputEl}
					bind:value
					{placeholder}
					list="custom-model-suggestions"
					autocomplete="off"
					spellcheck="false"
				/>
				{#if suggestions.length}
					<datalist id="custom-model-suggestions">
						{#each suggestions as s}
							<option value={s}></option>
						{/each}
					</datalist>
				{/if}
			</div>
			<div class="dialog-footer">
				<button class="btn-secondary" onclick={onClose}>Cancel</button>
				<button class="btn-primary" disabled={!value.trim()} onclick={submit}>Use model</button>
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
		z-index: 220;
		padding: 16px;
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
	}
	.hint {
		margin: 0 0 10px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-muted);
	}
	.dialog-body input {
		width: 100%;
		box-sizing: border-box;
		font-family: ui-monospace, monospace;
		font-size: 13px;
		padding: 9px 11px;
		border: 1px solid var(--border-light);
		border-radius: 7px;
		background: var(--bg-surface);
		color: var(--text);
	}
	.dialog-body input:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
	}
	.dialog-footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 10px 16px;
		border-top: 1px solid var(--border-light);
	}
	.btn-secondary,
	.btn-primary {
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 13px;
		font-weight: 600;
		padding: 7px 14px;
		border-radius: 7px;
		cursor: pointer;
		border: 1px solid transparent;
	}
	.btn-secondary {
		background: var(--bg-surface);
		border-color: var(--border-light);
		color: var(--text-secondary);
	}
	.btn-secondary:hover {
		background: var(--bg-elevated);
	}
	.btn-primary {
		background: var(--accent);
		color: white;
	}
	.btn-primary:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
