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
import type { CommentThread, ThreadOutcome } from '$lib/types';
import {
	USER_ORIGIN,
	SYSTEM_ORIGIN,
	FRAGMENT_NAME,
	getCommentsMap,
	getThread,
	appendThreadMessage,
	setThreadResolved,
	migrateLegacyThreads,
	readCommentThreads,
	serializeYDoc
} from '$lib/shared/ydoc-codec';
import {
	migrateLegacyReviewState,
	proposalThreadIds,
	resolveThreadMarks,
	summarizeThreadMarks
} from '$lib/shared/proposals';
import { touchLastSeen } from '$lib/server/last-seen';
import {
	appendUpdate,
	replayUpdatesInto,
	markTabDirty,
	flushMarkdownNow,
	clearDirty,
	isTabDirty,
	clearTabCaches,
	compactTab,
	setLiveDocResolver
} from './ydoc-persistence';
import { isBinaryTabPath } from './document-files';
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
			if (isBinaryTabPath(tabId)) return document;
			// Register the identity row before any update rows exist — the
			// yjs_updates FK requires it, which turns what used to be a silent
			// orphan into a loud error.
			ensureDocument(tabId);
			const ydoc = document as unknown as Y.Doc;
			const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
			if (fragment.length === 0) {
				replayUpdatesInto(ydoc, tabId);
			}
			// Upgrade legacy plain-object threads to nested Y form on the
			// authoritative load. onChange isn't attached yet, so the delta
			// is persisted manually (same pattern as the file seed).
			const before = Y.encodeStateVector(ydoc);
			migrateLegacyThreads(ydoc);
			migrateLegacyProposals(tabId, ydoc);
			const delta = Y.encodeStateAsUpdate(ydoc, before);
			if (delta.length > 0) appendUpdate(tabId, delta, SYSTEM_ORIGIN);
			return document;
		},
		async afterUnloadDocument({ documentName: tabId }) {
			onTabUnloaded(tabId);
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

/** A tab's live doc just left memory (its last connection closed — the
 * browser's Accept/Reject pause, a tab switch, a dropped socket). A change
 * still waiting for the 500ms flush tick would otherwise never reach the
 * workspace file: the tick resolves the live doc, finds none, and skips the
 * tab, so `document.md` lagged the CRDT until the next edit (and a reader
 * of the file — git, the agent's built-in Read — saw stale text). Replay
 * the log and write the file now instead. */
export function onTabUnloaded(tabId: string) {
	if (isTabDirty(tabId)) {
		try {
			flushTabMarkdownNow(tabId);
		} catch (err) {
			console.error(`[docwriter] flush on unload failed for "${tabId}":`, err);
		}
	}
	clearDirty(tabId);
	maybeCompactTab(tabId);
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

/** Land or discard one thread's proposal and resolve the thread, in one
 * `USER_ORIGIN` transaction so the client applies the returned delta as a
 * single undoable step: ctrl+z reopens the thread AND brings its marks
 * back. `accepted` keeps the inserted text (stamped `ai`) and removes the
 * struck text; `rejected` and `dismissed` revert. A thread with no
 * proposal (a comment) just resolves. */
export async function resolveTabThread(
	tabId: string,
	threadId: string,
	outcome: ThreadOutcome
): Promise<{ ok: boolean; hadProposal: boolean; yjsUpdate: string | null }> {
	return withLiveDoc(tabId, (ydoc) => {
		const commentsMap = getCommentsMap(ydoc);
		if (!getThread(commentsMap, threadId)) return { ok: false, hadProposal: false, yjsUpdate: null };
		const hadProposal = proposalThreadIds(ydoc).has(threadId);
		const beforeStateVector = Y.encodeStateVector(ydoc);
		ydoc.transact(() => {
			resolveThreadMarks(ydoc, threadId, outcome);
			setThreadResolved(commentsMap, threadId, true, outcome);
		}, USER_ORIGIN);
		const yjsUpdate = Buffer.from(Y.encodeStateAsUpdate(ydoc, beforeStateVector)).toString('base64');
		touchLastSeen(tabId, ydoc);
		return { ok: true, hadProposal, yjsUpdate };
	});
}

/** Accept or reject every open thread that holds a proposal, as one
 * undoable step. */
export async function resolveAllTabThreads(
	tabId: string,
	outcome: 'accepted' | 'rejected'
): Promise<{ count: number; yjsUpdate: string | null }> {
	return withLiveDoc(tabId, (ydoc) => {
		const commentsMap = getCommentsMap(ydoc);
		const ids = [...proposalThreadIds(ydoc)].filter((id) => {
			const t = getThread(commentsMap, id);
			return t && !t.resolved;
		});
		if (ids.length === 0) return { count: 0, yjsUpdate: null };
		const beforeStateVector = Y.encodeStateVector(ydoc);
		ydoc.transact(() => {
			for (const id of ids) {
				resolveThreadMarks(ydoc, id, outcome);
				setThreadResolved(commentsMap, id, true, outcome);
			}
		}, USER_ORIGIN);
		const yjsUpdate = Buffer.from(Y.encodeStateAsUpdate(ydoc, beforeStateVector)).toString('base64');
		touchLastSeen(tabId, ydoc);
		return { count: ids.length, yjsUpdate };
	});
}

/** Dismiss (or reopen) a comment thread. Dismissing reverts any proposal the
 * thread holds — a dismissed thread carries no live marks. Reopening clears
 * the flag; the marks come back only through undo. */
export async function setThreadResolution(
	tabId: string,
	threadId: string,
	resolved: boolean
): Promise<{ ok: boolean; yjsUpdate: string | null }> {
	if (resolved) {
		const r = await resolveTabThread(tabId, threadId, 'dismissed');
		return { ok: r.ok, yjsUpdate: r.yjsUpdate };
	}
	return withLiveDoc(tabId, (ydoc) => {
		const commentsMap = getCommentsMap(ydoc);
		if (!getThread(commentsMap, threadId)) return { ok: false, yjsUpdate: null };
		const beforeStateVector = Y.encodeStateVector(ydoc);
		ydoc.transact(() => setThreadResolved(commentsMap, threadId, false), USER_ORIGIN);
		const yjsUpdate = Buffer.from(Y.encodeStateAsUpdate(ydoc, beforeStateVector)).toString('base64');
		return { ok: true, yjsUpdate };
	});
}

/** Threads with proposals, and their summaries, on a tab's live doc. */
export function readTabProposals(ydoc: Y.Doc) {
	return summarizeThreadMarks(ydoc).filter((s) => s.hasProposal);
}

/** Carry a document written under the pending-round model (a `rounds`
 * array of string pairs, threads anchored by quote) over to marks. Runs on
 * the authoritative load path, inside the caller's persist window. A round
 * whose text no longer matches is dropped and its thread told why. A
 * backup precedes any change. */
function migrateLegacyProposals(tabId: string, ydoc: Y.Doc): void {
	const legacyRounds = ydoc.getArray('rounds').length;
	const threads = readCommentThreads(ydoc);
	const marked = new Set(summarizeThreadMarks(ydoc).map((s) => s.threadId));
	const needsAnchor = threads.some((t) => !t.resolved && t.anchor?.quote && !marked.has(t.id));
	if (legacyRounds === 0 && !needsAnchor) return;
	backupDocumentState(tabId, 'proposal-migration', ydoc);
	const byId = new Map<string, CommentThread>(threads.map((t) => [t.id, t]));
	let result = { migrated: 0, dropped: 0, anchored: 0 };
	ydoc.transact(() => {
		result = migrateLegacyReviewState(
			ydoc,
			(id) => {
				const t = byId.get(id);
				return { exists: !!t, resolved: t?.resolved ?? false, quote: t?.anchor?.quote ?? null };
			},
			(threadId, reason) => {
				if (!threadId || !byId.has(threadId)) return;
				appendThreadMessage(getCommentsMap(ydoc), threadId, {
					id: 'msg_migrated_' + Math.random().toString(36).slice(2, 10),
					author: 'agent',
					text: `I could not carry my earlier proposal on this thread over to the new tracked-changes format because ${reason}. Ask me to propose it again.`,
					timestamp: Date.now()
				});
			}
		);
	}, SYSTEM_ORIGIN);
	console.log(
		`[docwriter] migrated "${tabId}" to marks: ${result.migrated} proposal(s) carried, ${result.dropped} dropped, ${result.anchored} thread(s) re-anchored`
	);
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
