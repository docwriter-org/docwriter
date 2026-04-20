/**
 * Hocuspocus WebSocket server for Y.Doc sync.
 *
 * Phase 2: brought up alongside the existing client-side IndexedDB
 * persistence. `onLoadDocument` returns the registry's Y.Doc (replayed from
 * the `yjs_updates` SQLite table on miss); Hocuspocus clones its state into
 * its own internal Document for the session. `onChange` appends each incoming
 * update row to SQLite so the server-side log grows with the session.
 *
 * The origin string on each row defaults to `'user'` — client updates from
 * WebSocket connections don't carry a Yjs origin string the server can pull
 * out without additional wiring. Agent-driven updates (Phase 4) will come
 * through custom MCP tools that transact with `AGENT_ORIGIN` directly and
 * don't flow through this hook.
 */
import { Server } from '@hocuspocus/server';
import { getTabYDoc } from './ydoc-registry';
import { appendUpdate } from './ydoc-persistence';

export function createWsServer(port: number): Server {
	return new Server({
		port,
		// `quiet: true` — we print our own startup log in `hooks.server.ts`;
		// Hocuspocus's default start-screen is too chatty for our dev output.
		quiet: true,
		async onLoadDocument({ documentName: tabId }) {
			return getTabYDoc(tabId).ydoc;
		},
		async onChange({ documentName: tabId, update, context }) {
			const origin = (context as { origin?: string } | undefined)?.origin ?? 'user';
			appendUpdate(tabId, update, origin);
		}
	});
}
