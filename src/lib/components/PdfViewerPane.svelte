<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { themes, applyTheme } from '$lib/themes';
	import { selectedTheme } from '$lib/stores';

	interface Props {
		path: string;
	}
	let { path }: Props = $props();

	let iframeEl: HTMLIFrameElement | null = $state(null);
	let cacheBuster = $state(Date.now());
	let themeName = $state('light');

	let sseSource: EventSource | null = null;
	let saved: { scrollTop: number; scale: number; page: number } | null = null;
	let broadcastChannel: BroadcastChannel | null = null;

	function makePdfSrc(filePath: string, buster: number): string {
		const fileUrl = `/api/preview?path=${encodeURIComponent(filePath)}&v=${buster}`;
		return `/pdfjs/web/viewer.html?file=${encodeURIComponent(fileUrl)}`;
	}

	let src = $derived(makePdfSrc(path, cacheBuster));

	function captureScroll() {
		if (!iframeEl) return;
		try {
			const w = iframeEl.contentWindow as unknown as {
				PDFViewerApplication?: {
					page?: number;
					pdfViewer?: {
						currentScale?: number;
						container?: HTMLElement;
					};
				};
			};
			const app = w?.PDFViewerApplication;
			if (!app) return;
			saved = {
				page: app.page ?? 1,
				scrollTop: app.pdfViewer?.container?.scrollTop ?? 0,
				scale: app.pdfViewer?.currentScale ?? 1
			};
		} catch {
			/* detached or not ready */
		}
	}

	function restoreScroll() {
		if (!iframeEl || !saved) return;
		try {
			const w = iframeEl.contentWindow as unknown as {
				PDFViewerApplication?: {
					page?: number;
					pdfViewer?: {
						currentScale?: number;
						container?: HTMLElement;
					};
					eventBus?: { on: (e: string, cb: () => void) => void };
				};
			};
			const data = saved;
			const apply = () => {
				const app = w?.PDFViewerApplication;
				if (!app) return;
				if (app.pdfViewer && typeof data.scale === 'number') {
					app.pdfViewer.currentScale = data.scale;
				}
				if (typeof data.page === 'number') app.page = data.page;
				setTimeout(() => {
					if (app.pdfViewer?.container && typeof data.scrollTop === 'number') {
						app.pdfViewer.container.scrollTop = data.scrollTop;
					}
				}, 50);
			};
			const start = Date.now();
			const tick = () => {
				if (w?.PDFViewerApplication?.eventBus) {
					w.PDFViewerApplication.eventBus.on('pagesinit', apply);
					return;
				}
				if (Date.now() - start < 3000) setTimeout(tick, 50);
			};
			tick();
		} catch {
			/* ignore */
		}
	}

	function reload() {
		captureScroll();
		cacheBuster = Date.now();
	}

	function connectSse() {
		if (sseSource) return;
		try {
			sseSource = new EventSource('/api/live');
		} catch {
			return;
		}
		sseSource.addEventListener('preview_ready', (ev) => {
			try {
				const data = JSON.parse((ev as MessageEvent).data);
				if (typeof data?.path !== 'string') return;
				if (data.path === path || data.path.endsWith('/' + path)) reload();
			} catch {
				/* ignore */
			}
		});
		sseSource.onerror = () => {
			sseSource?.close();
			sseSource = null;
			setTimeout(connectSse, 3000);
		};
	}

	function applyDocwriterTheme(name: string) {
		const theme = themes.find((t) => t.name === name) ?? themes[0];
		if (!theme) return;
		themeName = theme.name;
		injectThemeIntoIframe();
	}

	function injectThemeIntoIframe() {
		if (!iframeEl) return;
		const doc = iframeEl.contentDocument;
		if (!doc?.documentElement) return;
		const theme = themes.find((t) => t.name === themeName) ?? themes[0];
		if (!theme) return;
		doc.documentElement.setAttribute('data-docwriter-theme', theme.name);
		for (const [k, v] of Object.entries(theme.vars)) {
			doc.documentElement.style.setProperty(k, v);
		}
	}

	function relaySynctexJump(file: string, line: number) {
		window.postMessage(
			{ kind: 'docwriter-synctex-jump', file, line },
			window.location.origin
		);
	}

	function attachSynctexHandler() {
		if (!iframeEl) return;
		const doc = iframeEl.contentDocument;
		if (!doc) return;
		const w = iframeEl.contentWindow as unknown as {
			PDFViewerApplication?: { pdfViewer?: { currentScale?: number } };
		};
		const handler = async (ev: MouseEvent) => {
			const target = ev.target as HTMLElement | null;
			const pageEl = target?.closest('.page[data-page-number]') as HTMLElement | null;
			if (!pageEl) return;
			const pageNum = parseInt(pageEl.dataset.pageNumber ?? '0', 10);
			if (!pageNum) return;
			const rect = pageEl.getBoundingClientRect();
			const scale = w?.PDFViewerApplication?.pdfViewer?.currentScale ?? 1;
			const cssPerPt = scale * (96 / 72);
			const x = (ev.clientX - rect.left) / cssPerPt;
			const y = (ev.clientY - rect.top) / cssPerPt;
			try {
				const res = await fetch('/api/synctex', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ pdf: path, page: pageNum, x, y })
				});
				const data = await res.json();
				if (data?.ok && typeof data.file === 'string' && typeof data.line === 'number') {
					relaySynctexJump(data.file, data.line);
				}
			} catch {
				/* synctex unavailable */
			}
		};
		const listener = handler as unknown as EventListener;
		doc.removeEventListener('dblclick', listener, true);
		doc.addEventListener('dblclick', listener, true);
	}

	function scrollPdfTo(page: number, x: number, y: number) {
		if (!iframeEl) return;
		const w = iframeEl.contentWindow as unknown as {
			PDFViewerApplication?: {
				pdfViewer?: {
					scrollPageIntoView: (opts: {
						pageNumber: number;
						destArray?: unknown[];
					}) => void;
				};
			};
		};
		const app = w?.PDFViewerApplication;
		if (!app?.pdfViewer) return;
		try {
			app.pdfViewer.scrollPageIntoView({
				pageNumber: page,
				destArray: ['XYZ', x, y, null]
			});
		} catch {
			/* PDF not ready */
		}
	}

	function connectBroadcastChannel() {
		if (broadcastChannel) return;
		try {
			broadcastChannel = new BroadcastChannel('docwriter-preview');
		} catch {
			return;
		}
		broadcastChannel.onmessage = (ev: MessageEvent) => {
			const data = ev.data as
				| { kind?: string; page?: number; x?: number; y?: number; v?: number }
				| null;
			if (!data || data.kind !== 'pdf-jump') return;
			scrollPdfTo(data.page ?? 1, data.x ?? 0, data.v ?? data.y ?? 0);
		};
	}

	function onIframeLoad() {
		restoreScroll();
		injectThemeIntoIframe();
		attachSynctexHandler();
	}

	onMount(() => {
		connectSse();
		connectBroadcastChannel();
	});

	onDestroy(() => {
		sseSource?.close();
		sseSource = null;
		broadcastChannel?.close();
		broadcastChannel = null;
	});

	$effect(() => {
		void path;
		cacheBuster = Date.now();
		saved = null;
	});

	$effect(() => {
		const unsub = selectedTheme.subscribe((name) => applyDocwriterTheme(name));
		return unsub;
	});
</script>

<div class="pdf-viewer-pane">
	<iframe bind:this={iframeEl} {src} title={path} onload={onIframeLoad}></iframe>
</div>

<style>
	.pdf-viewer-pane {
		flex: 1;
		min-height: 0;
		display: flex;
		background: var(--bg-surface, #1a1a1a);
	}
	iframe {
		flex: 1;
		border: none;
		background: var(--bg, #fff);
	}
</style>
