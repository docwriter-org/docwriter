/**
 * /api/synctex — bidirectional SyncTeX lookup.
 *
 * Two modes (body.mode):
 *   - 'backward' (default, used by the preview's PDF dblclick): PDF
 *     coords → source file + line. Shells out to
 *     `synctex edit -o "<page>:<x>:<y>:<pdf>"` and parses Input:/Line:.
 *   - 'forward' (used by the editor's "Show in PDF" action): source
 *     file + line → PDF page + bounding box. Shells out to
 *     `synctex view -i "<line>:<col>:<file>" -o <pdf>` and parses
 *     Page:/x:/y:/h:/v:/W:/H:.
 *
 * Both modes rely on the `.synctex.gz` file produced by pdflatex
 * `-synctex=1` (already in the docwriter pdflatex preset).
 *
 * Path safety: `pdf` query param must resolve under DOCWRITER_ROOT; the
 * returned source path is also constrained to the workspace before we
 * report it back. Synctex output that points outside the workspace
 * (system .sty includes, for example) is dropped to {error: 'outside-
 * workspace'} rather than relayed.
 *
 * Synctex output format (one block, line-oriented):
 *   SyncTeX result begin
 *   Output:<pdf path>
 *   Page:<n>
 *   x:<n>
 *   y:<n>
 *   ...
 *   Input:<absolute source path>
 *   Line:<n>
 *   Column:<n>
 *   ...
 *   SyncTeX result end
 *
 * We parse the first `Input:` and `Line:` after the begin marker.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { WORKSPACE_ROOT } from '$lib/server/document-files';

interface SynctexBackwardHit {
	file: string;
	line: number;
}

interface SynctexForwardHit {
	page: number;
	x: number;
	y: number;
	h: number;
	v: number;
	w: number;
	height: number;
}

function workspaceContains(absPath: string): boolean {
	let real: string;
	try {
		real = realpathSync(absPath);
	} catch {
		return false;
	}
	const rootReal = (() => {
		try {
			return realpathSync(WORKSPACE_ROOT);
		} catch {
			return WORKSPACE_ROOT;
		}
	})();
	return real === rootReal || real.startsWith(rootReal + '/');
}

function runSynctexBackward(pdf: string, page: number, x: number, y: number): Promise<string> {
	return new Promise((resolveProm) => {
		const arg = `${page}:${x}:${y}:${pdf}`;
		const child = spawn('synctex', ['edit', '-o', arg], {
			cwd: WORKSPACE_ROOT,
			env: process.env
		});
		let stdout = '';
		child.stdout?.on('data', (c) => (stdout += c.toString()));
		child.on('error', () => resolveProm(''));
		child.on('exit', () => resolveProm(stdout));
	});
}

function runSynctexForward(
	file: string,
	line: number,
	column: number,
	pdf: string
): Promise<string> {
	return new Promise((resolveProm) => {
		const arg = `${line}:${column}:${file}`;
		const child = spawn('synctex', ['view', '-i', arg, '-o', pdf], {
			cwd: WORKSPACE_ROOT,
			env: process.env
		});
		let stdout = '';
		child.stdout?.on('data', (c) => (stdout += c.toString()));
		child.on('error', () => resolveProm(''));
		child.on('exit', () => resolveProm(stdout));
	});
}

function parseSynctexBackward(text: string): SynctexBackwardHit | null {
	const begin = text.indexOf('SyncTeX result begin');
	if (begin < 0) return null;
	const end = text.indexOf('SyncTeX result end', begin);
	const block = end > begin ? text.slice(begin, end) : text.slice(begin);
	let file: string | null = null;
	let line: number | null = null;
	for (const raw of block.split('\n')) {
		const t = raw.trim();
		if (t.startsWith('Input:')) {
			// Synctex may emit the Input line with surrounding whitespace
			// or a leading/trailing colon-separated descriptor depending on
			// version; trim aggressively.
			const v = t.slice('Input:'.length).trim();
			if (v && !file) file = v;
		} else if (t.startsWith('Line:')) {
			const v = parseInt(t.slice('Line:'.length).trim(), 10);
			if (Number.isFinite(v) && v > 0 && line === null) line = v;
		}
		if (file && line !== null) break;
	}
	if (!file || line === null) return null;
	return { file, line };
}

function parseSynctexForward(text: string): SynctexForwardHit | null {
	const begin = text.indexOf('SyncTeX result begin');
	if (begin < 0) return null;
	const end = text.indexOf('SyncTeX result end', begin);
	const block = end > begin ? text.slice(begin, end) : text.slice(begin);
	let page: number | null = null;
	let x = 0,
		y = 0,
		h = 0,
		v = 0,
		w = 0,
		height = 0;
	for (const raw of block.split('\n')) {
		const t = raw.trim();
		if (t.startsWith('Page:') && page === null) {
			const n = parseInt(t.slice('Page:'.length).trim(), 10);
			if (Number.isFinite(n) && n > 0) page = n;
		} else if (t.startsWith('x:')) {
			x = parseFloat(t.slice('x:'.length).trim());
		} else if (t.startsWith('y:')) {
			y = parseFloat(t.slice('y:'.length).trim());
		} else if (t.startsWith('h:')) {
			h = parseFloat(t.slice('h:'.length).trim());
		} else if (t.startsWith('v:')) {
			v = parseFloat(t.slice('v:'.length).trim());
		} else if (t.startsWith('W:')) {
			w = parseFloat(t.slice('W:'.length).trim());
		} else if (t.startsWith('H:')) {
			height = parseFloat(t.slice('H:'.length).trim());
		}
	}
	if (page === null) return null;
	return { page, x, y, h, v, w, height };
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const mode = body?.mode === 'forward' ? 'forward' : 'backward';
	const pdf = typeof body?.pdf === 'string' ? body.pdf : '';
	if (!pdf) throw error(400, 'pdf is required');
	const absPdf = isAbsolute(pdf) ? pdf : resolve(WORKSPACE_ROOT, pdf);
	if (!existsSync(absPdf) || !workspaceContains(absPdf)) {
		throw error(403, 'pdf is outside the workspace or does not exist');
	}

	if (mode === 'backward') {
		const page = Number(body?.page);
		const x = Number(body?.x);
		const y = Number(body?.y);
		if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
			throw error(400, 'backward mode requires page, x, y');
		}
		const out = await runSynctexBackward(absPdf, Math.round(page), x, y);
		const hit = parseSynctexBackward(out);
		if (!hit) return json({ ok: false, reason: 'no-match' });
		const absFile = isAbsolute(hit.file) ? hit.file : resolve(WORKSPACE_ROOT, hit.file);
		if (!workspaceContains(absFile)) return json({ ok: false, reason: 'outside-workspace' });
		return json({ ok: true, file: relative(WORKSPACE_ROOT, absFile), line: hit.line });
	}

	// Forward mode: editor source → PDF page + bounding box.
	const file = typeof body?.file === 'string' ? body.file : '';
	const line = Number(body?.line);
	const column = Number.isFinite(Number(body?.column)) ? Number(body.column) : 0;
	if (!file || !Number.isFinite(line) || line < 1) {
		throw error(400, 'forward mode requires file, line');
	}
	const absFile = isAbsolute(file) ? file : resolve(WORKSPACE_ROOT, file);
	if (!workspaceContains(absFile)) {
		throw error(403, 'file is outside the workspace');
	}
	const out = await runSynctexForward(absFile, Math.round(line), Math.round(column), absPdf);
	const hit = parseSynctexForward(out);
	if (!hit) return json({ ok: false, reason: 'no-match' });
	return json({ ok: true, ...hit });
};
