/**
 * Path classification for the custom MCP doc tools.
 *
 * Three buckets:
 *   - **Scratch**: the agent's private scratch workspace under
 *     `.docwriter/agent/scratch/`. Plain filesystem I/O, no Y.Doc involvement.
 *   - **Open tab**: a file currently listed in `tabs.order`. Routed to the
 *     live Hocuspocus Document via DirectConnection.
 *   - **Unknown**: everything else. The tools reject these with an error —
 *     `write_doc` explicitly does not create new tabs.
 *
 * Paths can arrive in several shapes from the agent:
 *   - A workspace-relative id (e.g. `drafts/chapter-1.md`) — matches an
 *     entry in `tabs.order` directly.
 *   - An absolute path under DOCWRITER_ROOT pointing at the user-facing file
 *     (e.g. `/Users/.../root/drafts/chapter-1.md`) — matches by suffix.
 *   - A scratch path under `.docwriter/agent/scratch/` — handled by the
 *     scratch branch in the MCP tools; not a tab path.
 *
 * Scratch paths are routed to plain filesystem I/O (the `isScratchPath`
 * branch in the MCP tools); workspace paths are resolved to tab ids by
 * `resolveTabFromPath` and routed through the live Y.Doc.
 */
import { AGENT_SCRATCH_DIR, isAgentScratchPath } from './document-files';
import { getTabsState } from './runtime-state';

export { AGENT_SCRATCH_DIR };

/** True iff `path` is the scratch dir itself or anywhere inside it. Accepts
 * both absolute paths and relative fragments that include the scratch
 * segment (the agent sometimes quotes the relative form in tool inputs). */
export function isScratchPath(path: string): boolean {
	if (isAgentScratchPath(path)) return true;
	// Fallback: relative forms like ".docwriter/agent/scratch/foo.md".
	return path.includes('.docwriter/agent/scratch/') || path.endsWith('.docwriter/agent/scratch');
}

/** Returns the tabId if `path` identifies an open tab's workspace file,
 * else null. Matches three shapes:
 *   1. Exact match on a tab id (workspace-relative).
 *   2. Path ending with `/<tabId>` (absolute workspace path or any other
 *      suffix-form the agent may use).
 *   3. Path ending in `<tabId>` on its own (unlikely but harmless).
 *
 * Does NOT distinguish scratch paths — callers must check `isScratchPath`
 * first if they care about scratch-vs-tab routing. */
export function resolveTabFromPath(path: string): string | null {
	const open = getTabsState().order;
	// Longest-first so nested ids (e.g. `drafts/one.md` vs. `one.md`) match
	// the most specific open tab.
	const candidates = [...open].sort((a, b) => b.length - a.length);
	for (const id of candidates) {
		if (path === id) return id;
		if (path.endsWith('/' + id)) return id;
	}
	return null;
}

/** True iff a given tab id currently appears in `tabs.order`. */
export function isOpenTab(tabId: string | null | undefined): boolean {
	if (!tabId) return false;
	return getTabsState().order.includes(tabId);
}
