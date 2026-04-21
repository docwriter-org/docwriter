/**
 * SvelteKit server hooks — runs once at server startup.
 *
 * Handles one-shot CLI flags that are communicated via environment variables:
 *   DOCWRITER_NEW_SESSION=1   — clear the persisted SDK session ID so the
 *                               next render starts a fresh conversation.
 */
import type { Handle } from '@sveltejs/kit';
import { getSessionId, setSessionId } from '$lib/server/runtime-state';
import { installBundledSkills } from '$lib/server/skills-install';
import { createWsServer } from '$lib/server/ws-server';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { DOCWRITER_DIR } from '$lib/server/document-files';

// Install DocWriter's bundled project skill(s) into the workspace's
// `.claude/skills/` dir so the SDK picks them up via the 'project'
// settingSource. Idempotent — only overwrites the built-in skill files.
installBundledSkills();

// `state.json` used to mirror runtime state that now lives in SQLite. Drop
// the obsolete file so the workspace stops carrying dead duplicate state.
try {
	const obsoleteStateFile = join(DOCWRITER_DIR, 'state.json');
	if (existsSync(obsoleteStateFile)) unlinkSync(obsoleteStateFile);
} catch (err) {
	console.error('[docwriter] failed to remove obsolete state.json:', err);
}

// Phase 2: start the Hocuspocus WebSocket Y.Doc sync server on a separate
// port alongside Vite's HTTP server. Module-scope singleton guard keeps
// Vite HMR (which re-executes this file on save) from double-binding.
const WS_PORT = parseInt(process.env.DOCWRITER_WS_PORT ?? '', 10) || 3001;
let wsServer: ReturnType<typeof createWsServer> | null = (globalThis as unknown as { __docwriterWsServer?: ReturnType<typeof createWsServer> }).__docwriterWsServer ?? null;
if (!wsServer) {
	try {
		wsServer = createWsServer(WS_PORT);
		wsServer.listen();
		(globalThis as unknown as { __docwriterWsServer?: ReturnType<typeof createWsServer> }).__docwriterWsServer = wsServer;
		console.log(`[docwriter] Y.Doc sync listening on ws://localhost:${WS_PORT}`);
	} catch (err) {
		console.error('[docwriter] failed to start Y.Doc WebSocket server:', err);
	}
}

// Run at module load (= server startup), not per-request.
if (process.env.DOCWRITER_NEW_SESSION === '1') {
	try {
		if (getSessionId()) {
			// Overwrite with an empty session; the next query() will create a new one.
			setSessionId('');
			console.log('[docwriter] --new-session: cleared persisted session ID');
		}
	} catch {
		// Fresh workspace or early DB init failure — ignore.
	}
}

// Pass-through handle (no per-request modifications needed here).
export const handle: Handle = async ({ event, resolve }) => resolve(event);
