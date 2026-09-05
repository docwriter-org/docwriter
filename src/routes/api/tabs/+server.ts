import { json, error } from '@sveltejs/kit';
import { existsSync, unlinkSync, renameSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { RequestHandler } from './$types';
import {
	isValidTabId,
	tabFile,
	ensureDocWriterDir
} from '$lib/server/document-files';
import { writeTextAtomic } from '$lib/server/file-utils';
import {
	destroyTabState,
	unloadTabDoc,
	flushTabMarkdownNow
} from '$lib/server/ws-server';
import {
	tabHasPersistedUpdates,
	migrateTabCaches
} from '$lib/server/ydoc-persistence';
import {
	listOpenTabs,
	openDocument,
	closeDocument,
	renameDocument,
	setActiveDocument
} from '$lib/server/documents-store';
import { reconcileOpenTabs } from '$lib/server/tabs-reconcile';

/** GET /api/tabs  →  { order, active, tabs, missing }
 *
 * The documents table (status='open') is the source of truth. Tabs whose
 * file is absent stay listed — badged via `missing` — and either self-heal
 * from the CRDT log or, when there is no history to restore, drop after a
 * grace window. See `tabs-reconcile.ts`; a transient absence during a
 * `git pull` or an atomic save must never delete a tab. */
export const GET: RequestHandler = async () => {
	const state = reconcileOpenTabs();
	return json({
		order: state.order,
		active: state.active,
		tabs: state.order,
		missing: state.missing
	});
};

/** POST /api/tabs  body: { id: string }  →  open or create a tab.
 *
 * `id` is a workspace-relative path (e.g. "drafts/chapter-1.md" or
 * "script.py"). If the file exists, the document opens (a previously closed
 * document reopens with its full history — text, threads, pending rounds,
 * provenance). If the file is missing but the CRDT log has history, the
 * file is RESTORED from the log — never truncated (opening a file that was
 * mid-`git pull` used to create an empty file over it AND purge its entire
 * history). Only a path with no file and no history creates a fresh empty
 * file.
 *
 * Idempotent: opening an already-open tab just focuses it. */
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
		if (tabHasPersistedUpdates(id)) {
			// The file vanished externally but its Y.Doc history survives —
			// write the log's content back to disk instead of blanking both.
			flushTabMarkdownNow(id);
		} else {
			writeTextAtomic(path, '');
		}
	}
	openDocument(id);

	const { order } = listOpenTabs();
	return json({ ok: true, id, active: id, order });
};

/** DELETE /api/tabs?id=<path>[&deleteFile=true]
 *
 * Default: close the tab — a status flip on the documents row. Everything
 * (file, CRDT history, threads, pending rounds) is retained; reopening the
 * file restores it all.
 *
 * `?deleteFile=true` is the destructive path (tab context menu / FileTree
 * "delete file"): a JSON backup is written to `.docwriter/backups/`, then
 * the file is unlinked and the documents row deleted — the yjs_updates
 * foreign key cascades the whole log in the same statement, and the
 * feedback-import ledger drops references to the deleted threads. Nothing
 * can remain, by construction. */
export const DELETE: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id') || '';
	if (!isValidTabId(id)) throw error(400, 'Invalid tab id');
	const deleteFile = url.searchParams.get('deleteFile') === 'true';

	ensureDocWriterDir();

	if (deleteFile) {
		const path = tabFile(id);
		if (existsSync(path)) unlinkSync(path);
		await destroyTabState(id);
	} else {
		closeDocument(id);
	}

	const { order, active } = listOpenTabs();
	return json({ ok: true, order, active });
};

/** PATCH /api/tabs  body: { id, newId?, active? }  →  rename or focus.
 *
 * `active: true` just switches focus. `newId` renames the file AND re-keys
 * its persisted state in one transaction — the documents-row PK update
 * cascades through the yjs_updates foreign key, so history, threads and
 * provenance follow the file and the old id leaves nothing behind. The
 * browser's carried-over Y.Doc then replays the SAME history under the new
 * id, so the sync merge is a no-op (before the migration existed, the new
 * id cold-started from a file seed while the client synced up its old copy:
 * two independent histories of the same text, merging as duplicates). */
export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const id = String(body?.id || '').trim();
	if (!isValidTabId(id)) throw error(400, 'Invalid tab id');

	const state = reconcileOpenTabs();

	if (body?.newId) {
		const newId = String(body.newId).trim();
		if (!isValidTabId(newId)) throw error(400, 'Invalid new tab id');
		if (id === newId) return json({ ok: true, id, order: state.order, active: state.active });
		const from = tabFile(id);
		const to = tabFile(newId);
		if (!existsSync(from)) throw error(404, `Tab "${id}" not found`);
		if (existsSync(to)) throw error(409, `"${newId}" already exists.`);
		// Flush the latest committed text so the renamed file carries it,
		// drop the live in-memory doc (clients reconnect under the new id),
		// then move the file and re-key the persisted state.
		flushTabMarkdownNow(id);
		await unloadTabDoc(id);
		mkdirSync(dirname(to), { recursive: true });
		renameSync(from, to);
		renameDocument(id, newId);
		migrateTabCaches(id, newId);
		const { order, active } = listOpenTabs();
		return json({ ok: true, id: newId, order, active });
	}

	if (body?.active === true) {
		if (!state.order.includes(id)) throw error(404, `Tab "${id}" not found`);
		setActiveDocument(id);
		return json({ ok: true, id, order: state.order, active: id });
	}

	return json({ ok: true, id, order: state.order, active: state.active });
};
