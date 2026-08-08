<script lang="ts">
	import { onMount } from 'svelte';
	import { BookOpen, LoaderCircle, TriangleAlert } from 'lucide-svelte';
	import { tooltip } from '$lib/actions/tooltip';
	import type { StyleProfileSummary } from '$lib/style-profile';

	interface Props {
		onOpen: () => void;
		refreshToken?: number;
		/** Fired once when a running analysis finishes, whether or not the
		 *  dialog is open. The pill is the one thing that always polls, so it
		 *  is the one thing that reliably notices. */
		onAnalysisFinished?: (unresolvedCount: number) => void;
	}
	let { onOpen, refreshToken = 0, onAnalysisFinished }: Props = $props();
	let summary = $state<StyleProfileSummary | null>(null);
	let loading = $state(true);

	const label = $derived.by(() => {
		if (loading && !summary) return 'Checking references';
		if (!summary || summary.status === 'empty') return 'References not provided';
		if (summary.status === 'ready-to-analyze') return 'Analyze references';
		if (summary.status === 'analyzing') return 'Analyzing references';
		if (summary.status === 'stale') return 'Update style';
		if (summary.status === 'error') return 'Analysis failed';
		if (summary.status === 'needs-calibration' || summary.unresolvedCount > 0) return 'Calibrate references';
		if (summary.hasUnpublishedChanges) return 'Finalize style';
		// Outstanding choices are the dialog's business; the pill only reports
		// that a style is in force.
		return 'Style uploaded';
	});

	const tone = $derived.by(() => {
		if (!summary || ['empty', 'ready-to-analyze'].includes(summary.status)) return 'warning';
		if (summary.status === 'error') return 'error';
		if (summary.status === 'stale' || summary.status === 'needs-calibration' || summary.unresolvedCount > 0) {
			return 'pending';
		}
		if (summary.hasUnpublishedChanges) return 'pending';
		if (summary.status === 'analyzing') return 'working';
		return 'active';
	});

	const hint = $derived.by(() => {
		if (!summary || summary.status === 'empty') {
			return 'No writing references yet — the agent has nothing to learn your style from.\nClick to add some.';
		}
		if (summary.status === 'ready-to-analyze') {
			return 'References are added but not analyzed yet.\nClick to run the style analysis.';
		}
		if (summary.status === 'analyzing') return 'Measuring your references and drafting style guidance.';
		if (summary.status === 'error') return 'The last style analysis failed.\nClick to see what went wrong.';
		if (summary.status === 'stale') return 'Your references changed since the last analysis.\nClick to re-run it.';
		if (summary.status === 'needs-calibration' || summary.unresolvedCount > 0) {
			return 'A few style habits still need your pick between close passages.\nClick to finish calibrating.';
		}
		if (summary.hasUnpublishedChanges) {
			return 'Your reviewed style is saved as a draft.\nClick to finalize it for the writing agent.';
		}
		return 'Your author style is active and guiding the writing agent.';
	});

	async function load() {
		try {
			const response = await fetch('/api/style-profile');
			if (response.ok) {
				const next: StyleProfileSummary = await response.json();
				// Only a transition seen while mounted counts: a page opened
				// onto an already-finished pass should not announce it.
				if (summary?.status === 'analyzing' && next.status !== 'analyzing' && next.status !== 'error') {
					onAnalysisFinished?.(next.unresolvedCount);
				}
				summary = next;
			}
		} catch {
			// Keep the last known status while the local server reconnects.
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		refreshToken;
		void load();
	});

	onMount(() => {
		const interval = window.setInterval(load, 5000);
		window.addEventListener('focus', load);
		return () => {
			window.clearInterval(interval);
			window.removeEventListener('focus', load);
		};
	});
</script>

<button class="reference-pill {tone}" onclick={onOpen} use:tooltip={hint}>
	{#if tone === 'working'}
		<LoaderCircle size={12} class="pill-spinner" />
	{:else if tone === 'warning' || tone === 'error'}
		<TriangleAlert size={12} />
	{:else}
		<BookOpen size={12} />
	{/if}
	<span class="pill-label">{label}</span>
</button>

<style>
	/* Same shell as ModelPicker's .pill so the header reads as one row of
	 * controls — but unlike ModelPicker this control reports status, so the
	 * states that need the user to act (no references, failed analysis) tint
	 * the whole pill and carry a warning glyph. A bare colored dot was too
	 * easy to read as decoration. */
	.reference-pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 230px;
		padding: 4px 10px;
		border: 1px solid var(--border-light);
		border-radius: 999px;
		background: var(--bg-surface);
		color: var(--text-secondary);
		font: inherit;
		font-size: 12.5px;
		line-height: 1.2;
		white-space: nowrap;
		cursor: pointer;
	}
	.reference-pill:hover {
		background: var(--bg-hover);
		color: var(--text);
		border-color: var(--border);
	}
	.pill-label {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.reference-pill :global(svg) {
		flex-shrink: 0;
	}

	/* Needs the user's attention: nothing to learn from, or a failed run. */
	.reference-pill.warning,
	.reference-pill.error {
		font-weight: 500;
	}
	.reference-pill.warning {
		border-color: color-mix(in srgb, var(--feedback-border) 60%, var(--border-light));
		background: var(--feedback-bg);
		color: color-mix(in srgb, var(--feedback-border) 62%, var(--text));
	}
	.reference-pill.warning:hover {
		border-color: var(--feedback-border);
		background: color-mix(in srgb, var(--feedback-border) 14%, var(--feedback-bg));
		color: color-mix(in srgb, var(--feedback-border) 62%, var(--text));
	}
	.reference-pill.error {
		border-color: color-mix(in srgb, var(--diff-removed-color) 55%, var(--border-light));
		background: color-mix(in srgb, var(--diff-removed-color) 10%, var(--bg-surface));
		color: color-mix(in srgb, var(--diff-removed-color) 70%, var(--text));
	}
	.reference-pill.error:hover {
		border-color: var(--diff-removed-color);
		background: color-mix(in srgb, var(--diff-removed-color) 16%, var(--bg-surface));
		color: color-mix(in srgb, var(--diff-removed-color) 70%, var(--text));
	}
	/* Working as intended, with something optional left to do. */
	.reference-pill.pending {
		border-color: color-mix(in srgb, var(--accent) 45%, var(--border-light));
		background: var(--accent-bg);
		color: var(--accent-subject);
	}
	.reference-pill.pending:hover {
		border-color: var(--accent);
		background: var(--accent-bg);
		color: var(--accent-subject);
	}
	.reference-pill.active :global(svg) {
		color: var(--diff-added-color);
	}
	.reference-pill :global(.pill-spinner) {
		flex-shrink: 0;
		color: var(--accent);
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.reference-pill :global(.pill-spinner) {
			animation: none;
		}
	}
</style>
