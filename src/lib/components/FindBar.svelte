<script lang="ts">
	import { onMount } from 'svelte';
	import { Search, ChevronUp, ChevronDown, X, CaseSensitive } from 'lucide-svelte';
	import type { FindState } from '$lib/editor/find-overlay';

	interface Props {
		findState: FindState;
		onQueryChange: (query: string, caseSensitive: boolean) => void;
		onStep: (dir: 1 | -1) => void;
		onClose: () => void;
	}
	let { findState, onQueryChange, onStep, onClose }: Props = $props();

	let inputEl: HTMLInputElement | null = $state(null);
	// Local mirrors of the prop fields. Initialized empty; the $effect
	// below pulls in the parent's current values on mount and on every
	// prop change (parent re-opens the bar with a fresh state, e.g.
	// after a tab switch).
	let query = $state('');
	let caseSensitive = $state(false);
	$effect(() => {
		query = findState.query;
		caseSensitive = findState.caseSensitive;
	});

	onMount(() => {
		// Focus + select on open so the user can type immediately or paste
		// over an existing query.
		requestAnimationFrame(() => {
			inputEl?.focus();
			inputEl?.select();
		});
	});

	function commit() {
		onQueryChange(query, caseSensitive);
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
			return;
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			onStep(e.shiftKey ? -1 : 1);
			return;
		}
	}

	function toggleCase() {
		caseSensitive = !caseSensitive;
		commit();
	}

	let counter = $derived.by(() => {
		if (!findState.query) return '';
		if (findState.matches.length === 0) return 'no matches';
		const cur = findState.currentIdx >= 0 ? findState.currentIdx + 1 : 0;
		return `${cur} of ${findState.matches.length}`;
	});
</script>

<div class="find-bar" role="search">
	<Search size={12} class="find-icon" />
	<input
		bind:this={inputEl}
		type="text"
		placeholder="Find in document"
		bind:value={query}
		oninput={commit}
		onkeydown={onKey}
		spellcheck="false"
		autocomplete="off"
	/>
	<span class="counter" class:dim={!findState.query || findState.matches.length === 0}>{counter}</span>
	<button
		type="button"
		class="case-btn"
		class:active={caseSensitive}
		onclick={toggleCase}
		title="Match case"
		aria-pressed={caseSensitive}
	>
		<CaseSensitive size={12} />
	</button>
	<div class="step-group">
		<button
			type="button"
			class="step-btn"
			onclick={() => onStep(-1)}
			disabled={findState.matches.length === 0}
			title="Previous match (Shift+Enter)"
			aria-label="Previous match"
		>
			<ChevronUp size={12} />
		</button>
		<button
			type="button"
			class="step-btn"
			onclick={() => onStep(1)}
			disabled={findState.matches.length === 0}
			title="Next match (Enter)"
			aria-label="Next match"
		>
			<ChevronDown size={12} />
		</button>
	</div>
	<button type="button" class="close-btn" onclick={onClose} title="Close (Esc)" aria-label="Close find">
		<X size={12} />
	</button>
</div>

<style>
	.find-bar {
		position: absolute;
		top: 12px;
		right: 16px;
		z-index: 12;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 6px 5px 10px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 8px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
		font-family: 'Inter', -apple-system, sans-serif;
		font-size: 12px;
		color: var(--text);
	}
	.find-bar :global(.find-icon) {
		color: var(--text-faint);
		flex-shrink: 0;
	}
	input {
		font: inherit;
		border: none;
		outline: none;
		background: transparent;
		color: var(--text);
		min-width: 200px;
		padding: 2px 0;
	}
	input::placeholder {
		color: var(--text-faint);
	}
	.counter {
		font-size: 10.5px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		min-width: 56px;
		text-align: right;
		padding-right: 2px;
	}
	.counter.dim {
		color: var(--text-faint);
	}
	.case-btn,
	.step-btn,
	.close-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 5px;
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
	}
	.case-btn:hover,
	.step-btn:hover:not(:disabled),
	.close-btn:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.case-btn.active {
		color: var(--text);
		background: var(--bg-hover);
		border-color: var(--border-light);
	}
	.step-btn:disabled {
		cursor: default;
		opacity: 0.35;
	}
	.step-group {
		display: inline-flex;
		gap: 1px;
	}
</style>
