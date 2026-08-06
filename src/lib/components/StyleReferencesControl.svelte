<script lang="ts">
	import { BookOpen } from 'lucide-svelte';

	interface Props {
		hasReferences: boolean;
		hasSkill: boolean;
		analyzing: boolean;
		failed: boolean;
		stale: boolean;
		unresolved: number;
		onclick: () => void;
	}

	let {
		hasReferences,
		hasSkill,
		analyzing,
		failed,
		stale,
		unresolved,
		onclick
	}: Props = $props();

	const label = $derived.by(() => {
		if (analyzing) return 'Analyzing references';
		if (failed) return 'Analysis failed';
		if (!hasReferences) return 'References not provided';
		if (!hasSkill) return 'Calibrate references';
		if (unresolved > 0) return `Style active · ${unresolved} choices`;
		if (stale) return 'Update style';
		return 'Style active';
	});
</script>

<button
	class="style-pill"
	class:warn={!hasReferences || failed || stale}
	class:busy={analyzing}
	class:active={hasSkill && !failed}
	{onclick}
	title="Writing references and author style"
	type="button"
>
	<BookOpen size={13} strokeWidth={2} />
	<span>{label}</span>
</button>

<style>
	.style-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		height: 28px;
		padding: 0 0.65rem;
		border-radius: 6px;
		border: 1px solid var(--border, #e5e5e5);
		background: var(--bg-elevated, #fff);
		color: var(--text-secondary, #555);
		font-size: 12px;
		font-family: inherit;
		cursor: pointer;
		white-space: nowrap;
	}
	.style-pill:hover {
		border-color: var(--border-strong, #ccc);
		color: var(--text, #222);
	}
	.style-pill.active {
		border-color: color-mix(in srgb, #2f6f4e 35%, var(--border, #e5e5e5));
		color: #2f6f4e;
	}
	.style-pill.warn {
		border-color: color-mix(in srgb, #a15c2d 40%, var(--border, #e5e5e5));
		color: #8a4b1f;
	}
	.style-pill.busy {
		opacity: 0.75;
	}
</style>
