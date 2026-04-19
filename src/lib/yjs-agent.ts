import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import { ySyncPluginKey } from 'y-prosemirror';
import { EditorState } from '@tiptap/pm/state';
import { getYDocForTab } from './yjs-doc';
import {
	markdownBaseExtensions,
	plainBaseExtensions,
	collaborativeExtensions
} from './editor-extensions';
import { plainTextToPMJson } from './yjs-markdown';
import { mergeAgentEditsIntoCurrent } from './three-way-merge';

/**
 * Agent reconciliation layer. Per-tab:
 *   - a baseline Yjs snapshot captured at render start (used only for
 *     display purposes by the diff overlay, not for applying edits)
 *   - a Y.UndoManager that tracks only `AGENT_ORIGIN` transactions
 *   - an ephemeral "live editor" reference for the active tab
 *
 * Applying agent output is a single code path for every tab, active or not:
 *
 *   1. Parse the agent's new content into a ProseMirror node using the
 *      schema of a per-kind shared editor.
 *   2. Build (or reuse) a "sync editor" — a headless Tiptap editor bound
 *      to the target tab's Y.Doc via the Collaboration extension. For the
 *      active tab we reuse the live editor the user is interacting with;
 *      for background tabs we create one on demand.
 *   3. Compute the minimal PM range that changed (`findDiffStart` /
 *      `findDiffEnd`) and dispatch a single `replace` transaction inside
 *      a `ydoc.transact` with the desired origin.
 *
 * The targeted range is the key: only the bytes that actually changed get
 * new Yjs ops, so user edits outside that range are byte-for-byte preserved.
 * Edits inside the range race through the CRDT's item-level merge (inherent,
 * not something this layer can fix).
 *
 * `trackChanges` routes the Yjs origin:
 *   - `true`  → `AGENT_ORIGIN`, captured by this tab's UndoManager so the
 *               user's Reject rewinds just the agent's ops.
 *   - `false` → `ySyncPluginKey`, the origin y-prosemirror's yUndoPlugin
 *               watches by default; the ops go on the user's normal undo
 *               stack for silent-merge mode.
 */

const AGENT_ORIGIN = 'agent';
const FRAGMENT_NAME = 'default';

type Kind = 'markdown' | 'plain';

const baselineStates = new Map<string, Uint8Array>();
const undoManagers = new Map<string, Y.UndoManager>();
/** Per-tab shadow editor — a disposable Tiptap instance bound to the tab's
 * Y.Doc. Used when we need to apply agent output to a tab whose live editor
 * isn't currently focused. Cached to avoid rebuilding per apply. */
const shadowEditors = new Map<string, Editor>();
/** Per-kind parser editors, shared across tabs. */
let mdParser: Editor | null = null;
let plainParser: Editor | null = null;
let applying = false;

export interface ApplyAgentResult {
	applied: boolean;
	mergedContent: string;
	conflictCount: number;
	appliedHunks: number;
}

function getUndoManagerForTab(tabId: string): Y.UndoManager {
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

function getParser(kind: Kind): Editor {
	if (kind === 'plain') {
		if (!plainParser) plainParser = new Editor({ extensions: plainBaseExtensions(), content: '' });
		return plainParser;
	}
	if (!mdParser) mdParser = new Editor({ extensions: markdownBaseExtensions(), content: '' });
	return mdParser;
}

/** Parse a string into PM JSON using the right schema for the kind.
 * Markdown tabs round-trip through tiptap-markdown; plain tabs use a
 * simple `\n`-split mapping each line to a paragraph. */
function contentToPMJson(content: string, kind: Kind): unknown {
	if (kind === 'plain') return plainTextToPMJson(content);
	const ed = getParser('markdown');
	ed.commands.setContent(content, { emitUpdate: false });
	return ed.getJSON();
}

/** Get or create a Tiptap editor bound to the target tab's Y.Doc. For the
 * active tab the caller passes in the live editor; for background tabs we
 * spin up a headless one and cache it. */
function getShadowEditor(tabId: string, kind: Kind): Editor {
	const existing = shadowEditors.get(tabId);
	if (existing) return existing;
	const ydoc = getYDocForTab(tabId);
	const ed = new Editor({
		extensions: collaborativeExtensions(ydoc, { kind })
	});
	shadowEditors.set(tabId, ed);
	return ed;
}

export function isAgentApplyInProgress(): boolean {
	return applying;
}

/** Snapshot the given tab's Y.Doc state for later reject / diff purposes. */
export function captureBaselineForAgent(tabId: string): void {
	baselineStates.set(tabId, Y.encodeStateAsUpdate(getYDocForTab(tabId)));
}

export function clearAgentBaseline(tabId: string): void {
	baselineStates.delete(tabId);
}

export function clearAllAgentBaselines(): void {
	baselineStates.clear();
}

/**
 * Apply agent-produced content to the given tab's Y.Doc via a targeted
 * PM range replace. Works for active and background tabs alike — the
 * active tab's live editor is reused when provided; background tabs use
 * their own cached shadow editor.
 */
export function applyAgentMarkdown(
	tabId: string,
	content: string,
	trackChanges: boolean,
	activeEditor?: Editor,
	kind: Kind = 'markdown',
	mergeBase?: string
): ApplyAgentResult {
	getUndoManagerForTab(tabId);
	const editor = activeEditor ?? getShadowEditor(tabId, kind);
	const ydoc = getYDocForTab(tabId);
	const currentContent = getEditorContent(editor, kind);
	const mergeResult =
		typeof mergeBase === 'string'
			? mergeAgentEditsIntoCurrent(mergeBase, currentContent, content)
			: {
					mergedText: content,
					appliedHunks: content === currentContent ? 0 : 1,
					conflictCount: 0
				};
	const contentToApply = mergeResult.mergedText;

	const agentJson = contentToPMJson(contentToApply, kind);
	const agentNode = editor.schema.nodeFromJSON(agentJson);
	const liveNode = editor.state.doc;
	if (liveNode.eq(agentNode)) {
		return {
			applied: false,
			mergedContent: currentContent,
			conflictCount: mergeResult.conflictCount,
			appliedHunks: 0
		};
	}

	const start = liveNode.content.findDiffStart(agentNode.content);
	if (start === null || start === undefined) {
		return {
			applied: false,
			mergedContent: currentContent,
			conflictCount: mergeResult.conflictCount,
			appliedHunks: 0
		};
	}
	const diffEnd = liveNode.content.findDiffEnd(agentNode.content);
	let liveEnd: number;
	let agentEnd: number;
	if (diffEnd) {
		liveEnd = diffEnd.a;
		agentEnd = diffEnd.b;
	} else {
		liveEnd = liveNode.content.size;
		agentEnd = agentNode.content.size;
	}
	if (liveEnd < start) liveEnd = start;
	if (agentEnd < start) agentEnd = start;

	const slice = agentNode.slice(start, agentEnd);
	const tr = editor.state.tr.replace(start, liveEnd, slice);

	applying = true;
	try {
		ydoc.transact(() => {
			editor.view.dispatch(tr);
		}, trackChanges ? AGENT_ORIGIN : ySyncPluginKey);
	} finally {
		applying = false;
	}
	// Keep the ts typechecker from flagging EditorState as unused. This
	// import ensures the yjs-agent module pulls in the right PM state types
	// for strict type-checking in consumers; the runtime use is via editor.
	void EditorState;
	return {
		applied: true,
		mergedContent: contentToApply,
		conflictCount: mergeResult.conflictCount,
		appliedHunks: mergeResult.appliedHunks
	};
}

/** Undo the most recent agent-origin Yjs transaction on this tab. User
 * edits (default origin) are not touched.
 *
 * Sets `applying = true` for the duration of the undo so PM-layer code
 * (onEditorUpdate's user-edit region tracker) treats the resulting
 * transaction as an agent apply, not a user keystroke. Without this,
 * rejecting a round would paint the entire undone range as "user-edited"
 * orange. */
export function undoAgentChanges(tabId: string): boolean {
	const mgr = getUndoManagerForTab(tabId);
	const prev = applying;
	applying = true;
	try {
		return !!mgr.undo();
	} finally {
		applying = prev;
	}
}

/** Tear down all agent state. Called on editor teardown / HMR. */
export function disposeAgentUndo(): void {
	for (const mgr of undoManagers.values()) mgr.destroy();
	undoManagers.clear();
	for (const ed of shadowEditors.values()) ed.destroy();
	shadowEditors.clear();
	if (mdParser) {
		mdParser.destroy();
		mdParser = null;
	}
	if (plainParser) {
		plainParser.destroy();
		plainParser = null;
	}
	baselineStates.clear();
}

function getEditorContent(editor: Editor, kind: Kind): string {
	if (kind === 'plain') {
		return editor.getText({ blockSeparator: '\n' });
	}
	return (editor.storage as any).markdown?.getMarkdown?.() || '';
}
