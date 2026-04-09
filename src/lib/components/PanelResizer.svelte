<script lang="ts">
	let { onResize }: { onResize: (deltaX: number) => void } = $props();

	let dragging = $state(false);
	let startX = 0;

	function onMouseDown(e: MouseEvent) {
		dragging = true;
		startX = e.clientX;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		function onMouseMove(e: MouseEvent) {
			const delta = e.clientX - startX;
			startX = e.clientX;
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
		width: 6px;
		margin: 0 -3px;
		cursor: col-resize;
		background: transparent;
		flex-shrink: 0;
		align-self: stretch;
		position: relative;
		z-index: 10;
		transition: background 0.15s;
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
</style>
