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
import { getTabsState, setTabsState } from '$lib/server/runtime-state';
import { destroyTabState } from '$lib/server/ws-server';

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
			internal: childRel === '.docwriter' || childRel.startsWith('.docwriter/')
		});
	}

	// Folders first, then alphabetical.
	entries.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	return json({ path: relPath, entries });
};

/** POST /api/files { path, kind?: 'file'|'folder', content?: string } —
 * create a file or folder at `path` (relative to DOCWRITER_ROOT). Parent
 * directories are created as needed. 409s if the target already exists. */
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
		writeFileSync(abs, typeof body.content === 'string' ? body.content : '', 'utf-8');
	}
	return json({ ok: true, path: relPath, kind });
};

/** PATCH /api/files { from, to } — rename/move a file or folder within
 * the workspace. Both paths are safe-resolved. */
export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const from = typeof body.from === 'string' ? body.from.trim() : '';
	const to = typeof body.to === 'string' ? body.to.trim() : '';
	if (!from || !to) throw error(400, 'from and to required');
	const absFrom = resolveWorkspacePath(from);
	const absTo = resolveWorkspacePath(to);
	if (!existsSync(absFrom)) throw error(404, `Not found: ${from}`);
	if (existsSync(absTo)) throw error(409, `Target exists: ${to}`);
	mkdirSync(dirname(absTo), { recursive: true });
	renameSync(absFrom, absTo);
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

	// Any open tab whose id is (or is under) the deleted path must also
	// have its Hocuspocus Document + CRDT log torn down — otherwise
	// recreating the same path later resurrects the deleted content from
	// the stale yjs_updates log.
	const prefix = wasDir ? `${relPath}/` : null;
	const state = getTabsState();
	const doomed = state.order.filter((id) => id === relPath || (prefix && id.startsWith(prefix)));
	if (doomed.length > 0) {
		for (const id of doomed) {
			await destroyTabState(id);
		}
		const remaining = state.order.filter((id) => !doomed.includes(id));
		let active = state.active && doomed.includes(state.active) ? null : state.active;
		if (!active && remaining.length > 0) active = remaining[0];
		setTabsState({ order: remaining, active });
	}

	return json({ ok: true, path: relPath });
};
