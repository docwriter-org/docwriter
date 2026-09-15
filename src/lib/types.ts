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

/** Why a resolved thread closed. Absent while the thread is open. */
export type ThreadOutcome = 'accepted' | 'rejected' | 'dismissed';

/** Legacy quote-based anchor. Threads created before proposals became
 * marks stored where they sat as a quote; the load-time migration turns
 * it into a comment mark and nothing writes it any more. A thread's
 * position is the set of marks carrying its id (see proposals.ts). */
export interface LegacyCommentThreadAnchor {
	quote: string;
	occurrenceIndex: number;
	relStart?: string;
	relEnd?: string;
	contextBefore?: string;
	contextAfter?: string;
}

export type CommentAuthor = 'user' | 'agent' | 'external';

export interface CommentMessage {
	id: string;
	author: CommentAuthor;
	text: string;
	timestamp: number;
	/** Legacy. Older threads may carry a sketched edit from the removed
	 * "Approve & propose edit" flow. Nothing writes it any more: an agent
	 * reply that names a change is followed by an edit_doc proposal on the
	 * same thread, and the gutter renders these messages as plain text. */
	proposedEdit?: { oldString: string; newString: string };
	/** Reviewer agent that wrote this message during a critique pass.
	 * Only meaningful when author is 'agent'; the gutter renders the
	 * reviewer's mascot and name instead of the default cat. */
	reviewerId?: string;
	/** Name of the external commenter (e.g. "Maya"). Only meaningful
	 * when author is 'external'; the gutter shows this name instead of
	 * the default user/agent avatar. */
	externalAuthor?: string;
}

/** Threaded comment on a passage of a tab. Threads live in a Y.Map keyed
 * by thread id on each tab's Y.Doc, so they sync through Hocuspocus and
 * merge cleanly with concurrent edits. Where a thread sits in the document
 * is not stored on it: the document's `comment`, `insertion` and
 * `deletion` marks carry the thread id (see proposals.ts). */
export interface CommentThread {
	id: string;
	messages: CommentMessage[];
	resolved: boolean;
	/** Set when `resolved`; cleared on reopen. */
	outcome?: ThreadOutcome;
	createdAt: number;
	/** Legacy only; see `LegacyCommentThreadAnchor`. */
	anchor?: LegacyCommentThreadAnchor;
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
 * Agent edits are ALWAYS tracked: they land as tracked changes (marks) on
 * the document under a comment thread, with Accept / Reject on the thread.
 * There is no "merge silently" mode.
 */
export interface AgentSettings {
	agency: 'conservative' | 'balanced' | 'aggressive';
	/** When true, the agent's threads leave the gutter and its tracked
	 * changes render subdued. Lets you keep writing without the green/red
	 * marks competing for attention while the agent works in the
	 * background. Content is never hidden. */
	muted: boolean;
	/** When true, the agent is fully paused: no idle auto-wake, no Wake up,
	 * no Send / Cmd+Enter, and in-flight renders are cancelled on pause.
	 * Distinct from `muted` (which only hides the diff overlay). Toggled by
	 * double-clicking the Agent pill. */
	paused: boolean;
	/** Free-text description of who the draft is for. Empty means no audience
	 * bias. Injected into the agent prompt via session_state when it changes. */
	intendedAudience: string;
}

/** Canonical default agent settings. Imported by the server runtime-state.
 * NOTE: the client store (src/lib/stores.ts) still keeps its own copy of this
 * default; it should also import this constant in a later pass. */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
	agency: 'conservative',
	muted: false,
	paused: false,
	intendedAudience: ''
};

// ---------------------------------------------------------------------------
// Feedback import
// ---------------------------------------------------------------------------

export interface ImportedComment {
	id: string;
	author: string;
	text: string;
	originalAnchor?: string;
}

export type FeedbackDisposition = 'applied' | 'discussed' | 'deferred' | 'untouched';

export interface FeedbackLedgerEntry {
	importedCommentId: string;
	threadId?: string;
	disposition: FeedbackDisposition;
}

export interface FeedbackImportState {
	id: string;
	source: 'paste' | 'docx' | 'gdocs';
	tabId: string;
	createdAt: number;
	comments: ImportedComment[];
	commentToThread: Record<string, string>;
	dispositions: Record<string, FeedbackDisposition>;
}
