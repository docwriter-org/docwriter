import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readUserDoc, readMeta, writeMeta } from '$lib/server/document-io';
import { isValidTabId } from '$lib/server/document-files';
import { getTabsState } from '$lib/server/runtime-state';
import { flushTabMarkdownNow } from '$lib/server/ws-server';

/**
 * Per-tab document endpoint.
 *
 * Post Phase 5+6: this endpoint is only used for:
 *   - `GET` — read the current on-disk markdown + JSON meta (rules /
 *     agentSettings). Used by the client's initial `loadTab`.
 *   - `PUT` — persist `meta` (rules / agentSettings). `userMd` is ignored
 *     since Y.Doc sync owns editor content; the PUT is kept for meta-only
 *     writes from the AgentSettings / Rules panels.
 *
 * `POST { action: 'accept' | 'reject' }` was removed — accept/reject is
 * now a pure Y.Map('review') operation driven by the browser (see
 * `acceptAgentEdit` / `rejectAgentEdit` in `src/routes/+page.svelte`).
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
		userMd: readUserDoc(tabId),
		meta: readMeta()
	});
};

/**
 * Ignored `userMd` — the Y.Doc path delivers every keystroke over
 * WebSocket and the server writes the workspace file itself. A `meta`
 * payload (rules / agent settings) is still honored since those flow
 * through separate save paths.
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
