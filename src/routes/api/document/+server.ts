import { dev } from '$app/environment';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readUserDoc, readMeta, writeMeta } from '$lib/server/document-io';
import { isValidTabId } from '$lib/server/document-files';
import { getTabsState } from '$lib/server/runtime-state';
import { acceptTabRounds, rejectTabRounds, flushTabMarkdownNow } from '$lib/server/ws-server';
import { runTabWrite } from '$lib/server/mcp-doc-tools';

/**
 * Per-tab document endpoint.
 *
 * Post Phase 5+6: this endpoint is only used for:
 *   - `GET` — read the current on-disk text + JSON meta (rules /
 *     agentSettings). Used by the client's initial `loadTab`.
 *   - `PUT` — persist `meta` (rules / agentSettings). Content writes are ignored
 *     since Y.Doc sync owns editor content; the PUT is kept for meta-only
 *     writes from the AgentSettings / Rules panels.
 *
 * `POST` handles review-state mutations that need a server ack before the
 * UI clears, so a hard refresh cannot race ahead of the browser's
 * WebSocket send and resurrect already-accepted rounds.
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
	// Without this, a read within the 1s flush window sees stale file
	// content.
	try {
		flushTabMarkdownNow(tabId);
	} catch (e) {
		console.error(`[docwriter] sync flush failed for tab "${tabId}":`, e);
	}
	return json({
		tabId,
		content: readUserDoc(tabId),
		meta: readMeta()
	});
};

/**
 * Content writes are ignored — the Y.Doc path delivers every keystroke over
 * WebSocket and the server writes the workspace file itself. A `meta` payload
 * (rules / agent settings) is still honored since those flow through separate
 * save paths.
 */
export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => ({}));
		if (body && body.meta) {
			await writeMeta(body.meta);
		}
		return json({ ok: true });
	} catch (e) {
		return json({ error: String(e) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		const tabId = resolveTabId(url);
		const body = await request.json().catch(() => ({}));
		const roundId = typeof body.roundId === 'string' ? body.roundId : undefined;
		if (body?.action === 'accept_rounds') {
			const result = await acceptTabRounds(tabId, roundId);
			return json({ ok: true, ...result });
		}
		if (body?.action === 'reject_rounds') {
			const result = await rejectTabRounds(tabId, roundId);
			return json({ ok: true, ...result });
		}
		if (body?.action === 'dev_fake_agent_write') {
			if (!dev) {
				return json({ error: 'Not available outside dev mode' }, { status: 404 });
			}
			const content = typeof body.content === 'string' ? body.content : null;
			if (content === null) {
				return json({ error: 'Missing content' }, { status: 400 });
			}
			const result = await runTabWrite(tabId, 'dev_fake_agent_write', () => content);
			if ('error' in result) {
				return json({ error: result.error }, { status: 500 });
			}
			return json({ ok: true, ...result });
		}
		return json({ error: 'Unknown action' }, { status: 400 });
	} catch (e) {
		return json({ error: String(e) }, { status: 500 });
	}
};
