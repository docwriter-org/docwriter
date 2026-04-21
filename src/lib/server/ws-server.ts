/**
 * Hocuspocus WebSocket server for Y.Doc sync.
 *
 * Phase 3: this is the sole Y.Doc transport. Clients connect via
 * HocuspocusProvider, the server replays persisted updates from
 * `yjs_updates` on first load, appends new updates on every change, and
 * debounces a markdown flush back to the workspace file on disk.
 *
 * Important: the Y.Doc passed to `scheduleMarkdownFlush` must be the one
 * from the `onChange` payload (`document`), not the registry Y.Doc.
 * Hocuspocus's `onLoadDocument` copies state into its own internal
 * Document, so the registry Y.Doc becomes stale once clients are connected.
 * Hocuspocus's `Document` class extends `Y.Doc`, so it's API-compatible.
 *
 * The origin string on each row defaults to `'user'` — client updates from
 * WebSocket connections don't carry a Yjs origin string the server can pull
 * out without additional wiring. Agent-driven updates (Phase 4) will come
 * through custom MCP tools that transact with `AGENT_ORIGIN` directly.
 */
import { Server } from '@hocuspocus/server';
import type { Document } from '@hocuspocus/server';
import * as Y from 'yjs';
import type { PendingReviewRound } from '$lib/types';
import { AGENT_ORIGIN } from './ydoc-registry';
import {
	appendUpdate,
	replayUpdatesInto,
	scheduleMarkdownFlush,
	flushMarkdownNow
} from './ydoc-persistence';

// Per-tab UndoManager keyed on the Hocuspocus internal Document that syncs
// with clients. Built in onLoadDocument so it observes the LIVE doc;
// tearing it down in afterUnloadDocument avoids leaking observers.
const undoManagers = new Map<string, Y.UndoManager>();
const hydratedDocuments = new WeakSet<Y.Doc>();

export function getUndoManagerForTabServerSide(tabId: string): Y.UndoManager | null {
	return undoManagers.get(tabId) ?? null;
}

/** Singleton guard — kept on `globalThis` so SvelteKit route handlers can
 * grab the live Hocuspocus server even after Vite HMR re-imports
 * `hooks.server.ts`. Set in `hooks.server.ts`. */
function globalHolder() {
	return globalThis as unknown as { __docwriterWsServer?: Server };
}

export function createWsServer(port: number): Server {
	const server = new Server({
		port,
		// `quiet: true` — we print our own startup log in `hooks.server.ts`;
		// Hocuspocus's default start-screen is too chatty for our dev output.
		quiet: true,
		async onLoadDocument({ documentName: tabId, document }) {
			// `document` IS Hocuspocus's live internal Y.Doc (Document extends
			// Y.Doc). Hydrate it from SQLite — but only once per live Document
			// instance. Replaying the persisted log onto a doc that already has
			// the same logical content under a different clientID tree merges in
			// a second copy of the document, which is exactly the "refresh makes
			// the editor double" failure mode.
			//
			// In normal flow Hocuspocus only calls this hook once per Document
			// and the fragment IS empty here, so the guard is inert. It exists
			// as a structural guarantee: no matter how many times this hook
			// runs on the same live doc (reconnect reuse, direct-connection
			// paths re-entering createDocument, extension-ordering quirks), the
			// SQLite log lands exactly once.
			const ydoc = document as unknown as Y.Doc;
			const xmlFragment = ydoc.getXmlFragment('default');
			const alreadyHydrated =
				hydratedDocuments.has(ydoc) || xmlFragment.length > 0;

			// Fresh UndoManager on the live doc. Built BEFORE replay so
			// AGENT_ORIGIN rows repopulate the undo stack (Phase 7 invariant).
			const prior = undoManagers.get(tabId);
			if (prior) {
				prior.destroy();
				undoManagers.delete(tabId);
			}
			const undoManager = new Y.UndoManager(xmlFragment, {
				trackedOrigins: new Set([AGENT_ORIGIN])
			});
			undoManagers.set(tabId, undoManager);

			if (!alreadyHydrated) {
				replayUpdatesInto(ydoc, tabId);
			}
			hydratedDocuments.add(ydoc);
			return document;
		},
		async afterUnloadDocument({ documentName: tabId }) {
			const mgr = undoManagers.get(tabId);
			if (mgr) {
				mgr.destroy();
				undoManagers.delete(tabId);
			}
		},
		async onChange({ documentName: tabId, update, context, document, transactionOrigin }) {
			// transactionOrigin carries the Yjs origin attached to the
			// transaction that produced this update. For WebSocket-driven
			// updates it's the `Connection` instance; for direct-connection
			// writes (Phase 4 custom MCP tools) it's the string we passed to
			// `document.transact(..., origin)` — AGENT_ORIGIN.
			let origin: string;
			if (typeof transactionOrigin === 'string') {
				origin = transactionOrigin;
			} else if ((context as { origin?: string } | undefined)?.origin) {
				origin = (context as { origin: string }).origin;
			} else {
				origin = 'user';
			}
			appendUpdate(tabId, update, origin);
			// Use the live Document from the payload — the registry Y.Doc
			// goes stale post-connect (Hocuspocus copies state into its own
			// internal Document via encodeStateAsUpdate + applyUpdate).
			scheduleMarkdownFlush(tabId, document);
		}
	});
	globalHolder().__docwriterWsServer = server;
	return server;
}

/** Look up the live Hocuspocus Document for a tab, if one exists. Returns
 * `null` if no client has connected for this tab (the document isn't in
 * Hocuspocus's internal map until `onLoadDocument` fires for a real
 * connection). */
function getLiveDocument(tabId: string): Document | null {
	const server = globalHolder().__docwriterWsServer;
	if (!server) return null;
	const doc = server.hocuspocus.documents.get(tabId) ?? null;
	return doc;
}

/** Synchronously flush the authoritative Y.Doc for a tab to its workspace
 * file. Used by `GET /api/document` so reads always see the latest
 * keystrokes, even when the debounced flush hasn't fired yet (e.g. the
 * agent render path reads the file within 1s of a user edit).
 *
 * Falls back to the registry Y.Doc if no client is connected — that's
 * still the last-known-good state for the tab. */
export function flushTabMarkdownNow(tabId: string) {
	const live = getLiveDocument(tabId);
	if (live) {
		flushMarkdownNow(tabId, live as unknown as Y.Doc);
		return;
	}
	// No live connection — replay updates into a throwaway Y.Doc and
	// serialize that. Post-refactor the registry no longer caches a
	// long-lived Y.Doc (it went stale and caused content loss on reload;
	// see onLoadDocument), so we build state fresh from SQLite.
	const ydoc = new Y.Doc();
	replayUpdatesInto(ydoc, tabId);
	flushMarkdownNow(tabId, ydoc);
	ydoc.destroy();
}

/** Accept one pending review round (or all of them) on the server-
 * authoritative Y.Doc so the mutation is durably persisted before the UI
 * clears. This avoids a hard refresh racing ahead of the browser's
 * WebSocket send and resurrecting already-accepted review cards. */
export async function acceptTabRounds(
	tabId: string,
	roundId?: string
): Promise<{ acceptedCount: number; rounds: PendingReviewRound[] }> {
	const server = globalHolder().__docwriterWsServer;
	const applyAccept = (ydoc: Y.Doc) => {
		let result: { acceptedCount: number; rounds: PendingReviewRound[] } = {
			acceptedCount: 0,
			rounds: []
		};
		ydoc.transact(() => {
			const reviewMap = ydoc.getMap('review');
			const currentRaw = reviewMap.get('pendingRounds');
			const current = Array.isArray(currentRaw)
				? (currentRaw as PendingReviewRound[])
				: [];
			let next: PendingReviewRound[];
			if (!roundId) {
				next = [];
			} else {
				const idx = current.findIndex((round) => round.id === roundId);
				if (idx < 0) {
					result = { acceptedCount: 0, rounds: current };
					return;
				}
				next = current.slice(idx + 1);
			}
			result = {
				acceptedCount: current.length - next.length,
				rounds: next
			};
			reviewMap.set('pendingRounds', next);
			if (next.length === 0) {
				reviewMap.set('baseline', null);
				reviewMap.set('preAgent', null);
			} else {
				reviewMap.set('baseline', next[0].beforeMd);
				reviewMap.set('preAgent', next[0].beforeMd);
			}
		}, 'user');
		return result;
	};

	if (server?.hocuspocus) {
		const direct = await server.hocuspocus.openDirectConnection(tabId);
		try {
			let result: { acceptedCount: number; rounds: PendingReviewRound[] } = {
				acceptedCount: 0,
				rounds: []
			};
			await direct.transact((document) => {
				result = applyAccept(document as unknown as Y.Doc);
			});
			return result;
		} finally {
			await direct.disconnect();
		}
	}

	// Fallback when the WebSocket server isn't available (startup race, or
	// a test harness calling into this without Hocuspocus). Replay SQLite
	// into a throwaway Y.Doc, mutate, and persist the delta directly. The
	// registry no longer caches a long-lived Y.Doc.
	const ydoc = new Y.Doc();
	replayUpdatesInto(ydoc, tabId);
	const before = Y.encodeStateVector(ydoc);
	const result = applyAccept(ydoc);
	const update = Y.encodeStateAsUpdate(ydoc, before);
	if (update.length > 0) appendUpdate(tabId, update, 'user');
	ydoc.destroy();
	return result;
}

/** Reject one pending review round (or all of them). Rejecting undoes the
 * agent-origin transactions that produced the round's content via the
 * server-side UndoManager, then drops the round from the review map.
 *
 * Reject MUST run on the server, not the client: agent edits arrive at the
 * browser via Hocuspocus sync with the provider's internal origin, not
 * AGENT_ORIGIN, so a client-side UndoManager tracking AGENT_ORIGIN can't see
 * them. The server IS where the AGENT_ORIGIN transact happened, so its
 * UndoManager has the stack items. */
export async function rejectTabRounds(
	tabId: string,
	roundId?: string
): Promise<{ rejectedCount: number; rounds: PendingReviewRound[] }> {
	const server = globalHolder().__docwriterWsServer;
	if (!server?.hocuspocus) {
		// No live connection — nothing meaningful to undo (the UndoManager
		// lives with the Hocuspocus Document). Fall back to deleting the
		// rounds without rewinding content; the next real reject on a live
		// connection will behave correctly.
		const ydoc = new Y.Doc();
		replayUpdatesInto(ydoc, tabId);
		const before = Y.encodeStateVector(ydoc);
		let rejectedCount = 0;
		let rounds: PendingReviewRound[] = [];
		ydoc.transact(() => {
			const reviewMap = ydoc.getMap('review');
			const current =
				(reviewMap.get('pendingRounds') as PendingReviewRound[] | undefined) ?? [];
			let next: PendingReviewRound[];
			if (!roundId) {
				next = [];
			} else {
				const idx = current.findIndex((r) => r.id === roundId);
				if (idx < 0) {
					rejectedCount = 0;
					rounds = current;
					return;
				}
				next = current.slice(idx + 1);
			}
			rejectedCount = current.length - next.length;
			rounds = next;
			reviewMap.set('pendingRounds', next);
			if (next.length === 0) {
				reviewMap.set('baseline', null);
				reviewMap.set('preAgent', null);
			} else {
				reviewMap.set('baseline', next[0].beforeMd);
				reviewMap.set('preAgent', next[0].beforeMd);
			}
		}, 'user');
		const update = Y.encodeStateAsUpdate(ydoc, before);
		if (update.length > 0) appendUpdate(tabId, update, 'user');
		ydoc.destroy();
		return { rejectedCount, rounds };
	}

	const undoManager = undoManagers.get(tabId);
	const direct = await server.hocuspocus.openDirectConnection(tabId);
	try {
		let rejectedCount = 0;
		let rounds: PendingReviewRound[] = [];
		await direct.transact((document) => {
			const ydoc = document as unknown as Y.Doc;
			const reviewMap = ydoc.getMap('review');
			const current =
				(reviewMap.get('pendingRounds') as PendingReviewRound[] | undefined) ?? [];
			let keep: PendingReviewRound[];
			let rejected: PendingReviewRound[];
			if (!roundId) {
				keep = [];
				rejected = current;
			} else {
				const idx = current.findIndex((r) => r.id === roundId);
				if (idx < 0) {
					rounds = current;
					return;
				}
				// Per the FIFO reject policy: rejecting round idx also rejects
				// every later round (their content stacks on top and can't be
				// kept without this one). Rewind their undo steps in reverse.
				rejected = current.slice(idx);
				keep = current.slice(0, idx);
			}

			if (undoManager) {
				const totalSteps = rejected.reduce((s, r) => s + (r.stepCount || 1), 0);
				for (let i = 0; i < totalSteps; i++) {
					if (!undoManager.undo()) break;
				}
			}

			rejectedCount = rejected.length;
			rounds = keep;
			reviewMap.set('pendingRounds', keep);
			if (keep.length === 0) {
				reviewMap.set('baseline', null);
				reviewMap.set('preAgent', null);
			} else {
				reviewMap.set('baseline', keep[0].beforeMd);
				reviewMap.set('preAgent', keep[0].beforeMd);
			}
		});
		return { rejectedCount, rounds };
	} finally {
		await direct.disconnect();
	}
}
