import { json, error } from '@sveltejs/kit';
import { existsSync, unlinkSync, renameSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { RequestHandler } from './$types';
import {
	isValidTabId,
	tabFile,
	ensureDocWriterDir
} from '$lib/server/document-files';
import { getTabsState, setTabsState } from '$lib/server/runtime-state';
import { writeTextAtomic } from '$lib/server/file-utils';
import { destroyTabState } from '$lib/server/ws-server';

/** GET /api/tabs  →  { order, active, tabs: string[] }
 *
 * The tabs list is the source of truth now (was: scan notes/). If a
 * tab's file no longer exists on disk (user deleted it externally), we
 * drop it from the list. */
export const GET: RequestHandler = async () => {
	const state = reconcileTabsState();
	return json({
		order: state.order,
		active: state.active,
		tabs: state.order
	});
};

/** POST /api/tabs  body: { id: string }  →  open or create a tab.
 *
 * `id` is a workspace-relative path (e.g. "drafts/chapter-1.md" or
 * "script.py"). If the file already exists, just registers the tab. If
 * it doesn't, creates the file (seeded with a heading for markdown,
 * empty for everything else) plus any missing parent directories.
 *
 * Idempotent: opening an already-registered tab just marks it active. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const id = String(body?.id || '').trim();
	if (!isValidTabId(id)) {
		throw error(400, 'Invalid tab id. Must be a workspace-relative path.');
	}
	ensureDocWriterDir();
	const path = tabFile(id);
	if (!existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true });
		writeTextAtomic(path, '');
	}

	const state = reconcileTabsState();
	if (!state.order.includes(id)) state.order.push(id);
	state.active = id;
	setTabsState(state);

	return json({ ok: true, id, active: id, order: state.order });
};

/** DELETE /api/tabs?id=<path>[&deleteFile=true]
 *
 * Default: just close the tab (remove from `order`, leave the file on
 * disk). Opt in with `?deleteFile=true` to also unlink the file — that's
 * the destructive "delete file" action the user gets from the tab's
 * right-click menu or the FileTree context menu. */
export const DELETE: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id') || '';
	if (!isValidTabId(id)) throw error(400, 'Invalid tab id');
	const deleteFile = url.searchParams.get('deleteFile') === 'true';

	ensureDocWriterDir();

	if (deleteFile) {
		const path = tabFile(id);
		if (existsSync(path)) unlinkSync(path);
		// Drop the Hocuspocus Document + SQLite CRDT log for this tab.
		// Otherwise reopening the same path would replay stale updates and
		// resurrect the deleted content.
		await destroyTabState(id);
	}

	// Drop from order even if the file still exists (close semantics).
	const stored = getTabsState();
	const order = stored.order.filter((t) => t !== id);
	let active = stored.active === id ? null : stored.active;
	if (!active && order.length > 0) active = order[0];
	setTabsState({ order, active });
	return json({ ok: true, order, active });
};

/** PATCH /api/tabs  body: { id, newId? , active? }  →  rename or focus.
 *
 * `active: true` just switches focus. `newId` renames the file, the
 * agent shadow (if present), and updates order + active pointer. */
export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const id = String(body?.id || '').trim();
	if (!isValidTabId(id)) throw error(400, 'Invalid tab id');

	let state = reconcileTabsState();

	if (body?.newId) {
		const newId = String(body.newId).trim();
		if (!isValidTabId(newId)) throw error(400, 'Invalid new tab id');
		if (id === newId) return json({ ok: true, id, order: state.order, active: state.active });
		const from = tabFile(id);
		const to = tabFile(newId);
		if (!existsSync(from)) throw error(404, `Tab "${id}" not found`);
		if (existsSync(to)) throw error(409, `"${newId}" already exists.`);
		mkdirSync(dirname(to), { recursive: true });
		renameSync(from, to);
		state.order = state.order.map((t) => (t === id ? newId : t));
		if (state.active === id) state.active = newId;
		setTabsState(state);
		return json({ ok: true, id: newId, order: state.order, active: state.active });
	}

	if (body?.active === true) {
		if (!state.order.includes(id)) throw error(404, `Tab "${id}" not found`);
		state.active = id;
		setTabsState(state);
	}

	return json({ ok: true, id, order: state.order, active: state.active });
};

/** Reconcile the persisted tabs list against what's on disk. Drops any
 * entry whose file no longer exists (e.g. the user deleted it in their
 * terminal); resolves a dangling `active` pointer. */
function reconcileTabsState() {
	const stored = getTabsState();
	const order = stored.order.filter((id) => existsSync(tabFile(id)));
	let active = stored.active && order.includes(stored.active) ? stored.active : null;
	if (!active && order.length > 0) active = order[0];

	const cleaned = { order, active };
	const changed =
		cleaned.order.join('|') !== stored.order.join('|') ||
		cleaned.active !== stored.active;
	if (changed) setTabsState(cleaned);
	return cleaned;
}
