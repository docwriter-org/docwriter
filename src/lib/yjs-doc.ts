import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';

/**
 * Per-tab Y.Doc registry. Each tab has its own Y.Doc, bound to its own
 * IndexedDB store (`docwriter-doc:<tabId>`). Switching tabs switches which
 * Y.Doc is "current"; the editor rebuilds itself against the new doc.
 *
 * Each Y.Doc holds:
 *   - an XmlFragment named `default` (the editor content, via y-prosemirror)
 *   - a Y.Map named `review` with `baseline` and `preAgent` snapshot strings
 *     (null when no review is pending)
 *
 * y-indexeddb persists every transaction, so tab content and review state
 * both survive page refresh without any server round-trip.
 */

const DB_PREFIX = 'docwriter-doc:';
const FRAGMENT_NAME = 'default';
const REVIEW_MAP_NAME = 'review';

interface TabDoc {
	ydoc: Y.Doc;
	persistence: IndexeddbPersistence | null;
	readyPromise: Promise<void>;
}

const registry = new Map<string, TabDoc>();
let currentTabId: string | null = null;

/** Get (or create) the Y.Doc for a tab. Instantiating a Y.Doc also sets up
 * its IndexedDB persistence, so the first call for a tab hydrates from
 * whatever was stored previously. Subsequent calls return the same instance. */
export function getYDocForTab(tabId: string): Y.Doc {
	const existing = registry.get(tabId);
	if (existing) return existing.ydoc;
	const ydoc = new Y.Doc();
	let persistence: IndexeddbPersistence | null = null;
	let readyPromise: Promise<void>;
	if (typeof window !== 'undefined') {
		persistence = new IndexeddbPersistence(DB_PREFIX + tabId, ydoc);
		readyPromise = new Promise<void>((resolve) => {
			persistence!.once('synced', () => resolve());
		});
	} else {
		readyPromise = Promise.resolve();
	}
	registry.set(tabId, { ydoc, persistence, readyPromise });
	return ydoc;
}

/** Set which tab is "current" — subsequent calls to getYDoc/getXmlFragment/
 * getReviewMap operate on this tab's document. Changing the current tab
 * does NOT destroy other tabs' docs; they stay in memory so switching back
 * is instant and undo history is preserved. */
export function setCurrentTab(tabId: string): void {
	currentTabId = tabId;
	getYDocForTab(tabId);
}

export function getCurrentTab(): string | null {
	return currentTabId;
}

function requireCurrent(): TabDoc {
	if (!currentTabId) {
		throw new Error('No current tab — call setCurrentTab() before using the Y.Doc.');
	}
	const doc = registry.get(currentTabId);
	if (!doc) {
		// Should be unreachable: setCurrentTab always calls getYDocForTab.
		getYDocForTab(currentTabId);
		return registry.get(currentTabId)!;
	}
	return doc;
}

/** The current tab's Y.Doc. Throws if no tab has been made current. */
export function getYDoc(): Y.Doc {
	return requireCurrent().ydoc;
}

export function getXmlFragment(): Y.XmlFragment {
	return requireCurrent().ydoc.getXmlFragment(FRAGMENT_NAME);
}

/** The current tab's review map. Values are serializable JSON — legacy keys
 * like `baseline`/`preAgent` hold strings, and `pendingRounds` holds an
 * array of PendingReviewRound objects. */
export function getReviewMap(): Y.Map<unknown> {
	return requireCurrent().ydoc.getMap(REVIEW_MAP_NAME);
}

/** The review map for a specific tab, without changing the current pointer.
 * Used when a multi-tab render result lands and we need to set review state
 * on background tabs. */
export function getReviewMapForTab(tabId: string): Y.Map<unknown> {
	return getYDocForTab(tabId).getMap(REVIEW_MAP_NAME);
}

/** Resolves once IndexedDB has hydrated the current tab's Y.Doc. */
export function whenYDocReady(): Promise<void> {
	return requireCurrent().readyPromise;
}

/** True if the current tab's XmlFragment has no content — used to decide
 * whether to seed from the server's markdown on first load. */
export function isYDocEmpty(): boolean {
	return getXmlFragment().length === 0;
}

/** Destroy the Y.Doc for a given tab and clear its IndexedDB store. Called
 * when the user deletes a tab so stale editor state doesn't linger. */
export async function destroyTab(tabId: string): Promise<void> {
	const doc = registry.get(tabId);
	if (!doc) return;
	if (doc.persistence) {
		await doc.persistence.clearData();
		doc.persistence.destroy();
	}
	doc.ydoc.destroy();
	registry.delete(tabId);
	if (currentTabId === tabId) currentTabId = null;
}

/** Migrate a tab's Y.Doc to a new IndexedDB key when the file is renamed.
 * Copies the doc state under the new key, then deletes the old store. */
export async function renameTab(oldId: string, newId: string): Promise<void> {
	if (oldId === newId) return;
	const existing = registry.get(oldId);
	if (!existing) {
		// The old tab's doc was never loaded — nothing to migrate. Just
		// let the new tab hydrate fresh from the server on next access.
		return;
	}
	// Snapshot the old doc state, seed a new tab doc, swap the registry.
	const state = Y.encodeStateAsUpdate(existing.ydoc);
	const newYdoc = new Y.Doc();
	Y.applyUpdate(newYdoc, state);

	// Tear down the old IndexedDB store.
	if (existing.persistence) {
		await existing.persistence.clearData();
		existing.persistence.destroy();
	}
	existing.ydoc.destroy();
	registry.delete(oldId);

	// Spin up persistence for the new ID, seed it with the migrated state.
	let persistence: IndexeddbPersistence | null = null;
	let readyPromise: Promise<void>;
	if (typeof window !== 'undefined') {
		persistence = new IndexeddbPersistence(DB_PREFIX + newId, newYdoc);
		readyPromise = new Promise<void>((resolve) => {
			persistence!.once('synced', () => resolve());
		});
	} else {
		readyPromise = Promise.resolve();
	}
	registry.set(newId, { ydoc: newYdoc, persistence, readyPromise });
	if (currentTabId === oldId) currentTabId = newId;
}

/** Dev-only: nuke every tab's IndexedDB store and in-memory Y.Doc. */
export async function resetAllYDocs(): Promise<void> {
	for (const [id] of Array.from(registry)) {
		await destroyTab(id);
	}
	currentTabId = null;
}
