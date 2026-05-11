<script lang="ts">
	let { children } = $props();
</script>

{@render children()}

<style>
	/* Global hover tooltip element, owned by src/lib/actions/tooltip.ts.
	 * Lives at document.body level so it can position above any element
	 * without being clipped by overflow:hidden parents. */
	:global(.dw-tooltip) {
		position: fixed;
		top: -9999px;
		left: -9999px;
		max-width: 320px;
		padding: 6px 9px;
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
		font-size: 12px;
		line-height: 1.4;
		color: var(--text);
		background: var(--bg-elevated);
		border: 1px solid var(--border-light);
		border-radius: 6px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.08);
		pointer-events: none;
		opacity: 0;
		transition: opacity 120ms ease-out;
		z-index: 9999;
		white-space: pre-wrap;
		word-break: break-word;
	}
	:global(.dw-tooltip.visible) {
		opacity: 1;
	}
</style>
