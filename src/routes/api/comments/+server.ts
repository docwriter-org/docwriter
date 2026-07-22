import { error, json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import * as Y from 'yjs';
import type { Document } from '@hocuspocus/server';
import {
	getCommentsMap,
	serializeYDoc,
	captureAnchorContext,
	USER_ORIGIN
} from '$lib/shared/ydoc-codec';
import { isValidTabId } from '$lib/server/document-files';
import type { CommentMessage, CommentThread } from '$lib/types';

/** Resolve the live Hocuspocus server (stashed on globalThis by
 * ws-server.ts) so we can mutate a tab's Y.Doc via DirectConnection. */
function getHocuspocus(): {
	openDirectConnection: (name: string) => Promise<{
		transact: (cb: (doc: Document) => void | Promise<void>) => Promise<void>;
		disconnect: () => Promise<void>;
	}>;
} | null {
	const holder = globalThis as unknown as { __docwriterWsServer?: unknown };
	const server = holder.__docwriterWsServer as
		| { hocuspocus?: unknown }
		| undefined;
	return (server?.hocuspocus as ReturnType<typeof getHocuspocus>) ?? null;
}

async function mutateTabYDoc(
	tabId: string,
	mutator: (doc: Y.Doc) => { ok: true } | { ok: false; error: string; status?: number }
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
	const ws = getHocuspocus();
	if (!ws) return { ok: false, error: 'WebSocket server not initialized', status: 503 };
	const direct = await ws.openDirectConnection(tabId);
	let out: { ok: true } | { ok: false; error: string; status: number } = {
		ok: false,
		error: 'DirectConnection transact did not run',
		status: 500
	};
	try {
		await direct.transact((document) => {
			const doc = document as unknown as Y.Doc;
			const outcome = mutator(doc);
			out = outcome.ok ? { ok: true } : { ok: false, error: outcome.error, status: outcome.status ?? 400 };
		});
	} finally {
		await direct.disconnect();
	}
	return out;
}

function cryptoRandomId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

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

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const tabId = typeof body?.tabId === 'string' ? body.tabId : '';
	if (!isValidTabId(tabId)) throw error(400, 'Invalid tab id');

	if (body?.mode === 'new-thread') {
		const anchorText = typeof body.anchorText === 'string' ? body.anchorText : '';
		const messageText = typeof body.message === 'string' ? body.message.trim() : '';
		// Optional: rel positions captured by the client when the user
		// made the selection. When present, the comment overlay anchors
		// to the EXACT selection instead of the first occurrence of
		// anchorText. Stored unmodified — the client computed them via
		// y-prosemirror's absolutePositionToRelativePosition.
		const relStart = typeof body.relStart === 'string' ? body.relStart : undefined;
		const relEnd = typeof body.relEnd === 'string' ? body.relEnd : undefined;
		if (!anchorText) throw error(400, 'anchorText is required for a new thread');
		if (!messageText) throw error(400, 'message is required');
		const outcomeBox: { threadId?: string } = {};
		const outcome = await mutateTabYDoc(tabId, (doc) => {
			const liveText = serializeYDoc(doc);
			const hasRelAnchor = !!(relStart && relEnd);
			if (!hasRelAnchor && countOccurrences(liveText, anchorText) === 0) {
				return { ok: false, error: 'anchorText was not found in the document', status: 409 };
			}
			const threadId = 'thread_' + cryptoRandomId();
			const now = Date.now();
			const messages: CommentMessage[] = [];
			messages.push({
				id: 'msg_' + cryptoRandomId(),
				author: 'user',
				text: messageText,
				timestamp: now
			});
			// Snapshot the anchor's surroundings when the occurrence is
			// unambiguous, so the client's quote fallback can refuse to
			// re-attach to an unrelated occurrence typed later. With multiple
			// occurrences the client backfill stamps context from the actual
			// resolved range instead.
			const anchorIdx =
				countOccurrences(liveText, anchorText) === 1 ? liveText.indexOf(anchorText) : -1;
			const thread: CommentThread = {
				id: threadId,
				anchor: {
					quote: anchorText,
					occurrenceIndex: 0,
					...(relStart && relEnd ? { relStart, relEnd } : {}),
					...(anchorIdx >= 0 ? captureAnchorContext(liveText, anchorIdx, anchorText.length) : {})
				},
				messages,
				resolved: false,
				createdAt: now
			};
			const commentsMap = getCommentsMap(doc);
			doc.transact(() => commentsMap.set(threadId, thread), USER_ORIGIN);
			outcomeBox.threadId = threadId;
			return { ok: true };
		});
		if (!outcome.ok) throw error(outcome.status, outcome.error);
		return json({ threadId: outcomeBox.threadId });
	}

	if (body?.mode === 'reply') {
		const threadId = typeof body.threadId === 'string' ? body.threadId : '';
		const messageText = typeof body.message === 'string' ? body.message.trim() : '';
		if (!threadId) throw error(400, 'threadId is required');
		if (!messageText) throw error(400, 'message is required');
		// Dev-only test seam (mirrors dev_fake_agent_edit): allow faking an
		// agent-authored reply so the plan-first thread rendering can be
		// exercised locally without a live agent. Real agent replies go
		// through the reply_to_comment MCP tool, never this route.
		const author: CommentMessage['author'] =
			dev && body.author === 'agent' ? 'agent' : 'user';
		const outcome = await mutateTabYDoc(tabId, (doc) => {
			const commentsMap = getCommentsMap(doc);
			const existing = commentsMap.get(threadId);
			if (!existing) return { ok: false, error: 'Thread not found', status: 404 };
			const reply: CommentMessage = {
				id: 'msg_' + cryptoRandomId(),
				author,
				text: messageText,
				timestamp: Date.now()
			};
			const updated: CommentThread = {
				...existing,
				// User replying to a resolved thread re-opens it.
				resolved: false,
				messages: [...existing.messages, reply]
			};
			doc.transact(() => commentsMap.set(threadId, updated), USER_ORIGIN);
			return { ok: true };
		});
		if (!outcome.ok) throw error(outcome.status, outcome.error);
		return json({ ok: true });
	}

	throw error(400, 'Unknown comments mode');
};

export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const tabId = typeof body?.tabId === 'string' ? body.tabId : '';
	const threadId = typeof body?.threadId === 'string' ? body.threadId : '';
	if (!isValidTabId(tabId)) throw error(400, 'Invalid tab id');
	if (!threadId) throw error(400, 'threadId is required');
	const resolved = body?.resolved === true;

	const outcome = await mutateTabYDoc(tabId, (doc) => {
		const commentsMap = getCommentsMap(doc);
		const existing = commentsMap.get(threadId);
		if (!existing) return { ok: false, error: 'Thread not found', status: 404 };
		const updated: CommentThread = { ...existing, resolved };
		doc.transact(() => commentsMap.set(threadId, updated), USER_ORIGIN);
		return { ok: true };
	});
	if (!outcome.ok) throw error(outcome.status, outcome.error);
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ url }) => {
	const tabId = url.searchParams.get('tabId') ?? '';
	const threadId = url.searchParams.get('threadId') ?? '';
	if (!isValidTabId(tabId)) throw error(400, 'Invalid tab id');
	if (!threadId) throw error(400, 'threadId is required');

	const outcome = await mutateTabYDoc(tabId, (doc) => {
		const commentsMap = getCommentsMap(doc);
		if (!commentsMap.has(threadId)) return { ok: false, error: 'Thread not found', status: 404 };
		doc.transact(() => commentsMap.delete(threadId), USER_ORIGIN);
		return { ok: true };
	});
	if (!outcome.ok) throw error(outcome.status, outcome.error);
	return json({ ok: true });
};
