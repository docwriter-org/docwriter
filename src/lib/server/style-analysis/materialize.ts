import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Window } from 'happy-dom';
import { Readability } from '@mozilla/readability';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { NormalizedDocument } from '$lib/style-profile';
import { DOCWRITER_DIR } from '$lib/server/document-files';
import { resolveWorkspacePath } from '$lib/server/workspace-path';
import { writeTextAtomic } from '$lib/server/file-utils';
import {
	REFERENCES_CACHE_DIR,
	getStyleReference,
	isSelected,
	listStyleReferences,
	updateStyleReference,
	type StyleReference
} from '$lib/server/references';
import { normalizeText } from './analyze-style.mjs';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export interface MaterializedReference {
	reference: StyleReference;
	text: string;
	format: string;
	contentHash: string;
	cachePath: string;
}

function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

function cacheAbsolutePath(id: string): string {
	return join(REFERENCES_CACHE_DIR, `${id}.txt`);
}

function cacheRelativePath(id: string): string {
	return `.docwriter/style-analysis/source-cache/${id}.txt`;
}

function ensureCacheDir() {
	if (!existsSync(REFERENCES_CACHE_DIR)) mkdirSync(REFERENCES_CACHE_DIR, { recursive: true });
}

function isPrivateIp(address: string): boolean {
	const normalized = address.replace(/^::ffff:/, '');
	if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
	if (/^(?:fc|fd|fe8|fe9|fea|feb)/i.test(normalized)) return true;
	const parts = normalized.split('.').map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false;
	return parts[0] === 10
		|| parts[0] === 127
		|| parts[0] === 0
		|| (parts[0] === 169 && parts[1] === 254)
		|| (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
		|| (parts[0] === 192 && parts[1] === 168);
}

async function assertSafeUrl(url: URL) {
	if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Reference URL must use HTTP or HTTPS');
	if (url.username || url.password) throw new Error('Reference URL cannot include credentials');
	const addresses = await lookup(url.hostname, { all: true });
	if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
		throw new Error('Reference URL cannot resolve to a private network address');
	}
}

async function readResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
	const length = Number(response.headers.get('content-length') ?? 0);
	if (length > limit) throw new Error(`Reference is larger than ${Math.round(limit / 1024 / 1024)} MB`);
	if (!response.body) return new Uint8Array(await response.arrayBuffer());
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = response.body.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw new Error(`Reference is larger than ${Math.round(limit / 1024 / 1024)} MB`);
		}
		chunks.push(value);
	}
	const output = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

/**
 * An arXiv /abs/ page is a landing page — title, authors, abstract, and nothing
 * of how the paper is actually written. Prefer the full-text HTML, and let the
 * caller fall back to the PDF when a paper has no HTML rendering.
 */
export function arxivFullTextUrls(url: string): string[] {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return [];
	}
	if (!/(^|\.)arxiv\.org$/i.test(parsed.hostname)) return [];
	const match = /^\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?$/i.exec(parsed.pathname);
	if (!match) return [];
	const id = match[1];
	return [
		`https://arxiv.org/html/${id}`,
		`https://ar5iv.labs.arxiv.org/html/${id}`,
		`https://arxiv.org/pdf/${id}`
	];
}

async function fetchReference(url: string): Promise<{ bytes: Uint8Array; contentType: string; finalUrl: string }> {
	// Try the full-text renderings first; the original URL remains the fallback.
	for (const candidate of arxivFullTextUrls(url)) {
		try {
			return await fetchDirect(candidate);
		} catch {
			// Not every paper has an HTML rendering — keep walking the list.
		}
	}
	return fetchDirect(url);
}

async function fetchDirect(url: string): Promise<{ bytes: Uint8Array; contentType: string; finalUrl: string }> {
	let current = new URL(url);
	for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
		await assertSafeUrl(current);
		const response = await fetch(current, {
			redirect: 'manual',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: { 'user-agent': 'DocWriter style reference reader/1.0' }
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (!location || redirect === MAX_REDIRECTS) throw new Error('Reference URL redirected too many times');
			current = new URL(location, current);
			continue;
		}
		if (!response.ok) throw new Error(`Reference URL returned HTTP ${response.status}`);
		const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
		const limit = contentType === 'application/pdf' || current.pathname.toLowerCase().endsWith('.pdf')
			? MAX_PDF_BYTES
			: MAX_HTML_BYTES;
		return { bytes: await readResponseBytes(response, limit), contentType, finalUrl: current.toString() };
	}
	throw new Error('Reference URL could not be fetched');
}

export function cleanLatex(source: string): string {
	return source
		.replace(/(^|[^\\])%.*$/gm, '$1')
		.replace(/\\(?:section)\*?\{([^}]*)\}/g, '# $1')
		.replace(/\\(?:subsection)\*?\{([^}]*)\}/g, '## $1')
		.replace(/\\(?:subsubsection)\*?\{([^}]*)\}/g, '### $1')
		.replace(/\\cite\w*\{([^}]*)\}/g, '[$1]')
		.replace(/\\footnote\{([^}]*)\}/g, ' $1 ')
		.replace(/\\(?:textbf|textit|emph|underline)\{([^}]*)\}/g, '$1')
		.replace(/\\begin\{[^}]+\}|\\end\{[^}]+\}/g, '\n')
		.replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?/g, '')
		.replace(/[{}]/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function extractHtml(html: string, url: string): string {
	const window = new Window({ url });
	window.document.write(html);
	const parsed = new Readability(window.document as unknown as Document).parse();
	const text = parsed?.textContent || window.document.body?.textContent || '';
	window.close();
	return text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function removeRepeatedPageEdges(pages: string[][]): string[][] {
	if (pages.length < 3) return pages;
	const counts = new Map<string, number>();
	for (const lines of pages) {
		for (const line of [...lines.slice(0, 3), ...lines.slice(-3)]) {
			const key = line.trim();
			if (key.length >= 3) counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	const repeated = new Set([...counts.entries()]
		.filter(([, count]) => count >= Math.ceil(pages.length * 0.6))
		.map(([line]) => line));
	return pages.map((lines) => lines.filter((line, index) => {
		const atEdge = index < 3 || index >= lines.length - 3;
		return !(atEdge && repeated.has(line.trim()));
	}));
}

export async function extractPdf(bytes: Uint8Array): Promise<string> {
	const loadingTask = getDocument({ data: bytes, useSystemFonts: true, disableFontFace: true });
	const pdf = await loadingTask.promise;
	const pages: string[][] = [];
	for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
		const page = await pdf.getPage(pageNumber);
		const content = await page.getTextContent();
		const lines: string[] = [];
		let current = '';
		let previousY: number | null = null;
		for (const item of content.items) {
			if (!('str' in item)) continue;
			const y: number | null = Array.isArray(item.transform) ? Number(item.transform[5]) : previousY;
			if (previousY !== null && y !== null && Math.abs(y - previousY) > 3 && current.trim()) {
				lines.push(current.trim());
				current = '';
			}
			current += `${current ? ' ' : ''}${item.str}`;
			previousY = y;
		}
		if (current.trim()) lines.push(current.trim());
		pages.push(lines);
	}
	return removeRepeatedPageEdges(pages).map((lines) => lines.join('\n')).join('\n\n').trim();
}

function detectLocalFormat(path: string): string {
	const extension = extname(path).slice(1).toLowerCase();
	if (extension === 'markdown') return 'md';
	if (extension === 'htm') return 'html';
	return extension || 'text';
}

async function readLocalReference(reference: StyleReference): Promise<{ text: string; format: string; sourceFingerprint: string }> {
	const absolute = reference.type === 'stored-sample'
		? join(DOCWRITER_DIR, reference.target.replace(/^\.docwriter\//, ''))
		: resolveWorkspacePath(reference.target);
	if (!existsSync(absolute)) throw new Error('Reference file no longer exists');
	const format = detectLocalFormat(absolute);
	const bytes = new Uint8Array(readFileSync(absolute));
	const sourceFingerprint = sha256(bytes);
	if (format === 'pdf') {
		return { text: await extractPdf(bytes), format, sourceFingerprint };
	}
	const raw = new TextDecoder().decode(bytes);
	if (format === 'html') return { text: extractHtml(raw, `file://${absolute}`), format, sourceFingerprint };
	if (['tex', 'latex', 'sty', 'cls'].includes(format)) return { text: cleanLatex(raw), format: 'tex', sourceFingerprint };
	return { text: raw.trim(), format, sourceFingerprint };
}

async function readUrlReference(reference: StyleReference): Promise<{ text: string; format: string; sourceFingerprint: string }> {
	const fetched = await fetchReference(reference.target);
	const sourceFingerprint = sha256(fetched.bytes);
	const isPdf = fetched.contentType === 'application/pdf' || new URL(fetched.finalUrl).pathname.toLowerCase().endsWith('.pdf');
	if (isPdf) return { text: await extractPdf(fetched.bytes), format: 'pdf', sourceFingerprint };
	const decoded = new TextDecoder().decode(fetched.bytes);
	if (fetched.contentType === 'text/plain') return { text: decoded.trim(), format: 'text', sourceFingerprint };
	if (fetched.contentType === 'text/html' || /<html|<article|<body/i.test(decoded)) {
		return { text: extractHtml(decoded, fetched.finalUrl), format: 'html', sourceFingerprint };
	}
	throw new Error(`Unsupported reference content type: ${fetched.contentType || 'unknown'}`);
}

export async function materializeStyleReference(id: string, force = false): Promise<MaterializedReference> {
	const reference = getStyleReference(id);
	if (!reference) throw new Error('Style reference not found');
	if (!force && reference.materializationStatus === 'ready' && reference.cachePath && reference.contentHash) {
		const cache = cacheAbsolutePath(reference.id);
		if (existsSync(cache)) {
			return { reference, text: readFileSync(cache, 'utf8'), format: reference.format ?? 'text', contentHash: reference.contentHash, cachePath: reference.cachePath };
		}
	}
	updateStyleReference(id, { materializationStatus: 'pending', error: undefined });
	try {
		const result = reference.type === 'url' ? await readUrlReference(reference) : await readLocalReference(reference);
		if (!result.text.trim()) throw new Error('Reference did not contain readable text');
		ensureCacheDir();
		const normalized = result.text.replace(/\r\n/g, '\n').trim();
		const contentHash = sha256(normalized);
		writeTextAtomic(cacheAbsolutePath(id), `${normalized}\n`);
		const updated = updateStyleReference(id, {
			format: result.format,
			contentHash,
			sourceFingerprint: result.sourceFingerprint,
			materializationStatus: 'ready',
			cachePath: cacheRelativePath(id),
			extractedAt: Date.now(),
			error: undefined
		});
		return { reference: updated, text: normalized, format: result.format, contentHash, cachePath: cacheRelativePath(id) };
	} catch (error) {
		updateStyleReference(id, {
			materializationStatus: 'error',
			error: error instanceof Error ? error.message : String(error)
		});
		throw error;
	}
}

export function updateMaterializedReferenceText(id: string, text: string): MaterializedReference {
	const reference = getStyleReference(id);
	if (!reference) throw new Error('Style reference not found');
	const normalized = text.replace(/\r\n/g, '\n').trim();
	if (!normalized) throw new Error('Reference text is required');
	ensureCacheDir();
	const contentHash = sha256(normalized);
	writeTextAtomic(cacheAbsolutePath(id), `${normalized}\n`);
	const updated = updateStyleReference(id, {
		contentHash,
		materializationStatus: 'ready',
		cachePath: cacheRelativePath(id),
		extractedAt: Date.now(),
		error: undefined
	});
	return { reference: updated, text: normalized, format: updated.format ?? 'text', contentHash, cachePath: cacheRelativePath(id) };
}

export async function materializeAllReferences(force = false): Promise<MaterializedReference[]> {
	// Rejected sources stay in the list but must not shape the style.
	const references = listStyleReferences().filter(isSelected);
	const results: MaterializedReference[] = [];
	for (const reference of references) results.push(await materializeStyleReference(reference.id, force));
	return results;
}

export function normalizedDocumentFromMaterialized(item: MaterializedReference): NormalizedDocument {
	return normalizeText({
		sourceId: item.reference.id,
		role: item.reference.role,
		format: item.format,
		text: item.text
	}) as NormalizedDocument;
}

export function referenceIsStale(reference: StyleReference): boolean {
	if (reference.materializationStatus !== 'ready' || !reference.contentHash) return true;
	if (reference.type === 'url') return false;
	try {
		const absolute = reference.type === 'stored-sample'
			? join(DOCWRITER_DIR, reference.target.replace(/^\.docwriter\//, ''))
			: resolveWorkspacePath(reference.target);
		if (!existsSync(absolute)) return true;
		if (reference.sourceFingerprint) {
			return sha256(new Uint8Array(readFileSync(absolute))) !== reference.sourceFingerprint;
		}
		const format = detectLocalFormat(absolute);
		if (format === 'pdf') return false;
		const raw = readFileSync(absolute, 'utf8');
		const normalized = ['tex', 'latex', 'sty', 'cls'].includes(format) ? cleanLatex(raw) : raw.trim();
		return sha256(normalized) !== reference.contentHash;
	} catch {
		return true;
	}
}
