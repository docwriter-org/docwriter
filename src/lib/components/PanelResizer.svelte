<script lang="ts">
	import { onDestroy } from 'svelte';

	let { onResize }: { onResize: (deltaX: number) => void } = $props();

	let dragging = $state(false);
	let resizerEl: HTMLDivElement | null = $state(null);
	let startX = 0;
	let activePointerId: number | null = null;
	let previousBodyCursor = '';
	let previousRootCursor = '';
	let previousUserSelect = '';

	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		e.preventDefault();
		const delta = e.clientX - startX;
		startX = e.clientX;
		onResize(delta);
	}

	function finishDrag() {
		if (!dragging) return;
		dragging = false;
		document.body.style.cursor = previousBodyCursor;
		document.documentElement.style.cursor = previousRootCursor;
		document.body.style.userSelect = previousUserSelect;

		if (
			activePointerId !== null &&
			resizerEl?.hasPointerCapture?.(activePointerId)
		) {
			resizerEl.releasePointerCapture(activePointerId);
		}
		activePointerId = null;

		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', finishDrag);
		window.removeEventListener('pointercancel', finishDrag);
		window.removeEventListener('blur', finishDrag);
	}

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		e.preventDefault();
		dragging = true;
		startX = e.clientX;
		activePointerId = e.pointerId;
		previousBodyCursor = document.body.style.cursor;
		previousRootCursor = document.documentElement.style.cursor;
		previousUserSelect = document.body.style.userSelect;
		document.body.style.cursor = 'col-resize';
		document.documentElement.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		try {
			resizerEl?.setPointerCapture?.(e.pointerId);
		} catch {
			/* Pointer capture can fail for synthetic events; the drag shield still catches it. */
		}

		window.addEventListener('pointermove', onPointerMove, { passive: false });
		window.addEventListener('pointerup', finishDrag);
		window.addEventListener('pointercancel', finishDrag);
		window.addEventListener('blur', finishDrag);
	}

	onDestroy(finishDrag);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={resizerEl}
	class="resizer"
	class:active={dragging}
	role="separator"
	aria-orientation="vertical"
	onpointerdown={onPointerDown}
></div>
{#if dragging}
	<!-- Covers iframes during drag so pointerup cannot get swallowed by the embedded viewer. -->
	<div
		class="drag-shield"
		role="presentation"
		aria-hidden="true"
		onpointermove={onPointerMove}
		onpointerup={finishDrag}
		onpointercancel={finishDrag}
	></div>
{/if}

<style>
	.resizer {
		width: 6px;
		margin: 0 -3px;
		cursor: col-resize;
		background: transparent;
		flex-shrink: 0;
		align-self: stretch;
		position: relative;
		z-index: 10;
		transition: background 0.15s;
		touch-action: none;
		user-select: none;
	}
	.resizer::after {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 2px;
		width: 2px;
		background: var(--border-light);
	}
	.resizer:hover::after, .resizer.active::after {
		background: var(--accent);
		width: 3px;
		left: 1px;
	}
	.drag-shield {
		position: fixed;
		inset: 0;
		z-index: 2147483647;
		cursor: col-resize;
		background: transparent;
		touch-action: none;
		user-select: none;
	}
</style>
