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
import { stampWorkspaceDir } from '$lib/server/document-files';
import { syncRulesToClaudeMemory } from '$lib/server/claude-memory';
import { installBundledSkills } from '$lib/server/skills-install';
import { createWsServer } from '$lib/server/ws-server';
import { loadGlobalKeys, loadRepoEnv } from '$lib/server/api-keys';
import { failInterruptedStyleRun } from '$lib/server/style-analysis/interrupted-run';

// Load repo .env, then ~/.docwriter/keys.env into process.env so provider API
// keys are available before any render path reads process.env.<KEY>. The
// global store does not override repo .env or real shell env.
loadRepoEnv();
loadGlobalKeys();

// A fresh UUID per server process. Clients compare this against the one they
// last synced with; a mismatch means they're talking to a different server
// instance than the one their in-memory Y.Docs were synced against, so
// those Y.Docs must be discarded before the WebSocket provider attaches —
// otherwise stale client state syncs up and the server flushes it back to
// disk, silently overwriting external edits made while docwriter was down.
// Stashed on globalThis so the same module scope survives Vite HMR.
const SERVER_INSTANCE_ID_KEY = '__docwriterServerInstanceId';
const globalAny = globalThis as unknown as Record<string, string | undefined>;
if (!globalAny[SERVER_INSTANCE_ID_KEY]) {
	globalAny[SERVER_INSTANCE_ID_KEY] = randomUUID();
	// A style pass only exists in memory, so one that was running when the
	// process stopped can never finish. Mark it failed before anything reads
	// the profile, or the status pill sits on "Analyzing references" for good.
	// Inside this guard so Vite HMR re-executions never re-run it: mid-session
	// there may be a genuinely live pass this must not touch.
	failInterruptedStyleRun();
	// Name the workspace this .docwriter belongs to (and warn if the folder
	// was moved/copied), so a stale state dir elsewhere is identifiable.
	stampWorkspaceDir();
}

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

// Pass-through handle (no per-request modifications needed here).
export const handle: Handle = async ({ event, resolve }) => resolve(event);
