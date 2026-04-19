/**
 * /api/file-content — raw read/write for arbitrary files in the workspace.
 * Used by the "viewing" tabs surfaced from the FileTree (files outside
 * notes/ that aren't in the agent's context). Watched files still go
 * through /api/document.
 *
 * Path-traversal guarded: the resolved absolute path must stay inside
 * DOCWRITER_ROOT, or the endpoint 400s.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { resolveWorkspacePath } from '$lib/server/workspace-path';

const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB — prevents loading big binaries into the browser

export const GET: RequestHandler = async ({ url }) => {
	const relPath = url.searchParams.get('path') || '';
	if (!relPath) throw error(400, 'path required');
	const abs = resolveWorkspacePath(relPath);
	if (!existsSync(abs)) throw error(404, `Not found: ${relPath}`);
	const stat = statSync(abs);
	if (!stat.isFile()) throw error(400, `Not a file: ${relPath}`);
	if (stat.size > MAX_READ_BYTES) {
		return json({ path: relPath, content: '', truncated: true, size: stat.size });
	}
	const content = readFileSync(abs, 'utf-8');
	return json({ path: relPath, content, size: stat.size });
};

export const PUT: RequestHandler = async ({ url, request }) => {
	const relPath = url.searchParams.get('path') || '';
	if (!relPath) throw error(400, 'path required');
	const abs = resolveWorkspacePath(relPath);
	const body = await request.json();
	if (typeof body.content !== 'string') throw error(400, 'content required');
	writeFileSync(abs, body.content, 'utf-8');
	return json({ ok: true });
};
