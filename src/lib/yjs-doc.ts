import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

/**
 * Per-tab Y.Doc registry. Each tab has its own Y.Doc bound to a
 * `HocuspocusProvider` that syncs it with the server-authoritative Y.Doc
 * over WebSocket. Switching tabs switches which Y.Doc is "current"; the
 * editor rebuilds itself against the new doc.
 *
 * Each Y.Doc holds:
 *   - an XmlFragment named `default` (the editor content, via y-prosemirror)
 *   - a Y.Map named `review` with `pendingRounds`
 *
 * Phase 3: IndexedDB persistence is gone. The server is the single source
 * of truth — it replays each tab's Yjs update log from SQLite on first
 * connect and streams updates back to the browser via the provider.
 * `whenYDocReady` now awaits the provider's `synced` event; the Tiptap
 * editor mounts after that so it binds against a fully-hydrated Y.Doc.
 */

const FRAGMENT_NAME = 'default';
const REVIEW_MAP_NAME = 'review';

interface TabDoc {
	ydoc: Y.Doc;
	wsProvider: HocuspocusProvider | null;
	readyPromise: Promise<void>;
}

/** Build the WebSocket URL the HocuspocusProvider connects to. The port is
 * injected at build time via Vite's `PUBLIC_DOCWRITER_WS_PORT` env (falling
 * back to 3001 — the server default). Only callable in the browser. */
function wsUrl(): string {
	const port = import.meta.env.PUBLIC_DOCWRITER_WS_PORT || '3001';
	return `ws://${location.hostname}:${port}`;
}

const registry = new Map<string, TabDoc>();
let currentTabId: string | null = null;

/** Build a `synced` Promise wrapper for a HocuspocusProvider. Resolves on
 * the first `synced` event, whether initial sync fires immediately or after
 * a delayed connect. */
function waitForSynced(provider: HocuspocusProvider): Promise<void> {
	return new Promise((resolve) => {
		if (provider.synced) {
			resolve();
			return;
		}
		const onSynced = () => {
			provider.off('synced', onSynced);
			resolve();
		};
		provider.on('synced', onSynced);
	});
}

/** Get (or create) the Y.Doc for a tab. Instantiating a Y.Doc also attaches
 * the WebSocket provider, so the first call for a tab kicks off the server
 * handshake. Subsequent calls return the same instance. */
export function getYDocForTab(tabId: string): Y.Doc {
	const existing = registry.get(tabId);
	if (existing) return existing.ydoc;
	const ydoc = new Y.Doc();
	let wsProvider: HocuspocusProvider | null = null;
	let readyPromise: Promise<void>;
	if (typeof window !== 'undefined') {
		wsProvider = new HocuspocusProvider({
			url: wsUrl(),
			name: tabId,
			document: ydoc
		});
		readyPromise = waitForSynced(wsProvider);
	} else {
		readyPromise = Promise.resolve();
	}
	registry.set(tabId, { ydoc, wsProvider, readyPromise });
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

/** The current tab's review map. Values are serializable JSON;
 * `pendingRounds` holds an array of PendingReviewRound objects. */
export function getReviewMap(): Y.Map<unknown> {
	return requireCurrent().ydoc.getMap(REVIEW_MAP_NAME);
}

/** The review map for a specific tab, without changing the current pointer.
 * Used when a multi-tab render result lands and we need to set review state
 * on background tabs. */
export function getReviewMapForTab(tabId: string): Y.Map<unknown> {
	return getYDocForTab(tabId).getMap(REVIEW_MAP_NAME);
}

/** Resolves once the WebSocket provider has completed its initial sync with
 * the server (i.e. the current tab's Y.Doc is fully hydrated). */
export function whenYDocReady(): Promise<void> {
	return requireCurrent().readyPromise;
}

/** True if the current tab's XmlFragment has no content. */
export function isYDocEmpty(): boolean {
	return getXmlFragment().length === 0;
}

/** Destroy the Y.Doc for a given tab. Called when the user deletes a tab so
 * stale editor state doesn't linger. Disconnects the WebSocket provider so
 * the browser stops receiving updates for the gone tab. */
export async function destroyTab(tabId: string): Promise<void> {
	const doc = registry.get(tabId);
	if (!doc) return;
	if (doc.wsProvider) {
		doc.wsProvider.destroy();
	}
	doc.ydoc.destroy();
	registry.delete(tabId);
	if (currentTabId === tabId) currentTabId = null;
}

/** Migrate a tab's Y.Doc to a new id when the file is renamed. Tears down
 * the old provider, carries the Y.Doc state into a new doc, and connects a
 * fresh provider under the new name. The server's `yjs_updates` table is
 * still keyed by the old id — that's a caveat caller `renameTabAction` in
 * +page.svelte already handles by issuing a PATCH /api/tabs that renames
 * the file on disk; the next open of the new id will seed from that file. */
export async function renameTab(oldId: string, newId: string): Promise<void> {
	if (oldId === newId) return;
	const existing = registry.get(oldId);
	if (!existing) {
		// Old tab's doc was never loaded — nothing to migrate. Let the new
		// tab hydrate fresh from the server on next access.
		return;
	}
	// Snapshot the old doc state, seed a new tab doc, swap the registry.
	const state = Y.encodeStateAsUpdate(existing.ydoc);
	const newYdoc = new Y.Doc();
	Y.applyUpdate(newYdoc, state);

	// Tear down the old WS connection.
	if (existing.wsProvider) {
		existing.wsProvider.destroy();
	}
	existing.ydoc.destroy();
	registry.delete(oldId);

	// Spin up a provider for the new id. The server will seed from the
	// renamed-to file if its `yjs_updates` table has no rows for `newId`.
	let wsProvider: HocuspocusProvider | null = null;
	let readyPromise: Promise<void>;
	if (typeof window !== 'undefined') {
		wsProvider = new HocuspocusProvider({
			url: wsUrl(),
			name: newId,
			document: newYdoc
		});
		readyPromise = waitForSynced(wsProvider);
	} else {
		readyPromise = Promise.resolve();
	}
	registry.set(newId, { ydoc: newYdoc, wsProvider, readyPromise });
	if (currentTabId === oldId) currentTabId = newId;
}

/** Dev-only: destroy every tab's in-memory Y.Doc. Server-side state in
 * SQLite is unaffected; next open of a tab re-hydrates from there. */
export async function resetAllYDocs(): Promise<void> {
	for (const [id] of Array.from(registry)) {
		await destroyTab(id);
	}
	currentTabId = null;
}
