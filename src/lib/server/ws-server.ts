/**
 * Hocuspocus WebSocket server for Y.Doc sync.
 *
 * Hocuspocus owns the one Y.Doc per tab. `onLoadDocument` hydrates it from
 * SQLite; `onChange` appends every update to `yjs_updates` and marks the tab
 * dirty for the global 500ms flush loop.
 *
 * Origin tagging (persisted per update, used to drive the client's undo and
 * the diff overlay; the server itself doesn't undo):
 *   - agent writes via `openDirectConnection` transact with AGENT_ORIGIN.
 *   - user keystrokes arrive with a Connection object as the origin; onChange
 *     normalizes those to USER_ORIGIN.
 *   - cold-start replay and file-seed carry SYSTEM_ORIGIN.
 */
import { Server } from '@hocuspocus/server';
import type { IncomingMessage } from 'node:http';
import * as Y from 'yjs';
import type { PendingReviewRound } from '$lib/types';
import {
	USER_ORIGIN,
	FRAGMENT_NAME,
	getReviewArray,
	getCommentsMap,
	getFragment,
	readReviewRounds,
	serializeYDoc,
	replaceYDocText,
	applyEditToFragment
} from '$lib/shared/ydoc-codec';
import { applyPendingReviewRound } from '$lib/review-rounds';
import { touchLastSeen } from '$lib/server/last-seen';
import {
	appendUpdate,
	replayUpdatesInto,
	markTabDirty,
	flushMarkdownNow,
	clearDirty,
	purgeTabUpdates,
	setLiveDocResolver
} from './ydoc-persistence';
import { isMultiTenant } from './workspace';
import { runWithUser, getCurrentUserId } from './request-context';
import { getClerkClient, isAuthorizedUser } from './clerk-auth';

interface WsUserContext {
	userId?: string;
}

function globalHolder() {
	return globalThis as unknown as { __docwriterWsServer?: Server };
}

function currentServerInstanceId(): string {
	return (
		(globalThis as unknown as { __docwriterServerInstanceId?: string })
			.__docwriterServerInstanceId ?? ''
	);
}

/** In multi-tenant mode, doc names are `<userId>:<tabId>`. */
function parseDocName(documentName: string): { userId: string | null; tabId: string } {
	if (isMultiTenant()) {
		const idx = documentName.indexOf(':');
		if (idx > 0) {
			return { userId: documentName.slice(0, idx), tabId: documentName.slice(idx + 1) };
		}
	}
	return { userId: null, tabId: documentName };
}

function getContextUserId(context: unknown): string | null {
	const value = (context as WsUserContext | null)?.userId;
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function resolveDocContext(documentName: string, context?: unknown): { userId: string | null; tabId: string } {
	const parsed = parseDocName(documentName);
	return {
		userId: parsed.userId ?? getContextUserId(context),
		tabId: parsed.tabId
	};
}

/** Run a function in the user's workspace context, or directly if single-user. */
function inUserContext<T>(userId: string | null, fn: () => T): T {
	return userId ? runWithUser(userId, fn) : fn();
}

function directConnectionContext(): WsUserContext | undefined {
	const userId = isMultiTenant() ? getCurrentUserId() : null;
	return userId ? { userId } : undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function requestOrigin(request: IncomingMessage): string {
	const origin = firstHeader(request.headers.origin);
	if (origin) {
		try {
			return new URL(origin).origin;
		} catch {
			/* fall through to forwarded headers */
		}
	}
	const proto = firstHeader(request.headers['x-forwarded-proto']) ?? 'http';
	const host =
		firstHeader(request.headers['x-forwarded-host']) ??
		firstHeader(request.headers.host) ??
		'localhost';
	return new URL(`${proto}://${host}`).origin;
}

export function createWsServer(port: number): Server {
	const server = new Server({
		port,
		quiet: true,
		async onAuthenticate({ token, documentName, request }) {
			if (isMultiTenant()) {
				// Validate via Clerk using the session cookie from the upgrade request.
				const clerkClient = getClerkClient();
				if (!clerkClient) throw new Error('clerk-not-configured');
				try {
					const origin = requestOrigin(request);
					const url = new URL(request.url || '/', origin);
					const reqObj = new Request(url, { headers: request.headers as Record<string, string> });
					const state = await clerkClient.authenticateRequest(reqObj, {
						authorizedParties: [origin]
					});
					if (!state.isAuthenticated) throw new Error('not-authenticated');
					const auth = state.toAuth();
					if (!auth.userId) throw new Error('no-user');
					const allowed = await isAuthorizedUser(clerkClient, auth.userId);
					if (!allowed) throw new Error('unauthorized');
					const { userId: docUserId } = parseDocName(documentName);
					if (!docUserId) throw new Error('missing-user-prefix');
					if (docUserId !== auth.userId) throw new Error('user-mismatch');
					return { userId: auth.userId };
				} catch (err) {
					console.error('[onAuthenticate] multi-tenant auth error:', err);
					throw new Error('auth-failed');
				}
			}
			const expected = currentServerInstanceId();
			if (token && token === expected) return;
			throw new Error('server-instance-mismatch');
		},
		async onLoadDocument({ documentName, document, context }) {
			const { userId, tabId } = resolveDocContext(documentName, context);
			const ydoc = document as unknown as Y.Doc;
			const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
			if (fragment.length === 0) {
				inUserContext(userId, () => replayUpdatesInto(ydoc, tabId));
			}
			return document;
		},
		async afterUnloadDocument({ documentName }) {
			const { userId, tabId } = parseDocName(documentName);
			inUserContext(userId, () => clearDirty(tabId));
		},
		async onChange({ documentName, update, transactionOrigin, context }) {
			const { userId, tabId } = resolveDocContext(documentName, context);
			const origin = typeof transactionOrigin === 'string' ? transactionOrigin : USER_ORIGIN;
			inUserContext(userId, () => {
				appendUpdate(tabId, update, origin);
				markTabDirty(tabId);
			});
		}
	});

	// Wire the dirty-flush resolver so the global flush loop can find the
	// live doc for a tab without reaching back into this file.
	setLiveDocResolver((tabId, userId) => {
		const live = server.hocuspocus.documents.get(docNameForTab(tabId, userId));
		return (live as unknown as Y.Doc) ?? null;
	});

	globalHolder().__docwriterWsServer = server;
	return server;
}

/** Map a bare tabId to the Hocuspocus document name for the current user. */
function docNameForTab(tabId: string, userId = getCurrentUserId()): string {
	if (isMultiTenant()) {
		if (userId) return `${userId}:${tabId}`;
	}
	return tabId;
}

function getLiveDocument(tabId: string): Y.Doc | null {
	const server = globalHolder().__docwriterWsServer;
	if (!server) return null;
	const doc = server.hocuspocus.documents.get(docNameForTab(tabId));
	return (doc as unknown as Y.Doc) ?? null;
}

/** Synchronously flush the authoritative Y.Doc for a tab to its workspace
 * file. For the no-client-connected case, replay SQLite into a throwaway
 * doc. */
export function flushTabMarkdownNow(tabId: string) {
	const live = getLiveDocument(tabId);
	if (live) {
		flushMarkdownNow(tabId, live);
		return;
	}
	const ydoc = new Y.Doc();
	replayUpdatesInto(ydoc, tabId);
	flushMarkdownNow(tabId, ydoc);
	ydoc.destroy();
}

// ── Accept / Reject ──────────────────────────────────────────────────────

/** Run a write-transaction against the live Hocuspocus Document. Falls back
 * to a throwaway Y.Doc + direct SQLite append when the server isn't up (test
 * harness / startup race). */
async function withLiveDoc<T>(
	tabId: string,
	mutate: (doc: Y.Doc) => T
): Promise<T> {
	const server = globalHolder().__docwriterWsServer;
	if (server?.hocuspocus) {
		const direct = await server.hocuspocus.openDirectConnection(
			docNameForTab(tabId),
			directConnectionContext()
		);
		try {
			let result!: T;
			await direct.transact((document) => {
				result = mutate(document as unknown as Y.Doc);
			});
			return result;
		} finally {
			await direct.disconnect();
		}
	}
	const ydoc = new Y.Doc();
	replayUpdatesInto(ydoc, tabId);
	const before = Y.encodeStateVector(ydoc);
	const result = mutate(ydoc);
	const update = Y.encodeStateAsUpdate(ydoc, before);
	if (update.length > 0) appendUpdate(tabId, update, USER_ORIGIN);
	ydoc.destroy();
	return result;
}

/** After rounds are accepted/rejected, tidy up any comment threads they
 * were attached to. An *edit-only* thread — one the system auto-opened to
 * wrap a spontaneous agent edit, so it carries no real conversation (no
 * user message) — has nothing left to show once its edit is gone, so we
 * auto-resolve it (the card disappears). A thread with genuine back-and-
 * forth (any user message) is left open: the edit row clears but the
 * conversation stays, and the user resolves it manually via the card's
 * Resolve button. Runs inside the caller's transaction so the resolve
 * lands in the same Yjs delta as the round removal.
 *
 * `threadIds` are the feedbackThreadIds of the just-removed rounds. */
function resolveEmptyEditThreads(ydoc: Y.Doc, threadIds: Set<string>): void {
	if (threadIds.size === 0) return;
	const commentsMap = getCommentsMap(ydoc);
	const stillReferenced = new Set(
		getReviewArray(ydoc)
			.toArray()
			.map((r) => r.feedbackThreadId)
			.filter((id): id is string => typeof id === 'string')
	);
	for (const tid of threadIds) {
		const thread = commentsMap.get(tid);
		if (!thread || thread.resolved) continue;
		// Keep the thread if it still has a pending edit, or if it holds a
		// real conversation (any user message).
		if (stillReferenced.has(tid)) continue;
		if (thread.messages.some((m) => m.author === 'user')) continue;
		commentsMap.set(tid, { ...thread, resolved: true });
	}
}

export async function acceptTabRounds(
	tabId: string,
	roundId?: string | string[]
): Promise<{ acceptedCount: number; rounds: PendingReviewRound[]; yjsUpdate: string | null }> {
	return withLiveDoc(tabId, (ydoc) => {
		const reviewArr = getReviewArray(ydoc);
		const current = reviewArr.toArray();
		// roundId omitted → batch-accept everything (kept oldest-first so
		// each round applies against the previous round's output, the same
		// order the agent generated them in).
		// roundId given (string) → accept ONLY that round, leave the rest.
		// roundId given (array) → accept that SET of rounds (e.g. all edits
		// for one feedback thread), preserving oldest-first order so they
		// apply in sequence. Rounds are independent unless their text
		// overlaps; the stale check below surfaces a 409 if accepting this
		// subset alone would leave one inapplicable.
		let accepted: PendingReviewRound[];
		let remaining: PendingReviewRound[];
		if (!roundId) {
			if (current.length === 0) return { acceptedCount: 0, rounds: [], yjsUpdate: null };
			accepted = current;
			remaining = [];
		} else if (Array.isArray(roundId)) {
			const idSet = new Set(roundId);
			accepted = current.filter((r) => idSet.has(r.id));
			remaining = current.filter((r) => !idSet.has(r.id));
			if (accepted.length === 0) return { acceptedCount: 0, rounds: current, yjsUpdate: null };
		} else {
			const idx = current.findIndex((r) => r.id === roundId);
			if (idx < 0) return { acceptedCount: 0, rounds: current, yjsUpdate: null };
			accepted = [current[idx]];
			remaining = current.slice(0, idx).concat(current.slice(idx + 1));
		}

		// Stale check first: walk the ops as a string transform to verify each
		// round can still apply. Only after every round passes do we commit
		// to mutating the live fragment — otherwise a stale round mid-batch
		// would leave the doc in a half-applied state. (We intentionally
		// re-do this work inside the transact below; this pre-pass exists
		// solely to throw before any mutation lands.)
		let staleCheck = serializeYDoc(ydoc);
		for (const round of accepted) {
			const applied = applyPendingReviewRound(staleCheck, round);
			if (applied.stale) {
				const err = new Error(
					round.staleReason ??
						applied.staleReason ??
						'This proposal is stale and needs to be regenerated before it can be accepted.'
				) as Error & { staleRoundId?: string; staleRound?: PendingReviewRound };
				err.name = 'StalePendingReviewError';
				err.staleRoundId = round.id;
				err.staleRound = round;
				throw err;
			}
			staleCheck = applied.nextText;
		}

		// Capture state vector before mutation so we can compute the exact
		// delta to send back to the client in the HTTP response. The client
		// applies this delta directly — no WebSocket round-trip, no remount.
		const beforeStateVector = Y.encodeStateVector(ydoc);

		// Mutate the live fragment one op at a time, touching only the
		// paragraphs each op covers. Concurrent user typing in any other
		// paragraph merges through Yjs CRDT untouched. `write` ops are
		// wholesale by contract; they keep using replaceYDocText.
		ydoc.transact(() => {
			const fragment = getFragment(ydoc);
			for (const round of accepted) {
				const op = round.operation;
				if (!op) {
					// Legacy round without an operation; carry over the stored
					// afterMd by replacing the fragment wholesale. Rare; only
					// hit by rounds persisted before the operation field
					// existed.
					if (typeof round.afterMd === 'string') {
						replaceYDocText(ydoc, round.afterMd);
					}
					continue;
				}
				if (op.type === 'write') {
					replaceYDocText(ydoc, op.content);
					continue;
				}
				// op.type === 'edit'
				const ok = applyEditToFragment(
					fragment,
					op.oldString,
					op.newString,
					op.replaceAll === true
				);
				if (!ok) {
					// Stale check passed but the surgical apply couldn't find
					// the string. Concurrent user edit between the check and
					// the apply (rare; same transact, but still possible if
					// the fragment shape diverges from the serialized text we
					// stale-checked against). Throw so the client can re-queue
					// the round; the partially-applied prior rounds in this
					// batch land — better than reverting them and losing them.
					const err = new Error(
						`Edit could not be applied surgically: oldString not found in the live fragment. The text may have changed concurrently. Re-queue the round.`
					) as Error & { staleRoundId?: string; staleRound?: PendingReviewRound };
					err.name = 'StalePendingReviewError';
					err.staleRoundId = round.id;
					err.staleRound = round;
					throw err;
				}
			}
			// Remove the accepted rounds in reverse order so each delete's
			// index stays valid. With single-round accept this loop runs once;
			// with batch accept it walks all rounds.
			const acceptedIds = new Set(accepted.map((r) => r.id));
			const indices: number[] = [];
			reviewArr.toArray().forEach((r, i) => {
				if (acceptedIds.has(r.id)) indices.push(i);
			});
			for (let i = indices.length - 1; i >= 0; i--) {
				reviewArr.delete(indices[i], 1);
			}
			resolveEmptyEditThreads(
				ydoc,
				new Set(
					accepted
						.map((r) => r.feedbackThreadId)
						.filter((id): id is string => typeof id === 'string')
				)
			);
		}, USER_ORIGIN);

		// Encode the exact Yjs delta so the client can apply it immediately
		// via the HTTP response, without waiting for the WebSocket broadcast.
		const deltaBytes = Y.encodeStateAsUpdate(ydoc, beforeStateVector);
		const yjsUpdate = Buffer.from(deltaBytes).toString('base64');

		touchLastSeen(tabId, ydoc);

		return { acceptedCount: accepted.length, rounds: remaining, yjsUpdate };
	});
}

export async function rejectTabRounds(
	tabId: string,
	roundId?: string
): Promise<{ rejectedCount: number; rounds: PendingReviewRound[]; yjsUpdate: string | null }> {
	return withLiveDoc(tabId, (ydoc) => {
		const reviewArr = getReviewArray(ydoc);
		const current = reviewArr.toArray();
		if (current.length === 0) return { rejectedCount: 0, rounds: [], yjsUpdate: null };
		// No roundId = reject everything. With a roundId, drop only that
		// round; later rounds stay and will surface stale if they no longer
		// apply (the materializer marks them).
		const beforeStateVector = Y.encodeStateVector(ydoc);
		const threadIdsOf = (rs: PendingReviewRound[]) =>
			new Set(
				rs
					.map((r) => r.feedbackThreadId)
					.filter((id): id is string => typeof id === 'string')
			);
		if (!roundId) {
			ydoc.transact(() => {
				reviewArr.delete(0, current.length);
				resolveEmptyEditThreads(ydoc, threadIdsOf(current));
			}, USER_ORIGIN);
			const deltaBytes = Y.encodeStateAsUpdate(ydoc, beforeStateVector);
			const yjsUpdate = Buffer.from(deltaBytes).toString('base64');
			touchLastSeen(tabId, ydoc);
			return { rejectedCount: current.length, rounds: [], yjsUpdate };
		}
		const idx = current.findIndex((r) => r.id === roundId);
		if (idx < 0) return { rejectedCount: 0, rounds: current, yjsUpdate: null };
		ydoc.transact(() => {
			reviewArr.delete(idx, 1);
			resolveEmptyEditThreads(ydoc, threadIdsOf([current[idx]]));
		}, USER_ORIGIN);
		const remaining = current.slice(0, idx).concat(current.slice(idx + 1));
		const deltaBytes = Y.encodeStateAsUpdate(ydoc, beforeStateVector);
		const yjsUpdate = Buffer.from(deltaBytes).toString('base64');
		touchLastSeen(tabId, ydoc);
		return { rejectedCount: 1, rounds: remaining, yjsUpdate };
	});
}

/** Resolve (or reopen) a comment thread. The thread is the PARENT of any
 * edits grouped under it, so resolving it also drops those pending edits —
 * a resolved thread carries no live proposals. Both the comments-map write
 * and the review-array deletes happen in ONE `USER_ORIGIN` transaction, so
 * the returned delta — applied on the client with `USER_ORIGIN` — lands as a
 * single undoable step: ctrl+z reopens the thread AND resurrects its edits
 * (both the comments map and the review array are in the editor's
 * UndoManager scope). Reopening (resolved=false) just clears the flag. */
export async function setThreadResolution(
	tabId: string,
	threadId: string,
	resolved: boolean
): Promise<{ ok: boolean; yjsUpdate: string | null }> {
	return withLiveDoc(tabId, (ydoc) => {
		const commentsMap = getCommentsMap(ydoc);
		const thread = commentsMap.get(threadId);
		if (!thread) return { ok: false, yjsUpdate: null };
		const reviewArr = getReviewArray(ydoc);
		const beforeStateVector = Y.encodeStateVector(ydoc);
		ydoc.transact(() => {
			commentsMap.set(threadId, { ...thread, resolved });
			if (resolved) {
				const arr = reviewArr.toArray();
				for (let i = arr.length - 1; i >= 0; i--) {
					if (arr[i].feedbackThreadId === threadId) reviewArr.delete(i, 1);
				}
			}
		}, USER_ORIGIN);
		const yjsUpdate = Buffer.from(
			Y.encodeStateAsUpdate(ydoc, beforeStateVector)
		).toString('base64');
		return { ok: true, yjsUpdate };
	});
}

// ── Tab destruction ──────────────────────────────────────────────────────

/** Fully tear down server-side state for a tab whose file was just deleted:
 * disconnect any WS clients, unload the Hocuspocus Document, and drop the
 * persisted CRDT log. Without this, reopening the same path would replay
 * stale updates from SQLite and silently resurrect the deleted content. */
export async function destroyTabState(tabId: string): Promise<void> {
	const server = globalHolder().__docwriterWsServer;
	const name = docNameForTab(tabId);
	if (server?.hocuspocus) {
		try {
			server.hocuspocus.closeConnections(name);
		} catch (err) {
			console.error(`[docwriter] closeConnections failed for "${tabId}":`, err);
		}
		const doc = server.hocuspocus.documents.get(name);
		if (doc) {
			try {
				await server.hocuspocus.unloadDocument(doc);
			} catch (err) {
				console.error(`[docwriter] unloadDocument failed for "${tabId}":`, err);
			}
			server.hocuspocus.documents.delete(name);
		}
	}
	purgeTabUpdates(tabId);
}

// Re-export so legacy imports resolve.
export { readReviewRounds };
