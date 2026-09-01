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
	replaceYDocTextWithAiProvenance,
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
	clearTabCaches,
	compactTab,
	setLiveDocResolver
} from './ydoc-persistence';
import { isKnownTextExtension } from './document-files';
import { ensureDocument, deleteDocument } from './documents-store';
import { backupDocumentState } from './state-backup';
import { scrubFeedbackThreads } from './feedback-import';
import { getDb } from './db';

function globalHolder() {
	return globalThis as unknown as { __docwriterWsServer?: Server };
}

function currentServerInstanceId(): string {
	return (
		(globalThis as unknown as { __docwriterServerInstanceId?: string })
			.__docwriterServerInstanceId ?? ''
	);
}

export function createWsServer(port: number): Server {
	const server = new Server({
		port,
		quiet: true,
		async onAuthenticate({ token }) {
			// Require a matching instance id on every connect. The client
			// fetches /api/session at mount time to populate sessionStorage
			// with the current id before any WS provider is created, so a
			// legitimate connect always has the right token. Rejecting empty
			// tokens closes a race: if a mismatch handler clears sessionStorage
			// and the provider auto-reconnects before the page reload completes,
			// the reconnect would send an empty token and (under the previous
			// `!token || token === expected` check) silently succeed —
			// letting the stale in-memory Y.Doc sync up into the new workspace.
			const expected = currentServerInstanceId();
			if (token && token === expected) return;
			throw new Error('server-instance-mismatch');
		},
		async onLoadDocument({ documentName: tabId, document }) {
			// Binary tabs (PDFs, images) are preview-only: never seed or sync
			// a Y.Doc for one — the old path decoded the file's bytes as UTF-8
			// into the CRDT log.
			if (!isKnownTextExtension(tabId)) return document;
			// Register the identity row before any update rows exist — the
			// yjs_updates FK requires it, which turns what used to be a silent
			// orphan into a loud error.
			ensureDocument(tabId);
			const ydoc = document as unknown as Y.Doc;
			const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
			if (fragment.length === 0) {
				replayUpdatesInto(ydoc, tabId);
			}
			return document;
		},
		async afterUnloadDocument({ documentName: tabId }) {
			clearDirty(tabId);
			maybeCompactTab(tabId);
		},
		async onChange({ documentName: tabId, update, transactionOrigin }) {
			const origin = typeof transactionOrigin === 'string' ? transactionOrigin : USER_ORIGIN;
			appendUpdate(tabId, update, origin);
			markTabDirty(tabId);
		}
	});

	// Wire the dirty-flush resolver so the global flush loop can find the
	// live doc for a tab without reaching back into this file.
	setLiveDocResolver((tabId) => {
		const live = server.hocuspocus.documents.get(tabId);
		return (live as unknown as Y.Doc) ?? null;
	});

	globalHolder().__docwriterWsServer = server;
	return server;
}

/** Above this many log rows, a tab's history is merged into one snapshot
 * row when its live doc unloads. Compaction is the ONE sanctioned source of
 * seq gaps (AUTOINCREMENT never reuses); replay cost and log size stay
 * bounded on heavily-edited documents. */
const COMPACT_THRESHOLD_ROWS = 500;

function maybeCompactTab(tabId: string) {
	try {
		const row = getDb()
			.prepare(`SELECT COUNT(*) AS n FROM yjs_updates WHERE tab_id = ?`)
			.get(tabId) as { n: number } | undefined;
		if ((row?.n ?? 0) > COMPACT_THRESHOLD_ROWS) {
			compactTab(tabId);
			console.log(`[docwriter] compacted "${tabId}" (${row!.n} rows → 1)`);
		}
	} catch (err) {
		console.error(`[docwriter] compaction check failed for "${tabId}":`, err);
	}
}

function getLiveDocument(tabId: string): Y.Doc | null {
	const server = globalHolder().__docwriterWsServer;
	if (!server) return null;
	const doc = server.hocuspocus.documents.get(tabId);
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
		const direct = await server.hocuspocus.openDirectConnection(tabId);
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
 * conversation stays, and the user dismisses it manually via the card's
 * Dismiss button. Runs inside the caller's transaction so the dismiss
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
): Promise<{
	acceptedCount: number;
	rounds: PendingReviewRound[];
	yjsUpdate: string | null;
	skippedStale: Array<{ id: string; reason: string }>;
}> {
	return withLiveDoc(tabId, (ydoc) => {
		const reviewArr = getReviewArray(ydoc);
		const current = reviewArr.toArray();
		// roundId omitted → batch-accept everything (kept oldest-first so
		// each round applies against the previous round's output, the same
		// order the agent generated them in).
		// roundId given (string) → accept ONLY that round, leave the rest.
		// roundId given (array) → accept that SET of rounds (e.g. all edits
		// for one feedback thread), preserving oldest-first order so they
		// apply in sequence.
		let requested: PendingReviewRound[];
		if (!roundId) {
			if (current.length === 0)
				return { acceptedCount: 0, rounds: [], yjsUpdate: null, skippedStale: [] };
			requested = current;
		} else if (Array.isArray(roundId)) {
			const idSet = new Set(roundId);
			requested = current.filter((r) => idSet.has(r.id));
			if (requested.length === 0)
				return { acceptedCount: 0, rounds: current, yjsUpdate: null, skippedStale: [] };
		} else {
			const idx = current.findIndex((r) => r.id === roundId);
			if (idx < 0)
				return { acceptedCount: 0, rounds: current, yjsUpdate: null, skippedStale: [] };
			requested = [current[idx]];
		}

		// Stale walk: verify each round as a string transform before touching
		// the live fragment. Batch accepts (everything / a set) SKIP stale
		// rounds and land the rest — one stuck proposal must not block every
		// other accept (it used to 409 the whole batch). A single-round
		// accept still throws so the client's stale-rescue flow (re-queue
		// the agent to rebase this exact round) can take over.
		const singleMode = typeof roundId === 'string';
		let staleCheck = serializeYDoc(ydoc);
		const accepted: PendingReviewRound[] = [];
		const skippedStale: Array<{ id: string; reason: string }> = [];
		for (const round of requested) {
			const applied = applyPendingReviewRound(staleCheck, round);
			if (applied.stale) {
				const reason =
					round.staleReason ??
					applied.staleReason ??
					'This proposal is stale and needs to be regenerated before it can be accepted.';
				if (singleMode) {
					const err = new Error(reason) as Error & {
						staleRoundId?: string;
						staleRound?: PendingReviewRound;
					};
					err.name = 'StalePendingReviewError';
					err.staleRoundId = round.id;
					err.staleRound = round;
					throw err;
				}
				skippedStale.push({ id: round.id, reason });
				continue;
			}
			staleCheck = applied.nextText;
			accepted.push(round);
		}
		if (accepted.length === 0) {
			return { acceptedCount: 0, rounds: current, yjsUpdate: null, skippedStale };
		}
		const acceptedIdSet = new Set(accepted.map((r) => r.id));
		const remaining = current.filter((r) => !acceptedIdSet.has(r.id));

		// Capture state vector before mutation so we can compute the exact
		// delta to send back to the client in the HTTP response. The client
		// applies this delta directly — no WebSocket round-trip, no remount.
		const beforeStateVector = Y.encodeStateVector(ydoc);

		// Mutate the live fragment one op at a time, touching only the
		// paragraphs each op covers. Concurrent user typing in any other
		// paragraph merges through Yjs CRDT untouched. `write` ops are
		// wholesale by contract. Every op here is agent-authored, so both
		// paths tag introduced text with the `ai` provenance attribute
		// (diff-scoped: carried-over user prose stays human-authored).
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
						replaceYDocTextWithAiProvenance(ydoc, round.afterMd);
					}
					continue;
				}
				if (op.type === 'write') {
					replaceYDocTextWithAiProvenance(ydoc, op.content);
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

		return { acceptedCount: accepted.length, rounds: remaining, yjsUpdate, skippedStale };
	});
}

export async function rejectTabRounds(
	tabId: string,
	roundId?: string,
	options?: { keepThreads?: boolean }
): Promise<{ rejectedCount: number; rounds: PendingReviewRound[]; yjsUpdate: string | null }> {
	return withLiveDoc(tabId, (ydoc) => {
		const reviewArr = getReviewArray(ydoc);
		const current = reviewArr.toArray();
		if (current.length === 0) return { rejectedCount: 0, rounds: [], yjsUpdate: null };
		// No roundId = reject everything. With a roundId, drop only that
		// round; later rounds stay and will surface stale if they no longer
		// apply (the materializer marks them).
		// keepThreads: drop the edit but leave its announce thread open —
		// used when Accept on a stale proposal re-queues the agent to
		// re-attach that same thread to the current text.
		const keepThreads = options?.keepThreads === true;
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
				if (!keepThreads) resolveEmptyEditThreads(ydoc, threadIdsOf(current));
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
			if (!keepThreads) resolveEmptyEditThreads(ydoc, threadIdsOf([current[idx]]));
		}, USER_ORIGIN);
		const remaining = current.slice(0, idx).concat(current.slice(idx + 1));
		const deltaBytes = Y.encodeStateAsUpdate(ydoc, beforeStateVector);
		const yjsUpdate = Buffer.from(deltaBytes).toString('base64');
		touchLastSeen(tabId, ydoc);
		return { rejectedCount: 1, rounds: remaining, yjsUpdate };
	});
}

/** Dismiss (or reopen) a comment thread. The thread is the PARENT of any
 * edits grouped under it, so dismissing it also drops those pending edits —
 * a dismissed thread carries no live proposals. Both the comments-map write
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

/** Disconnect any WS clients and drop the in-memory Hocuspocus Document for
 * a tab, WITHOUT touching its persisted state. The next load replays from
 * SQLite. Used by the rename path (the log is migrated to the new id, not
 * discarded) and as the first half of `destroyTabState`. */
export async function unloadTabDoc(tabId: string): Promise<void> {
	const server = globalHolder().__docwriterWsServer;
	if (!server?.hocuspocus) return;
	try {
		server.hocuspocus.closeConnections(tabId);
	} catch (err) {
		console.error(`[docwriter] closeConnections failed for "${tabId}":`, err);
	}
	const doc = server.hocuspocus.documents.get(tabId);
	if (doc) {
		try {
			await server.hocuspocus.unloadDocument(doc);
		} catch (err) {
			console.error(`[docwriter] unloadDocument failed for "${tabId}":`, err);
		}
		server.hocuspocus.documents.delete(tabId);
	}
}

/** Fully tear down state for a document whose file was just deleted:
 * snapshot a JSON backup, disconnect WS clients, unload the live Document,
 * and delete the identity row — the yjs_updates FK cascades the whole log
 * in the same statement. Without the delete, reopening the same path would
 * replay stale updates and silently resurrect the deleted content. */
export async function destroyTabState(tabId: string): Promise<void> {
	// Snapshot before destruction (invariant: no deletion without a backup),
	// and collect the doomed thread ids so the feedback-import ledger drops
	// its references instead of pointing at threads that no longer exist.
	try {
		const live = getLiveDocument(tabId);
		const ydoc = live ?? new Y.Doc();
		if (!live) replayUpdatesInto(ydoc, tabId);
		const threadIds = [...getCommentsMap(ydoc).keys()];
		if (serializeYDoc(ydoc).length > 0 || threadIds.length > 0) {
			backupDocumentState(tabId, 'delete-file', ydoc);
		}
		scrubFeedbackThreads(threadIds);
		if (!live) ydoc.destroy();
	} catch (err) {
		console.error(`[docwriter] pre-delete backup failed for "${tabId}":`, err);
	}
	await unloadTabDoc(tabId);
	deleteDocument(tabId);
	clearTabCaches(tabId);
}

// Re-export so legacy imports resolve.
export { readReviewRounds };
