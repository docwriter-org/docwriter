/**
 * In-memory per-tab Y.Doc + UndoManager registry on the server.
 *
 * Phase 7: the UndoManager is constructed BEFORE the persisted updates are
 * replayed into the Y.Doc. That ordering is load-bearing for Reject after a
 * server restart — each `ydoc.transact(..., origin)` in `replayUpdatesInto`
 * fires through the UndoManager's observer, so AGENT_ORIGIN transactions
 * repopulate the undo stack on cold start. If the UndoManager were built
 * afterward (the Phase 2 shape), the stack would always be empty at boot
 * and a Reject of a pending round would silently do nothing.
 *
 * `AGENT_ORIGIN` is the transaction-origin tag used for server-side agent
 * writes. The UndoManager relies on that tag to isolate agent edits from
 * user edits.
 */
import * as Y from 'yjs';
import { replayUpdatesInto } from './ydoc-persistence';

export const AGENT_ORIGIN = 'agent';

const FRAGMENT_NAME = 'default';
const REVIEW_MAP_NAME = 'review';

interface TabYDocEntry {
	ydoc: Y.Doc;
	undoManager: Y.UndoManager;
	reviewMap: Y.Map<unknown>;
}

const registry = new Map<string, TabYDocEntry>();

/** Get (or lazily load) the Y.Doc entry for a tab. First call constructs a
 * fresh Y.Doc, attaches an AGENT_ORIGIN-tracking UndoManager, and THEN
 * replays any persisted updates so the UndoManager observes each replayed
 * transaction with its original origin. Subsequent calls return the cached
 * entry. */
export function getTabYDoc(tabId: string): TabYDocEntry {
	let entry = registry.get(tabId);
	if (!entry) {
		const ydoc = new Y.Doc();
		const xmlFragment = ydoc.getXmlFragment(FRAGMENT_NAME);
		const reviewMap = ydoc.getMap(REVIEW_MAP_NAME);
		const undoManager = new Y.UndoManager(xmlFragment, {
			trackedOrigins: new Set([AGENT_ORIGIN])
		});
		// Replay AFTER the UndoManager is attached so agent-origin
		// transactions from prior sessions repopulate the undo stack.
		replayUpdatesInto(ydoc, tabId);
		entry = { ydoc, undoManager, reviewMap };
		registry.set(tabId, entry);
	}
	return entry;
}

/** Release an in-memory Y.Doc entry. Called when a tab is deleted or
 * explicitly unloaded; does NOT remove persisted updates from SQLite. */
export function destroyTabYDoc(tabId: string) {
	const entry = registry.get(tabId);
	if (entry) {
		entry.undoManager.destroy();
		entry.ydoc.destroy();
		registry.delete(tabId);
	}
}
