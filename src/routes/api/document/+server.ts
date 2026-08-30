import { dev } from '$app/environment';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readUserDoc, readMeta, writeMeta } from '$lib/server/document-io';
import { isValidTabId } from '$lib/server/document-files';
import { getTabsState } from '$lib/server/runtime-state';
import {
	acceptTabRounds,
	rejectTabRounds,
	setThreadResolution,
	flushTabMarkdownNow
} from '$lib/server/ws-server';
import { setActiveFeedbackThreadId } from '$lib/server/mcp-doc-tools';
import { runTabWrite } from '$lib/server/mcp-doc-tools';

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = 0;
	while ((idx = haystack.indexOf(needle, idx)) !== -1) {
		count += 1;
		idx += needle.length;
	}
	return count;
}

/**
 * Per-tab document endpoint.
 *
 *   - `GET` — read the current on-disk text + JSON meta (rules /
 *     agentSettings). Used by the client's initial `loadTab`.
 *   - `PUT` — persist `meta` (rules / agentSettings). Editor content
 *     writes are ignored here; Y.Doc sync over WebSocket owns content.
 *   - `POST` — review-state mutations (accept_rounds / reject_rounds)
 *     that need a server ack before the UI clears, so a hard refresh
 *     can't race ahead of the WebSocket send and resurrect already-
 *     accepted rounds.
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
		// Accept a SET of rounds (e.g. all edits for one feedback thread).
		const roundIds = Array.isArray(body.roundIds)
			? (body.roundIds.filter((x: unknown) => typeof x === 'string') as string[])
			: undefined;
		if (body?.action === 'accept_rounds') {
			let result;
			try {
				result = await acceptTabRounds(tabId, roundIds ?? roundId);
			} catch (e) {
				if ((e as Error).name === 'StalePendingReviewError') {
					const stale = e as Error & {
						staleRoundId?: string;
						staleRound?: { operation?: { type?: string } };
					};
					return json(
						{
							error: stale.message,
							stale: true,
							staleRoundId: stale.staleRoundId ?? null,
							staleRoundKind: stale.staleRound?.operation?.type ?? null
						},
						{ status: 409 }
					);
				}
				throw e;
			}
			try {
				flushTabMarkdownNow(tabId);
				return json({ ok: true, diskFlushed: true, ...result });
			} catch (e) {
				console.error(`[docwriter] accept flush failed for tab "${tabId}":`, e);
				return json({
					ok: true,
					diskFlushed: false,
					diskFlushError: String(e),
					...result
				});
			}
		}
		if (body?.action === 'reject_rounds') {
			const result = await rejectTabRounds(tabId, roundId, {
				keepThreads: body.keepThreads === true
			});
			return json({ ok: true, ...result });
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
			const result = await runTabWrite(tabId, 'dev_fake_agent_write', () => ({
				operation: { type: 'write', content },
				afterMd: content
			}));
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
			let failure: string | null = null;
			// Dev-only: allow tagging the fake edit with a feedback thread so
			// the gutter's grouped-card rendering can be exercised locally.
			const fakeThreadId =
				typeof body.feedbackThreadId === 'string' ? body.feedbackThreadId : null;
			if (fakeThreadId) setActiveFeedbackThreadId(fakeThreadId);
			let result;
			try {
				result = await runTabWrite(tabId, 'dev_fake_agent_edit', (currentMd) => {
					const hits = countOccurrences(currentMd, oldString);
					if (hits === 0) {
						failure = 'oldString not found in current document';
						return null;
					}
					if (hits > 1) {
						failure = `oldString matched ${hits} locations in current document`;
						return null;
					}
					return {
						operation: { type: 'edit', oldString, newString },
						afterMd: currentMd.replace(oldString, newString)
					};
				});
			} finally {
				if (fakeThreadId) setActiveFeedbackThreadId(null);
			}
			if ('error' in result) {
				if (failure) {
					return json({ error: failure }, { status: 409 });
				}
				return json({ error: result.error }, { status: 500 });
			}
			return json({ ok: true, ...result });
		}
		return json({ error: 'Unknown action' }, { status: 400 });
	} catch (e) {
		return json({ error: String(e) }, { status: 500 });
	}
};
