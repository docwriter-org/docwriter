/**
 * /api/files — workspace directory listing for the FileTree UI.
 *
 * GET /api/files?path=<rel>  → one level of entries under `<rel>` (relative
 *                              to DOCWRITER_ROOT). Empty/missing → root.
 *
 * Security: the resolved absolute path is validated to stay inside
 * DOCWRITER_ROOT — refuses any `..` escapes, symlink targets, etc.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	existsSync,
	readdirSync,
	statSync,
	mkdirSync,
	writeFileSync,
	renameSync,
	rmSync
} from 'fs';
import { join, dirname } from 'path';
import { resolveWorkspacePath } from '$lib/server/workspace-path';
import { listDocuments, renameDocument } from '$lib/server/documents-store';
import { destroyTabState, unloadTabDoc, flushTabMarkdownNow } from '$lib/server/ws-server';
import { migrateTabCaches } from '$lib/server/ydoc-persistence';

/** Names we always hide from the tree — noise that obscures the writing
 * workspace. `.docwriter/` is intentionally NOT here; the user wants to
 * see it (its contents are often the target of rule / hook edits). */
const HIDDEN = new Set(['.git', 'node_modules', '.svelte-kit', 'build', '.DS_Store']);

interface Entry {
	name: string;
	kind: 'file' | 'folder';
	/** Relative to DOCWRITER_ROOT; forward-slash separated for URL use. */
	path: string;
	/** True for files in the `notes/` tree — the directory the agent reads
	 * from. Lets the client style agent-watched files differently. */
	watched: boolean;
	/** True for anything inside `.docwriter/` — the app's own state
	 * (SQLite DB, hooks.json, scratch files). Rendered with an accent. */
	internal: boolean;
}

export const GET: RequestHandler = async ({ url }) => {
	const relPath = url.searchParams.get('path') || '';
	const abs = resolveWorkspacePath(relPath);
	if (!existsSync(abs)) return json({ path: relPath, entries: [] });
	const stat = statSync(abs);
	if (!stat.isDirectory()) {
		return json({ path: relPath, entries: [] });
	}

	const names = readdirSync(abs);
	const entries: Entry[] = [];
	for (const name of names) {
		if (HIDDEN.has(name)) continue;
		const childAbs = join(abs, name);
		let childStat;
		try {
			childStat = statSync(childAbs);
		} catch {
			continue;
		}
		const kind: 'file' | 'folder' = childStat.isDirectory() ? 'folder' : 'file';
		const childRel = (relPath ? relPath + '/' : '') + name;
		entries.push({
			name,
			kind,
			path: childRel,
			watched: childRel === 'notes' || childRel.startsWith('notes/'),
			internal: ['.docwriter', '.agents', '.claude'].some(
				(prefix) => childRel === prefix || childRel.startsWith(prefix + '/')
			)
		});
	}

	// Folders first, then alphabetical.
	entries.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	return json({ path: relPath, entries });
};

/** POST /api/files { path, kind?: 'file'|'folder', content?: string, encoding?: 'base64' } —
 * create a file or folder at `path` (relative to DOCWRITER_ROOT). Parent
 * directories are created as needed. 409s if the target already exists.
 * Pass `encoding: 'base64'` with a base64-encoded `content` to write binary
 * files (e.g. PDFs, images) without corruption. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const relPath = typeof body.path === 'string' ? body.path.trim() : '';
	const kind: 'file' | 'folder' = body.kind === 'folder' ? 'folder' : 'file';
	if (!relPath) throw error(400, 'path required');
	const abs = resolveWorkspacePath(relPath);
	if (existsSync(abs)) throw error(409, `Already exists: ${relPath}`);
	if (kind === 'folder') {
		mkdirSync(abs, { recursive: true });
	} else {
		mkdirSync(dirname(abs), { recursive: true });
		const raw = typeof body.content === 'string' ? body.content : '';
		const buf = body.encoding === 'base64' ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf-8');
		writeFileSync(abs, buf);
	}
	return json({ ok: true, path: relPath, kind });
};

/** PATCH /api/files { from, to } — rename/move a file or folder within
 * the workspace. Both paths are safe-resolved. Every document row under the
 * moved path is re-keyed with it (flush → unload → rename row; the
 * yjs_updates FK cascade moves the log), so history, threads and
 * provenance follow the file and nothing orphans under the old id. */
export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const from = typeof body.from === 'string' ? body.from.trim() : '';
	const to = typeof body.to === 'string' ? body.to.trim() : '';
	if (!from || !to) throw error(400, 'from and to required');
	const absFrom = resolveWorkspacePath(from);
	const absTo = resolveWorkspacePath(to);
	if (!existsSync(absFrom)) throw error(404, `Not found: ${from}`);
	if (existsSync(absTo)) throw error(409, `Target exists: ${to}`);
	const wasDir = statSync(absFrom).isDirectory();
	const prefix = wasDir ? `${from}/` : null;
	const moved = listDocuments()
		.map((d) => d.tabId)
		.filter((id) => id === from || (prefix && id.startsWith(prefix)));
	for (const id of moved) {
		flushTabMarkdownNow(id);
		await unloadTabDoc(id);
	}
	mkdirSync(dirname(absTo), { recursive: true });
	renameSync(absFrom, absTo);
	for (const id of moved) {
		const newId = id === from ? to : `${to}/${id.slice(prefix!.length)}`;
		renameDocument(id, newId);
		migrateTabCaches(id, newId);
	}
	return json({ ok: true, from, to });
};

/** DELETE /api/files?path=<rel> — remove a file or recursively remove a
 * directory. */
export const DELETE: RequestHandler = async ({ url }) => {
	const relPath = url.searchParams.get('path') || '';
	if (!relPath) throw error(400, 'path required');
	const abs = resolveWorkspacePath(relPath);
	if (!existsSync(abs)) return json({ ok: true, path: relPath });
	const wasDir = statSync(abs).isDirectory();
	rmSync(abs, { recursive: true, force: true });

	// Every document whose id is (or is under) the deleted path — open OR
	// closed — must be torn down with it: backup, live-doc unload, and the
	// identity-row delete whose FK cascades the CRDT log. Otherwise
	// recreating the same path later resurrects the deleted content from
	// the stale yjs_updates log (and closed documents would dangle forever).
	const prefix = wasDir ? `${relPath}/` : null;
	const doomed = listDocuments()
		.map((d) => d.tabId)
		.filter((id) => id === relPath || (prefix && id.startsWith(prefix)));
	for (const id of doomed) {
		await destroyTabState(id);
	}

	return json({ ok: true, path: relPath });
};
