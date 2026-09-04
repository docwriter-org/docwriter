# CLAUDE.md

Guidance for Claude Code when working on **DocWriter**.

## Commands

```bash
# Requires Node 22+ (use `nvm use 22` if needed)
npm run dev          # Start Vite dev server (hot reload)
npm run build        # Production build
npm run check        # TypeScript + Svelte type checking
npm run check:watch  # Watch mode type checking
npm run test:unit    # vitest (src/**/*.test.ts)
npm run doctor       # docwriter doctor — inspect/repair .docwriter state
```

Validate changes with `npm run check` AND `npm run test:unit`. The
lifecycle/consistency invariants live in
`src/lib/server/state-consistency.test.ts`.

## What DocWriter is

A plain-markdown writing editor with an AI side-channel. The user writes
markdown in a Tiptap editor. The editor state for every open tab is a CRDT
(Yjs `Y.Doc`) whose authoritative copy lives on the **server**; the browser
is a synced client. An agent proposes edits by mutating the server Y.Doc
directly through custom MCP tools. Every mutation reaches the browser over
a WebSocket as an atomic Yjs update and appears in the UI as a reviewable
round. The data model is flat markdown — no atoms, no blocks, no pins.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system.

## The one big idea

**The server owns the Y.Doc.** Clients connect to a Hocuspocus WebSocket
and sync the same per-tab `Y.Doc` the agent is editing. Every Yjs update
— user keystroke, agent edit, review-map change — appends to the
`yjs_updates` table in `.docwriter/docwriter.db` with its original Yjs
origin. SQLite is the persistence layer; `document.md` is a debounced
markdown backup for portability and git, not the source of truth. There
are no shadow files: the agent's `edit_doc` / `write_doc` MCP tools open a
`DirectConnection` to the live Hocuspocus document and transact with
`AGENT_ORIGIN` directly.

## Persistence layout

```
project-root/
  document.md          ← user-facing markdown (debounced 1s flush from the
                         server Y.Doc; git-friendly)
  drafts/chapter-1.md  ← any workspace file can be an open tab
  .docwriter/
    docwriter.db       ← SQLite: documents, yjs_updates, rules, reviewers,
                         recent_actions, action_usage_counts,
                         provider_session_entries, conversation_events,
                         kv (sessionId, agentSettings, feedbackImport…)
    workspace.json     ← stamp naming the workspace this state dir belongs
                         to (written on boot; warns if the folder moved)
    backups/           ← JSON snapshots written before any destructive
                         transition (file delete, external-edit reseed,
                         doctor repairs); pruned to the newest 40
    hooks.json         ← user-defined shell hooks (read by hooks-config.ts)
    agent/scratch/     ← agent scratch workspace (lazy-created on first
                         scratch write; cleared on "New session")
```

**`documents` is the identity table** (schema v13): one row per document
the app holds CRDT state for — lifecycle `status` (`open` in the tab bar /
`closed` but restorable), tab-bar order, the agent's `last_seen` diff
baseline (was kv `last_seen:<tabId>`), and the missing-file grace stamp.
`yjs_updates.tab_id` has a FOREIGN KEY to it with ON DELETE/UPDATE CASCADE:
deleting a document deletes its log in the same statement, renaming re-keys
it, and an orphaned log row is structurally impossible. The old `tabs`
table is gone; all access goes through `documents-store.ts` (never
DELETE-all + INSERT for identity tables). Closing a tab is a status flip —
reopening replays text, threads, pending rounds, and provenance. A missing
file badges the tab (grace window; history-backed docs self-heal from the
log) instead of deleting it. External file edits fold in as one appended
SYSTEM update (normalized comparison — typography-only diffs don't count);
log rows are deleted only by explicit delete, `docwriter doctor`, or
compaction (>500 rows on unload), always after a backup. Binary tabs
(`isBinaryTabPath` — a DENYLIST; LaTeX/Typst/BibTeX are text) are
preview-only and never touch the CRDT.

SQLite is the single source of truth for runtime state — there is no
`state.json` JSON mirror (it was removed; only stale comments referenced it).

No per-tab shadows (`.docwriter/agent/<tabId>`), no IndexedDB, no
in-browser persistence. A fresh browser paints only after the WebSocket's
first `synced` event — on localhost this is sub-20ms.

## Layout

- **Left (`OutlinePane`, 200px default, resizable):** auto-generated TOC from headings only
  (`showOutline`), with the `FileTree` below it. This is the sole
  `OutlinePane` instance — it renders only the TOC. (There used to be a
  second `showReview` instance in a right-hand sidebar; that mode has been
  removed.)
- **Center:** Tiptap editor + a floating `AgentDock` in the top-right (Wake
  up button, sleeping-cat mascot, gear-icon settings popover). The agent
  tool-call log (`HistoryPane`) lives inside the expandable
  `AgentDockShell`, not a fixed pane.
- **Pending agent edits + comment threads** render inline in the editor's
  comment gutter (`CommentGutter`, mounted in `TiptapEditor`) with Accept /
  Reject / Retry, plus per-tab badges on the `TabBar` — there is no separate
  review column.
- **Proposed rules / hooks** surface as dismissable toasts (`ToastStack`).
- **AI provenance toggle** (`AiProvenanceToggle`, in the editor's sticky
  top-right chrome next to `PreviewButton`): colors agent-written text,
  iA-Writer-authorship style. Accepting a round stamps the `ai` Yjs
  text-format attribute onto the text the agent actually introduced — a
  word-level diff (`diffWordLevel` in `ydoc-codec.ts`), so surviving user
  prose stays unmarked. The client renders the attribute as the
  `AiProvenanceMark` Tiptap mark (`span[data-ai-text]`); the toggle is pure
  CSS view state (`showAiProvenance` store, localStorage). Typing into an
  AI span strips the mark from the typed text ("make it your own").

## Agent SDK integration

`/api/render` streams a single `query()` call over SSE:

1. Build a multi-tab prompt:
   - Every text tab: header (path + active marker) + diff vs the document's `last_seen` baseline (a `documents` column) if it changed, else "unchanged" note. Diffs above ~8KB are summarized (`+X/−Y lines — call read_doc`) instead of inlined. Binary tabs are listed as preview-only, never materialized. No tab content is ever inlined; the agent calls `read_doc(file_path)` on demand.
   - First-render tab (no `last_seen`): path only — agent must `read_doc` to see content.
   Agency guidance (`conservative` / `balanced` / `aggressive`) rewires
   the "how to decide whether to edit" section.
2. `query()` runs with two MCP servers:
   - `docwriter` — `propose_rule` / `propose_hook` (user-review tools).
   - `docwriter-doc` — `edit_doc` / `read_doc` / `write_doc` /
     `comment_doc` / `reply_to_comment` / `list_threads` on tab paths;
     these route scratch paths to plain filesystem I/O and tab paths to
     `DirectConnection.transact` against the live Hocuspocus document.
     `comment_doc` accepts an optional `external_author` parameter for
     feedback import (sets `author: 'external'` on the thread).
   Built-in `Edit` / `Write` / `Read` remain available for files outside
   the open-tab set; the prompt explicitly routes open-tab work through
   the custom tools.
   There is no approve-a-suggestion step: a reply that names a change is
   followed by `edit_doc` on the same thread in the same turn, and the
   diff lands under the explanation. Only genuine uncertainty about the
   change itself (rare) earns a reply with no proposal. The old
   `proposed_edit` parameter and the gutter's "Approve & propose edit"
   button are gone; `CommentMessage.proposedEdit` survives as legacy data
   on older threads and renders as plain text.
   `comment-then-edit.test.ts` guards the contract.
   The feedback trigger quotes the passage as "Current text of the
   passage, quoted verbatim from the document" — the earlier
   `Rewrite it: "<passage>"` read as "rewrite it TO this", and the agent
   compared the quote with the document and declared nothing to change.
   An edit-mode feedback turn that ends with no new round on the tab gets
   one harness retry (`feedbackRetryPrompt` in the render route) naming
   the fact; it stands down only if the agent already said no change is
   needed or asked a question on the thread.
   The fixed agent dock floats over the lower gutter column, so
   `CommentGutter` scrolls a card into view (`revealCard`) when it opens
   and when the proposal an author is waiting on lands — its edits
   section and reply box are exactly the part the dock covers.
   A card's message list is capped at 300px and scrolls; it opens at its
   END (newest reply, then the edits section below), because a long first
   comment used to fill the box and hide the agent's answer and the
   proposal. Growth after that scrolls smoothly (`followNewMessages`).
   A round that moves text (one diff block only strikes, another block
   of the same round only adds) gets a "Proposed text moves below ↓"
   button under the struck passage (`createMovedNote` in
   `diff-overlay.ts`); red alone read as a deletion while the green sat
   off-screen past a code block. Clicking it scrolls the insertion into
   view.
3. Agent calls `edit_doc`: server finds the single `old_string` match in
   the live markdown, then in one `document.transact(..., AGENT_ORIGIN)`
   both rebuilds the XmlFragment via a headless Collaboration editor and
   appends a new `PendingReviewRound` to the tab's `Y.Map('review')`. The
   content change + review card land atomically.
4. Hocuspocus syncs the combined update to every connected browser over
   WebSocket. The review card appears next to the Tiptap cursor.
5. SSE stream emits `tool_call_start`, `tool_call`, `assistant_text`,
   `result` — drives the HistoryPane. The `result` event does NOT carry
   markdown anymore; there's nothing to apply on the client.
6. After render completes, update each text tab's `last_seen` column to the current
   markdown for every tab the agent saw, so the next render's diff block
   reflects what changed since.

Tool results for `edit_doc` / `write_doc` come from one helper,
`describeTabWrite` in `mcp-doc-tools.ts`, shared by the MCP tools and the
provider handlers. They say the edit was *proposed* as a pending diff on
its thread, never *applied*: the document changes only when the author
Accepts, and the old "Edit applied to X." had the agent telling the author
an edit was in when it was still pending. A replacement that leaves the
text identical after typography normalization creates no round and says
"No change proposed" instead of succeeding silently.

## Agent reconciliation

There is none — in the old sense. Agent edits flow as CRDT ops directly
through the live Hocuspocus document; the browser receives them like any
other remote update. No client-side 3-way merge, no clone-and-diff, no
rolling baselines. User keystrokes typed during a render converge with
agent ops via Yjs's item-level CRDT merge.

On the server, Accept/Reject run against the live Hocuspocus Document
(`acceptTabRounds` / `rejectTabRounds` in `ws-server.ts`; there is no
server-side UndoManager). Reject removes the round from the review
`Y.Array`; the doc fragment isn't touched. Accept walks each accepted
round and applies its `edit` op via `applyEditToFragment` (in
`ydoc-codec.ts`), which deletes + reinserts only the paragraphs the edit
covers. `write` ops fall back to wholesale `replaceYDocText`. Batch
accepts SKIP stale rounds and report them (`skippedStale`) instead of
409ing everything; only single-round accepts throw the
StalePendingReviewError that drives the client's rebase flow. Both paths
run in a single `ydoc.transact(..., USER_ORIGIN)` along with the
`reviewArr.delete`.

Because Accept's blast radius is bounded to the affected paragraphs,
the client doesn't need to disconnect + remount the editor to avoid
clobbering concurrent typing — the Yjs sync delivers the surgical
update over the existing WebSocket and ProseMirror re-renders only the
touched range. `acceptAgentEdit` / `rejectAgentEdit` in `+page.svelte`
just POST to `/api/document` and let the sync handle the UI update.

On the client, undo lives in `src/lib/editor-extensions.ts`: a custom
`Y.UndoManager` scoped to the text fragment + review array + comments map,
with `trackedOrigins = {ySyncPluginKey, USER_ORIGIN}` — local typing and
Accept/Reject are undoable; agent-origin changes are not on the local undo
stack. The editor update handler distinguishes user typing from remote/
agent transactions via `transaction.getMeta(ySyncPluginKey)` (undefined ⇒
local typing ⇒ restart the idle timer).

## Agent settings

`AgentSettings` in `src/lib/types.ts`, persisted in the SQLite `kv` table
(`agentSettings` key; see `runtime-state.ts`):
- **autonomy** (`agency: 'conservative' | 'balanced' | 'aggressive'`) —
  prompt rewiring.
- **trackChanges** — review mode on/off. (Track-changes off bypasses the
  pending-round UI; edits still flow through `AGENT_ORIGIN` so Undo
  continues to isolate them.)

Edited via the `AgentDock` settings popover (click the gear icon pinned to
the mascot card).

## Critique passes (reviewer agents)

Settings → **Critique pass** lists reviewer agents — built-ins (PhD
Advisor, Copy Editor, Skeptic, Fresh Eyes) from
`src/lib/shared/reviewers.ts`, custom ones from the SQLite `reviewers`
table (`/api/reviewers` CRUD; created via `ReviewerEditorDialog`, which
collects name, mascot, color, and the reviewer's system prompt). Picking
one POSTs `/api/render` with `reviewerId`:

- The server resolves the reviewer, builds a `<mode>` message
  (`buildCritiqueMessage` in `src/lib/server/reviewers.ts`) telling the
  agent to adopt the reviewer's brief (its prompt + the shared pass
  procedure: read the whole draft, rationale comment before each edit,
  ≤6 findings, honest "no findings" allowed) and run it IN THIS TURN.
  Critique renders run at `effort: 'medium'`.
- **Never delegate document work to a subagent.** `docwriter-doc` is an
  in-process SDK MCP server bound to the query that connects it, so a
  subagent's `read_doc` / `comment_doc` / `edit_doc` calls fail with
  "Stream closed" — and the failure takes the parent's connection with
  it, costing the rest of the turn its tools too. The pass used to spawn
  a subagent and silently produced nothing: the reviewer did the whole
  analysis, then could not land one finding. The same rule is stated in
  the system prompt's `## Subagents` section and in the feedback-import
  prompts, which had the same defect.
- `setActiveReviewerId` in `mcp-doc-tools.ts` (same lifecycle as
  `setActiveFeedbackThreadId`) stamps `reviewerId` onto every review
  round and agent comment the pass creates. Findings are ordinary
  threads + pending rounds — Accept/Reject/reply machinery unchanged.
- Client: the `activeReviewer` store makes the agent pill hand itself to
  the reviewer while the pass runs (mascot + name, reviewer-tinted, in
  `AgentDockShell` and `HistoryPane`); `CommentGutter` renders the
  reviewer's mascot + name on attributed cards via `ReviewerMascot`
  (line-icon set keyed by the reviewer's `icon` field).

## Feedback import

Settings → **Import feedback…** lets the user bring in external reviewer
comments and have the agent take a first pass at addressing them. Two
input paths:

- **Upload .docx**: server-side extraction of Word comments from
  `word/comments.xml` via `jszip` (`src/lib/server/docx-comments.ts`).
  Each `<w:comment>` yields author + text; anchored passages come from
  `<w:commentRangeStart/End>` markers in `word/document.xml`. The dialog
  (`FeedbackImportDialog`) shows a preview before importing.
- **Paste raw text**: any format (email, Slack, reviewer notes). Sent
  as-is to the agent via `buildRawFeedbackMessage`; the agent identifies
  individual comments, finds matching passages, and anchors them itself.

The import is a single agent pass — threads appear progressively in the
gutter as the agent works. For structured imports (.docx), the prompt
uses `buildFeedbackImportMessage` (in `src/lib/shared/feedback-import.ts`)
with numbered comments and original anchor hints. The agent receives the
prompt directly and works the batch itself — like a critique pass, it
must not delegate to a subagent, which cannot reach the document tools.

**External author attribution**: `CommentAuthor` includes `'external'`
alongside `'user'` and `'agent'`. The `comment_doc` MCP tool accepts an
optional `external_author` parameter; when set,
`createAgentCommentThread` stamps `author: 'external'` and
`externalAuthor: <name>` on the first message. `CommentGutter` renders
external authors with a purple `MessageSquare` icon and the person's
name.

**Coverage ledger**: import state (comments, thread mappings,
dispositions) is persisted in the SQLite `kv` table under the
`feedbackImport` key (`src/lib/server/feedback-import.ts`). The
`FeedbackLedger` component in `AgentDockShell` polls
`GET /api/feedback-import` and shows per-comment disposition
(applied / discussed / deferred / untouched) with a progress bar.
When `comment_doc` fires with `external_author`, the handler matches
against the active import and records the thread ID; `edit_doc` upgrades
the disposition from `discussed` to `applied`.

## Conventions

- **Svelte 5 runes** (`$state`, `$derived`, `$effect`) in components.
  `$store` auto-subscription is fine in runes mode (TiptapEditor uses it);
  if you use manual `.subscribe()`, capture and call the unsubscriber on
  destroy — leaked subscriptions on remounting components were a real bug.
- **Font:** Lora (serif) for editor prose, Inter for UI, Geist Mono for
  plain/code rendering.
- **Model selection:** multi-provider (claude / openai / codex / cursor /
  pi); request bodies carry `provider` + `model`.
- **Timing:** 3s idle countdown to auto-submit, 500ms markdown-flush tick
  on the server, Cmd/Ctrl+Enter skips the countdown.
- **Yjs origins** (`AGENT_ORIGIN`, `USER_ORIGIN`, `SYSTEM_ORIGIN`) are
  single shared constants in `src/lib/shared/ydoc-codec.ts`, imported by
  both client and server — never redefine them locally.

## Gotchas

- **Accept/Reject pause the WebSocket, and the resume must re-arm it.**
  `pauseTabSync` disconnects the provider so the HTTP response's delta is
  applied locally with `USER_ORIGIN` (undo contract). `disconnect()` only
  starts the close handshake; if the HTTP reply lands before the close
  completes, the provider's `connect()` returns early without setting
  `shouldConnect`, and the later close never reconnects — a silently dead
  tab (keystrokes stop syncing, the agent's next proposals never arrive).
  The resume sets `websocketProvider.shouldConnect = true` before
  `connect()`. `onSyncConnectionChange` reports a tab that stays
  disconnected outside a pause for 5 s; the page turns it into a history
  notification.
- **Unloading a live doc flushes it.** `afterUnloadDocument` runs
  `onTabUnloaded`: a tab still dirty from the 500 ms flush window is
  replayed from the log and written to its file before the dirty flag is
  dropped, so `document.md` never lags the CRDT because the last browser
  disconnected mid-window.
- **`globalThis.__docwriterWsServer` singleton.** Vite HMR re-executes
  `hooks.server.ts` on save; the module-scope guard keeps us from
  double-binding the Hocuspocus port (`ECONNREFUSED`-via-reconnect). The
  live server instance is also how route handlers (`mcp-doc-tools.ts`,
  `/api/document`'s flush path) reach `openDirectConnection`.
- **`yjs_updates.payload` column.** The blob column holding raw Yjs
  updates is named `payload`. (Historical: it was originally named
  `update`, a SQLite reserved word; migration v2 renamed it. Don't
  revive the old name.)
- **`ySyncPluginKey` must come from `@tiptap/y-tiptap`.** The
  Collaboration extension installs its sync plugin from `@tiptap/y-tiptap`,
  not `y-prosemirror`; both packages define a `PluginKey('y-sync')`, and
  prosemirror-state dedupes key names, so the two instances never match.
  Import the key (and the rel-position helpers) from
  `src/lib/editor-extensions.ts`, which re-exports the correct one —
  importing from `y-prosemirror` silently breaks agent-vs-user transaction
  classification and comment anchoring (this was a real shipped bug).
- **Hocuspocus's internal Document is authoritative.** Once the WS server
  is up, server code that wants to READ a tab should prefer the live
  in-memory Document (`hocuspocus.documents.get(...)`, falling back to a
  throwaway Y.Doc hydrated via `replayUpdatesInto`), and code that wants
  to MUTATE a tab MUST go through
  `hocuspocus.openDirectConnection(...)` (see `getHocuspocus` in
  `mcp-doc-tools.ts`) — never mutate a replayed throwaway doc.
- **Comment threads are nested Y types.** Each thread is a `Y.Map`
  (id/anchor/resolved/createdAt) holding a `Y.Array` of messages, so
  concurrent writes merge (a Dismiss racing an agent reply keeps both).
  NEVER `commentsMap.set(id, {...})` a whole plain object — that reverts to
  last-writer-wins and one side's write silently vanishes (the original
  dismissed-thread-resurrects / reply-disappears bug). Read via
  `readThreadValue`/`getThread`/`readCommentThreads` (they also accept the
  legacy plain shape); write via `putThread` / `appendThreadMessage` /
  `setThreadResolved` / `setThreadAnchor`. Legacy threads migrate on doc
  load. Client observers must `observeDeep` — nested mutations don't fire
  shallow map observers.
- **Per-render state is per-render, not module-level.** The reviewer id,
  the active feedback thread and the stale-accept payload live in an
  `AsyncLocalStorage` scope opened by `runWithRenderScope`
  (`mcp-doc-tools.ts`), because `runTabWrite` / `createAgentEditThread` /
  `createAgentCommentThread` / `applyReplyToComment` are shared by every
  provider and read them ambiently. As module globals they were clobbered
  by overlapping renders: a critique pass's findings got another
  reviewer's id or none, a feedback reply attached to the wrong thread,
  and whichever render finished first blanked all three for the one still
  streaming. Never move them back to module scope.
- **Agent tool availability is per-render.** `buildDocToolsMcp()` builds a
  FRESH `docwriter-doc` MCP server for every `query()`. It must never become
  a module singleton again: an in-process SDK MCP server binds to the query
  that connects it, so a shared instance leaves a second, overlapping render
  with no `edit_doc` / `read_doc` / `comment_doc` at all. Paired with that,
  `permissionMode` is `'default'`, NOT `'acceptEdits'` — `acceptEdits`
  auto-approves built-in file mutation and skips `canUseTool`, so the
  "built-in Edit / Write are restricted to your scratch directory" gate
  never ran and a tool-less agent would rewrite the workspace file with no
  review round, no thread and no diff card. `agent-voice.test.ts` and the
  live gate message are the guards.
- **Injected transcript voice.** The transcript is the author and the agent
  talking: injected user turns speak as "I", the system prompt is the
  author's briefing, and the agent addresses the author as "you" — never
  "the user" in anything a person reads. Trigger-string MATCHERS
  (`stale-accept.ts`, `+page.svelte` shortDescription) accept both the old
  third-person and new first-person forms because persisted rounds carry
  old triggers; keep them in lockstep when templates change.
- **`Y.XmlText.toString()` is not plain text.** Once a text node carries a
  format attribute (the `ai` provenance attribute), `toString()` serializes
  formatted ranges as XML tags (`a <ai>b</ai>`). All text extraction in
  `ydoc-codec.ts` goes through `toDelta()` — never call `toString()` on a
  fragment's text. Related: `Y.Text.insert` WITHOUT attributes inherits the
  formatting of the preceding character; build formatted paragraphs with
  `applyDelta` (attribute-less ops insert genuinely unformatted).
- **Serialization is plain text, not markdown.** `serializeFragment` /
  `serializeYDoc` in `ydoc-codec.ts` emit the document text verbatim
  (plus typography normalization) — nothing escapes markdown specials, and
  the `ai` provenance attribute is stripped, so `document.md`, `read_doc`,
  prompt diffs and stale checks all see plain text (provenance lives only
  in the CRDT log).
  The editor schema is intentionally minimal (Document / Paragraph /
  Text / HardBreak); don't add StarterKit, Link, or Tiptap's history
  extension — undo is the custom `Y.UndoManager` wired through
  `Collaboration.configure({ yUndoOptions })` in `editor-extensions.ts`.
