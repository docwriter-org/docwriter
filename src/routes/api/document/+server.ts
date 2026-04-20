import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	readUserDoc,
	readMeta,
	writeMeta,
	acceptAgentDoc,
	rejectAgentDoc
} from '$lib/server/document-io';
import { isValidTabId } from '$lib/server/document-files';
import { getTabsState } from '$lib/server/runtime-state';
import { flushTabMarkdownNow } from '$lib/server/ws-server';

/**
 * Per-tab document endpoint.
 *
 * Phase 3: the client no longer persists `userMd` through `PUT`; the
 * server is authoritative for Y.Doc state and writes `document.md` itself
 * on a debounce off the WebSocket stream. `PUT` is kept as a backward-
 * compatible no-op (returns 200 with `{ ok: true, deprecated: true }`) so
 * any stragglers calling it don't see an error. Callers sending a `meta`
 * payload still get their rules / agentSettings persisted — that's still
 * a legitimate write path.
 *
 * `GET` remains the canonical way to read a tab's on-disk markdown (used
 * by `+page.svelte`'s `loadTab` to snapshot pre-render state before the
 * Y.Doc is hydrated).
 *
 * `POST { action: 'accept' | 'reject' }` is still valid — shadow cleanup
 * for the agent render flow lives here until Phase 6 deletes the whole
 * shadow machinery.
 */

function resolveTabId(url: URL): string {
	const explicit = url.searchParams.get('tab');
	if (explicit) {
		if (!isValidTabId(explicit)) throw error(400, 'Invalid tab id');
		return explicit;
	}
	const active = getTabsState().active;
	if (!active) throw error(400, 'No active tab — create one first');
	return active;
}

export const GET: RequestHandler = async ({ url }) => {
	const tabId = resolveTabId(url);
	// Force-flush any pending debounced Y.Doc → disk write before reading.
	// Without this, a read within the 1s flush window (including the
	// agent render path's pre-render snapshot) sees stale file content.
	try {
		flushTabMarkdownNow(tabId);
	} catch (e) {
		console.error(`[docwriter] sync flush failed for tab "${tabId}":`, e);
	}
	return json({
		tabId,
		userMd: readUserDoc(tabId),
		meta: readMeta()
	});
};

/**
 * Deprecated in Phase 3. Ignored `userMd` — the Y.Doc path delivers every
 * keystroke over WebSocket and the server writes `document.md` itself. A
 * `meta` payload (rules / agent settings) is still honored, since those
 * flow through separate save paths. Remove this endpoint in a later
 * cleanup phase once we're sure no clients call it with `userMd`.
 */
export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => ({}));
		if (body && body.meta) {
			await writeMeta(body.meta);
		}
		return json({ ok: true, deprecated: true });
	} catch (e) {
		return json({ error: String(e) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, url }) => {
	// Accept / reject actions for the agent's pending shadow on a given tab.
	try {
		const tabId = resolveTabId(url);
		const body = await request.json();
		if (body.action === 'accept') {
			await acceptAgentDoc(tabId);
			return json({ ok: true });
		}
		if (body.action === 'reject') {
			await rejectAgentDoc(tabId);
			return json({ ok: true });
		}
		return json({ error: 'Unknown action' }, { status: 400 });
	} catch (e) {
		return json({ error: String(e) }, { status: 500 });
	}
};
