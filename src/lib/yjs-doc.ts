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

/** Wait until the provider has no local changes left to send/ack. This is
 * stricter than `synced`: we use it before submit / accept / reject so the
 * server sees the user's latest local typing before it makes decisions
 * based on the document text. */
function waitForProviderQuiescent(
	provider: HocuspocusProvider,
	timeoutMs = 2_000
): Promise<boolean> {
	return new Promise((resolve) => {
		const isIdle = () => provider.synced && !provider.hasUnsyncedChanges;
		if (isIdle()) {
			resolve(true);
			return;
		}

		let settled = false;
		const cleanup = () => {
			provider.off('unsyncedChanges', onUnsyncedChanges);
			provider.off('synced', onSynced);
			if (timer) clearTimeout(timer);
		};
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(ok);
		};
		const maybeFinish = () => {
			if (isIdle()) finish(true);
		};
		const onUnsyncedChanges = () => maybeFinish();
		const onSynced = () => maybeFinish();
		const timer = setTimeout(() => finish(isIdle()), timeoutMs);

		provider.on('unsyncedChanges', onUnsyncedChanges);
		provider.on('synced', onSynced);
		maybeFinish();
	});
}

/** sessionStorage key the client uses to remember which server instance its
 * in-memory Y.Docs have been synced against. Exported so the preflight check
 * and the WS-auth handler share the same key. */
export const SERVER_INSTANCE_STORAGE_KEY = 'docwriter.serverInstanceId';

/** Token the HocuspocusProvider presents on every (re)connect. The server's
 * `onAuthenticate` rejects if this is non-empty and doesn't match its own
 * `serverInstanceId` — the sign that this client's Y.Doc was synced against
 * a different server process than the one now listening. Reads fresh from
 * sessionStorage so a successful preflight reconcile between connections
 * shows up without rebuilding the provider. */
function currentInstanceToken(): string {
	if (typeof window === 'undefined') return '';
	return sessionStorage.getItem(SERVER_INSTANCE_STORAGE_KEY) ?? '';
}

/** Handle a server rejection due to an instance-id mismatch. The client's
 * in-memory Y.Doc holds ops from a previous server process; if we let it
 * keep running, the reconnect loop would either retry endlessly or sync
 * those stale ops up on a later successful auth. Drop everything and do a
 * full page reload — the fresh page's preflight fetch of /api/session will
 * observe the new serverInstanceId and start clean. */
let instanceMismatchHandled = false;
function handleInstanceMismatch(): void {
	if (typeof window === 'undefined') return;
	if (instanceMismatchHandled) return;
	instanceMismatchHandled = true;
	sessionStorage.removeItem(SERVER_INSTANCE_STORAGE_KEY);
	window.location.reload();
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
			document: ydoc,
			token: currentInstanceToken,
			onAuthenticationFailed: handleInstanceMismatch
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

/** Wait until the current tab's local Yjs updates have been acknowledged by
 * the server. Returns false on timeout so callers can avoid racing server
 * reads/mutations against still-in-flight local typing. */
export function waitForCurrentTabSync(timeoutMs = 2_000): Promise<boolean> {
	const doc = requireCurrent();
	if (!doc.wsProvider) return Promise.resolve(true);
	return waitForProviderQuiescent(doc.wsProvider, timeoutMs);
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
			document: newYdoc,
			token: currentInstanceToken,
			onAuthenticationFailed: handleInstanceMismatch
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

/** Compare the server's current `serverInstanceId` to the one this browser
 * tab last observed. If they differ (e.g. the server was restarted while the
 * tab stayed open, or the workspace was wiped), destroy every in-memory Y.Doc
 * BEFORE the next WebSocket provider attaches. Otherwise stale Yjs ops from
 * the pre-restart session would sync up into the freshly-seeded server doc
 * and the debounced markdown flush would clobber disk edits made while the
 * server was down.
 *
 * This is layer 1 of the anti-clobber defense: the HTTP preflight caught on
 * initial page load. Layer 2 is the WS `onAuthenticate` token check that
 * kicks in when the tab stays open across a server restart (no reload to
 * trigger this preflight). Keep both — they cover different cases.
 *
 * Must be awaited before any `setCurrentTab` / `getYDocForTab` call on app
 * mount. Safe to call repeatedly: it only resets on an actual mismatch. */
export async function reconcileServerInstance(currentId: string): Promise<void> {
	if (typeof window === 'undefined') return;
	const stored = sessionStorage.getItem(SERVER_INSTANCE_STORAGE_KEY);
	if (stored && stored !== currentId) {
		await resetAllYDocs();
	}
	sessionStorage.setItem(SERVER_INSTANCE_STORAGE_KEY, currentId);
}
