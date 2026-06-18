/**
 * GET /api/hooks/preview-match?file=...
 *
 * Given an active tab path, return the preview output to open:
 *   1. A same-stem `.pdf` beside a `.tex` file (e.g. `main.tex` →
 *      `main.pdf`) when that PDF exists on disk — no hook required.
 *   2. Otherwise the first enabled hook whose `output` template resolves
 *      (pandoc HTML, etc.).
 *
 * Returns `{ outputPath: string | null }`. Null hides the Preview button.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolvePreviewOutputPath } from '$lib/server/preview-match';

export const GET: RequestHandler = async ({ url }) => {
	const file = url.searchParams.get('file') ?? '';
	return json({ outputPath: resolvePreviewOutputPath(file) });
};
