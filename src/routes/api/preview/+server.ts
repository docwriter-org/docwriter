/**
 * /api/preview?path=... — serves a file from the workspace for the
 * preview window. Used by:
 *   - The preview SvelteKit route (PDFs, HTML, images)
 *   - The bundled PDF.js viewer's `?file=` parameter
 *
 * Path safety: the requested path is resolved to an absolute path and
 * verified to live under DOCWRITER_ROOT. Anything else returns 403.
 * Symlinks-out-of-root are blocked by the realpath check.
 *
 * No caching headers — the preview window cache-busts via a `?v=` query
 * param, but this endpoint always serves the freshest bytes on disk.
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { extname, isAbsolute, resolve } from 'path';
import { WORKSPACE_ROOT } from '$lib/server/document-files';

const MIME_BY_EXT: Record<string, string> = {
	'.pdf': 'application/pdf',
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.txt': 'text/plain; charset=utf-8',
	'.md': 'text/plain; charset=utf-8'
};

function resolveSafe(requested: string): string | null {
	const abs = isAbsolute(requested) ? requested : resolve(WORKSPACE_ROOT, requested);
	// Resolve through symlinks so we can't be tricked into escaping
	// DOCWRITER_ROOT via a symlink under a workspace dir.
	let real: string;
	try {
		real = realpathSync(abs);
	} catch {
		return null;
	}
	const rootReal = (() => {
		try {
			return realpathSync(WORKSPACE_ROOT);
		} catch {
			return WORKSPACE_ROOT;
		}
	})();
	if (real !== rootReal && !real.startsWith(rootReal + '/')) return null;
	return real;
}

export const GET: RequestHandler = async ({ url }) => {
	const requested = url.searchParams.get('path');
	if (!requested) throw error(400, 'path query parameter is required');
	const real = resolveSafe(requested);
	if (!real) throw error(403, 'path is outside the workspace or does not exist');
	if (!existsSync(real)) throw error(404, 'file not found');
	const stat = statSync(real);
	if (!stat.isFile()) throw error(400, 'path is not a file');
	const ext = extname(real).toLowerCase();
	const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
	const body = readFileSync(real);
	return new Response(body, {
		headers: {
			'Content-Type': contentType,
			'Content-Length': String(body.byteLength),
			'Cache-Control': 'no-store',
			// Allow the PDF.js viewer (loaded from /pdfjs/web/viewer.html
			// in the same origin) to fetch this file.
			'X-Content-Type-Options': 'nosniff'
		}
	});
};
