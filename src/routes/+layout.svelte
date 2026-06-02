<script lang="ts">
	import ClerkUserButton from '$lib/components/ClerkUserButton.svelte';

	let { children } = $props();
</script>

{@render children()}
<ClerkUserButton />

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

	/* Shared button shells for modal/dialog footers. Defined globally so
	 * AgentModal, Dialog, and any future dialog stay visually identical
	 * without each component redefining the styles. Component-local
	 * variants (e.g. OutlinePane's btn-accept/btn-reject) keep their own
	 * styling on purpose because they encode action semantics. */
	:global(.btn-primary),
	:global(.btn-secondary) {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 6px 14px;
		font-family: inherit;
		font-size: 12.5px;
		font-weight: 500;
		border-radius: 5px;
		cursor: pointer;
	}
	:global(.btn-primary) {
		background: var(--accent);
		color: white;
		border: 1px solid var(--accent);
	}
	:global(.btn-primary:hover) {
		filter: brightness(0.94);
	}
	:global(.btn-primary:disabled) {
		opacity: 0.4;
		cursor: default;
	}
	:global(.btn-primary.danger) {
		background: #c53030;
		border-color: #c53030;
	}
	:global(.btn-primary.danger:hover) {
		filter: brightness(0.94);
	}
	:global(.btn-secondary) {
		background: var(--bg-surface);
		color: var(--text);
		border: 1px solid var(--border-light);
	}
	:global(.btn-secondary:hover) {
		background: var(--bg);
	}

	/* Veil applied to right-pane content (history entries + pending
	 * review cards) when the agent is muted. Heavy fade + blur + no
	 * pointer events, so the user really cannot follow what the agent
	 * is doing until they unmute. The agent dock at the top of the
	 * pane stays unaffected so the user always has access to the
	 * Bell / Send / Restart controls. */
	:global(.muted-veil) {
		opacity: 0.18;
		filter: blur(3px);
		pointer-events: none;
		user-select: none;
		transition: opacity 240ms ease, filter 240ms ease;
	}
</style>
