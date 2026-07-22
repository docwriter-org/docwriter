/** A concrete violation of a rule, ideally lifted verbatim from the
 * user's own session (a rejected agent edit, a passage they flagged).
 * Rendered under the rule in the agent prompt as a few-shot negative
 * example — "what this rule looks like when broken". */
export interface RuleExample {
	violation: string;
	note?: string;
}

export interface Rule {
	id: string;
	text: string;
	examples?: RuleExample[];
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
	/** Offending passage the agent quoted when proposing (usually from a
	 * rejected edit). Stored as the rule's first example on accept. */
	exampleViolation?: string;
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
	/** Comment thread this edit was made in response to, if any. Set when the
	 * edit was produced during a render triggered by feedback on a thread, so
	 * the gutter can group an agent's edits under that feedback's card
	 * (numbered 1, 2, 3…) instead of showing them as loose, separate cards. */
	feedbackThreadId?: string;
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
interface CommentThreadAnchor {
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
	 *   - Server-side `reply_to_comment` can't compute them (it has no PM
	 *     binding), so it omits them — the client backfills on first
	 *     render via the comment-overlay's view hook. Same applies to any
	 *     thread the user opens through a server-side path (e.g. the
	 *     feedback popup's auto-created thread).
	 *   - Legacy threads (created before this field existed) lack them
	 *     and also get backfilled on first render.
	 * When absent, the overlay falls back to indexOf-based anchoring. */
	relStart?: string;
	relEnd?: string;
	/** Plain-text snapshot of what surrounded the anchored passage when the
	 * anchor was (last) known to be alive — up to ~32 chars each side,
	 * newlines stripped. Used by the overlay's quote fallback: when the rel
	 * positions die (the anchored text was deleted, e.g. by accepting an
	 * agent edit), the thread may only re-attach to an occurrence of the
	 * quote whose surroundings match this context. That keeps undo working
	 * (restored text brings back the same context) while preventing the
	 * thread from resurrecting on an unrelated occurrence of the same
	 * string typed elsewhere later. Optional: captured server-side at
	 * creation when the occurrence is unambiguous, and backfilled by the
	 * client whenever the thread renders anchored. */
	contextBefore?: string;
	contextAfter?: string;
}

type CommentAuthor = 'user' | 'agent';

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

/** Routing hint carried from the feedback popup to the agent prompt. Both
 * modes open a comment thread on the passage (the feedback always persists
 * as a thread); the mode decides how the agent responds:
 *  - `edit`: directly propose an `edit_doc` change.
 *  - `plan`: first reply on the thread via `reply_to_comment` with the
 *    diagnosis (why the passage was flagged, concretely) and the intended
 *    change, THEN propose the edit — the reflection shows as a comment
 *    above the pending-edit card. */
export type FeedbackMode = 'edit' | 'plan';

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
 *  - `agency`: the autonomy level. `conservative` waits for direct requests
 *    or obvious fixes; `balanced` can create new comment threads on its own
 *    but does not make unsolicited edits; `aggressive` can create comments
 *    and propose reviewable edits on its own.
 *
 * Agent edits are ALWAYS tracked: they land behind the green/red diff overlay
 * as Accept/Reject review rounds. There is no "merge silently" mode.
 */
export interface AgentSettings {
	agency: 'conservative' | 'balanced' | 'aggressive';
	/** When true, agent edits still land in the pending-review array, but the
	 * editor's inline diff overlay stays hidden until the user clicks a
	 * pending card — at which point only that round's decorations render.
	 * Lets you keep writing without the green/red overlay competing for
	 * attention while the agent works in the background. */
	muted: boolean;
	/** When true, the agent is fully paused: no idle auto-wake, no Wake up,
	 * no Send / Cmd+Enter, and in-flight renders are cancelled on pause.
	 * Distinct from `muted` (which only hides the diff overlay). Toggled by
	 * double-clicking the Agent pill. */
	paused: boolean;
}

/** Canonical default agent settings. Imported by the server runtime-state.
 * NOTE: the client store (src/lib/stores.ts) still keeps its own copy of this
 * default; it should also import this constant in a later pass. */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
	agency: 'conservative',
	muted: false,
	paused: false
};
