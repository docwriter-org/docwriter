<script lang="ts">
	import { onMount } from 'svelte';
	import { Eye } from 'lucide-svelte';
	import { selectedTheme } from '$lib/stores';

	/**
	 * Top-right floating preview button. On click, opens /preview in a
	 * popup window pointed at whatever output file the matching hook
	 * produces for the active tab.
	 *
	 * Resolves the output via /api/hooks/preview-match. If no hook with
	 * an `output` template matches the active tab, the button is hidden
	 * — no point showing an inert control.
	 */
	interface Props {
		activeTabPath: string | null;
	}
	let { activeTabPath }: Props = $props();

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

	onMount(refresh);

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
	<button class="preview-btn" onclick={openPreview} title={`Open preview: ${outputPath.split('/').pop()}`}>
		<Eye size={12} />
		<span>Preview</span>
	</button>
{/if}

<style>
	/* Pinned top-right of the editor host, just to the left of where
	 * the FindBar lives so they don't collide when find is open. The
	 * FindBar wins the corner when both are visible. */
	.preview-btn {
		position: absolute;
		top: 12px;
		right: 16px;
		z-index: 11;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 26px;
		padding: 0 10px 0 8px;
		font: inherit;
		font-size: 12px;
		font-weight: 500;
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
</style>
