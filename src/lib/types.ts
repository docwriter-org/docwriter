export interface Rule {
	id: string;
	text: string;
}

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type AllowedImageMediaType = (typeof ALLOWED_IMAGE_TYPES)[number];

/** An image the user attached to an agent message (dragged into ChatPanel). */
export interface ImageAttachment {
	/** Original filename, for display only. */
	name: string;
	mediaType: AllowedImageMediaType;
	/** Base64-encoded image data (no `data:` URI prefix). */
	data: string;
}

/** Rule the agent proposed mid-render. Shows as a pending card in the
 * OutlinePane; Accept adds it to the `rules` list, Reject dismisses it. */
export interface ProposedRule {
	id: string;
	text: string;
	reason?: string;
	timestamp: number;
}

/** One round of agent edits pending the user's review. The outline pane
 * shows one card per round so each can be accepted/rejected independently,
 * while the editor's diff overlay composes them all into a single view
 * derived from the live doc plus the queued operations. */
export type PendingReviewOperation =
	| {
			type: 'edit';
			oldString: string;
			newString: string;
			/** When true, replace every occurrence of `oldString`. When false
			 * or omitted (default), `oldString` must match exactly once. */
			replaceAll?: boolean;
	  }
	| {
			type: 'write';
			content: string;
	  };

export interface PendingReviewRound {
	id: string;
	/** Stored edit intent. `edit` proposals can be replayed safely against
	 * the latest live doc on Accept; `write` proposals are whole-document
	 * rewrites and require a matching base hash. */
	operation?: PendingReviewOperation;
	/** Lightweight fingerprint of the proposal base text. Used to detect a
	 * stale whole-document `write` before Accept clobbers newer user edits. */
	baseHash?: string;
	/** Derived preview strings. These are computed on demand from the live
	 * document plus `operation`, and may be absent on the persisted round.
	 * Legacy rounds written before the op-based model may still persist
	 * these directly. */
	beforeMd?: string;
	afterMd?: string;
	/** User-facing prompt or trigger that produced this round. */
	trigger?: string;
	timestamp: number;
	/** Heuristic classification of this round's size, computed at write
	 * time via a char-count threshold. `tiny` edits (e.g. a typo fix,
	 * a single-word tweak) render subtler — softer in the editor
	 * overlay, compact inline pill in the outline — so small corrections
	 * don't look like a big paragraph-level rewrite. `big` edits get the
	 * full green/red diff treatment. */
	kind?: 'tiny' | 'big';
	/** How many AGENT_ORIGIN undo steps this round contributed to the
	 * server's live-doc Y.UndoManager. With incremental streaming (one apply per
	 * Edit/Write tool call + one final apply at result time), this can be
	 * >1 per round. Reject pops this many steps to fully rewind. Defaults
	 * to 1 when absent (backward compat with rounds written before
	 * streaming). */
	stepCount?: number;
	/** Derived marker: this proposal can no longer be replayed cleanly
	 * against the current live doc and needs regeneration. */
	stale?: boolean;
	staleReason?: string;
}

/** Character-delta threshold for classifying rounds as `tiny` vs `big`.
 * Sum of added + removed characters below this is "tiny". */
export const TINY_EDIT_THRESHOLD = 25;

/** Shell hook the agent proposed mid-render. Accept appends to
 * `.docwriter/hooks.json`; Reject dismisses it. */
export type ProposedHookEvent =
	| 'PreToolUse'
	| 'PostToolUse'
	| 'PostToolUseFailure'
	| 'UserPromptSubmit'
	| 'Stop'
	| 'SubagentStop'
	| 'SessionStart'
	| 'SessionEnd'
	| 'Notification';

export interface ProposedHook {
	id: string;
	event: ProposedHookEvent;
	matcher?: string;
	command: string;
	reason?: string;
	timestamp: number;
}

export interface Action {
	id: string;
	label: string;
	icon: string; // lucide icon name
	pinned: boolean;
	color: string;
}

/** Threaded comment anchored to a passage in a tab.
 *
 * Anchoring is quote-based: `anchor.quote` stores a snapshot of the
 * selected text at creation. On every render the client searches the
 * current live markdown for the quote; a unique match becomes the
 * decoration range, multiple matches prefer the `occurrenceIndex`-th
 * match (0-based), and zero matches flag the thread as "detached" in
 * the UI (rendered at the top of the Outline without an anchor).
 *
 * Threads live in a Y.Map keyed by thread id on each tab's Y.Doc, so
 * they sync through Hocuspocus exactly like pending review rounds and
 * merge cleanly with concurrent edits.
 */
export interface CommentThreadAnchor {
	quote: string;
	/** Which occurrence of `quote` to prefer when it appears multiple
	 * times in the document. Snapshot at thread creation; stays fixed
	 * across edits so the anchor doesn't drift between matches. */
	occurrenceIndex: number;
	/** Base64-encoded Y.RelativePosition for the start/end of the anchored
	 * passage. Yjs CRDT-tracks these through every concurrent edit (user
	 * typing, agent edits, syncs across clients), so the highlight stays
	 * glued to the text instead of teleporting when the quote no longer
	 * matches. Optional because:
	 *   - Server-side `post_comment` can't compute them (it has no PM
	 *     binding), so it omits them — the client backfills on first
	 *     render via the comment-overlay's view hook.
	 *   - Legacy threads (created before this field existed) lack them
	 *     and also get backfilled on first render.
	 * When absent, the overlay falls back to indexOf-based anchoring. */
	relStart?: string;
	relEnd?: string;
}

export type CommentAuthor = 'user' | 'agent';

export interface CommentMessage {
	id: string;
	author: CommentAuthor;
	text: string;
	timestamp: number;
	/** Optional edit the agent sketched in this reply. When present, the
	 * thread popover shows an "Approve & propose edit" button that asks
	 * the agent to apply it via `edit_doc` in the next render. */
	proposedEdit?: { oldString: string; newString: string };
}

export interface CommentThread {
	id: string;
	anchor: CommentThreadAnchor;
	messages: CommentMessage[];
	resolved: boolean;
	createdAt: number;
}

/** Routing hint carried from the feedback popup to the agent prompt.
 *  - `auto`: agent decides comment vs. edit based on tone.
 *  - `edit`: force an `edit_doc` call (no `post_comment`).
 *  - `discuss`: force a `post_comment` call (no `edit_doc`). */
export type FeedbackMode = 'auto' | 'edit' | 'discuss';

export interface Annotation {
	id: string;
	tabId: string;
	excerpt: string;
	comment: string;
	from: number;
	to: number;
	timestamp: number;
}

export interface InlineFeedback {
	text: string;
	x: number;
	y: number;
}

export type HistoryEntry =
	| {
			type: 'user_action';
			timestamp: number;
			description: string;
			/** Per-tab unified line diffs (tabId → diff text) summarising what
			 * the user changed since the previous render. Populated only for
			 * submit events where at least one tab has a non-empty diff. */
			tabDiffs?: Record<string, string>;
			/** Supporting quote shown under the description — e.g. the passage
			 * a feedback action was applied to. Full text of the trigger
			 * already goes to the agent; this is purely for the history pane
			 * label. */
			quote?: string;
	  }
	| {
			type: 'tool_call';
			timestamp: number;
			tool_name: string;
			input: Record<string, unknown>;
			durationMs?: number;
			subagent?: boolean;
			/** SDK-assigned id for matching a later `tool_result` back to this
			 * call. Set on `tool_call_start`; optional on legacy entries
			 * restored from older transcripts. */
			tool_use_id?: string;
			/** Text payload of the tool's return value (first text block of
			 * the MCP `CallToolResult`). Populated when the SDK emits the
			 * user message carrying the tool_result. Absent if the call is
			 * still pending. */
			result?: string;
			/** `isError: true` on the MCP tool response — surfaces so the UI
			 * can show why `edit_doc` / `write_doc` / etc. failed instead of
			 * leaving the user guessing. */
			isError?: boolean;
	  }
	| { type: 'assistant_text'; timestamp: number; text: string }
	| { type: 'assistant_thinking'; timestamp: number; text: string }
	| { type: 'render_start'; timestamp: number; trigger: string }
	| { type: 'render_end'; timestamp: number; success: boolean; durationMs?: number }
	| {
			type: 'status';
			timestamp: number;
			status: 'compacting' | 'requesting' | null;
			compactResult?: 'success' | 'failed';
			error?: string;
	  }
	| {
			type: 'notification';
			timestamp: number;
			text: string;
			priority?: 'low' | 'medium' | 'high' | 'immediate';
	  }
	| {
			type: 'task';
			timestamp: number;
			taskId: string;
			phase: 'started' | 'progress' | 'updated' | 'completed' | 'failed' | 'stopped';
			description?: string;
			summary?: string;
			taskType?: string;
			lastToolName?: string;
	  }
	| {
			type: 'tool_progress';
			timestamp: number;
			tool_name: string;
			elapsedSeconds: number;
			taskId?: string;
	  }
	| {
			type: 'hook_run';
			timestamp: number;
			hookId: string;
			event: string; // PostToolUse | PreToolUse | Stop
			command: string;
			status: 'running' | 'done' | 'failed';
			exitCode?: number;
			stdout?: string;
			stderr?: string;
			durationMs?: number;
	  };

/** Agent behavior settings. Persisted in SQLite runtime state.
 *
 *  - `agency`: how eager the agent is to make edits. `conservative` keeps
 *    the current "default to NO edits" posture; `balanced` makes one focused
 *    improvement per round when there's clearly something to do; `aggressive`
 *    proactively rewrites for clarity, tightness, and flow.
 *  - `trackChanges`: when true (default), agent edits land behind the
 *    green/red diff overlay with an Accept/Reject card. When false, the
 *    agent's changes merge silently into the doc — no review step, no
 *    overlay. Ctrl+Z still works because agent ops are then applied with
 *    the default origin (user undo stack).
 */
export interface AgentSettings {
	agency: 'conservative' | 'balanced' | 'aggressive';
	trackChanges: boolean;
	/** When true, agent edits still land in the pending-review array, but the
	 * editor's inline diff overlay stays hidden until the user clicks a
	 * pending card — at which point only that round's decorations render.
	 * Lets you keep writing without the green/red overlay competing for
	 * attention while the agent works in the background. */
	muted: boolean;
}
