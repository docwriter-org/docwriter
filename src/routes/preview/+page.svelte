<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { themes, applyTheme } from '$lib/themes';

	/**
	 * Pop-out preview window. Reads ?path=... from the URL, picks a
	 * renderer by file extension, and stays synced via the /api/live
	 * SSE bus: whenever a `preview_ready` event arrives whose `path`
	 * matches ours, the viewer reloads with scroll position preserved.
	 *
	 * Scroll preservation:
	 *   - HTML / SVG: same-origin iframe — we read iframe.contentWindow.
	 *     scrollY before reload, restore after the load event.
	 *   - PDF: bundled PDF.js viewer (static/pdfjs/web/viewer.html) gives
	 *     us programmatic access via window.PDFViewerApplication. We
	 *     snapshot { page, container.scrollTop, scale } before reload
	 *     and restore once the viewer's eventBus fires `pagesinit`.
	 *   - Image: scrollY of the wrapper element.
	 */
	let path = $state('');
	let kind = $state<'pdf' | 'html' | 'image' | 'text' | 'unknown'>('unknown');
	let iframeEl: HTMLIFrameElement | null = $state(null);
	let wrapperEl: HTMLDivElement | null = $state(null);
	let cacheBuster = $state(Date.now());
	let connectionState = $state<'connecting' | 'connected' | 'disconnected'>('connecting');
	let lastReloadAt = $state<number | null>(null);
	let themeName = $state('light');
	let embedded = $state(false);
	let closePdfSidebar = $state(false);

	let sseSource: EventSource | null = null;
	let saved: { kind: 'html' | 'pdf' | 'image'; data: unknown } | null = null;
	let broadcastChannel: BroadcastChannel | null = null;
	let pendingPdfJump: { page: number; x: number; y: number } | null = null;
	let pendingPdfJumpAttempts = 0;
	let pendingPdfJumpTimer: ReturnType<typeof setTimeout> | null = null;
	let pdfSearchSerial = 0;

	function inferKind(p: string): typeof kind {
		const ext = p.toLowerCase().split('.').pop() ?? '';
		if (ext === 'pdf') return 'pdf';
		if (ext === 'html' || ext === 'htm' || ext === 'svg') return 'html';
		if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
		if (['txt', 'md'].includes(ext)) return 'text';
		return 'unknown';
	}

	function makePdfSrc(path: string, buster: number): string {
		const fileUrl = `/api/preview?path=${encodeURIComponent(path)}&v=${buster}`;
		return `/pdfjs/web/viewer.html?file=${encodeURIComponent(fileUrl)}${closePdfSidebar ? '#pagemode=none' : ''}`;
	}
	function makeDirectSrc(path: string, buster: number): string {
		return `/api/preview?path=${encodeURIComponent(path)}&v=${buster}`;
	}

	function captureScroll() {
		if (!iframeEl) return;
		try {
			if (kind === 'pdf') {
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
					kind: 'pdf',
					data: {
						page: app.page ?? 1,
						scrollTop: app.pdfViewer?.container?.scrollTop ?? 0,
						scale: app.pdfViewer?.currentScale ?? 1
					}
				};
				return;
			}
			if (kind === 'html') {
				const win = iframeEl.contentWindow;
				if (!win) return;
				saved = { kind: 'html', data: { scrollX: win.scrollX, scrollY: win.scrollY } };
				return;
			}
		} catch {
			/* cross-origin or detached — ignore */
		}
	}

	function restoreScroll() {
		if (!iframeEl || !saved) return;
		try {
			if (saved.kind === 'pdf') {
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
				const data = saved.data as { page: number; scrollTop: number; scale: number };
				const apply = () => {
					const app = w?.PDFViewerApplication;
					if (!app) return;
					if (app.pdfViewer && typeof data.scale === 'number') {
						app.pdfViewer.currentScale = data.scale;
					}
					if (typeof data.page === 'number') app.page = data.page;
					// Sub-page scroll precision: set container scrollTop after
					// the viewer settles on the chosen page.
					setTimeout(() => {
						if (app.pdfViewer?.container && typeof data.scrollTop === 'number') {
							app.pdfViewer.container.scrollTop = data.scrollTop;
						}
					}, 50);
				};
				// PDFViewerApplication isn't ready synchronously; poll briefly.
				const start = Date.now();
				const tick = () => {
					if (w?.PDFViewerApplication?.eventBus) {
						w.PDFViewerApplication.eventBus.on('pagesinit', apply);
						return;
					}
					if (Date.now() - start < 3000) {
						setTimeout(tick, 50);
					}
				};
				tick();
				return;
			}
			if (saved.kind === 'html') {
				const win = iframeEl.contentWindow;
				if (!win) return;
				const data = saved.data as { scrollX: number; scrollY: number };
				// Wait a tick so the doc has laid out post-load.
				setTimeout(() => win.scrollTo(data.scrollX, data.scrollY), 0);
				return;
			}
		} catch {
			/* ignore */
		}
	}

	function reload() {
		captureScroll();
		cacheBuster = Date.now();
		lastReloadAt = Date.now();
		// restoreScroll runs from the iframe's load handler below
	}

	function manualReload() {
		reload();
	}

	function openInNewWindow() {
		window.open(makeDirectSrc(path, Date.now()), '_blank');
	}

	function connectSse() {
		if (sseSource) return;
		try {
			sseSource = new EventSource('/api/live');
		} catch {
			connectionState = 'disconnected';
			return;
		}
		sseSource.addEventListener('open', () => (connectionState = 'connected'));
		sseSource.addEventListener('connected', () => (connectionState = 'connected'));
		sseSource.addEventListener('preview_ready', (ev) => {
			try {
				const data = JSON.parse((ev as MessageEvent).data);
				if (typeof data?.path !== 'string') return;
				// Match by absolute path or by exact requested-path string.
				if (data.path === path || data.path.endsWith('/' + path)) {
					reload();
				}
			} catch {
				/* ignore malformed event */
			}
		});
		sseSource.onerror = () => {
			connectionState = 'disconnected';
			sseSource?.close();
			sseSource = null;
			setTimeout(connectSse, 3000);
		};
	}

	/** Apply the docwriter theme to BOTH the preview shell (this document)
	 * and the PDF.js iframe (same-origin, so we can reach into its DOM).
	 * For HTML / image previews the iframe is whatever HTML the user
	 * generated and we don't try to restyle that — only PDF.js, which is
	 * our viewer we control. */
	function applyDocwriterTheme(name: string) {
		const theme = themes.find((t) => t.name === name) ?? themes[0];
		if (!theme) return;
		themeName = theme.name;
		applyTheme(theme);
		injectThemeIntoIframe();
	}

	function injectThemeIntoIframe() {
		if (!iframeEl || kind !== 'pdf') return;
		const doc = iframeEl.contentDocument;
		if (!doc?.documentElement) return;
		const theme = themes.find((t) => t.name === themeName) ?? themes[0];
		if (!theme) return;
		doc.documentElement.setAttribute('data-docwriter-theme', theme.name);
		for (const [k, v] of Object.entries(theme.vars)) {
			doc.documentElement.style.setProperty(k, v);
		}
	}

	function closePdfSidebarIfRequested() {
		if (!closePdfSidebar || !iframeEl || kind !== 'pdf') return;
		const win = iframeEl.contentWindow as unknown as
			| {
					PDFViewerApplication?: {
						pdfSidebar?: {
							isOpen?: boolean;
							close?: () => void;
							switchView?: (view: number, forceOpen?: boolean) => void;
						};
					};
			  }
			| null;
		const start = Date.now();
		const attempt = () => {
			try {
				const sidebar = win?.PDFViewerApplication?.pdfSidebar;
				if (sidebar) {
					sidebar.switchView?.(0, false);
					if (sidebar.isOpen) sidebar.close?.();
					return;
				}
			} catch {
				/* PDF.js may still be initializing — retry briefly. */
			}
			if (Date.now() - start < 3000) {
				setTimeout(attempt, 50);
			}
		};
		attempt();
	}

	/** Attach a dblclick listener to the PDF.js viewer that resolves the
	 * click to a source location via /api/synctex and relays it to the
	 * docwriter host window. PDF.js renders each page as a
	 * `<div class="page" data-page-number="N">`; we compute the click's
	 * page-relative coordinates, divide by the current scale to get PDF
	 * points (synctex expects points, not CSS pixels), and POST to the
	 * synctex endpoint. */
	function attachSynctexHandler() {
		if (!iframeEl || kind !== 'pdf') return;
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
			// CSS pixels → PDF points. PDF.js renders one PDF point as
			// `scale * (96/72)` CSS pixels (96dpi CSS, 72pt PDF). Divide
			// the click offset by that factor to get PDF coordinates that
			// synctex expects. (Earlier version only divided by scale,
			// landing clicks ~33% too far down/right.)
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
					relayJumpToHost(data.file, data.line);
				}
			} catch {
				/* synctex CLI missing, .synctex.gz missing, network error — silent */
			}
		};
		// Use the iframe document so the listener survives PDF.js's own
		// internal re-renders (it doesn't re-create the document, only the
		// page divs inside it).
		const listener = handler as unknown as EventListener;
		doc.removeEventListener('dblclick', listener, true);
		doc.addEventListener('dblclick', listener, true);
	}

	function relayJumpToHost(file: string, line: number) {
		const opener = window.opener as Window | null;
		const embeddedParent = window.parent !== window ? window.parent : null;
		const target = opener && !opener.closed ? opener : embeddedParent;
		if (!target) return;
		try {
			target.postMessage(
				{ kind: 'docwriter-synctex-jump', file, line },
				window.location.origin
			);
			if (target === opener) opener.focus();
		} catch {
			/* host navigated away or different origin — ignore */
		}
	}

	/** Open a BroadcastChannel both sides (docwriter editor + this
	 * preview window) talk on for forward synctex jumps. Docwriter
	 * broadcasts {kind: 'pdf-jump', page, x, y, h, v, w, height} after
	 * the user clicks "Show in PDF"; this handler scrolls the PDF.js
	 * viewer to that page and y position using PDFViewerApplication's
	 * scrollPageIntoView with a destination array. */
	function connectBroadcastChannel() {
		if (broadcastChannel) return;
		try {
			broadcastChannel = new BroadcastChannel('docwriter-preview');
		} catch {
			return;
		}
		broadcastChannel.onmessage = (ev: MessageEvent) => {
			const data = ev.data as
				| { kind?: string; page?: number; x?: number; y?: number; h?: number; v?: number; queries?: string[] }
				| null;
			if (!data) return;
			if (data.kind === 'pdf-search') {
				const queries = Array.isArray(data.queries)
					? data.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
					: [];
				if (queries.length > 0) void searchPdf(queries);
				return;
			}
			if (data.kind !== 'pdf-jump') return;
			scrollPdfTo(data.page ?? 1, data.x ?? 0, data.v ?? data.y ?? 0);
		};
	}

	function tryScrollPdfTo(jump: { page: number; x: number; y: number }): boolean {
		if (!iframeEl || kind !== 'pdf') return false;
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
		if (!app?.pdfViewer) return false;
		// destArray: [ref, { name: 'XYZ' }, x, top, zoom]. PDF.js uses bottom-left origin
		// for PDF coords; synctex Y is from the top of the page in points,
		// so we leave it as `y` (PDF.js does the conversion internally
		// when interpreting XYZ dest with `top` measured from page bottom?
		// Actually for synctex 'v' it's "vertical pos in TeX coords from
		// page top". PDF.js's destArray top is from the page bottom in
		// most APIs. Empirically, passing (pageHeight - y) here lands you
		// at the right place; PDF.js's XYZ handler treats top as PDF
		// y-coord from bottom-left. We rely on synctex giving us 'v' that
		// can be used as page-top distance + the viewer's automatic
		// conversion. If it's slightly off vertically that's the cause.)
		try {
			app.pdfViewer.scrollPageIntoView({
				pageNumber: jump.page,
				destArray: [null, { name: 'XYZ' }, jump.x, jump.y, null]
			});
			window.focus();
			return true;
		} catch {
			return false;
		}
	}

	function flushPendingPdfJump() {
		if (!pendingPdfJump) return;
		if (tryScrollPdfTo(pendingPdfJump)) {
			pendingPdfJump = null;
			pendingPdfJumpAttempts = 0;
			if (pendingPdfJumpTimer) clearTimeout(pendingPdfJumpTimer);
			pendingPdfJumpTimer = null;
			return;
		}
		if (pendingPdfJumpAttempts >= 40) {
			pendingPdfJump = null;
			pendingPdfJumpAttempts = 0;
			pendingPdfJumpTimer = null;
			return;
		}
		pendingPdfJumpAttempts += 1;
		if (pendingPdfJumpTimer) clearTimeout(pendingPdfJumpTimer);
		pendingPdfJumpTimer = setTimeout(flushPendingPdfJump, 100);
	}

	function scrollPdfTo(page: number, x: number, y: number) {
		pendingPdfJump = { page, x, y };
		pendingPdfJumpAttempts = 0;
		flushPendingPdfJump();
	}

	function getPdfApplication():
		| {
				eventBus?: { dispatch: (name: string, data: Record<string, unknown>) => void };
				findController?: { _matchesCountTotal?: number };
				pdfViewer?: { container?: HTMLElement };
		  }
		| null {
		if (!iframeEl || kind !== 'pdf') return null;
		try {
			const w = iframeEl.contentWindow as unknown as {
				PDFViewerApplication?: {
					eventBus?: { dispatch: (name: string, data: Record<string, unknown>) => void };
					findController?: { _matchesCountTotal?: number };
					pdfViewer?: { container?: HTMLElement };
				};
			};
			return w?.PDFViewerApplication ?? null;
		} catch {
			return null;
		}
	}

	function dispatchPdfFind(query: string): boolean {
		const app = getPdfApplication();
		if (!app?.eventBus) return false;
		app.eventBus.dispatch('find', {
			source: window,
			type: '',
			query,
			caseSensitive: false,
			entireWord: false,
			highlightAll: true,
			findPrevious: false,
			matchDiacritics: false,
			phraseSearch: true
		});
		return true;
	}

	async function searchPdf(queries: string[]) {
		const serial = ++pdfSearchSerial;
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		for (let attempt = 0; attempt < 40; attempt += 1) {
			if (serial !== pdfSearchSerial) return;
			const app = getPdfApplication();
			if (app?.eventBus && app.findController) {
				for (const query of queries) {
					if (serial !== pdfSearchSerial) return;
					if (!dispatchPdfFind(query)) break;
					await sleep(450);
					if ((app.findController._matchesCountTotal ?? 0) > 0) return;
				}
				return;
			}
			await sleep(100);
		}
	}

	function closeEmbeddedPreview() {
		if (!embedded || window.parent === window) return;
		try {
			window.parent.postMessage(
				{ kind: 'docwriter-close-preview-pane' },
				window.location.origin
			);
		} catch {
			/* parent navigated away or different origin — ignore */
		}
	}

	onMount(() => {
		const url = new URL(window.location.href);
		path = url.searchParams.get('path') ?? '';
		kind = inferKind(path);
		embedded = url.searchParams.get('embedded') === '1';
		closePdfSidebar =
			url.searchParams.get('pdfSidebar') === '0' ||
			url.searchParams.get('pdfSidebar') === 'closed';
		const themeParam = url.searchParams.get('theme');
		applyDocwriterTheme(themeParam ?? 'light');
		if (path) {
			document.title = `Preview · ${path.split('/').pop()}`;
		}
		connectSse();
		connectBroadcastChannel();
	});

	onDestroy(() => {
		sseSource?.close();
		sseSource = null;
		broadcastChannel?.close();
		broadcastChannel = null;
		if (pendingPdfJumpTimer) clearTimeout(pendingPdfJumpTimer);
		pendingPdfJumpTimer = null;
	});

	let src = $derived(
		kind === 'pdf'
			? makePdfSrc(path, cacheBuster)
			: kind === 'html'
				? makeDirectSrc(path, cacheBuster)
				: ''
	);
</script>

<svelte:head>
	<title>{path ? `Preview · ${path}` : 'Preview'}</title>
</svelte:head>

<div class="preview-shell" bind:this={wrapperEl}>
	<header>
		<span class="path" title={path}>{path || '(no path)'}</span>
		<span class="status" class:connected={connectionState === 'connected'} class:disconnected={connectionState === 'disconnected'}>
			{connectionState}
		</span>
		<button onclick={manualReload} title="Reload now">Reload</button>
		<button onclick={openInNewWindow} title="Open raw file in a new tab">Raw</button>
		{#if embedded}
			<button onclick={closeEmbeddedPreview} title="Close side preview">Close</button>
		{/if}
		{#if lastReloadAt}
			<span class="last-reload">updated {new Date(lastReloadAt).toLocaleTimeString()}</span>
		{/if}
	</header>

	<main>
		{#if !path}
			<div class="empty">No path provided. Open via the editor's preview button or pass ?path=…</div>
		{:else if kind === 'pdf' || kind === 'html'}
			<iframe
				bind:this={iframeEl}
				{src}
				title={path}
				onload={() => {
					restoreScroll();
					injectThemeIntoIframe();
					closePdfSidebarIfRequested();
					attachSynctexHandler();
					flushPendingPdfJump();
				}}
			></iframe>
		{:else if kind === 'image'}
			<div class="image-wrap">
				<img src={makeDirectSrc(path, cacheBuster)} alt={path} />
			</div>
		{:else if kind === 'text'}
			<iframe
				bind:this={iframeEl}
				src={makeDirectSrc(path, cacheBuster)}
				title={path}
				onload={() => {
					restoreScroll();
					injectThemeIntoIframe();
					closePdfSidebarIfRequested();
					attachSynctexHandler();
					flushPendingPdfJump();
				}}
			></iframe>
		{:else}
			<div class="empty">Unsupported file type for inline preview. Use the Raw button to download.</div>
		{/if}
	</main>
</div>

<style>
	/* All chrome colors use docwriter theme tokens (applied to :root by
	 * applyDocwriterTheme on mount). The same tokens are also injected
	 * into the PDF.js iframe via docwriter-theme.css so the viewer
	 * matches. */
	:global(html),
	:global(body) {
		margin: 0;
		padding: 0;
		height: 100%;
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
		background: var(--bg, #1a1a1a);
		color: var(--text, #e8e8e8);
	}
	.preview-shell {
		display: flex;
		flex-direction: column;
		height: 100vh;
	}
	header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 10px;
		background: var(--bg-elevated, #1e1e1e);
		border-bottom: 1px solid var(--border-light, #2e2e2e);
		font-size: 12px;
	}
	.path {
		font-family: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 11px;
		color: var(--text-secondary, #cfcfcf);
		max-width: 60%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.status {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 2px 6px;
		border-radius: 999px;
		background: var(--bg-surface, #2a2a2a);
		color: var(--text-faint, #aaa);
	}
	.status.connected {
		background: color-mix(in srgb, var(--diff-added-color, #10b981) 18%, transparent);
		color: var(--diff-added-color, #10b981);
	}
	.status.disconnected {
		background: color-mix(in srgb, var(--diff-removed-color, #ef4444) 18%, transparent);
		color: var(--diff-removed-color, #ef4444);
	}
	button {
		font: inherit;
		font-size: 11px;
		padding: 3px 9px;
		background: var(--bg-surface, #2a2a2a);
		color: var(--text, #e8e8e8);
		border: 1px solid var(--border-light, #3a3a3a);
		border-radius: 5px;
		cursor: pointer;
		transition: background 120ms ease, border-color 120ms ease;
	}
	button:hover {
		background: var(--bg-hover, #353535);
		border-color: var(--border, #4a4a4a);
	}
	.last-reload {
		margin-left: auto;
		font-size: 10.5px;
		color: var(--text-faint, #888);
		font-variant-numeric: tabular-nums;
	}
	main {
		flex: 1;
		min-height: 0;
		display: flex;
		background: var(--bg, #1a1a1a);
	}
	iframe {
		flex: 1;
		border: none;
		background: var(--bg, #fff);
	}
	.image-wrap {
		flex: 1;
		overflow: auto;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 16px;
		background: var(--bg-surface, #1a1a1a);
	}
	.image-wrap img {
		max-width: 100%;
		height: auto;
	}
	.empty {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-faint, #888);
		font-size: 13px;
		padding: 32px;
		text-align: center;
	}
</style>
