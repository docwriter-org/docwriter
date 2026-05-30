/**
 * Media overlay — Substack-style inline previews for the plain-markdown
 * editor.
 *
 * Same architectural shape as `diff-overlay.ts` / `comment-overlay.ts`:
 * a ProseMirror plugin that READS the live doc and emits widget
 * decorations. It never mutates content, never adds nodes, never alters
 * the markdown source. The Y.Doc stays plain text.
 *
 * Three render modes:
 *
 *   1. Image thumbnail. Triggered by any `![alt](src)` token anywhere in
 *      a paragraph (or a bare image-extension URL on its own line). A
 *      block widget is appended after the host paragraph and renders an
 *      `<img>` (max ~360px tall). Workspace-relative paths route through
 *      `/api/preview`; http(s) URLs hit the host directly.
 *
 *   2. Inline link mark. Every absolute URL anywhere in paragraph text
 *      gets a `Decoration.inline` with class `media-link-inline` and a
 *      `data-url` attribute — a subtle dotted underline signals the
 *      affordance.
 *
 *   3. Hover-card tooltip. A floating element (`document.body`) listens
 *      for `mouseover` on inline link marks and renders an og card
 *      tooltip near the hovered link. og metadata is fetched lazily via
 *      `/api/opengraph` and cached in plugin state; while loading, the
 *      tooltip shows a skeleton, and on fetch failure it shows a
 *      minimal domain-only chrome.
 *
 * Composition with diff/comment/find/celebration overlays:
 *   - Image widgets are block widgets AFTER the paragraph; inline link
 *     marks are inline decorations ON existing text. Neither shares a
 *     DOM slot with diff word/line decorations.
 *   - When the agent rewrites a URL during a review round, the diff
 *     overlay paints the strike+highlight on the markdown text and the
 *     inline mark follows the live URL — hovering the new URL during
 *     review shows what you'd be accepting.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

interface ImageToken {
	readonly kind: 'image';
	readonly src: string;
	readonly alt: string;
}

interface CardToken {
	readonly kind: 'card';
	readonly url: string;
	/** Markdown link text, or the URL itself when the line is a bare URL.
	 * Used as a fallback title while og data is loading or has failed. */
	readonly fallbackTitle: string;
}

type MediaToken = ImageToken | CardToken;

interface ParagraphMedia {
	/** PM position immediately AFTER the host paragraph node — where the
	 * block widget renders. Stays consistent across keystrokes because
	 * the scan re-runs on every doc change. */
	readonly insertAt: number;
	/** Stable per-paragraph id so the widget DOM survives keystroke-level
	 * decoration set rebuilds without flicker. The id is derived from
	 * the paragraph's plain text + index, which is fine because two
	 * paragraphs with identical text and the same ordinal position
	 * really are interchangeable from the widget's POV. */
	readonly key: string;
	readonly tokens: readonly MediaToken[];
}

type OgState =
	| { readonly kind: 'loading' }
	| {
			readonly kind: 'loaded';
			readonly title: string | null;
			readonly description: string | null;
			readonly image: string | null;
			readonly siteName: string | null;
	  }
	| { readonly kind: 'error' };

/** An http(s) URL detected in paragraph text — its PM range and the
 * canonicalized URL string. Drives an inline `.media-link-inline`
 * decoration; hovering the decoration triggers a floating og-card
 * tooltip (see the plugin view below). Inline links don't get block
 * cards — those are reserved for own-line standalone URLs (Substack
 * convention) — but the hover preview gives a low-friction "what's
 * behind this link" affordance for inline references. */
interface InlineLink {
	readonly from: number;
	readonly to: number;
	readonly url: string;
}

interface MediaOverlayState {
	readonly paragraphs: readonly ParagraphMedia[];
	readonly inlineLinks: readonly InlineLink[];
	/** og fetch results keyed by URL. Survives across transactions so a
	 * fetch that resolves three keystrokes after it was started still
	 * lands on the right card. */
	readonly ogByUrl: ReadonlyMap<string, OgState>;
	/** Bumped whenever ogByUrl gains a new entry, so the `decorations`
	 * call below sees a different state object identity and PM rebuilds
	 * the widget set. */
	readonly version: number;
}

const mediaKey = new PluginKey<MediaOverlayState>('mediaOverlay');

/** Match any `![alt](src)` in a paragraph. The src capture stops at the
 * first `)` so a parenthesized title (e.g. `![](foo (1).png)`) won't
 * round-trip — markdown itself doesn't really support nested parens
 * here anyway, so this matches what the rest of the toolchain would
 * accept. */
const IMAGE_MD_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
/** Bare URL alone on a line. Used only to detect when a standalone
 * link's URL has an image extension — those still produce a thumbnail
 * widget. Non-image standalone URLs are handled by the inline mark +
 * hover tooltip path; no block card. */
const STANDALONE_BARE_URL_RE = /^\s*(https?:\/\/\S+?)\s*$/;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?.*)?$/i;

/** Per-paragraph scan cache. ProseMirror does structural sharing, so an
 * unchanged paragraph node retains its identity across transactions —
 * a WeakMap on the node lets us skip the regex pass for paragraphs the
 * user didn't touch. Same trick the diff overlay uses for word diffs. */
const scanCache = new WeakMap<PMNode, MediaToken[]>();

function scanParagraphTokens(node: PMNode): MediaToken[] {
	const cached = scanCache.get(node);
	if (cached) return cached;
	const text = node.textContent;
	const tokens: MediaToken[] = [];
	if (text) {
		// Inline images: any number per paragraph. Each match becomes one
		// thumbnail widget; multiple thumbnails stack vertically below
		// the line (rare in practice — usually one image per line).
		IMAGE_MD_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = IMAGE_MD_RE.exec(text)) !== null) {
			const src = match[2].trim();
			if (src) tokens.push({ kind: 'image', alt: match[1] ?? '', src });
		}
		// Bare image URL on its own line — still produces a thumbnail
		// widget. Non-image standalone URLs deliberately do NOT produce
		// block cards: the inline `.media-link-inline` decoration plus
		// the hover tooltip cover that case more lightly. Empty space
		// below a URL line was visually heavier than the link warranted.
		if (tokens.length === 0) {
			const bareMatch = text.match(STANDALONE_BARE_URL_RE);
			if (bareMatch) {
				const url = bareMatch[1].trim();
				if (IMAGE_EXT_RE.test(url)) {
					tokens.push({ kind: 'image', alt: '', src: url });
				}
			}
		}
	}
	scanCache.set(node, tokens);
	return tokens;
}

/** Walk the doc once and collect, for each top-level paragraph, the
 * tokens that should produce widgets and the position to attach them. */
function scanDoc(doc: PMNode): ParagraphMedia[] {
	const out: ParagraphMedia[] = [];
	let pos = 0;
	for (let i = 0; i < doc.childCount; i += 1) {
		const child = doc.child(i);
		const childPos = pos;
		const childEnd = childPos + child.nodeSize;
		// Plain-text editor only has paragraph nodes at the top level, but
		// guard anyway — anything non-paragraph (a stray block from a
		// future schema change) just gets skipped.
		if (child.type.name === 'paragraph') {
			const tokens = scanParagraphTokens(child);
			if (tokens.length > 0) {
				out.push({
					insertAt: childEnd,
					key: `${i}:${child.textContent.length}:${tokens.map(tokenKey).join('|')}`,
					tokens
				});
			}
		}
		pos = childEnd;
	}
	return out;
}

/** Walk every text node in the doc and pick out absolute URLs. Different
 * granularity from `scanDoc`: that runs per paragraph for block widgets,
 * this runs per text node for inline marks — a single paragraph can host
 * many inline URLs and we need PM positions for each. */
const INLINE_URL_RE = /https?:\/\/[^\s<>"'()]+/g;
/** Trailing punctuation that's almost never part of a URL but commonly
 * tails one in prose: "see https://example.com." should highlight the
 * URL only, not the period. */
const URL_TRAILING_TRIM_RE = /[.,;:!?)\]}]+$/;

/** First absolute http(s) URL in `text`, or null. Shared with the diff
 * overlay so proposed (green ghost) URL tokens get the same hover-card
 * affordance as live doc links. */
export function extractUrlFromText(text: string): string | null {
	INLINE_URL_RE.lastIndex = 0;
	const match = INLINE_URL_RE.exec(text);
	if (!match) return null;
	const trimmed = match[0].replace(URL_TRAILING_TRIM_RE, '');
	return trimmed || null;
}

/** When proposed diff text contains a URL, mark the element so the
 * media-overlay hover handler shows og metadata for the NEW url rather
 * than the live-doc inline mark (which still points at the old one). */
export function applyProposedLinkAttrs(el: HTMLElement, text: string): void {
	const url = extractUrlFromText(text);
	if (!url) return;
	el.classList.add('media-link-inline');
	el.dataset.url = url;
}

function scanInlineLinks(doc: PMNode): InlineLink[] {
	const out: InlineLink[] = [];
	doc.descendants((node, pos) => {
		if (!node.isText || !node.text) return true;
		const text = node.text;
		INLINE_URL_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = INLINE_URL_RE.exec(text)) !== null) {
			const raw = match[0];
			const trimmed = raw.replace(URL_TRAILING_TRIM_RE, '');
			if (!trimmed) continue;
			const from = pos + match.index;
			const to = from + trimmed.length;
			out.push({ from, to, url: trimmed });
		}
		return true;
	});
	return out;
}

function tokenKey(token: MediaToken): string {
	if (token.kind === 'image') return `img:${token.src}`;
	return `card:${token.url}`;
}

/** Resolve an image src for use in an `<img>` tag. http(s) URLs and
 * data: URIs go straight through; anything else is treated as a
 * workspace-relative path and routed through `/api/preview`. */
function resolveImageSrc(src: string): string {
	if (/^(https?:|data:|blob:)/i.test(src)) return src;
	return `/api/preview?path=${encodeURIComponent(src)}`;
}

/** Pull the visible domain off a URL for the card footer. Strips `www.`
 * because Substack does and it reads cleaner. Returns the raw URL on
 * parse failure (shouldn't happen — we filtered to http(s) upstream). */
function pickHostname(url: string): string {
	try {
		const host = new URL(url).hostname;
		return host.replace(/^www\./, '');
	} catch {
		return url;
	}
}

/** Build the thumbnail widget DOM. Non-editable, non-selectable, sized
 * to a comfortable max so a giant image doesn't dominate the editor. */
function renderImageWidget(token: ImageToken): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'media-widget media-image-widget';
	wrap.setAttribute('contenteditable', 'false');
	const img = document.createElement('img');
	img.className = 'media-thumb';
	img.loading = 'lazy';
	img.alt = token.alt;
	img.src = resolveImageSrc(token.src);
	img.draggable = false;
	// On 404 / decode error, fade the chrome so the user knows the image
	// isn't loading. The markdown source stays exactly as they wrote it.
	img.addEventListener('error', () => {
		wrap.classList.add('media-thumb-error');
		const note = document.createElement('div');
		note.className = 'media-thumb-error-label';
		note.textContent = `Couldn't load ${token.src}`;
		wrap.replaceChildren(note);
	});
	wrap.appendChild(img);
	return wrap;
}

/** Build the og card widget DOM. Renders a skeleton when og data is
 * still loading; renders the resolved card otherwise. The same DOM
 * node is replaced on each state change via `key` (set as a data
 * attribute) so PM doesn't recycle a stale skeleton when the fetch
 * resolves. */
function renderCardWidget(token: CardToken, og: OgState): HTMLElement {
	const wrap = document.createElement('a');
	wrap.className = 'media-widget media-card-widget';
	wrap.setAttribute('contenteditable', 'false');
	wrap.setAttribute('href', token.url);
	wrap.setAttribute('target', '_blank');
	wrap.setAttribute('rel', 'noreferrer noopener');
	wrap.dataset.state = og.kind;

	if (og.kind === 'loading') {
		wrap.appendChild(buildCardSkeleton(token));
		return wrap;
	}
	if (og.kind === 'error') {
		// Fall back to a tiny chrome that just shows the domain — the
		// markdown line itself is still a plain link, so we don't need
		// to be loud here.
		const minimal = document.createElement('div');
		minimal.className = 'media-card-minimal';
		minimal.textContent = pickHostname(token.url);
		wrap.appendChild(minimal);
		return wrap;
	}

	const data = og;
	const title = data.title || token.fallbackTitle || pickHostname(token.url);
	const description = data.description ?? '';
	const hostname = data.siteName || pickHostname(token.url);

	if (data.image) {
		const imgWrap = document.createElement('div');
		imgWrap.className = 'media-card-image';
		const img = document.createElement('img');
		img.src = data.image;
		img.alt = '';
		img.loading = 'lazy';
		img.draggable = false;
		img.addEventListener('error', () => imgWrap.remove());
		imgWrap.appendChild(img);
		wrap.appendChild(imgWrap);
	}

	const body = document.createElement('div');
	body.className = 'media-card-body';

	const titleEl = document.createElement('div');
	titleEl.className = 'media-card-title';
	titleEl.textContent = title;
	body.appendChild(titleEl);

	if (description) {
		const descEl = document.createElement('div');
		descEl.className = 'media-card-desc';
		descEl.textContent = description;
		body.appendChild(descEl);
	}

	const hostEl = document.createElement('div');
	hostEl.className = 'media-card-host';
	hostEl.textContent = hostname;
	body.appendChild(hostEl);

	wrap.appendChild(body);
	return wrap;
}

function buildCardSkeleton(token: CardToken): HTMLElement {
	const skeleton = document.createElement('div');
	skeleton.className = 'media-card-skeleton';
	const block = document.createElement('div');
	block.className = 'media-card-skeleton-image';
	skeleton.appendChild(block);
	const lines = document.createElement('div');
	lines.className = 'media-card-skeleton-body';
	for (const width of ['62%', '88%', '40%']) {
		const line = document.createElement('div');
		line.className = 'media-card-skeleton-line';
		line.style.width = width;
		lines.appendChild(line);
	}
	skeleton.appendChild(lines);
	const hostEl = document.createElement('div');
	hostEl.className = 'media-card-host';
	hostEl.textContent = pickHostname(token.url);
	skeleton.appendChild(hostEl);
	return skeleton;
}

function buildDecorations(state: MediaOverlayState, doc: PMNode): DecorationSet {
	const decorations: Decoration[] = [];
	for (const para of state.paragraphs) {
		// Defensive bounds check — `insertAt` was correct at scan time but
		// any drift between scan and decoration paint (concurrent agent
		// edit, undo) would otherwise throw inside PM.
		if (para.insertAt > doc.content.size) continue;
		for (let i = 0; i < para.tokens.length; i += 1) {
			const token = para.tokens[i];
			const widgetKey = `${para.key}#${i}`;
			if (token.kind === 'image') {
				decorations.push(
					Decoration.widget(para.insertAt, () => renderImageWidget(token), {
						side: 1,
						key: widgetKey,
						ignoreSelection: true
					})
				);
			} else {
				const og = state.ogByUrl.get(token.url) ?? { kind: 'loading' };
				decorations.push(
					Decoration.widget(para.insertAt, () => renderCardWidget(token, og), {
						side: 1,
						// Keying on og state means the widget node is re-built
						// when the fetch resolves — no manual DOM patching.
						key: `${widgetKey}@${og.kind}`,
						ignoreSelection: true
					})
				);
			}
		}
	}
	// Inline link marks. Both safe attributes (`class`, `data-url`) make
	// it trivially easy for the view-level hover handler to find the
	// hovered link's URL without any extra plugin state lookups.
	for (const link of state.inlineLinks) {
		if (link.from < 0 || link.to > doc.content.size) continue;
		decorations.push(
			Decoration.inline(link.from, link.to, {
				class: 'media-link-inline',
				'data-url': link.url
			})
		);
	}
	if (decorations.length === 0) return DecorationSet.empty;
	return DecorationSet.create(doc, decorations);
}

/** Side-channel for the view plugin: which URLs need a fetch right now.
 * Includes both standalone-line cards (block widgets) and inline link
 * marks — the latter so the hover tooltip is instant when the user
 * actually hovers. Pre-fetching means the first hover never sits on
 * the loading skeleton. */
function pickPendingUrls(state: MediaOverlayState): string[] {
	const want = new Set<string>();
	for (const para of state.paragraphs) {
		for (const token of para.tokens) {
			if (token.kind === 'card') want.add(token.url);
		}
	}
	for (const link of state.inlineLinks) {
		want.add(link.url);
	}
	const pending: string[] = [];
	for (const url of want) {
		if (!state.ogByUrl.has(url)) pending.push(url);
	}
	return pending;
}

interface OgFetchedMeta {
	readonly type: 'og-fetched';
	readonly url: string;
	readonly value: Exclude<OgState, { kind: 'loading' }>;
}

export const MediaOverlay = Extension.create({
	name: 'mediaOverlay',
	addProseMirrorPlugins() {
		return [
			new Plugin<MediaOverlayState>({
				key: mediaKey,
				state: {
					init: (_config, instance): MediaOverlayState => ({
						paragraphs: scanDoc(instance.doc),
						inlineLinks: scanInlineLinks(instance.doc),
						ogByUrl: new Map(),
						version: 0
					}),
					apply(tr, prev): MediaOverlayState {
						const meta = tr.getMeta(mediaKey) as OgFetchedMeta | undefined;
						let next = prev;
						if (tr.docChanged) {
							// `tr.doc` is the post-transaction doc — same as the
							// in-flight newState's doc but doesn't require us to
							// rely on partial-state semantics during construction.
							next = {
								...next,
								paragraphs: scanDoc(tr.doc),
								inlineLinks: scanInlineLinks(tr.doc)
							};
						}
						if (meta?.type === 'og-fetched') {
							const ogByUrl = new Map(next.ogByUrl);
							ogByUrl.set(meta.url, meta.value);
							next = { ...next, ogByUrl, version: next.version + 1 };
						}
						return next;
					}
				},
				props: {
					decorations(state) {
						const s = mediaKey.getState(state);
						if (!s) return null;
						return buildDecorations(s, state.doc);
					}
				},
				view(view: EditorView) {
					/** Fire fetches for any URL we don't yet have og data for.
					 * The plugin state's `ogByUrl` map answers "do we have
					 * data?"; a local `fired` Set guards against double-firing
					 * during the in-flight window before the fetch resolves
					 * and writes into `ogByUrl`. While `fired` says yes but
					 * `ogByUrl` says no, `decorations()` falls back to the
					 * `loading` skeleton — that's the correct UX. */
					const fired = new Set<string>();
					const fireFetches = (currentView: EditorView) => {
						const s = mediaKey.getState(currentView.state);
						if (!s) return;
						for (const url of pickPendingUrls(s)) {
							if (fired.has(url)) continue;
							fired.add(url);
							void fetchOgInto(currentView, url);
						}
					};
					// Initial pass once the editor mounts — the constructor
					// can't dispatch transactions, so do it on the next tick.
					queueMicrotask(() => fireFetches(view));

					// Hover-tooltip wiring. One persistent floating element
					// outside the editor's DOM tree (so the editor's overflow
					// + scroll boundaries can't clip it) gets shown/hidden
					// over inline `.media-link-inline` decorations. Hover
					// in: brief delay, then fetch og + render card. Hover
					// out: brief delay before hiding so the user can move
					// the cursor INTO the tooltip without it vanishing.
					const tooltip = document.createElement('div');
					tooltip.className = 'media-link-tooltip';
					tooltip.style.display = 'none';
					document.body.appendChild(tooltip);
					let hoverTimer: ReturnType<typeof setTimeout> | null = null;
					let hideTimer: ReturnType<typeof setTimeout> | null = null;
					let activeUrl: string | null = null;

					const positionTooltip = (anchor: DOMRect) => {
						const margin = 8;
						const vw = window.innerWidth;
						const vh = window.innerHeight;
						// Render once invisibly to measure, then position with
						// final coords. Otherwise a tooltip near the right edge
						// would overshoot the viewport before we can clamp it.
						tooltip.style.visibility = 'hidden';
						tooltip.style.display = 'block';
						const rect = tooltip.getBoundingClientRect();
						let left = anchor.left;
						let top = anchor.bottom + margin;
						if (left + rect.width > vw - margin) left = vw - margin - rect.width;
						if (left < margin) left = margin;
						if (top + rect.height > vh - margin) {
							const above = anchor.top - margin - rect.height;
							if (above >= margin) top = above;
							else top = Math.max(margin, vh - margin - rect.height);
						}
						tooltip.style.left = `${left}px`;
						tooltip.style.top = `${top}px`;
						tooltip.style.visibility = 'visible';
					};

					const renderTooltip = (url: string) => {
						const s = mediaKey.getState(view.state);
						const og = s?.ogByUrl.get(url) ?? { kind: 'loading' as const };
						tooltip.replaceChildren(
							renderCardWidget({ kind: 'card', url, fallbackTitle: url }, og)
						);
					};

					const showTooltip = (target: HTMLElement, url: string) => {
						if (hideTimer) {
							clearTimeout(hideTimer);
							hideTimer = null;
						}
						activeUrl = url;
						renderTooltip(url);
						positionTooltip(target.getBoundingClientRect());
						// Kick off og fetch if we don't yet have data — the
						// hover may be the first time anyone asked about
						// this URL (e.g., a long doc where we never scrolled
						// past it on initial mount).
						if (!fired.has(url)) {
							fired.add(url);
							void fetchOgInto(view, url);
						}
					};

					const hideTooltip = () => {
						tooltip.style.display = 'none';
						activeUrl = null;
					};

					const onMouseOver = (event: MouseEvent) => {
						const target = (event.target as HTMLElement | null)?.closest(
							'.media-link-inline'
						) as HTMLElement | null;
						if (!target) return;
						const url = target.dataset.url;
						if (!url) return;
						if (hoverTimer) clearTimeout(hoverTimer);
						hoverTimer = setTimeout(() => showTooltip(target, url), 280);
					};

					const onMouseOut = (event: MouseEvent) => {
						const fromLink = (event.target as HTMLElement | null)?.closest(
							'.media-link-inline'
						) as HTMLElement | null;
						if (!fromLink) return;
						const related = event.relatedTarget as HTMLElement | null;
						// Moving from the link into the tooltip itself or back
						// into the SAME link span (mouseout fires on each
						// child-element boundary inside a marked range): keep
						// it open. Only fire the hide timer when the cursor
						// has actually left this link.
						if (related && tooltip.contains(related)) return;
						if (related && fromLink.contains(related)) return;
						const relatedLink = related?.closest?.('.media-link-inline') as
							| HTMLElement
							| null;
						if (relatedLink && relatedLink.dataset.url === fromLink.dataset.url) {
							return;
						}
						if (hoverTimer) {
							clearTimeout(hoverTimer);
							hoverTimer = null;
						}
						if (hideTimer) clearTimeout(hideTimer);
						hideTimer = setTimeout(hideTooltip, 180);
					};

					tooltip.addEventListener('mouseenter', () => {
						if (hideTimer) {
							clearTimeout(hideTimer);
							hideTimer = null;
						}
					});
					tooltip.addEventListener('mouseleave', () => {
						if (hideTimer) clearTimeout(hideTimer);
						hideTimer = setTimeout(hideTooltip, 120);
					});

					view.dom.addEventListener('mouseover', onMouseOver);
					view.dom.addEventListener('mouseout', onMouseOut);

					return {
						update(currentView, prevState) {
							const before = mediaKey.getState(prevState);
							const after = mediaKey.getState(currentView.state);
							if (before === after) return;
							fireFetches(currentView);
							// If a tooltip is open and the og fetch we were
							// waiting for just landed, re-render in place so
							// the skeleton flips to the resolved card.
							if (activeUrl) renderTooltip(activeUrl);
						},
						destroy() {
							fired.clear();
							if (hoverTimer) clearTimeout(hoverTimer);
							if (hideTimer) clearTimeout(hideTimer);
							view.dom.removeEventListener('mouseover', onMouseOver);
							view.dom.removeEventListener('mouseout', onMouseOut);
							tooltip.remove();
						}
					};
				}
			})
		];
	}
});

/** og fetch + dispatch. Runs outside the PM transaction lifecycle —
 * the resolve dispatch is what makes the card flip from skeleton to
 * loaded chrome. */
async function fetchOgInto(view: EditorView, url: string): Promise<void> {
	let value: Exclude<OgState, { kind: 'loading' }>;
	try {
		const response = await fetch(`/api/opengraph?url=${encodeURIComponent(url)}`);
		const data = await response.json();
		if (data && typeof data === 'object' && 'error' in data) {
			value = { kind: 'error' };
		} else {
			value = {
				kind: 'loaded',
				title: typeof data?.title === 'string' ? data.title : null,
				description: typeof data?.description === 'string' ? data.description : null,
				image: typeof data?.image === 'string' ? data.image : null,
				siteName: typeof data?.siteName === 'string' ? data.siteName : null
			};
		}
	} catch {
		value = { kind: 'error' };
	}
	if (!view.dom) return;
	try {
		view.dispatch(
			view.state.tr.setMeta(mediaKey, { type: 'og-fetched', url, value } satisfies OgFetchedMeta)
		);
	} catch {
		/* editor destroyed mid-fetch; nothing to update */
	}
}

