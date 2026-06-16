/**
 * SvelteKit server hooks — runs once at server startup.
 *
 * Handles one-shot CLI flags that are communicated via environment variables:
 *   DOCWRITER_NEW_SESSION=1   — clear the persisted SDK session ID so the
 *                               next render starts a fresh conversation.
 */
import type { Handle } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getRules, getSessionId, setSessionId } from '$lib/server/runtime-state';
import { syncRulesToClaudeMemory } from '$lib/server/claude-memory';
import { installBundledSkills } from '$lib/server/skills-install';
import { createWsServer } from '$lib/server/ws-server';
import { loadGlobalKeys } from '$lib/server/api-keys';
import { maybeHandleClerkAuth } from '$lib/server/clerk-auth';
import { IS_HOSTED_LANDING } from '$lib/server/deploy-mode';

// Load ~/.docwriter/keys.env into process.env (without overriding real env /
// repo .env) so provider API keys are available cross-workspace and in the
// built server. Runs before any render path reads process.env.<KEY>.
if (!IS_HOSTED_LANDING) {
	loadGlobalKeys();
}

// A fresh UUID per server process. Clients compare this against the one they
// last synced with; a mismatch means they're talking to a different server
// instance than the one their in-memory Y.Docs were synced against, so
// those Y.Docs must be discarded before the WebSocket provider attaches —
// otherwise stale client state syncs up and the server flushes it back to
// disk, silently overwriting external edits made while docwriter was down.
// Stashed on globalThis so the same module scope survives Vite HMR.
const SERVER_INSTANCE_ID_KEY = '__docwriterServerInstanceId';
const globalAny = globalThis as unknown as Record<string, string | undefined>;
if (!IS_HOSTED_LANDING && !globalAny[SERVER_INSTANCE_ID_KEY]) {
	globalAny[SERVER_INSTANCE_ID_KEY] = randomUUID();
}

if (!IS_HOSTED_LANDING) {
	// Install DocWriter's bundled project skill(s) into the workspace's
	// `.claude/skills/` dir so the SDK picks them up via the 'project'
	// settingSource. Idempotent — only overwrites the built-in skill files.
	installBundledSkills();

	// Start the Hocuspocus WebSocket Y.Doc sync server on a separate port
	// alongside Vite's HTTP server. Module-scope singleton guard keeps Vite
	// HMR (which re-executes this file on save) from double-binding.
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

	// Safety-net re-sync of rules → .claude/CLAUDE.md on every server boot.
	// Catches the rare case where a previous mutation landed the DB write
	// but crashed before the file write — without this, the drift would
	// persist until the next rule edit. Cheap: hash-checked, no-ops when
	// the file already matches.
	try {
		syncRulesToClaudeMemory(getRules());
	} catch {
		/* fresh workspace or DB not yet initialized — ignore */
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
}

// Pass-through handle unless Clerk auth intercepts the request.
export const handle: Handle = async ({ event, resolve }) => {
	const clerkResponse = await maybeHandleClerkAuth(event, resolve);
	if (clerkResponse) return clerkResponse;
	return resolve(event);
};
