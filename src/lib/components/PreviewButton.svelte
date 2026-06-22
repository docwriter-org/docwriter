<script lang="ts">
	import { onMount } from 'svelte';
	import { Columns2, ExternalLink } from 'lucide-svelte';
	import { selectedTheme } from '$lib/stores';

	/**
	 * Top-right floating preview button. On click, opens /preview in a
	 * popup window pointed at the companion PDF for a `.tex` tab (same stem,
	 * e.g. `main.tex` → `main.pdf`) or at a hook's configured output.
	 *
	 * Resolves the output via /api/hooks/preview-match. If no companion
	 * PDF or hook output matches, the button is hidden.
	 */
	interface Props {
		activeTabPath: string | null;
		onOpenSplit?: (path: string) => void;
		splitOpen?: boolean;
	}
	let { activeTabPath, onOpenSplit, splitOpen = false }: Props = $props();

	let outputPath = $state<string | null>(null);

	async function refresh() {
		if (!activeTabPath) {
			outputPath = null;
			return;
		}
		try {
			const res = await fetch(
				`/api/hooks/preview-match?file=${encodeURIComponent(activeTabPath)}`
			);
			if (!res.ok) {
				outputPath = null;
				return;
			}
			const data = await res.json();
			outputPath = typeof data?.outputPath === 'string' ? data.outputPath : null;
		} catch {
			outputPath = null;
		}
	}

	onMount(() => {
		void refresh();
		let es: EventSource | null = null;
		try {
			es = new EventSource('/api/live');
			es.addEventListener('preview_ready', () => void refresh());
			es.addEventListener('reload', () => void refresh());
		} catch {
			es = null;
		}
		return () => {
			es?.close();
		};
	});

	// Re-resolve whenever the active tab changes.
	$effect(() => {
		void activeTabPath;
		void refresh();
	});

	let theme = $state('light');
	selectedTheme.subscribe((v) => (theme = v));

	function openPreview() {
		if (!outputPath) return;
		const url = `/preview?path=${encodeURIComponent(outputPath)}&theme=${encodeURIComponent(theme)}`;
		window.open(url, 'docwriter-preview', 'width=900,height=1200,resizable=yes,scrollbars=yes');
	}
</script>

{#if outputPath}
	<div class="preview-control" class:with-split={!!onOpenSplit}>
		<button class="preview-btn" onclick={openPreview} title={`Open preview window: ${outputPath.split('/').pop()}`}>
			<ExternalLink size={12} />
			<span>Preview window</span>
		</button>
		{#if onOpenSplit}
			<button
				class="preview-btn icon-only"
				class:active={splitOpen}
				onclick={() => {
					if (outputPath) onOpenSplit?.(outputPath);
				}}
				title={`Open side preview: ${outputPath.split('/').pop()}`}
				aria-label="Open side preview"
			>
				<Columns2 size={13} />
			</button>
		{/if}
	</div>
{/if}

<style>
	/* Pinned top-right of the editor host, just to the left of where
	 * the FindBar lives so they don't collide when find is open. The
	 * FindBar wins the corner when both are visible. */
	.preview-control {
		position: absolute;
		top: 12px;
		right: 16px;
		z-index: 11;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.preview-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		height: 26px;
		padding: 0 10px 0 8px;
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		white-space: nowrap;
		color: var(--text-faint);
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 8px;
		cursor: pointer;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
		transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
	}
	.preview-btn:hover {
		color: var(--text);
		background: var(--bg-hover);
		border-color: var(--border);
	}
	.preview-btn.icon-only {
		width: 28px;
		padding: 0;
	}
	.preview-btn.active {
		color: var(--accent);
		background: var(--accent-bg);
		border-color: var(--accent-light);
	}
</style>
