/**
 * Hocuspocus WebSocket server for Y.Doc sync.
 *
 * Hocuspocus owns the one Y.Doc per tab. `onLoadDocument` hydrates it from
 * SQLite; `onChange` appends every update to `yjs_updates` and marks the tab
 * dirty for the global 500ms flush loop. One UndoManager per live Document,
 * stored as a private property on the doc so it tracks the live state for
 * the full lifetime of that doc (and gets GC'd with it).
 *
 * Origin tagging:
 *   - agent writes via `openDirectConnection` transact with AGENT_ORIGIN.
 *   - user keystrokes arrive with a Connection object as the origin; onChange
 *     normalizes those to USER_ORIGIN.
 *   - cold-start replay and file-seed carry SYSTEM_ORIGIN.
 * The UndoManager's `trackedOrigins` = {AGENT_ORIGIN}.
 */
import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';
import type { PendingReviewRound } from '$lib/types';
import {
	AGENT_ORIGIN,
	USER_ORIGIN,
	FRAGMENT_NAME,
	getReviewArray,
	getFragment,
	readReviewRounds,
	serializeYDoc,
	replaceYDocText,
	applyEditToFragment
} from '$lib/shared/ydoc-codec';
import { applyPendingReviewRound } from '$lib/review-rounds';
import {
	appendUpdate,
	replayUpdatesInto,
	markTabDirty,
	flushMarkdownNow,
	clearDirty,
	purgeTabUpdates,
	setLiveDocResolver
} from './ydoc-persistence';

const UNDO_MANAGER_KEY = Symbol('docwriter.undoManager');

interface DocWithUndo extends Y.Doc {
	[UNDO_MANAGER_KEY]?: Y.UndoManager;
}

function ensureUndoManager(doc: Y.Doc): Y.UndoManager {
	const d = doc as DocWithUndo;
	if (d[UNDO_MANAGER_KEY]) return d[UNDO_MANAGER_KEY]!;
	const mgr = new Y.UndoManager(doc.getXmlFragment(FRAGMENT_NAME), {
		trackedOrigins: new Set([AGENT_ORIGIN]),
		captureTimeout: 0
	});
	d[UNDO_MANAGER_KEY] = mgr;
	return mgr;
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
			const ydoc = document as unknown as Y.Doc;
			const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
			// UndoManager must exist BEFORE replay so agent-origin transactions
			// from prior sessions repopulate the undo stack.
			ensureUndoManager(ydoc);
			if (fragment.length === 0) {
				replayUpdatesInto(ydoc, tabId);
			}
			return document;
		},
		async afterUnloadDocument({ documentName: tabId }) {
			clearDirty(tabId);
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

export async function acceptTabRounds(
	tabId: string,
	roundId?: string
): Promise<{ acceptedCount: number; rounds: PendingReviewRound[]; yjsUpdate: string | null }> {
	return withLiveDoc(tabId, (ydoc) => {
		const reviewArr = getReviewArray(ydoc);
		const current = reviewArr.toArray();
		// roundId omitted → batch-accept everything (kept oldest-first so
		// each round applies against the previous round's output, the same
		// order the agent generated them in).
		// roundId given → accept ONLY that round, leave the rest pending.
		// Rounds are independent unless their text overlaps; the stale
		// check below will surface a 409 if accepting this one alone would
		// leave it inapplicable (e.g. its old_string only existed after a
		// prior pending round had landed).
		let accepted: PendingReviewRound[];
		let remaining: PendingReviewRound[];
		if (!roundId) {
			if (current.length === 0) return { acceptedCount: 0, rounds: [], yjsUpdate: null };
			accepted = current;
			remaining = [];
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
		}, USER_ORIGIN);

		// Encode the exact Yjs delta so the client can apply it immediately
		// via the HTTP response, without waiting for the WebSocket broadcast.
		const deltaBytes = Y.encodeStateAsUpdate(ydoc, beforeStateVector);
		const yjsUpdate = Buffer.from(deltaBytes).toString('base64');

		return { acceptedCount: accepted.length, rounds: remaining, yjsUpdate };
	});
}

export async function rejectTabRounds(
	tabId: string,
	roundId?: string
): Promise<{ rejectedCount: number; rounds: PendingReviewRound[] }> {
	return withLiveDoc(tabId, (ydoc) => {
		const reviewArr = getReviewArray(ydoc);
		const current = reviewArr.toArray();
		if (current.length === 0) return { rejectedCount: 0, rounds: [] };
		// No roundId = reject everything. With a roundId, drop only that
		// round; later rounds stay and will surface stale if they no longer
		// apply (the materializer marks them).
		if (!roundId) {
			ydoc.transact(() => reviewArr.delete(0, current.length), USER_ORIGIN);
			return { rejectedCount: current.length, rounds: [] };
		}
		const idx = current.findIndex((r) => r.id === roundId);
		if (idx < 0) return { rejectedCount: 0, rounds: current };
		ydoc.transact(() => reviewArr.delete(idx, 1), USER_ORIGIN);
		const remaining = current.slice(0, idx).concat(current.slice(idx + 1));
		return { rejectedCount: 1, rounds: remaining };
	});
}

// ── Tab destruction ──────────────────────────────────────────────────────

/** Fully tear down server-side state for a tab whose file was just deleted:
 * disconnect any WS clients, unload the Hocuspocus Document, and drop the
 * persisted CRDT log. Without this, reopening the same path would replay
 * stale updates from SQLite and silently resurrect the deleted content. */
export async function destroyTabState(tabId: string): Promise<void> {
	const server = globalHolder().__docwriterWsServer;
	if (server?.hocuspocus) {
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
	purgeTabUpdates(tabId);
}

// Re-export so legacy imports resolve.
export { readReviewRounds };
