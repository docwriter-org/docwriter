<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Port of MagicUI's ShineBorder (magicui.design/docs/components/shine-border).
	 * Wraps arbitrary content with an animated conic-gradient border that
	 * rotates around the element. Pure CSS — no JS runtime cost.
	 *
	 * Usage:
	 *   <ShineBorder active={rendering} color={["#4f46e5", "#a855f7"]}>
	 *     {#snippet children()}<button>...</button>{/snippet}
	 *   </ShineBorder>
	 */
	interface Props {
		/** When false, renders children without the border overlay. */
		active?: boolean;
		/** Stops on the conic gradient. Pass 1-3 colors for gradient, or a
		 * single color for a pulsing glow. */
		color?: string[];
		/** Border width in px. */
		borderWidth?: number;
		/** Rotation period in seconds. Lower = faster. */
		duration?: number;
		/** Inherits the wrapped element's border-radius via a CSS var. Pass
		 * the same radius (px) as the child for a flush border. */
		radius?: number;
		children: Snippet;
	}

	let {
		active = true,
		color = ['#a855f7', '#4f46e5', '#22d3ee'],
		borderWidth = 1.5,
		duration = 8,
		radius = 10,
		children
	}: Props = $props();

	const gradientStops = $derived(
		color.length === 1 ? [color[0], color[0], color[0]] : [...color, color[0]]
	);
</script>

<div
	class="shine-border"
	class:active
	style:--shine-border-width="{borderWidth}px"
	style:--shine-radius="{radius}px"
	style:--shine-duration="{duration}s"
	style:--shine-stops={gradientStops.join(', ')}
>
	{@render children()}
</div>

<style>
	/* Animatable custom prop — without @property, `--shine-angle` wouldn't
	 * animate since its type defaults to `<custom-ident>` and browsers can't
	 * interpolate those. */
	@property --shine-angle {
		syntax: '<angle>';
		initial-value: 0deg;
		inherits: false;
	}

	.shine-border {
		position: relative;
		display: inline-block;
		border-radius: var(--shine-radius, 10px);
	}
	.shine-border.active::before {
		content: '';
		position: absolute;
		inset: calc(-1 * var(--shine-border-width));
		border-radius: inherit;
		padding: var(--shine-border-width);
		background: conic-gradient(from var(--shine-angle), var(--shine-stops));
		/* Mask trick: fill the ring area but not the inside, so we see only
		 * the border. `content-box` of the inner linear-gradient excludes
		 * the padding area, then mask-composite: exclude XORs it with the
		 * full-cover outer mask to leave only the ring. */
		-webkit-mask:
			linear-gradient(#000 0 0) content-box,
			linear-gradient(#000 0 0);
		-webkit-mask-composite: xor;
		mask:
			linear-gradient(#000 0 0) content-box,
			linear-gradient(#000 0 0);
		mask-composite: exclude;
		animation: shine-rotate var(--shine-duration, 8s) linear infinite;
		pointer-events: none;
		z-index: 1;
	}
	@keyframes shine-rotate {
		to {
			--shine-angle: 360deg;
		}
	}
</style>
