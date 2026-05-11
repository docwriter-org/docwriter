import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { COMMENTS_MAP_NAME, FRAGMENT_NAME, REVIEW_ARRAY_NAME } from '$lib/shared/ydoc-codec';
import type { CommentThread, PendingReviewRound } from './types';

/**
 * Per-tab Y.Doc registry. Each tab has its own Y.Doc bound to a
 * `HocuspocusProvider` that syncs it with the server-authoritative Y.Doc
 * over WebSocket. Switching tabs switches which Y.Doc is "current".
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
	const port = import.meta.env.PUBLIC_DOCWRITER_WS_PORT || '3001';
	return `ws://${location.hostname}:${port}`;
}

const registry = new Map<string, TabDoc>();
let currentTabId: string | null = null;

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
	// Destroy every provider FIRST so none of them can auto-reconnect
	// with a now-empty token in the microsecond window before reload
	// navigates away. Without this, Hocuspocus will accept the empty
	// token on reconnect (first-load exemption) and the browser's
	// stale in-memory Y.Doc syncs up into the new server's workspace —
	// producing orphan files like a previous session's tab materializing
	// in a brand-new workspace directory.
	for (const [id, entry] of Array.from(registry)) {
		if (entry.wsProvider) {
			try { entry.wsProvider.destroy(); } catch {}
		}
		try { entry.ydoc.destroy(); } catch {}
		registry.delete(id);
	}
	currentTabId = null;
	sessionStorage.removeItem(SERVER_INSTANCE_STORAGE_KEY);
	window.location.reload();
}

function createProvider(ydoc: Y.Doc, tabId: string): HocuspocusProvider {
	return new HocuspocusProvider({
		url: wsUrl(),
		name: tabId,
		document: ydoc,
		token: currentInstanceToken,
		onAuthenticationFailed: handleInstanceMismatch
	});
}

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
		getYDocForTab(currentTabId);
		return registry.get(currentTabId)!;
	}
	return doc;
}

export function getYDoc(): Y.Doc {
	return requireCurrent().ydoc;
}

export function getXmlFragment(): Y.XmlFragment {
	return requireCurrent().ydoc.getXmlFragment(FRAGMENT_NAME);
}

/** Current tab's Y.Array of pending review rounds. */
export function getReviewArray(): Y.Array<PendingReviewRound> {
	return requireCurrent().ydoc.getArray<PendingReviewRound>(REVIEW_ARRAY_NAME);
}

/** Review array for a specific tab without changing the current pointer. */
export function getReviewArrayForTab(tabId: string): Y.Array<PendingReviewRound> {
	return getYDocForTab(tabId).getArray<PendingReviewRound>(REVIEW_ARRAY_NAME);
}

/** Comment-thread map for a specific tab. Keyed by thread id. */
export function getCommentsMapForTab(tabId: string): Y.Map<CommentThread> {
	return getYDocForTab(tabId).getMap<CommentThread>(COMMENTS_MAP_NAME);
}

export function whenYDocReady(): Promise<void> {
	return requireCurrent().readyPromise;
}

export function waitForCurrentTabSync(timeoutMs = 2_000): Promise<boolean> {
	const doc = requireCurrent();
	if (!doc.wsProvider) return Promise.resolve(true);
	return waitForProviderIdle(doc.wsProvider, timeoutMs);
}

export function isYDocEmpty(): boolean {
	return getXmlFragment().length === 0;
}

export async function destroyTab(tabId: string): Promise<void> {
	const doc = registry.get(tabId);
	if (!doc) return;
	if (doc.wsProvider) doc.wsProvider.destroy();
	doc.ydoc.destroy();
	registry.delete(tabId);
	if (currentTabId === tabId) currentTabId = null;
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
	if (currentTabId === oldId) currentTabId = newId;
}

/** Apply a base64-encoded Yjs update directly to a tab's local Y.Doc,
 * using the tab's own WebSocket provider as the Yjs origin. This prevents
 * the HocuspocusProvider from echoing the update back to the server (the
 * provider skips forwarding updates whose origin equals itself). When the
 * server later delivers the same update via WebSocket it will be a no-op. */
export function applyUpdateToTab(tabId: string, updateBase64: string): void {
	const doc = registry.get(tabId);
	if (!doc) return;
	const bytes = Uint8Array.from(atob(updateBase64), (c) => c.charCodeAt(0));
	Y.applyUpdate(doc.ydoc, bytes, doc.wsProvider ?? 'server-accept');
}

export async function resetAllYDocs(): Promise<void> {
	for (const [id] of Array.from(registry)) {
		await destroyTab(id);
	}
	currentTabId = null;
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
