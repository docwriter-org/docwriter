import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	readUserDoc,
	readMeta,
	writeUserDoc,
	writeMeta,
	acceptAgentDoc,
	rejectAgentDoc
} from '$lib/server/document-io';
import { isValidTabId } from '$lib/server/document-files';
import { getTabsState } from '$lib/server/runtime-state';

/**
 * Per-tab document endpoint. Every call takes a `tab` query parameter (or
 * defaults to the active tab from state.json). The client's Y.Doc for that
 * tab is the canonical editor state; this endpoint persists the backing
 * markdown file + server-side metadata.
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
	return json({
		tabId,
		userMd: readUserDoc(tabId),
		meta: readMeta()
	});
};

export const PUT: RequestHandler = async ({ request, url }) => {
	try {
		const tabId = resolveTabId(url);
		const body = await request.json();
		if (typeof body.userMd === 'string') {
			await writeUserDoc(tabId, body.userMd, body.meta);
		} else if (body.meta) {
			await writeMeta(body.meta);
		}
		return json({ ok: true });
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
