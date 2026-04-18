<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import type { Snippet } from 'svelte';
	import { annotate } from 'rough-notation';
	import type { RoughAnnotation, RoughAnnotationType } from 'rough-notation/lib/model';

	/**
	 * Svelte port of MagicUI's Highlighter
	 * (magicui.design/docs/components/highlighter). Same underlying lib
	 * (`rough-notation`), same hand-drawn marker aesthetic.
	 */
	interface Props {
		children: Snippet;
		active?: boolean;
		action?: RoughAnnotationType;
		/** CSS color. CSS vars are supported — we resolve them via
		 * getComputedStyle since rough-notation writes the color literally
		 * into the generated SVG. */
		color?: string;
		strokeWidth?: number;
		/** Number of marker passes. 2 gives a chunkier, more marker-like
		 * fill; 1 is a single thin stroke. */
		iterations?: number;
		/** Set true to animate the stroke being drawn. Default false —
		 * instant render, no perceived lag. */
		animate?: boolean;
		/** Animation duration in ms (only matters when `animate` is true). */
		duration?: number;
	}

	let {
		children,
		active = true,
		action = 'highlight',
		color = 'var(--accent)',
		strokeWidth = 1.5,
		iterations = 2,
		animate = false,
		duration = 800
	}: Props = $props();

	let wrapperEl: HTMLSpanElement | null = $state(null);
	let annotation: RoughAnnotation | null = null;

	function resolveColor(raw: string, el: HTMLElement): string {
		if (!raw.startsWith('var(')) return raw;
		const varName = raw.slice(4, raw.length - 1).split(',')[0].trim();
		const computed = getComputedStyle(el).getPropertyValue(varName).trim();
		return computed || '#7c3aed';
	}

	async function mount() {
		if (!active || !wrapperEl) return;
		// Wait for Svelte to flush the DOM so the wrapper has real bounds
		// before rough-notation measures it. Without this, wrappers inside
		// pending-card rows can render with width=0 and the SVG draws
		// offscreen.
		await tick();
		if (!wrapperEl) return;
		const resolvedColor = resolveColor(color, wrapperEl);
		annotation = annotate(wrapperEl, {
			type: action,
			color: resolvedColor,
			strokeWidth,
			animationDuration: animate ? duration : 0,
			iterations,
			animate,
			multiline: true
		});
		annotation.show();
	}

	function unmount() {
		if (annotation) {
			annotation.remove();
			annotation = null;
		}
	}

	onMount(() => {
		void mount();
	});
	onDestroy(unmount);

	// Re-annotate on active toggle.
	$effect(() => {
		void active;
		unmount();
		if (active) void mount();
	});
</script>

<span bind:this={wrapperEl} class="highlighter">
	{@render children()}
</span>

<style>
	.highlighter {
		/* inline-block gives rough-notation a reliable bounding rect to
		 * annotate, even when the highlighted text sits inside flex/grid
		 * containers or wraps across lines. `position: relative` anchors
		 * the SVG overlay rough-notation injects. */
		display: inline-block;
		position: relative;
	}
</style>
