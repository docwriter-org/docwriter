import * as Y from 'yjs';
import { PluginKey } from '@tiptap/pm/state';
import { getYDocForTab } from './yjs-doc';

/**
 * Agent reconciliation layer (post Phase 5+6).
 *
 * Agent edits land in the browser via Hocuspocus WebSocket sync — the
 * custom MCP tools in `src/lib/server/mcp-doc-tools.ts` mutate the live
 * server Y.Doc with `AGENT_ORIGIN`, and the change streams to every
 * connected client's Y.Doc. This file keeps only what's needed on the
 * browser side:
 *
 *   - A per-tab `Y.UndoManager` that tracks `AGENT_ORIGIN` transactions so
 *     Reject rewinds just the agent's ops (user keystrokes are preserved).
 *   - An `AGENT_APPLY_KEY` ProseMirror plugin key so editor-side policy
 *     (autosave / idle timer) can distinguish agent-origin transactions
 *     from plain user typing.
 *
 * The older client-side apply / baseline-capture / 3-way merge path is
 * gone — the server tools apply directly to the live Y.Doc, so the
 * browser no longer has to re-derive a minimal PM range diff.
 */

export const AGENT_ORIGIN = 'agent';
const FRAGMENT_NAME = 'default';
export const AGENT_APPLY_KEY = new PluginKey('agentApply');

const undoManagers = new Map<string, Y.UndoManager>();

/** Get (or create) the per-tab UndoManager. Tracks only `AGENT_ORIGIN`
 * transactions with `captureTimeout: 0`, so every agent-origin transaction
 * is its own step — `undo()` rewinds one Edit/Write worth of change. */
export function getUndoManagerForTab(tabId: string): Y.UndoManager {
	const existing = undoManagers.get(tabId);
	if (existing) return existing;
	const ydoc = getYDocForTab(tabId);
	const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
	const mgr = new Y.UndoManager(fragment, {
		trackedOrigins: new Set([AGENT_ORIGIN]),
		captureTimeout: 0
	});
	undoManagers.set(tabId, mgr);
	return mgr;
}

/** Undo the most recent agent-origin Yjs transaction on this tab. User
 * edits (default origin) are not touched — they're not in the tracked
 * origin set, so the UndoManager never captured them. */
export function undoAgentChanges(tabId: string): boolean {
	const mgr = getUndoManagerForTab(tabId);
	return !!mgr.undo();
}

/** Tear down all agent state. Called on editor teardown / HMR. */
export function disposeAgentUndo(): void {
	for (const mgr of undoManagers.values()) mgr.destroy();
	undoManagers.clear();
}
