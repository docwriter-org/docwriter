<script lang="ts">
	let { onResize }: { onResize: (deltaY: number) => void } = $props();

	let dragging = $state(false);
	let startY = 0;

	function onMouseDown(e: MouseEvent) {
		dragging = true;
		startY = e.clientY;
		document.body.style.cursor = 'row-resize';
		document.body.style.userSelect = 'none';

		function onMouseMove(e: MouseEvent) {
			const delta = e.clientY - startY;
			startY = e.clientY;
			onResize(delta);
		}

		function onMouseUp() {
			dragging = false;
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', onMouseUp);
		}

		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseup', onMouseUp);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="resizer" class:active={dragging} onmousedown={onMouseDown}></div>

<style>
	.resizer {
		height: 8px;
		margin: -4px 0;
		cursor: row-resize;
		background: transparent;
		flex-shrink: 0;
		position: relative;
		z-index: 10;
	}
	.resizer::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		top: 3px;
		height: 2px;
		background: var(--border-light);
		transition: background 0.15s, height 0.15s, top 0.15s;
	}
	.resizer:hover::after,
	.resizer.active::after {
		background: var(--accent);
		height: 3px;
		top: 2px;
	}
</style>
