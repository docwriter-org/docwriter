import { error, json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import * as Y from 'yjs';
import type { Document } from '@hocuspocus/server';
import {
	getCommentsMap,
	getThread,
	putThread,
	appendThreadMessage,
	setThreadResolved,
	decodeRelPosition,
	USER_ORIGIN
} from '$lib/shared/ydoc-codec';
import {
	committedText,
	resolveThreadMarks,
	setCommentMarkByAbsolutePositions,
	setCommentMarkByViewOffsets,
	type CommentMarkResult
} from '$lib/shared/proposals';
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

type MutateOutcome =
	| { ok: true }
	| { ok: false; error: string; status?: number; overlapThreadId?: string };

async function mutateTabYDoc(
	tabId: string,
	mutator: (doc: Y.Doc) => MutateOutcome
): Promise<{ ok: true } | { ok: false; error: string; status: number; overlapThreadId?: string }> {
	const ws = getHocuspocus();
	if (!ws) return { ok: false, error: 'WebSocket server not initialized', status: 503 };
	const direct = await ws.openDirectConnection(tabId);
	let out: { ok: true } | { ok: false; error: string; status: number; overlapThreadId?: string } = {
		ok: false,
		error: 'DirectConnection transact did not run',
		status: 500
	};
	try {
		await direct.transact((document) => {
			const doc = document as unknown as Y.Doc;
			const outcome = mutator(doc);
			out = outcome.ok
				? { ok: true }
				: {
						ok: false,
						error: outcome.error,
						status: outcome.status ?? 400,
						...(outcome.overlapThreadId ? { overlapThreadId: outcome.overlapThreadId } : {})
					};
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

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const tabId = typeof body?.tabId === 'string' ? body.tabId : '';
	if (!isValidTabId(tabId)) throw error(400, 'Invalid tab id');

	if (body?.mode === 'new-thread') {
		const anchorText = typeof body.anchorText === 'string' ? body.anchorText : '';
		const messageText = typeof body.message === 'string' ? body.message.trim() : '';
		// Optional: rel positions captured by the client when the user made
		// the selection. When present, the comment mark goes on the EXACT
		// selection instead of the first occurrence of anchorText.
		const relStart = typeof body.relStart === 'string' ? body.relStart : undefined;
		const relEnd = typeof body.relEnd === 'string' ? body.relEnd : undefined;
		if (!anchorText) throw error(400, 'anchorText is required for a new thread');
		if (!messageText) throw error(400, 'message is required');
		const outcomeBox: { threadId?: string } = {};
		const outcome = await mutateTabYDoc(tabId, (doc) => {
			const threadId = 'thread_' + cryptoRandomId();
			const now = Date.now();
			const thread: CommentThread = {
				id: threadId,
				messages: [
					{
						id: 'msg_' + cryptoRandomId(),
						author: 'user',
						text: messageText,
						timestamp: now
					}
				],
				resolved: false,
				createdAt: now
			};
			let marked: CommentMarkResult = { ok: false, reason: 'range' };
			doc.transact(() => {
				const rs = relStart ? decodeRelPosition(relStart) : null;
				const re = relEnd ? decodeRelPosition(relEnd) : null;
				const from = rs ? Y.createAbsolutePositionFromRelativePosition(rs, doc) : null;
				const to = re ? Y.createAbsolutePositionFromRelativePosition(re, doc) : null;
				if (from && to) marked = setCommentMarkByAbsolutePositions(doc, threadId, from, to);
				if (!marked.ok && marked.reason === 'range') {
					const text = committedText(doc);
					const idx = text.indexOf(anchorText);
					if (idx >= 0) {
						marked = setCommentMarkByViewOffsets(
							doc,
							threadId,
							{ kind: 'committed' },
							idx,
							idx + anchorText.length
						);
					}
				}
				if (marked.ok) putThread(getCommentsMap(doc), thread);
			}, USER_ORIGIN);
			const m = marked as CommentMarkResult;
			if (!m.ok) {
				// A passage has one thread: the client posts this feedback as a
				// reply on the thread that already holds the passage instead.
				return m.reason === 'overlap'
					? {
							ok: false,
							error: 'The selected passage already has a thread',
							status: 409,
							overlapThreadId: m.otherThreadId
						}
					: { ok: false, error: 'anchorText was not found in the document', status: 409 };
			}
			outcomeBox.threadId = threadId;
			return { ok: true };
		});
		if (!outcome.ok) {
			if (outcome.overlapThreadId) {
				return json({ error: outcome.error, overlapThreadId: outcome.overlapThreadId }, { status: 409 });
			}
			throw error(outcome.status, outcome.error);
		}
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
			if (!getThread(commentsMap, threadId)) {
				return { ok: false, error: 'Thread not found', status: 404 };
			}
			const reply: CommentMessage = {
				id: 'msg_' + cryptoRandomId(),
				author,
				text: messageText,
				timestamp: Date.now()
			};
			// Append + reopen as field-level writes: a reply racing an agent
			// write keeps both (the whole-object rewrite used to be
			// last-writer-wins — one side's write silently vanished).
			doc.transact(() => {
				appendThreadMessage(commentsMap, threadId, reply);
				setThreadResolved(commentsMap, threadId, false);
			}, USER_ORIGIN);
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
		if (!getThread(commentsMap, threadId)) {
			return { ok: false, error: 'Thread not found', status: 404 };
		}
		doc.transact(() => {
			if (resolved) resolveThreadMarks(doc, threadId, 'dismissed');
			setThreadResolved(commentsMap, threadId, resolved, resolved ? 'dismissed' : undefined);
		}, USER_ORIGIN);
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
		doc.transact(() => {
			resolveThreadMarks(doc, threadId, 'dismissed');
			commentsMap.delete(threadId);
		}, USER_ORIGIN);
		return { ok: true };
	});
	if (!outcome.ok) throw error(outcome.status, outcome.error);
	return json({ ok: true });
};
