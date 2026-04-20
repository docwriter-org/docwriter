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
import { getTabYDoc } from './ydoc-registry';
import { appendUpdate, scheduleMarkdownFlush, flushMarkdownNow } from './ydoc-persistence';

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
		async onLoadDocument({ documentName: tabId }) {
			return getTabYDoc(tabId).ydoc;
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
	// No live connection — serialize from the registry copy. Worst case
	// this is a no-op (empty Y.Doc) but it won't crash the read.
	const entry = getTabYDoc(tabId);
	flushMarkdownNow(tabId, entry.ydoc);
}
