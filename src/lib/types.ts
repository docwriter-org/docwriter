export interface Rule {
	id: string;
	text: string;
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
 * anchored at the EARLIEST round's `beforeMd`. */
export interface PendingReviewRound {
	id: string;
	/** Editor markdown captured immediately before this round applied.
	 * Used as the baseline for the diff overlay (when this is the earliest
	 * pending round) and as the restore target when the user rejects this
	 * round. */
	beforeMd: string;
	/** Agent's output for this round — recorded for auditing / diff
	 * summary; the Y.Doc already has it merged in. */
	afterMd: string;
	/** User-facing prompt or trigger that produced this round. */
	trigger?: string;
	timestamp: number;
	/** Heuristic classification of this round's size, computed at write
	 * time via a char-count threshold. `tiny` edits (e.g. a typo fix,
	 * a single-word tweak) render subtler — softer in the editor
	 * overlay, compact inline pill in the outline — so small corrections
	 * don't look like a big paragraph-level rewrite. `big` edits get the
	 * full green/red diff treatment. */
	kind: 'tiny' | 'big';
	/** How many AGENT_ORIGIN undo steps this round contributed to the
	 * tab's Y.UndoManager. With incremental streaming (one apply per
	 * Edit/Write tool call + one final apply at result time), this can be
	 * >1 per round. Reject pops this many steps to fully rewind. Defaults
	 * to 1 when absent (backward compat with rounds written before
	 * streaming). */
	stepCount?: number;
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
	| { type: 'tool_call'; timestamp: number; tool_name: string; input: Record<string, unknown>; durationMs?: number; subagent?: boolean }
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

/** Agent behavior settings. Persisted to .docwriter/state.json.
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
}
