<script lang="ts">
	import { Sparkles } from 'lucide-svelte';
	import { showAiProvenance } from '$lib/stores';

	/**
	 * Top-right sticky toggle for the AI-provenance view (next to the
	 * preview buttons). When on, agent-written text — tracked as the `ai`
	 * format attribute stamped at accept time — is colored in the editor,
	 * iA-Writer-authorship style: your words render normal, the AI's words
	 * render in the provenance color. Pure view state; toggling never
	 * touches the document.
	 */
</script>

<button
	class="ai-provenance-btn"
	class:active={$showAiProvenance}
	onclick={() => showAiProvenance.update((v) => !v)}
	title={$showAiProvenance
		? 'Hide AI authorship highlighting'
		: 'Show AI authorship: color text the AI wrote'}
	aria-label="Toggle AI authorship highlighting"
	aria-pressed={$showAiProvenance}
	type="button"
>
	<Sparkles size={12} />
	<span>AI text</span>
</button>

<style>
	/* Mirrors PreviewButton's .preview-btn so the top-right chrome cluster
	 * reads as one control group. */
	.ai-provenance-btn {
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
	.ai-provenance-btn:hover {
		color: var(--text);
		background: var(--bg-hover);
		border-color: var(--border);
	}
	.ai-provenance-btn.active {
		color: var(--ai-provenance, var(--accent));
		background: var(--accent-bg);
		border-color: var(--accent-light);
	}
</style>
