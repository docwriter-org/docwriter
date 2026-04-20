/**
 * In-memory per-tab Y.Doc + UndoManager registry on the server.
 *
 * Phase 2: entries are materialized on demand from the `yjs_updates` table
 * (via `loadYDoc`) and cached in a Map. The UndoManager is constructed
 * *after* replay in Phase 2 — Phase 7 may move it before replay so that the
 * UndoManager observes every replayed transaction with its original origin.
 *
 * `AGENT_ORIGIN` matches the string constant in the browser's
 * `src/lib/yjs-agent.ts`. Both sides must agree, or the UndoManager won't
 * correctly isolate agent transactions.
 */
import * as Y from 'yjs';
import { loadYDoc } from './ydoc-persistence';

export const AGENT_ORIGIN = 'agent'; // match the browser's yjs-agent.ts

const FRAGMENT_NAME = 'default';
const REVIEW_MAP_NAME = 'review';

interface TabYDocEntry {
	ydoc: Y.Doc;
	undoManager: Y.UndoManager;
	reviewMap: Y.Map<unknown>;
}

const registry = new Map<string, TabYDocEntry>();

/** Get (or lazily load) the Y.Doc entry for a tab. First call replays any
 * persisted updates from SQLite. Subsequent calls return the cached entry. */
export function getTabYDoc(tabId: string): TabYDocEntry {
	let entry = registry.get(tabId);
	if (!entry) {
		const ydoc = loadYDoc(tabId);
		const xmlFragment = ydoc.getXmlFragment(FRAGMENT_NAME);
		const reviewMap = ydoc.getMap(REVIEW_MAP_NAME);
		const undoManager = new Y.UndoManager(xmlFragment, {
			trackedOrigins: new Set([AGENT_ORIGIN])
		});
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
