/**
 * /api/opengraph — server-side OpenGraph metadata fetcher.
 *
 * GET /api/opengraph?url=<absolute-url>
 *   → { url, title, description, image, siteName }
 *   → { url, error: '<reason>' }   (HTTP 200 — clients fall back to a plain
 *                                    link decoration; an error response code
 *                                    here would just spam the network panel)
 *
 * Why server-side? Two reasons:
 *
 *   1. CORS. Almost no third-party site sets CORS headers permitting an
 *      arbitrary localhost origin to read its `<head>`, so a browser fetch
 *      of `https://nytimes.com/article` from the editor would fail. The
 *      Node fetch on the server has no such constraint.
 *   2. We can cap the response size + parse a tiny window of the document
 *      head, instead of streaming a multi-MB article body into the client.
 *
 * The endpoint is intentionally permissive: it never throws, never echoes
 * a 5xx for an upstream failure. Clients treat absence of metadata as
 * "render the line as a plain markdown link" and move on.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Soft cap on response body. We only want the `<head>`; an article
 * body, image, or video stream wastes bandwidth and CPU on a regex pass
 * that won't find anything new past the closing `</head>` anyway. 256 KB
 * comfortably covers every real-world `<head>` I've seen. */
const MAX_BODY_BYTES = 256 * 1024;

/** Total time budget for the upstream fetch — paste-time UX has to feel
 * snappy. If a site is slow, we'd rather give up and show a plain link
 * than block the editor for 10s. */
const FETCH_TIMEOUT_MS = 5_000;

/** In-memory LRU. Each entry holds the resolved metadata (or an error
 * marker), the timestamp of the fetch, and an LRU position via Map's
 * insertion order. Re-getting an entry deletes + re-inserts it to bump
 * it to the most-recent slot. */
const CACHE_TTL_MS = 60 * 60 * 1_000;
const CACHE_MAX = 200;

interface OgMetadata {
	readonly url: string;
	readonly title: string | null;
	readonly description: string | null;
	readonly image: string | null;
	readonly siteName: string | null;
}

interface CacheEntry {
	readonly fetchedAt: number;
	readonly value: OgMetadata | { readonly url: string; readonly error: string };
}

const ogCache = new Map<string, CacheEntry>();

function readCache(key: string): CacheEntry | null {
	const hit = ogCache.get(key);
	if (!hit) return null;
	if (Date.now() - hit.fetchedAt > CACHE_TTL_MS) {
		ogCache.delete(key);
		return null;
	}
	ogCache.delete(key);
	ogCache.set(key, hit);
	return hit;
}

function writeCache(key: string, entry: CacheEntry): void {
	ogCache.set(key, entry);
	if (ogCache.size > CACHE_MAX) {
		const oldest = ogCache.keys().next().value;
		if (oldest !== undefined) ogCache.delete(oldest);
	}
}

/** Decode the small set of HTML entities that show up in title/description
 * meta tags. Going through a full HTML parser would be overkill — these
 * five cover ~99% of cases and are cheap. */
function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, '/')
		.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Pull the value of a `<meta property="og:foo" content="...">` (or
 * `name="..."` — Twitter card meta uses `name`, OG uses `property`) tag
 * out of an HTML head. Returns null if no match. The regex is tolerant
 * of attribute order and single/double quotes. */
function pickMeta(head: string, key: string): string | null {
	// Match either `property="key"` or `name="key"`, then `content="..."`,
	// in either order. Two regexes are easier to reason about than one
	// monster with backreferences.
	const propFirst = new RegExp(
		`<meta[^>]*?(?:property|name)=["']${key}["'][^>]*?content=["']([^"']*)["']`,
		'i'
	);
	const contentFirst = new RegExp(
		`<meta[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["']${key}["']`,
		'i'
	);
	const m1 = head.match(propFirst);
	if (m1?.[1]) return decodeHtmlEntities(m1[1]).trim() || null;
	const m2 = head.match(contentFirst);
	if (m2?.[1]) return decodeHtmlEntities(m2[1]).trim() || null;
	return null;
}

/** Fall back to the `<title>` element when no `og:title` / `twitter:title`
 * is present. Most sites include a `<title>`; only single-page apps that
 * render in JS sometimes don't. */
function pickTitleTag(head: string): string | null {
	const m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!m) return null;
	const inner = m[1].replace(/\s+/g, ' ').trim();
	return inner ? decodeHtmlEntities(inner) : null;
}

function resolveAgainstBase(value: string | null, base: string): string | null {
	if (!value) return null;
	try {
		return new URL(value, base).toString();
	} catch {
		return null;
	}
}

function parseOgFromHtml(html: string, requestedUrl: string): OgMetadata {
	// Trim to the head — most metadata lives there, and bounding the
	// regex input keeps latency stable on long pages.
	const headEnd = html.search(/<\/head\s*>/i);
	const head = headEnd > 0 ? html.slice(0, headEnd) : html.slice(0, 32 * 1024);
	const title =
		pickMeta(head, 'og:title') ?? pickMeta(head, 'twitter:title') ?? pickTitleTag(head);
	const description =
		pickMeta(head, 'og:description') ??
		pickMeta(head, 'twitter:description') ??
		pickMeta(head, 'description');
	const rawImage = pickMeta(head, 'og:image') ?? pickMeta(head, 'twitter:image');
	const image = resolveAgainstBase(rawImage, requestedUrl);
	const siteName = pickMeta(head, 'og:site_name');
	return { url: requestedUrl, title, description, image, siteName };
}

/** Read at most `MAX_BODY_BYTES` from the response body and return the
 * decoded string. We use the streaming reader so a multi-MB article
 * doesn't get fully buffered before we slice. */
async function readBoundedBody(response: Response): Promise<string> {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: false });
	let total = 0;
	let collected = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		collected += decoder.decode(value, { stream: true });
		if (total >= MAX_BODY_BYTES) {
			try {
				await reader.cancel();
			} catch {
				/* upstream already closed; ignore */
			}
			break;
		}
	}
	collected += decoder.decode();
	return collected;
}

async function fetchOgMetadata(targetUrl: string): Promise<OgMetadata | { error: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(targetUrl, {
			method: 'GET',
			redirect: 'follow',
			signal: controller.signal,
			headers: {
				// Identifying as a real browser improves hit rate against sites
				// that gate metadata behind a UA check (Twitter, LinkedIn).
				'User-Agent':
					'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
					'(KHTML, like Gecko) Chrome/120.0 Safari/537.36 DocWriter/1.0',
				Accept: 'text/html,application/xhtml+xml',
				'Accept-Language': 'en-US,en;q=0.9'
			}
		});
		if (!response.ok) {
			return { error: `Upstream ${response.status}` };
		}
		const contentType = response.headers.get('content-type') ?? '';
		if (!/text\/html|application\/xhtml/i.test(contentType)) {
			return { error: `Non-HTML content-type: ${contentType.split(';')[0] || 'unknown'}` };
		}
		const body = await readBoundedBody(response);
		return parseOgFromHtml(body, response.url || targetUrl);
	} catch (err: unknown) {
		const message =
			err instanceof Error
				? err.name === 'AbortError'
					? 'Timeout'
					: err.message
				: 'Fetch failed';
		return { error: message };
	} finally {
		clearTimeout(timer);
	}
}

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

export const GET: RequestHandler = async ({ url }) => {
	const target = url.searchParams.get('url') ?? '';
	if (!target) throw error(400, 'url required');
	if (!isHttpUrl(target)) {
		return json({ url: target, error: 'Only http(s) URLs are supported' });
	}
	const cached = readCache(target);
	if (cached) {
		return json(cached.value);
	}
	const result = await fetchOgMetadata(target);
	const value =
		'error' in result
			? { url: target, error: result.error }
			: result;
	writeCache(target, { fetchedAt: Date.now(), value });
	return json(value);
};
