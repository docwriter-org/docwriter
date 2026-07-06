/**
 * Shared access to the live per-tab Y.Doc that Hocuspocus holds in memory.
 *
 * Two ways in, both routing a tabId through `docNameForTab` so multi-tenant
 * (`<userId>:<tabId>`) and single-user (`<tabId>`) name encodings agree with
 * ws-server:
 *
 *   - `getHocuspocus()` → the mutation path. Returns a handle whose
 *     `openDirectConnection(tabId)` opens a `DirectConnection` on the live
 *     Document; callers run `direct.transact(...)` and set their own Yjs
 *     origin inside (AGENT_ORIGIN for agent mutators, USER_ORIGIN for user
 *     comment writes). Returns null when the server isn't up.
 *   - `withLiveTabDoc(tabId, fn)` → the read path. Runs `fn` against the tab's
 *     authoritative Y.Doc: the in-memory Hocuspocus Document if a client is
 *     connected, otherwise a throwaway Y.Doc hydrated from SQLite and
 *     destroyed afterwards. This is READ-ONLY — mutations on the throwaway
 *     fallback are discarded. Use `getHocuspocus()` to mutate.
 *
 * Before this module, /api/render, mcp-doc-tools, and /api/comments each kept
 * their own copy of the `globalThis.__docwriterWsServer` reach plus the
 * live-or-replay fallback; several of those copies looked the tab up by bare
 * tabId and so misrouted in multi-tenant mode. This is the single place that
 * knows how to reach a live tab doc.
 */
import * as Y from 'yjs';
import type { Document } from '@hocuspocus/server';
import { docNameForTab } from './doc-name';
import { replayUpdatesInto } from './ydoc-persistence';

export type DirectConnection = {
	transact: (cb: (doc: Document) => void | Promise<void>) => Promise<void>;
	disconnect: () => Promise<void>;
};

/** Count non-overlapping occurrences of `needle` in `haystack`. Shared by the
 * doc tools and the comment/document routes that anchor edits to a unique
 * passage. */
export function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = 0;
	while ((idx = haystack.indexOf(needle, idx)) !== -1) {
		count += 1;
		idx += needle.length;
	}
	return count;
}

/** Resolve the live Hocuspocus instance stashed on `globalThis` by
 * `ws-server.ts`. The stashed handle is a `Server` wrapper whose real
 * directory-of-documents lives at `.hocuspocus`; `openDirectConnection` is a
 * method on the inner `Hocuspocus`, not the `Server` wrapper. Tab ids are
 * mapped to user-scoped doc names via `docNameForTab`. Returns null if it
 * isn't up (development-time misconfiguration, not a tool-call runtime
 * condition). */
export function getHocuspocus(): {
	openDirectConnection: (tabId: string) => Promise<DirectConnection>;
} | null {
	const holder = globalThis as unknown as {
		__docwriterWsServer?: {
			hocuspocus?: { openDirectConnection: (name: string) => Promise<DirectConnection> };
		};
	};
	const inner = holder.__docwriterWsServer?.hocuspocus;
	if (!inner) return null;
	return {
		openDirectConnection: (tabId: string) => inner.openDirectConnection(docNameForTab(tabId))
	};
}

/** Run `fn` against a tab's live authoritative Y.Doc. Prefers the in-memory
 * Hocuspocus Document (what connected clients are synced to); falls back to a
 * throwaway Y.Doc hydrated from SQLite when no client is connected, destroying
 * it after `fn` returns. READ-ONLY: writes to the fallback doc are thrown away
 * with it — mutate through `getHocuspocus().openDirectConnection` instead. */
export function withLiveTabDoc<T>(tabId: string, fn: (doc: Y.Doc) => T): T {
	const holder = globalThis as unknown as {
		__docwriterWsServer?: {
			hocuspocus?: { documents?: { get(name: string): unknown } };
		};
	};
	const liveDoc = holder.__docwriterWsServer?.hocuspocus?.documents?.get(
		docNameForTab(tabId)
	) as Y.Doc | undefined;
	if (liveDoc) return fn(liveDoc);
	const ydoc = new Y.Doc();
	try {
		replayUpdatesInto(ydoc, tabId);
		return fn(ydoc);
	} finally {
		ydoc.destroy();
	}
}
