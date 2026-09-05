import * as Y from 'yjs';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import { env } from '$env/dynamic/public';
import {
	COMMENTS_MAP_NAME,
	FRAGMENT_NAME,
	REVIEW_ARRAY_NAME,
	USER_ORIGIN,
	type CommentsMap
} from '$lib/shared/ydoc-codec';
import type { PendingReviewRound } from './types';

/**
 * Per-tab Y.Doc registry. Each tab has its own Y.Doc bound to a
 * `HocuspocusProvider` that syncs it with the server-authoritative Y.Doc
 * over WebSocket.
 *
 * Callers pass an explicit `tabId` — there is no module-level "current tab".
 * The UI's `activeTab` store is the source of truth for which tab is focused.
 *
 * Each Y.Doc holds:
 *   - an XmlFragment named `default` (editor content, via y-prosemirror)
 *   - a Y.Array named `rounds` (PendingReviewRound entries)
 */

interface TabDoc {
	ydoc: Y.Doc;
	wsProvider: HocuspocusProvider | null;
	readyPromise: Promise<void>;
}

function wsUrl(): string {
	// Runtime (not build-time) env: the CLI picks a free WS port per instance
	// and passes it via PUBLIC_DOCWRITER_WS_PORT, so the value can't be baked
	// into the bundle at build time.
	const port = env.PUBLIC_DOCWRITER_WS_PORT || '3001';
	return `ws://${location.hostname}:${port}`;
}

const registry = new Map<string, TabDoc>();

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

/** Resolve once the provider has no unsynced local changes. Event-driven:
 * listens for `synced` and `unsyncedChanges` and resolves the first time
 * both conditions line up. Returns `false` on timeout so callers can avoid
 * racing a server read against still-in-flight keystrokes. */
function waitForProviderIdle(
	provider: HocuspocusProvider,
	timeoutMs = 2_000
): Promise<boolean> {
	return new Promise((resolve) => {
		const idle = () => provider.synced && !provider.hasUnsyncedChanges;
		if (idle()) {
			resolve(true);
			return;
		}
		let done = false;
		const finish = (ok: boolean) => {
			if (done) return;
			done = true;
			provider.off('unsyncedChanges', check);
			provider.off('synced', check);
			clearTimeout(timer);
			resolve(ok);
		};
		const check = () => {
			if (idle()) finish(true);
		};
		const timer = setTimeout(() => finish(idle()), timeoutMs);
		provider.on('unsyncedChanges', check);
		provider.on('synced', check);
	});
}

export const SERVER_INSTANCE_STORAGE_KEY = 'docwriter.serverInstanceId';

function currentInstanceToken(): string {
	if (typeof window === 'undefined') return '';
	return sessionStorage.getItem(SERVER_INSTANCE_STORAGE_KEY) ?? '';
}

let instanceMismatchHandled = false;
function handleInstanceMismatch(): void {
	if (typeof window === 'undefined') return;
	if (instanceMismatchHandled) return;
	instanceMismatchHandled = true;
	for (const [id, entry] of Array.from(registry)) {
		if (entry.wsProvider) {
			try { entry.wsProvider.destroy(); } catch {}
		}
		try { entry.ydoc.destroy(); } catch {}
		registry.delete(id);
	}
	sessionStorage.removeItem(SERVER_INSTANCE_STORAGE_KEY);
	window.location.reload();
}

/** Tabs whose provider is deliberately offline for the Accept/Reject
 * transport (`pauseTabSync`). Their disconnects are expected and must not
 * be reported as a lost connection. */
const pausedTabs = new Set<string>();

type SyncConnectionListener = (event: { tabId: string; connected: boolean }) => void;
const syncConnectionListeners = new Set<SyncConnectionListener>();
/** How long a tab may sit disconnected (outside a pause) before it counts
 * as a lost connection. Reconnects normally take milliseconds. */
const LOST_CONNECTION_GRACE_MS = 5_000;
const lostTimers = new Map<string, ReturnType<typeof setTimeout>>();
const reportedLost = new Set<string>();

/** Be told when a tab's WebSocket has been down for longer than a normal
 * reconnect, and when it comes back. A silently dead provider is invisible
 * otherwise: keystrokes stop reaching the server and the agent's proposals
 * stop arriving, while every button still looks alive. */
export function onSyncConnectionChange(listener: SyncConnectionListener): () => void {
	syncConnectionListeners.add(listener);
	return () => syncConnectionListeners.delete(listener);
}

function trackConnection(provider: HocuspocusProvider, tabId: string): void {
	provider.on('status', ({ status }: { status: WebSocketStatus }) => {
		if (status === WebSocketStatus.Connected) {
			const timer = lostTimers.get(tabId);
			if (timer) clearTimeout(timer);
			lostTimers.delete(tabId);
			if (reportedLost.delete(tabId)) {
				for (const l of syncConnectionListeners) l({ tabId, connected: true });
			}
			return;
		}
		if (pausedTabs.has(tabId) || lostTimers.has(tabId) || reportedLost.has(tabId)) return;
		lostTimers.set(
			tabId,
			setTimeout(() => {
				lostTimers.delete(tabId);
				if (pausedTabs.has(tabId) || provider.configuration.websocketProvider.status === WebSocketStatus.Connected) return;
				reportedLost.add(tabId);
				for (const l of syncConnectionListeners) l({ tabId, connected: false });
			}, LOST_CONNECTION_GRACE_MS)
		);
	});
}

function createProvider(ydoc: Y.Doc, tabId: string): HocuspocusProvider {
	const provider = new HocuspocusProvider({
		url: wsUrl(),
		name: tabId,
		document: ydoc,
		token: currentInstanceToken,
		onAuthenticationFailed: handleInstanceMismatch
	});
	trackConnection(provider, tabId);
	return provider;
}

/** Get or create the local Y.Doc + Hocuspocus provider for `tabId`. */
export function getYDocForTab(tabId: string): Y.Doc {
	const existing = registry.get(tabId);
	if (existing) return existing.ydoc;
	const ydoc = new Y.Doc();
	let wsProvider: HocuspocusProvider | null = null;
	let readyPromise: Promise<void>;
	if (typeof window !== 'undefined') {
		wsProvider = createProvider(ydoc, tabId);
		readyPromise = waitForSynced(wsProvider);
	} else {
		readyPromise = Promise.resolve();
	}
	registry.set(tabId, { ydoc, wsProvider, readyPromise });
	return ydoc;
}

export function getXmlFragmentForTab(tabId: string): Y.XmlFragment {
	return getYDocForTab(tabId).getXmlFragment(FRAGMENT_NAME);
}

export function getReviewArrayForTab(tabId: string): Y.Array<PendingReviewRound> {
	return getYDocForTab(tabId).getArray<PendingReviewRound>(REVIEW_ARRAY_NAME);
}

/** Comment-thread map for a specific tab. Keyed by thread id; values are
 * nested Y.Maps (or legacy plain objects) — read via `readThreadValue`. */
export function getCommentsMapForTab(tabId: string): CommentsMap {
	return getYDocForTab(tabId).getMap<unknown>(COMMENTS_MAP_NAME);
}

/** First Hocuspocus `synced` for `tabId`. */
export function whenYDocReadyForTab(tabId: string): Promise<void> {
	getYDocForTab(tabId);
	return registry.get(tabId)!.readyPromise;
}

/** True when the tab's provider has no unsynced local changes (or no provider). */
export function waitForTabSync(tabId: string, timeoutMs = 2_000): Promise<boolean> {
	const doc = registry.get(tabId);
	if (!doc) return Promise.resolve(false);
	if (!doc.wsProvider) return Promise.resolve(true);
	return waitForProviderIdle(doc.wsProvider, timeoutMs);
}

/** Temporarily stop receiving WebSocket updates for a tab. Accept/Reject use
 * this to prevent the server's broadcast from winning the race against the
 * HTTP response: the returned update must be applied locally with USER_ORIGIN
 * so the editor creates a real undo stack item. */
export function pauseTabSync(tabId: string): () => void {
	const doc = registry.get(tabId);
	const provider = doc?.wsProvider;
	if (!provider) return () => {};
	pausedTabs.add(tabId);
	provider.disconnect();
	let resumed = false;
	return () => {
		if (resumed) return;
		resumed = true;
		pausedTabs.delete(tabId);
		// `disconnect()` only STARTS the close handshake. If the server's
		// HTTP reply beats the close frame back, the socket still reports
		// Connected here, and the provider's `connect()` returns early
		// without re-arming `shouldConnect` — so when the close completes
		// a moment later nothing reconnects, and this tab is silently
		// offline for the rest of the session: keystrokes stop syncing and
		// the agent's next proposals never arrive. Re-arm the flag first;
		// the provider's own close handler then reconnects in that case,
		// and `connect()` handles the already-closed case as before.
		provider.configuration.websocketProvider.shouldConnect = true;
		void provider.connect();
	};
}

export function isYDocEmptyForTab(tabId: string): boolean {
	return getXmlFragmentForTab(tabId).length === 0;
}

export async function destroyTab(tabId: string): Promise<void> {
	const doc = registry.get(tabId);
	if (!doc) return;
	if (doc.wsProvider) doc.wsProvider.destroy();
	doc.ydoc.destroy();
	registry.delete(tabId);
}

/** Migrate a tab's Y.Doc to a new id after a file rename. Carries state
 * over so the next connect doesn't start from an empty doc. */
export async function renameTab(oldId: string, newId: string): Promise<void> {
	if (oldId === newId) return;
	const existing = registry.get(oldId);
	if (!existing) return;
	const state = Y.encodeStateAsUpdate(existing.ydoc);
	const newYdoc = new Y.Doc();
	Y.applyUpdate(newYdoc, state);
	if (existing.wsProvider) existing.wsProvider.destroy();
	existing.ydoc.destroy();
	registry.delete(oldId);
	let wsProvider: HocuspocusProvider | null = null;
	let readyPromise: Promise<void>;
	if (typeof window !== 'undefined') {
		wsProvider = createProvider(newYdoc, newId);
		readyPromise = waitForSynced(wsProvider);
	} else {
		readyPromise = Promise.resolve();
	}
	registry.set(newId, { ydoc: newYdoc, wsProvider, readyPromise });
}

/** Apply a base64-encoded Yjs update directly to a tab's local Y.Doc.
 * Use USER_ORIGIN so the editor's UndoManager records accept/reject
 * transactions as user actions; the later WebSocket broadcast of the same
 * server update is a CRDT no-op. */
export function applyUpdateToTab(tabId: string, updateBase64: string): void {
	const doc = registry.get(tabId);
	if (!doc) return;
	const bytes = Uint8Array.from(atob(updateBase64), (c) => c.charCodeAt(0));
	Y.applyUpdate(doc.ydoc, bytes, USER_ORIGIN);
}

export async function resetAllYDocs(): Promise<void> {
	for (const [id] of Array.from(registry)) {
		await destroyTab(id);
	}
}

/** Reset every in-memory Y.Doc if the server's `serverInstanceId` doesn't
 * match what this browser tab last saw. Prevents stale ops from syncing up
 * into a freshly-seeded server doc after a restart. */
export async function reconcileServerInstance(currentId: string): Promise<void> {
	if (typeof window === 'undefined') return;
	const stored = sessionStorage.getItem(SERVER_INSTANCE_STORAGE_KEY);
	if (stored && stored !== currentId) {
		await resetAllYDocs();
	}
	sessionStorage.setItem(SERVER_INSTANCE_STORAGE_KEY, currentId);
}
