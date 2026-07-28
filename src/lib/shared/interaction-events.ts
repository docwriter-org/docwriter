/**
 * Interaction-event taxonomy — the shared contract between the client
 * emitter (`$lib/interaction-log-client`), the server emitter
 * (`$lib/server/interaction-log`), the `/api/log` ingest endpoint, and
 * any analysis code reading the `interaction_events` table.
 *
 * Design rules:
 *   - Events record *interactions*, not content. Payloads carry IDs,
 *     kinds, counts and lengths — never document text. (Content is
 *     recoverable by replaying `yjs_updates`; keeping text out of this
 *     table makes it shareable/aggregatable on its own.)
 *   - Don't add events for things other tables already capture: typing
 *     lives in `yjs_updates` (origin-tagged), the agent transcript and
 *     tool calls live in `conversation_events` / `provider_session_entries`.
 *   - Server-observable interactions are logged at their HTTP choke point
 *     (`source: 'server'`); only view-layer interactions that never reach
 *     the server are client-emitted (`source: 'client'`).
 */

export type InteractionSource = 'client' | 'server';

/** What caused a `/api/render` submission. Carried in the render request
 * body and logged on `render.start`. `idle` = the 3s idle countdown fired;
 * `keyboard` = Cmd/Ctrl+Enter; `wake_button` = click on the agent pill. */
export type RenderTrigger =
	| 'idle'
	| 'keyboard'
	| 'wake_button'
	| 'chat'
	| 'feedback_chip'
	| 'comment_reply'
	| 'approve_thread'
	| 'accept_followup'
	| 'retry_stale'
	| 'retry_feedback'
	| 'autonomy_change'
	| 'reviewer'
	| 'freeze'
	| 'tab_delete'
	| 'plan_approve'
	| 'plan_feedback'
	| 'panel'
	| 'unknown';

export type InteractionEventName =
	// -- app lifecycle ------------------------------------------------------
	| 'app.boot' //          server: {version, participant, newSession}
	| 'app.focus' //         client: {focused, visible}
	// -- tabs (server, /api/tabs) ------------------------------------------
	| 'tab.open' //          {created} — POST; created=true when file was made
	| 'tab.switch' //        PATCH {active:true}
	| 'tab.rename' //        {from, to}
	| 'tab.close' //         {deletedFile}
	// -- renders (server, /api/render) -------------------------------------
	| 'render.start' //      {trigger, provider, model, reviewerId?, planMode, msgChars, images}
	| 'render.end' //        {status: ok|error|aborted|plan, durationMs, sessionId?}
	| 'render.queue_drop' // client: implicit wakeup silently dropped mid-render
	// -- review rounds (server, /api/document POST) -------------------------
	| 'review.accept' //     {scope: single|thread|all, count, roundIds, opTypes, reviewerIds}
	| 'review.reject' //     {scope, count, roundIds}
	| 'review.stale' //      accept hit the 409 stale path: {roundId, kind}
	// -- comment threads ----------------------------------------------------
	| 'thread.new' //        server: {threadId, actionLabel?, anchorChars, msgChars}
	| 'thread.reply' //      server: {threadId, msgChars}
	| 'thread.resolve' //    server: {threadId, resolved}
	| 'thread.open' //       client: {threadId}
	| 'thread.close' //      client: {threadId}
	| 'thread.delete' //     server: {threadId}
	// -- settings / rules / hooks (server) ----------------------------------
	| 'settings.change' //   agentSettings diff: {key, from, to}
	| 'rules.change' //      {added, removed, total}
	| 'hook.change' //       {added, removed, total}
	| 'pref.change' //       /api/session prefs: {key, value}
	| 'reviewer.create' //   {reviewerId}
	| 'reviewer.delete' //   {reviewerId}
	// -- session ------------------------------------------------------------
	| 'session.new' //       server: "New session" clicked
	// -- workspace files (server, /api/files) -------------------------------
	| 'file.op' //           {op: create|move|delete, path|from/to, kind|wasDir}
	// -- toasts (client; accepts also produce server-side *.change events) --
	| 'toast.accept' //      {kind: rule|hook}
	| 'toast.dismiss' //     {kind: rule|hook|error}
	// -- view-layer UI (client-only state) ----------------------------------
	| 'ui.provenance' //     {on}
	| 'ui.preview' //        {mode: window|split, open}
	| 'ui.dock' //           {expanded}
	| 'ui.transcript_open'
	| 'ui.sessions_open'
	| 'ui.find_open'
	| 'ui.outline_jump' //   {level?}
	| 'ui.menu_open' //      {menu: settings|tab_context|tree_context}
	| 'ui.dialog_open' //    {name}
	| 'ui.pin_diff' //       {pinned}
	| 'ui.copy_proposal'
	| 'ui.autonomy_preview' // hovered an autonomy option without committing: {level}
	| 'ui.feedback_abandoned' // selection popup closed without sending: {hadCustomText}
	| 'ui.model_change' //   {provider, model}
	| 'ui.view_pref' //      client-only prefs: {key, value} (fontScale, sidebar…)
	// -- editor (client) ----------------------------------------------------
	| 'editor.undo'
	| 'editor.redo';

/** One event as sent by the client batcher to `POST /api/log`. */
export interface ClientLogEvent {
	event: string;
	data?: Record<string, unknown>;
	tabId?: string;
	/** Client-side Date.now() at emit time. The server stamps its own
	 * `created` on insert; `clientTs` preserves intra-batch ordering. */
	clientTs: number;
}

export interface ClientLogBatch {
	/** Random ID per page load — distinguishes multiple open windows. */
	windowId: string;
	events: ClientLogEvent[];
}

/** Loose validation for client-supplied names: dotted lowercase tokens.
 * The ingest endpoint accepts any matching name (forward compatibility)
 * rather than rejecting unknown ones. */
export const INTERACTION_EVENT_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export const MAX_LOG_BATCH_EVENTS = 100;
export const MAX_LOG_EVENT_DATA_CHARS = 4096;
