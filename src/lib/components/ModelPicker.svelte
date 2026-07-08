<script lang="ts">
	import { Check, ChevronDown } from 'lucide-svelte';
	import type { ModelOption, ProviderOption } from '$lib/stores';

	interface Props {
		providers: ProviderOption[];
		currentProvider: string;
		onSelectProvider: (id: string) => void;
		/** Models already filtered to the current provider. */
		models: ModelOption[];
		currentModel: string;
		onSelectModel: (id: string) => void;
		/** Open the custom-model dialog. */
		onCustomModel: () => void;
	}
	let {
		providers,
		currentProvider,
		onSelectProvider,
		models,
		currentModel,
		onSelectModel,
		onCustomModel
	}: Props = $props();

	/** Which pill's dropdown is open, if any. */
	let open = $state<'provider' | 'model' | null>(null);
	let rootEl: HTMLDivElement | null = $state(null);
	let filter = $state('');
	let filterEl: HTMLInputElement | null = $state(null);

	const providerLabel = $derived(
		providers.find((p) => p.id === currentProvider)?.label ?? currentProvider
	);

	// Match by full id (labels can collide across providers, e.g. "GPT-5.4").
	const modelLabel = $derived(
		models.find((m) => m.id === currentModel)?.label ?? currentModel
	);

	const filteredModels = $derived(
		filter.trim()
			? models.filter((m) => {
					const q = filter.trim().toLowerCase();
					return m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
				})
			: models
	);

	function toggle(which: 'provider' | 'model') {
		open = open === which ? null : which;
		if (open === 'model') {
			filter = '';
			// Focus the filter box once it's mounted.
			queueMicrotask(() => filterEl?.focus());
		}
	}

	function closeAll() {
		open = null;
	}

	function pickProvider(id: string) {
		onSelectProvider(id);
		closeAll();
	}

	function pickModel(id: string) {
		onSelectModel(id);
		closeAll();
	}

	// Close on outside click / Escape.
	$effect(() => {
		if (open === null) return;
		function onDown(e: MouseEvent) {
			if (rootEl && !rootEl.contains(e.target as Node)) closeAll();
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') closeAll();
		}
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	});
</script>

<div class="model-picker" bind:this={rootEl}>
	<!-- Provider pill -->
	<div class="pill-wrap">
		<button
			class="pill"
			class:open={open === 'provider'}
			onclick={() => toggle('provider')}
			aria-haspopup="menu"
			aria-expanded={open === 'provider'}
			title="Provider"
		>
			<span class="pill-dot" aria-hidden="true"></span>
			<span class="pill-label">{providerLabel}</span>
			<ChevronDown size={13} class="pill-caret" />
		</button>

		{#if open === 'provider'}
			<div class="dropdown" role="menu">
				{#each providers as p (p.id)}
					<button class="row" role="menuitem" onclick={() => pickProvider(p.id)}>
						<span class="row-check">
							{#if p.id === currentProvider}<Check size={12} strokeWidth={2.5} />{/if}
						</span>
						<span class="row-label">{p.label}</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Model pill -->
	<div class="pill-wrap">
		<button
			class="pill"
			class:open={open === 'model'}
			onclick={() => toggle('model')}
			aria-haspopup="menu"
			aria-expanded={open === 'model'}
			title="Model"
		>
			<span class="pill-label">{modelLabel}</span>
			<ChevronDown size={13} class="pill-caret" />
		</button>

		{#if open === 'model'}
			<div class="dropdown model-dropdown" role="menu">
				<div class="filter-wrap">
					<input
						bind:this={filterEl}
						bind:value={filter}
						class="filter"
						type="text"
						placeholder="Search models…"
						spellcheck="false"
						autocomplete="off"
					/>
				</div>
				<div class="rows">
					{#each filteredModels as m (m.id)}
						<button class="row" role="menuitem" onclick={() => pickModel(m.id)}>
							<span class="row-check">
								{#if m.id === currentModel}<Check size={12} strokeWidth={2.5} />{/if}
							</span>
							<span class="row-label">{m.label}</span>
						</button>
					{/each}
					{#if filteredModels.length === 0}
						<div class="empty">No models match “{filter.trim()}”</div>
					{/if}
				</div>
				<div class="divider" role="separator"></div>
				<button
					class="row"
					role="menuitem"
					onclick={() => {
						closeAll();
						onCustomModel();
					}}
				>
					<span class="row-check"></span>
					<span class="row-label">Custom model…</span>
				</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.model-picker {
		display: flex;
		align-items: center;
		gap: 6px;
		font-family: 'Inter', -apple-system, sans-serif;
	}
	.pill-wrap {
		position: relative;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: inherit;
		font-size: 12.5px;
		color: var(--text-secondary);
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		padding: 4px 8px 4px 10px;
		border-radius: 999px;
		cursor: pointer;
		line-height: 1.2;
		max-width: 220px;
		white-space: nowrap;
	}
	.pill:hover,
	.pill.open {
		background: var(--bg-hover);
		color: var(--text);
		border-color: var(--border);
	}
	.pill-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		flex-shrink: 0;
	}
	.pill-label {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pill :global(.pill-caret) {
		color: var(--text-faint);
		flex-shrink: 0;
	}
	.dropdown {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		min-width: 200px;
		max-width: 280px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1), 0 2px 4px rgba(0, 0, 0, 0.04);
		padding: 4px;
		z-index: 200;
		font-size: 13px;
	}
	.model-dropdown {
		min-width: 240px;
	}
	.filter-wrap {
		padding: 2px 2px 4px;
	}
	.filter {
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		font-size: 12.5px;
		color: var(--text);
		background: var(--bg-surface);
		border: 1px solid var(--border-light);
		border-radius: 5px;
		padding: 5px 8px;
		outline: none;
	}
	.filter:focus {
		border-color: var(--accent);
	}
	.filter::placeholder {
		color: var(--text-faint);
	}
	.rows {
		max-height: 320px;
		overflow-y: auto;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 10px 6px 6px;
		border: none;
		background: none;
		font: inherit;
		color: var(--text);
		text-align: left;
		cursor: pointer;
		border-radius: 4px;
		line-height: 1.35;
		white-space: nowrap;
		box-sizing: border-box;
	}
	.row:hover {
		background: var(--bg-hover);
	}
	.row-check {
		width: 12px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--accent);
		flex-shrink: 0;
	}
	.row-label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.divider {
		height: 1px;
		background: var(--border-light);
		margin: 3px 0;
	}
	.empty {
		padding: 8px 10px;
		color: var(--text-faint);
		font-size: 12.5px;
	}
</style>
