<script lang="ts">
	import { onDestroy } from 'svelte';
	import { selectedTheme } from '$lib/stores';

	interface Props {
		path: string;
		closePdfSidebar?: boolean;
	}
	let { path, closePdfSidebar = true }: Props = $props();

	let themeName = $state('light');
	const unsubscribeTheme = selectedTheme.subscribe((name) => {
		themeName = name;
	});
	onDestroy(unsubscribeTheme);

	let src = $derived(
		`/preview?path=${encodeURIComponent(path)}&theme=${encodeURIComponent(themeName)}&embedded=1${closePdfSidebar ? '&pdfSidebar=0' : ''}`
	);
</script>

<div class="pdf-viewer-pane">
	<iframe {src} title={`Preview: ${path}`}></iframe>
</div>

<style>
	.pdf-viewer-pane {
		flex: 1;
		min-height: 0;
		display: flex;
		background: var(--bg, #fff);
	}
	iframe {
		flex: 1;
		border: none;
		background: var(--bg, #fff);
	}
</style>
