/**
 * SvelteKit server hooks — runs once at server startup.
 *
 * Handles one-shot CLI flags that are communicated via environment variables:
 *   DOCWRITER_NEW_SESSION=1   — clear the persisted SDK session ID so the
 *                               next render starts a fresh conversation.
 */
import type { Handle } from '@sveltejs/kit';
import { readRuntimeState, setSessionId } from '$lib/server/runtime-state';
import { installBundledSkills } from '$lib/server/skills-install';
import { seedFromJsonFilesIfNeeded } from '$lib/server/db-seed';

// Install DocWriter's bundled project skill(s) into the workspace's
// `.claude/skills/` dir so the SDK picks them up via the 'project'
// settingSource. Idempotent — only overwrites the built-in skill files.
installBundledSkills();

// Phase 1 SQLite scaffolding: open the DB and prime it from the existing
// JSON files on first run. No read paths consume this yet — the JSON files
// remain the source of truth. Wrapped in try/catch so a DB-init failure
// can't take down the server startup path.
try {
	seedFromJsonFilesIfNeeded();
} catch (err) {
	console.error('[docwriter] SQLite seed failed (non-fatal):', err);
}

// Run at module load (= server startup), not per-request.
if (process.env.DOCWRITER_NEW_SESSION === '1') {
	try {
		const state = readRuntimeState();
		if (state.sessionId) {
			// Overwrite with an empty session; the next query() will create a new one.
			setSessionId('');
			console.log('[docwriter] --new-session: cleared persisted session ID');
		}
	} catch {
		// State file may not exist yet on a fresh workspace — that's fine.
	}
}

// Pass-through handle (no per-request modifications needed here).
export const handle: Handle = async ({ event, resolve }) => resolve(event);
