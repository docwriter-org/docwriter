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
import { migrateRenamedTab } from '$lib/server/tab-rename';
import { resolveTabRename, visibleTabsState } from '$lib/shared/tab-reconcile';

/** GET /api/tabs  →  { order, active, tabs: string[] }
 *
 * Hide tabs whose files are currently missing. Do not persist that filter:
 * a compile/sync/rename race used to DELETE the `tabs` row while thousands
 * of `yjs_updates` stayed behind. */
export const GET: RequestHandler = async () => {
	const state = visibleOpenTabs();
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
		await destroyTabState(id);
	}

	const state = getTabsState();
	if (!state.order.includes(id)) state.order.push(id);
	state.active = id;
	setTabsState(state);

	return json({ ok: true, id, active: id, order: visibleOpenTabs().order });
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
	const visible = visibleOpenTabs();
	return json({ ok: true, order: visible.order, active: visible.active });
};

/** PATCH /api/tabs  body: { id, newId? , active? }  →  rename or focus.
 *
 * `active: true` just switches focus. `newId` renames the file and
 * migrates the CRDT log + last_seen key so the tab does not vanish. */
export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const id = String(body?.id || '').trim();
	if (!isValidTabId(id)) throw error(400, 'Invalid tab id');

	if (body?.newId) {
		const newId = String(body.newId).trim();
		if (!isValidTabId(newId)) throw error(400, 'Invalid new tab id');
		if (id === newId) {
			const visible = visibleOpenTabs();
			return json({ ok: true, id, order: visible.order, active: visible.active });
		}
		const from = tabFile(id);
		const to = tabFile(newId);
		const resolution = resolveTabRename(existsSync(from), existsSync(to));
		if (resolution === 'source-missing') throw error(404, `Tab "${id}" not found`);
		if (resolution === 'target-exists') throw error(409, `"${newId}" already exists.`);
		if (resolution === 'rename') {
			mkdirSync(dirname(to), { recursive: true });
			renameSync(from, to);
		}
		await migrateRenamedTab(id, newId);
		const state = getTabsState();
		state.order = state.order.map((t) => (t === id ? newId : t));
		if (!state.order.includes(newId)) state.order.push(newId);
		if (state.active === id) state.active = newId;
		setTabsState(state);
		const visible = visibleOpenTabs();
		return json({ ok: true, id: newId, order: visible.order, active: visible.active });
	}

	if (body?.active === true) {
		const state = getTabsState();
		if (!state.order.includes(id)) throw error(404, `Tab "${id}" not found`);
		state.active = id;
		setTabsState(state);
	}

	const visible = visibleOpenTabs();
	return json({ ok: true, id, order: visible.order, active: visible.active });
};

function visibleOpenTabs() {
	return visibleTabsState(getTabsState(), (id) => existsSync(tabFile(id)));
}
