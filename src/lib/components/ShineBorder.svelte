<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Border Beam — direct port of MagicUI's BorderBeam
	 * (magicui.design/docs/components/border-beam). A square comet
	 * travels around the host's border via CSS `offset-path`; a mask
	 * on the wrapper clips it to only show along the border ring,
	 * leaving the wrapped content untouched.
	 *
	 * Two layers:
	 *   1. `.bb-mask` — absolute inset:0 inside the host, with a
	 *      transparent border of `borderWidth`. The two-layer mask
	 *      (transparent in padding-box, white in border-box) +
	 *      `mask-composite: intersect` makes only the border ring
	 *      visible; everything else inside this layer is clipped out.
	 *   2. `.bb-beam` — the comet, an aspect-square element with a
	 *      horizontal gradient (head → tail → transparent), animated
	 *      from `offset-distance: 0%` to `100%` along the host's
	 *      rectangular path.
	 *
	 * The `color` array is `[from, to]` (head, mid). Tail fades to
	 * transparent. Old call sites using a 3-color array still work —
	 * the third stop is ignored.
	 */
	interface Props {
		active?: boolean;
		color?: string[];
		borderWidth?: number;
		duration?: number;
		/** Corner radius of the host (px). Match the wrapped element. */
		radius?: number;
		/** Beam length along the path (px). Longer = more visible streak. */
		size?: number;
		/** Beam thickness perpendicular to the path (px). Keep this LESS THAN
		 * the host's smaller dimension so the beam can't span two opposite
		 * border edges at once and "light up" both. */
		thickness?: number;
		children: Snippet;
	}

	let {
		active = true,
		color = ['#ffaa40', '#9c40ff'],
		borderWidth = 1.5,
		duration = 4,
		radius = 10,
		size = 80,
		thickness = 10,
		children
	}: Props = $props();

	const colorFrom = $derived(color[0] ?? '#ffaa40');
	const colorTo = $derived(color[1] ?? color[0] ?? '#9c40ff');
</script>

<div
	class="bb-host"
	style:--bb-radius="{radius}px"
	style:--bb-border="{borderWidth}px"
	style:--bb-duration="{duration}s"
	style:--bb-size="{size}px"
	style:--bb-thickness="{thickness}px"
	style:--bb-from={colorFrom}
	style:--bb-to={colorTo}
>
	{@render children()}
	{#if active}
		<div class="bb-mask" aria-hidden="true">
			<div class="bb-beam"></div>
		</div>
	{/if}
</div>

<style>
	.bb-host {
		position: relative;
		display: inline-flex;
		align-items: center;
		border-radius: var(--bb-radius, 10px);
	}

	/* The mask layer carves out the border ring as the only visible
	 * area for the beam. Two-layer mask:
	 *   - layer 1: transparent gradient, clipped to padding-box
	 *   - layer 2: white gradient, clipped to border-box
	 *   - composite: intersect — only pixels visible in both layers show
	 * The padding-box of this layer is the inside of the transparent
	 * border; border-box includes the border itself. The intersect of
	 * "fully visible everywhere outside padding-box" (layer 1's clip
	 * boundary leaves the border-ring un-clipped) and "white inside
	 * border-box" leaves only the border ring visible. */
	.bb-mask {
		position: absolute;
		inset: 0;
		border-radius: inherit;
		border: var(--bb-border, 1.5px) solid transparent;
		pointer-events: none;
		mask:
			linear-gradient(transparent, transparent),
			linear-gradient(white, white);
		mask-clip: padding-box, border-box;
		mask-composite: intersect;
		-webkit-mask:
			linear-gradient(transparent, transparent),
			linear-gradient(white, white);
		-webkit-mask-clip: padding-box, border-box;
		-webkit-mask-composite: source-in;
	}

	/* The beam: a square with a horizontal gradient (right is the
	 * bright head, fading to transparent on the left). offset-path
	 * traces the rounded rectangle of the .bb-mask container's border;
	 * offset-distance animates 0% → 100% on a linear loop. */
	.bb-beam {
		position: absolute;
		/* Long thin rectangle. Width = streak length along the path; height
		 * = thickness perpendicular to the path. Keeping height small means
		 * the beam can't visually span two opposite border edges of a thin
		 * pill at once. */
		width: var(--bb-size, 80px);
		height: var(--bb-thickness, 10px);
		/* SYMMETRIC gradient (transparent on both ends, bright in the
		 * middle). Combined with `offset-rotate: auto` (the default on
		 * offset-path), the beam appears to glide smoothly through the
		 * curved ends of a capsule — without a symmetric gradient, the
		 * head and tail flip orientation through the cap and read as a
		 * "pause". With the symmetry, you can't tell rotation is happening. */
		background: linear-gradient(
			to right,
			transparent 0%,
			var(--bb-to) 30%,
			var(--bb-from) 50%,
			var(--bb-to) 70%,
			transparent 100%
		);
		offset-path: rect(0 auto auto 0 round var(--bb-radius, 10px));
		animation: bb-travel var(--bb-duration, 4s) linear infinite;
	}

	@keyframes bb-travel {
		to {
			offset-distance: 100%;
		}
	}
</style>
