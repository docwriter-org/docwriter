import { dev } from '$app/environment';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readUserDoc, readMeta, writeMeta } from '$lib/server/document-io';
import { isValidTabId } from '$lib/server/document-files';
import { getTabsState } from '$lib/server/runtime-state';
import {
	resolveTabThread,
	resolveAllTabThreads,
	setThreadResolution,
	flushTabMarkdownNow
} from '$lib/server/ws-server';
import { runWithRenderScope, runTabWrite } from '$lib/server/mcp-doc-tools';
import type { ThreadOutcome } from '$lib/types';

/**
 * Per-tab document endpoint.
 *
 *   - `GET` — read the current on-disk text + JSON meta (rules /
 *     agentSettings). Used by the client's initial `loadTab`.
 *   - `PUT` — persist `meta` (rules / agentSettings). Editor content
 *     writes are ignored here; Y.Doc sync over WebSocket owns content.
 *   - `POST` — review-state mutations (resolve a thread with an outcome,
 *     resolve every proposal, dismiss / reopen) that need a server ack
 *     before the UI clears, so a hard refresh can't race ahead of the
 *     WebSocket send. Each returns the Yjs delta so the client applies it
 *     locally with USER_ORIGIN (the undo contract).
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

function readOutcome(value: unknown): ThreadOutcome | null {
	return value === 'accepted' || value === 'rejected' || value === 'dismissed' ? value : null;
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

function flushed(tabId: string): { diskFlushed: boolean; diskFlushError?: string } {
	try {
		flushTabMarkdownNow(tabId);
		return { diskFlushed: true };
	} catch (e) {
		console.error(`[docwriter] accept flush failed for tab "${tabId}":`, e);
		return { diskFlushed: false, diskFlushError: String(e) };
	}
}

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		const tabId = resolveTabId(url);
		const body = await request.json().catch(() => ({}));
		if (body?.action === 'resolve_thread') {
			const threadId = typeof body.threadId === 'string' ? body.threadId : '';
			const outcome = readOutcome(body.outcome);
			if (!threadId || !outcome) return json({ error: 'threadId and outcome required' }, { status: 400 });
			const result = await resolveTabThread(tabId, threadId, outcome);
			if (!result.ok) return json({ error: 'Thread not found' }, { status: 404 });
			return json({ ...result, ...(outcome === 'accepted' ? flushed(tabId) : {}) });
		}
		if (body?.action === 'resolve_all') {
			const outcome = readOutcome(body.outcome);
			if (outcome !== 'accepted' && outcome !== 'rejected') {
				return json({ error: 'outcome must be accepted or rejected' }, { status: 400 });
			}
			const result = await resolveAllTabThreads(tabId, outcome);
			return json({ ok: true, ...result, ...(outcome === 'accepted' ? flushed(tabId) : {}) });
		}
		if (body?.action === 'set_thread_resolution') {
			const threadId = typeof body.threadId === 'string' ? body.threadId : '';
			const resolved = body.resolved === true;
			if (!threadId) return json({ error: 'threadId required' }, { status: 400 });
			const result = await setThreadResolution(tabId, threadId, resolved);
			return json({ ...result });
		}
		if (body?.action === 'dev_fake_agent_write') {
			if (!dev) {
				return json({ error: 'Not available outside dev mode' }, { status: 404 });
			}
			const content = typeof body.content === 'string' ? body.content : null;
			if (content === null) {
				return json({ error: 'Missing content' }, { status: 400 });
			}
			const result = await runTabWrite(tabId, { kind: 'write', content });
			if ('error' in result) {
				return json({ error: result.error }, { status: 500 });
			}
			return json({ ok: true, ...result });
		}
		if (body?.action === 'dev_fake_agent_edit') {
			if (!dev) {
				return json({ error: 'Not available outside dev mode' }, { status: 404 });
			}
			const oldString = typeof body.oldString === 'string' ? body.oldString : null;
			const newString = typeof body.newString === 'string' ? body.newString : null;
			if (oldString === null || newString === null) {
				return json({ error: 'Missing oldString/newString' }, { status: 400 });
			}
			// Dev-only: allow tagging the fake edit with a feedback thread so
			// the gutter's grouped-card rendering can be exercised locally.
			const fakeThreadId =
				typeof body.feedbackThreadId === 'string' ? body.feedbackThreadId : null;
			const result = await runWithRenderScope({ feedbackThreadId: fakeThreadId }, () =>
				runTabWrite(tabId, { kind: 'edit', oldString, newString })
			);
			if ('error' in result) {
				const status = result.code === 'not-found' || result.code === 'ambiguous' || result.code === 'overlap' ? 409 : 500;
				return json({ error: result.error }, { status });
			}
			return json({ ok: true, ...result });
		}
		return json({ error: 'Unknown action' }, { status: 400 });
	} catch (e) {
		return json({ error: String(e) }, { status: 500 });
	}
};
