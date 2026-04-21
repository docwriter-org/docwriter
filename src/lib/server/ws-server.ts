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
	readReviewRounds,
	serializeYDoc,
	replaceYDocText
} from '$lib/shared/ydoc-codec';
import { applyPendingReviewRound } from '$lib/review-rounds';
import {
	appendUpdate,
	replayUpdatesInto,
	markTabDirty,
	flushMarkdownNow,
	clearDirty,
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
			const expected = currentServerInstanceId();
			if (!token || token === expected) return;
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
): Promise<{ acceptedCount: number; rounds: PendingReviewRound[] }> {
	return withLiveDoc(tabId, (ydoc) => {
		const reviewArr = getReviewArray(ydoc);
		const current = reviewArr.toArray();
		let cutIdx: number;
		if (!roundId) {
			if (current.length === 0) return { acceptedCount: 0, rounds: [] };
			cutIdx = current.length;
		} else {
			const idx = current.findIndex((r) => r.id === roundId);
			if (idx < 0) return { acceptedCount: 0, rounds: current };
			cutIdx = idx + 1;
		}
		const accepted = current.slice(0, cutIdx);
		const remaining = current.slice(cutIdx);

		let commitTarget = serializeYDoc(ydoc);
		for (const round of accepted) {
			const applied = applyPendingReviewRound(commitTarget, round);
			if (applied.stale) {
				const err = new Error(
					round.staleReason ??
						applied.staleReason ??
						'This proposal is stale and needs to be regenerated before it can be accepted.'
				);
				err.name = 'StalePendingReviewError';
				throw err;
			}
			commitTarget = applied.nextText;
		}

		ydoc.transact(() => {
			if (serializeYDoc(ydoc) !== commitTarget) {
				replaceYDocText(ydoc, commitTarget);
			}
			reviewArr.delete(0, cutIdx);
		}, USER_ORIGIN);

		return { acceptedCount: accepted.length, rounds: remaining };
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

// Re-export so legacy imports resolve.
export { readReviewRounds };
