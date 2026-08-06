/**
 * Materialize style references into plain text for analysis.
 * Supports workspace files, stored samples, pasted text, URLs (HTML/text/PDF).
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { DOCWRITER_DIR } from '../document-files';
import { resolveWorkspacePath } from '../workspace-path';
import type { StyleReference } from '../references';
import type { ReferenceRole } from './schemas';

export const STYLE_CACHE_DIR = join(DOCWRITER_DIR, 'references', 'cache');

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

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

function isPrivateUrl(url: URL): boolean {
	const host = url.hostname.toLowerCase();
	if (BLOCKED_HOSTS.has(host)) return true;
	if (host.endsWith('.local') || host.endsWith('.internal')) return true;
	if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
		return true;
	}
	return false;
}

async function fetchUrl(urlStr: string): Promise<{ text: string; format: string; cachePath: string }> {
	ensureCacheDir();
	const url = new URL(urlStr);
	if (!/^https?:$/i.test(url.protocol)) throw new Error('Only http(s) URLs are supported');
	if (isPrivateUrl(url)) throw new Error('Private network URLs are blocked');

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(urlStr, {
			signal: controller.signal,
			redirect: 'follow',
			headers: { 'User-Agent': 'DocWriterStyleBot/1.0' }
		});
		if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
		if ((res.redirected ? new URL(res.url) : url) && isPrivateUrl(new URL(res.url))) {
			throw new Error('Redirected to private network');
		}
		const contentType = res.headers.get('content-type');
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > MAX_BYTES) throw new Error('Response exceeds size limit');
		const format = detectFormat(res.url, contentType);
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
		return { ...base, format, text, contentHash: contentHash(text) };
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
	if (!existsSync(cachePath)) return null;
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
