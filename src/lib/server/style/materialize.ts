/**
 * Materialize style references into plain text for analysis.
 * Supports workspace files, stored samples, pasted text, URLs (HTML/text/PDF).
 */
import { createHash } from 'crypto';
import { lookup as dnsLookup } from 'dns/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, extname, join, resolve } from 'path';
import { isIP } from 'net';
import { DOCWRITER_DIR } from '../document-files';
import { resolveWorkspacePath } from '../workspace-path';
import type { StyleReference } from '../references';
import type { ReferenceRole } from './schemas';

export const STYLE_CACHE_DIR = join(DOCWRITER_DIR, 'references', 'cache');

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'metadata', 'metadata.google.internal']);

export type MaterializedSource = {
	sourceId: string;
	role: ReferenceRole;
	label: string;
	type: StyleReference['type'] | 'paste';
	target: string;
	format: string;
	contentHash: string;
	text: string;
	cachePath?: string;
	extractedAt: number;
	error?: string;
};

function ensureCacheDir() {
	if (!existsSync(STYLE_CACHE_DIR)) mkdirSync(STYLE_CACHE_DIR, { recursive: true });
}

export function contentHash(text: string): string {
	return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function stripHtml(html: string): string {
	let t = html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
		.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
	// Prefer article/main if present
	const article = t.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? t.match(/<main[\s\S]*?<\/main>/i)?.[0];
	if (article) t = article;
	t = t
		.replace(/<\/(p|div|h[1-6]|li|tr|br|blockquote)>/gi, '\n')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<li[^>]*>/gi, '- ')
		.replace(/<h([1-6])[^>]*>/gi, (_, n) => `${'#'.repeat(Number(n))} `)
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
	return t;
}

/** Very light PDF text extraction: pull printable strings from content streams. */
export function extractPdfText(buf: Buffer): string {
	const raw = buf.toString('latin1');
	const chunks: string[] = [];
	const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
	let m: RegExpExecArray | null;
	while ((m = streamRe.exec(raw))) {
		const body = m[1];
		// Tj / TJ string operands
		const tj = /(?:\((?:\\.|[^\\)])*\)|\<(?:[0-9A-Fa-f]{2})*\>)\s*Tj/g;
		let tm: RegExpExecArray | null;
		while ((tm = tj.exec(body))) {
			const token = tm[0].replace(/\s*Tj$/, '');
			if (token.startsWith('(')) {
				chunks.push(
					token
						.slice(1, -1)
						.replace(/\\n/g, '\n')
						.replace(/\\r/g, '')
						.replace(/\\t/g, '\t')
						.replace(/\\\(/g, '(')
						.replace(/\\\)/g, ')')
						.replace(/\\\\/g, '\\')
				);
			}
		}
		const tjArr = /\[(.*?)\]\s*TJ/gs;
		let am: RegExpExecArray | null;
		while ((am = tjArr.exec(body))) {
			const parts = am[1].match(/\((?:\\.|[^\\)])*\)/g) ?? [];
			for (const p of parts) {
				chunks.push(
					p
						.slice(1, -1)
						.replace(/\\n/g, '\n')
						.replace(/\\\(/g, '(')
						.replace(/\\\)/g, ')')
						.replace(/\\\\/g, '\\')
				);
			}
		}
	}
	const text = chunks.join(' ').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
	return text;
}

function detectFormat(pathOrUrl: string, contentType?: string | null): string {
	const lower = pathOrUrl.toLowerCase();
	if (contentType?.includes('pdf') || lower.endsWith('.pdf')) return 'pdf';
	if (contentType?.includes('html') || lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
	if (lower.endsWith('.tex') || lower.endsWith('.latex')) return 'latex';
	if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')) return 'markdown';
	if (contentType?.includes('text/plain') || lower.endsWith('.txt')) return 'text';
	return 'text';
}

function isPrivateIpv4(host: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return false;
	const parts = m.slice(1).map(Number);
	if (parts.some((n) => n > 255)) return true; // treat invalid as blocked
	const [a, b] = parts;
	if (a === 10) return true;
	if (a === 127) return true;
	if (a === 0) return true;
	if (a === 169 && b === 254) return true;
	if (a === 192 && b === 168) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	return false;
}

function isPrivateIpv6(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, '');
	if (h === '::1' || h === '::') return true;
	// IPv4-mapped IPv6 (:ffff:x.x.x.x)
	const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
	if (mapped) return isPrivateIpv4(mapped[1]);
	// Unique local fc00::/7, link-local fe80::/10
	if (h.startsWith('fc') || h.startsWith('fd')) return true;
	if (/^fe[89ab]/i.test(h)) return true;
	return false;
}

export function isPrivateUrl(url: URL): boolean {
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (BLOCKED_HOSTS.has(host)) return true;
	if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
		return true;
	}
	const ipVersion = isIP(host);
	if (ipVersion === 4) return isPrivateIpv4(host);
	if (ipVersion === 6) return isPrivateIpv6(host);
	// Hostname that looks like a dotted quad already handled; block obvious private patterns
	if (isPrivateIpv4(host) || isPrivateIpv6(host)) return true;
	return false;
}

async function assertPublicHostname(hostname: string): Promise<void> {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
		throw new Error('Private network URLs are blocked');
	}
	const ipVersion = isIP(host);
	if (ipVersion === 4 && isPrivateIpv4(host)) throw new Error('Private network URLs are blocked');
	if (ipVersion === 6 && isPrivateIpv6(host)) throw new Error('Private network URLs are blocked');
	if (ipVersion) return;

	let addresses: string[];
	try {
		const results = await dnsLookup(host, { all: true, verbatim: true });
		addresses = results.map((r) => r.address);
	} catch {
		throw new Error('Unable to resolve URL host');
	}
	if (!addresses.length) throw new Error('Unable to resolve URL host');
	for (const addr of addresses) {
		const v = isIP(addr);
		if (v === 4 && isPrivateIpv4(addr)) throw new Error('Private network URLs are blocked');
		if (v === 6 && isPrivateIpv6(addr)) throw new Error('Private network URLs are blocked');
	}
}

/** True when cachePath resolves under STYLE_CACHE_DIR. */
export function isStyleCachePath(cachePath: string): boolean {
	try {
		const abs = resolve(cachePath);
		const root = resolve(STYLE_CACHE_DIR);
		return abs === root || abs.startsWith(root + '/');
	} catch {
		return false;
	}
}

async function fetchUrl(urlStr: string): Promise<{ text: string; format: string; cachePath: string }> {
	ensureCacheDir();
	const url = new URL(urlStr);
	if (!/^https?:$/i.test(url.protocol)) throw new Error('Only http(s) URLs are supported');
	if (isPrivateUrl(url)) throw new Error('Private network URLs are blocked');
	await assertPublicHostname(url.hostname);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(urlStr, {
			signal: controller.signal,
			redirect: 'manual',
			headers: { 'User-Agent': 'DocWriterStyleBot/1.0' }
		});
		// Follow a small number of redirects with re-validation (anti-SSRF).
		let finalRes = res;
		let hops = 0;
		let currentUrl = url;
		while (finalRes.status >= 300 && finalRes.status < 400 && hops < 3) {
			const loc = finalRes.headers.get('location');
			if (!loc) break;
			const next = new URL(loc, currentUrl);
			if (!/^https?:$/i.test(next.protocol)) throw new Error('Redirect to unsupported protocol');
			if (isPrivateUrl(next)) throw new Error('Redirected to private network');
			await assertPublicHostname(next.hostname);
			currentUrl = next;
			finalRes = await fetch(next.toString(), {
				signal: controller.signal,
				redirect: 'manual',
				headers: { 'User-Agent': 'DocWriterStyleBot/1.0' }
			});
			hops++;
		}
		if (!finalRes.ok) throw new Error(`Fetch failed: ${finalRes.status}`);
		const contentType = finalRes.headers.get('content-type');
		const buf = Buffer.from(await finalRes.arrayBuffer());
		if (buf.length > MAX_BYTES) throw new Error('Response exceeds size limit');
		const format = detectFormat(currentUrl.toString(), contentType);
		let text: string;
		if (format === 'pdf') text = extractPdfText(buf);
		else if (format === 'html') text = stripHtml(buf.toString('utf-8'));
		else text = buf.toString('utf-8');
		if (!text.trim()) throw new Error('No extractable text');
		const hash = contentHash(text);
		const cachePath = join(STYLE_CACHE_DIR, `${hash}.txt`);
		writeFileSync(cachePath, text, 'utf-8');
		return { text, format, cachePath };
	} finally {
		clearTimeout(timer);
	}
}

function readWorkspaceFile(target: string): { text: string; format: string } {
	const abs = resolveWorkspacePath(target);
	const buf = readFileSync(abs);
	const format = detectFormat(target);
	if (format === 'pdf') return { text: extractPdfText(buf), format };
	if (format === 'html') return { text: stripHtml(buf.toString('utf-8')), format };
	return { text: buf.toString('utf-8'), format };
}

function fromCache(ref: StyleReference, role: ReferenceRole): MaterializedSource | null {
	if (!ref.cachePath || !isStyleCachePath(ref.cachePath) || !existsSync(ref.cachePath)) {
		return null;
	}
	const text = readFileSync(ref.cachePath, 'utf-8');
	if (!text.trim()) return null;
	return {
		sourceId: ref.id,
		role,
		label: ref.label,
		type: ref.type,
		target: ref.target,
		format: ref.format ?? detectFormat(ref.target),
		text,
		cachePath: ref.cachePath,
		contentHash: ref.contentHash || contentHash(text),
		extractedAt: ref.extractedAt ?? Date.now()
	};
}

export async function materializeReference(
	ref: StyleReference,
	role: ReferenceRole = (ref.role as ReferenceRole) || 'authored'
): Promise<MaterializedSource> {
	const base = {
		sourceId: ref.id,
		role,
		label: ref.label,
		type: ref.type,
		target: ref.target,
		extractedAt: Date.now()
	};
	try {
		// Prefer user-corrected / previously extracted cache when present.
		const cached = fromCache(ref, role);
		if (cached) return cached;

		if (ref.type === 'url') {
			const { text, format, cachePath } = await fetchUrl(ref.target);
			return {
				...base,
				format,
				text,
				cachePath,
				contentHash: contentHash(text)
			};
		}
		const { text, format } = readWorkspaceFile(ref.target);
		const hash = contentHash(text);
		const cachePath = writeCachedExtraction(text);
		return { ...base, format, text, cachePath, contentHash: hash };
	} catch (err) {
		return {
			...base,
			format: 'unknown',
			text: '',
			contentHash: '',
			error: (err as Error).message
		};
	}
}

export async function materializePaste(
	name: string,
	content: string,
	role: ReferenceRole
): Promise<MaterializedSource> {
	const text = content.trim();
	if (!text) throw new Error('Paste content is required');
	const hash = contentHash(text);
	return {
		sourceId: `paste_${hash}`,
		role,
		label: name || 'Pasted sample',
		type: 'paste',
		target: `paste://${basename(name || 'sample')}`,
		format: 'text',
		contentHash: hash,
		text,
		extractedAt: Date.now()
	};
}

export function readCachedExtraction(cachePath: string): string | null {
	if (!isStyleCachePath(cachePath) || !existsSync(cachePath)) return null;
	return readFileSync(cachePath, 'utf-8');
}

export function writeCachedExtraction(text: string): string {
	ensureCacheDir();
	const hash = contentHash(text);
	const cachePath = join(STYLE_CACHE_DIR, `${hash}.txt`);
	writeFileSync(cachePath, text, 'utf-8');
	return cachePath;
}

export function formatFromPath(path: string): string {
	return detectFormat(path);
}

export { extname };
