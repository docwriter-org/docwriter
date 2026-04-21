# DocWriter Architecture

DocWriter is a local writing environment built as:

- a CLI launcher (`bin/docwriter.js`, `bin/docwriter-dev.js`)
- a SvelteKit web app (`src/routes/+page.svelte`)
- a server-authoritative Yjs runtime: per-tab `Y.Doc`s held in memory on
  the server, persisted as an append-only log of CRDT updates in SQLite,
  and synced to browser clients over a Hocuspocus WebSocket
- a Claude Agent SDK loop that edits tab files through custom MCP tools
  (`edit_doc` / `read_doc` / `write_doc`) operating directly on the live
  server Y.Doc, plus plain filesystem I/O for an agent scratch workspace

The current architecture is organized around one idea:

> The server owns each tab's Y.Doc. Every mutation — user keystroke or
> agent edit — is a Yjs transaction with an explicit origin, appended to
> SQLite, broadcast to all connected browsers. Review, undo, and reject
> fall out of the CRDT's origin-tagged update log.

## System At A Glance

```text
CLI
  -> sets DOCWRITER_ROOT, PORT, model/auth defaults
  -> launches built SvelteKit server or Vite dev server
  -> SvelteKit + the Hocuspocus WebSocket share one Node process

Browser
  -> Svelte page shell
  -> Tiptap editor bound to per-tab Y.Doc via HocuspocusProvider
  -> review UI, file tree, agent history, hooks/rules panels

Server
  -> /api/document, /api/tabs, /api/files, /api/file-content
  -> /api/render streaming SSE
  -> /api/history, /api/session, /api/hooks, /api/references, /api/live,
     /api/ask-user-reply
  -> Hocuspocus WebSocket (port 3001 by default) — the Y.Doc sync channel

Persistence
  -> .docwriter/docwriter.db — SQLite
        yjs_updates  (append-only Y.Doc ops per tab, origin-tagged)
        tabs, rules, hooks, recent_actions, action_usage_counts, kv
  -> document.md — debounced 1s flush from the server Y.Doc (per tab)

Agent runtime
  -> Claude Agent SDK query() (spawned per /api/render)
  -> reads any workspace file via Read/Glob/Grep
  -> edits OPEN TABS via edit_doc / write_doc (custom MCP tools that
     transact against the live Hocuspocus Document with AGENT_ORIGIN)
  -> reads live tab content via read_doc (serializes live Y.Doc)
  -> writes .docwriter/agent/scratch/ via plain filesystem (fall-through
     in edit_doc / write_doc, or via built-in Edit/Write)
  -> emits tool/status/progress events back to the UI over SSE
```

## Runtime Topology

### 1. Launch modes

DocWriter has two entrypoints:

- `bin/docwriter.js`
  Starts the built app, picks a port, sets `DOCWRITER_ROOT`, and optionally
  enables `--watch`, `--new-session`, and model/API-key overrides.
- `bin/docwriter-dev.js`
  Starts Vite directly against another workspace for live UI development.

In both modes, the app is pointed at an arbitrary workspace root via
`DOCWRITER_ROOT`. The editor repo is just the application source; the
actual writing happens in some other folder.

The Hocuspocus WebSocket server is started from `src/hooks.server.ts` at
SvelteKit boot, on a separate TCP port (`DOCWRITER_WS_PORT`, default
`3001`). A `globalThis.__docwriterWsServer` guard keeps Vite HMR from
double-binding during dev.

### 2. Workspace model

Any workspace-relative text file can be an open tab.

- Markdown-like files (`.md`, `.markdown`, `.mdx`) use the markdown editor
  mode.
- Other recognized text extensions (`.txt`, `.json`, `.py`, `.html`, etc.)
  use plain-text mode.

Tabs are stored in the SQLite `tabs` table as an ordered list plus an
active-tab pointer.

## Persistence Layers

DocWriter persists state across three layers.

### 1. Workspace files

The user's project folder. Every open tab's content is debounced-written
back to its real workspace path (`DOCWRITER_ROOT/<tabId>`) ~1 second
after the last change reaches the server. The file on disk is the
portable, git-friendly form; it is not the source of truth.

```text
workspace/
  ch12.asciidoc
  drafts/intro.md
  scripts/cleanup.py
```

### 2. `.docwriter/`

Machine-managed runtime state:

```text
.docwriter/
  docwriter.db        ← SQLite (authoritative)
  agent/
    scratch/          ← agent's own drafts (lazy-created)
  references/         ← saved writing-style samples
  references.json     ← references index
```

- `docwriter.db`
  The authoritative store, queried through `src/lib/server/db.ts`
  (`getDb()`). Schema: `yjs_updates` (per-tab append-only Yjs update log,
  origin-tagged), `tabs`, `rules`, `hooks`, `recent_actions`,
  `action_usage_counts`, `kv`. The `kv` table holds singletons like
  `sessionId` and `last_seen:<tabId>`.

- `.docwriter/agent/scratch/`
  Session-scoped scratch space for the agent's own drafts and notes.
  Writable by the agent through `edit_doc` / `write_doc` (fall-through
  when the path is under this directory) or the built-in `Edit`/`Write`.
  Not surfaced as user tabs; wiped on "New session". Directory is
  created lazily on first scratch write — the old `.docwriter/agent/`
  parent no longer exists by default.

### 3. Server-side Y.Doc registry

For every open tab, `src/lib/server/ydoc-registry.ts` holds an in-memory
tuple:

- `ydoc` — a `Y.Doc` with an `XmlFragment` named `default` (the editor
  content) and a `Y.Map` named `review` (with `pendingRounds` plus a few
  legacy-compat fields).
- `undoManager` — a `Y.UndoManager` scoped to the fragment, tracking only
  `AGENT_ORIGIN` transactions.
- `reviewMap` — handle to the same review map for convenience.

On first access for a tab:

1. Construct a fresh `Y.Doc`.
2. Attach the UndoManager.
3. Call `replayUpdatesInto(ydoc, tabId)` — replays every row of
   `yjs_updates` for that tab through `ydoc.transact(..., row.origin)`.
   Because the UndoManager is already attached, agent-origin transactions
   from prior sessions repopulate the undo stack and Reject works after
   a server restart.

When Hocuspocus's `onLoadDocument` fires for that tab, it copies the
registry Y.Doc's state into its own internal `Document`. From that point
forward, the live Hocuspocus `Document` is authoritative; the registry
Y.Doc is stale. Route handlers that want to mutate a tab (the custom MCP
tools, the `/api/document` GET-flush path) go through
`server.hocuspocus.openDirectConnection(tabId)`.

## Client Architecture

`src/routes/+page.svelte` is the page shell. It orchestrates:

- theme setup
- tab lifecycle (open / focus / rename / close / delete)
- editor mount/remount per tab (gated on the HocuspocusProvider's
  `synced` event, so Tiptap binds against a fully hydrated Y.Doc)
- file tree, writing-references panel, rule/hook/session settings panels
- the streaming render loop and agent history
- review accept/reject/retry flows (pure Y.Map('review') mutations that
  propagate via Hocuspocus sync)

### Main UI regions

- left sidebar: outline + files tree
- center: tab strip, editor
- right sidebar: agent history, pending review / proposed rules / user
  questions
- floating agent dock: wake button, cost pill, send-message popover

### Important Svelte components

- `src/lib/editor/TiptapEditor.svelte` — editor surface, idle-submit
  timer, feedback popup, diff overlay.
- `src/lib/components/FileTree.svelte` — workspace explorer with inline
  create / rename interactions.
- `src/lib/components/OutlinePane.svelte` — outline + review cards,
  proposed rules, hooks, user questions.
- `src/lib/components/HistoryPane.svelte` — agent history, notifications,
  tool calls, thinking summaries, annotations.
- `src/lib/components/AgentDock.svelte` — wake button, cost pill, direct
  message popover.

### Stores

`src/lib/stores.ts`:

- document projections: `userMd`, `pendingReviewRounds`
- agent/review UI: `proposedRules`, `proposedHooks`,
  `pendingUserQuestions`, `agentHistory`, `annotations`,
  `isRendering`, `submitCountdown`
- preferences/session: `selectedModel`, `selectedTheme`,
  `historyVerbosity`, `showFilesPane`, `agentSettings`, `sessionCost`
- tab state: `tabs`, `activeTab`, `activeTabKind`

The editor content itself lives in Yjs, not in stores — the stores are
projections or UI wrappers.

## Per-Tab Editor Model

`src/lib/yjs-doc.ts` manages the per-tab registry on the client. For each
tab:

- `getYDocForTab(tabId)` creates (or reuses) a `Y.Doc` and a
  `HocuspocusProvider` connected to `ws://<host>:<WS_PORT>/<tabId>`.
- `whenYDocReady()` resolves on the provider's first `synced` event.
- `setCurrentTab(tabId)` switches which doc the live editor uses.
- `destroyTab(tabId)` tears down the provider and the Y.Doc; server-side
  state in `yjs_updates` is unaffected.
- `renameTab(oldId, newId)` snapshots the old Y.Doc, spins up a fresh
  provider for the new id, and hands the state over. `/api/tabs` renames
  the file on disk; the next server-side `replayUpdatesInto(newId)`
  seeds from the renamed file.

IndexedDB persistence is gone. Refreshes wait on the WebSocket sync
(sub-20ms on localhost). The Y.Doc on the server is the single source of
truth for content + review state.

## Editor Update Loop

`TiptapEditor.svelte` handles every ProseMirror update.

1. If the transaction carries the `ySyncPluginKey` meta (Yjs pushing a
   remote update into the editor), skip — no side effects.
2. Serialize the editor content to markdown (or plain text) and publish
   to the `userMd` store (for outline + readers).
3. If the transaction carries `AGENT_APPLY_KEY` meta (set locally when
   an agent-origin Y.Doc update is applied), skip the idle-timer
   restart — an agent edit is not "the user is still writing."
4. Otherwise restart the 3-second idle-submit countdown.

There's no longer a client-side autosave to `PUT /api/document`; the
server's Y.Doc-to-disk flush owns that responsibility.

## Agent Render Pipeline

The render flow lives in `src/routes/api/render/+server.ts`.

### Prompt construction

`buildMultiTabPrompt(activeTabId, tabs, userMessage)` assembles:

- **Active tab:** full current content (read from the live Hocuspocus
  Document) inlined as a fenced code block, plus a unified-line diff
  against `kv['last_seen:<tabId>']` if present.
- **Non-active tab with changes:** path + diff only. The agent is told
  to call `read_doc(path)` if it needs full content.
- **Non-active tab unchanged:** path only.
- **First-render tab (no `last_seen`):** full content.
- Plus: persistent writing rules (read from SQLite-backed
  `runtime-state.ts`), style references index, agency guidance
  (`conservative` / `balanced` / `aggressive`), tool usage rules, and
  `propose_rule` / `propose_hook` tool definitions.

After render completes, the handler writes
`kv['last_seen:<tabId>'] = currentMd` for every tab the agent saw.

### Custom MCP tools

DocWriter registers two in-process MCP servers during `/api/render`:

- **`docwriter`** (`src/routes/api/render/+server.ts`)
  Non-file-writing proposals that the user must explicitly review.
- **`docwriter-doc`** (`src/lib/server/mcp-doc-tools.ts`)
  File/document tools that understand DocWriter's live-tab model.

The full custom tool set is:

| MCP server | Tool | What it does | Where it writes/reads |
| --- | --- | --- | --- |
| `docwriter` | `propose_rule({ text, reason? })` | Suggests a persistent writing rule. The tool itself only ACKs; the real side effect is an SSE `rule_proposal` event that creates an Accept/Reject card in the UI. | No file write. User review only. |
| `docwriter` | `propose_hook({ event, matcher?, command, reason? })` | Suggests an automation hook. Like `propose_rule`, this only emits a proposal for user review. | No file write. User review only. |
| `docwriter-doc` | `read_doc({ path })` | Reads the current content of a path that DocWriter understands. For open tabs it serializes the live Hocuspocus Y.Doc, so the result matches what the browser is showing right now. | Open tabs: live Y.Doc. Scratch: plain file read. |
| `docwriter-doc` | `edit_doc({ path, old_string, new_string })` | Replaces exactly one occurrence of `old_string`. On open tabs it edits the live Y.Doc and appends a pending review round in the same `AGENT_ORIGIN` transaction. | Open tabs: live Y.Doc. Scratch: plain file edit. |
| `docwriter-doc` | `write_doc({ path, content })` | Replaces the full content at `path`. Same transaction/review flow as `edit_doc` for open tabs. Does not create new tabs. | Open tabs: live Y.Doc. Scratch: plain file write. |

The built-in SDK tools are still available where appropriate:

- `Read` / `Glob` / `Grep` can inspect the wider workspace.
- `AskUserQuestion` is an SDK tool, not a DocWriter MCP tool; DocWriter
  intercepts it in `canUseTool` and renders the question in the UI.
- Built-in `Edit` / `Write` are intentionally not the authority for open
  tabs because they would bypass the live Y.Doc, review rounds, and
  origin-tagged undo flow.

#### Path routing (`src/lib/server/path-router.ts`)

The document tools route by `path` before doing any work:

| Path shape | Resolution | Behavior |
| --- | --- | --- |
| `.docwriter/agent/scratch/...` | Scratch path | Plain filesystem I/O. Private agent workspace; not surfaced as user tabs. |
| `drafts/ch1.md` (workspace-relative tab id) | Open tab | Resolve directly from `tabs.order`, then operate on the live Hocuspocus document. |
| `/abs/path/to/workspace/drafts/ch1.md` | Open tab | Match by suffix against the open-tab ids, then operate on the live Hocuspocus document. |
| Anything else | Unknown path | Reject with `isError: true`. `write_doc` never creates a new tab implicitly. |

#### Open-tab tool flow

For `edit_doc` / `write_doc` on an open tab:

1. `resolveTabFromPath(path)` maps the tool input to an existing open tab.
2. `getHocuspocus().openDirectConnection(tabId)` opens a handle to the
   live Hocuspocus `Document`, not the stale registry copy.
3. The tool serializes the current live doc (`beforeMd`), computes the
   requested new content, and validates edit preconditions (`old_string`
   count for `edit_doc`).
4. Inside one `document.transact(..., AGENT_ORIGIN)`, a headless Tiptap
   Collaboration editor calls `setContent(...)` against the live Y.Doc.
   That is what turns markdown/plain text into the actual CRDT updates.
5. In the same transaction, the tool appends a `PendingReviewRound` into
   `Y.Map('review').pendingRounds`.
6. Hocuspocus broadcasts the combined Yjs update to every browser, and
   `onChange` persists it into SQLite's `yjs_updates` log.

This "content mutation + review metadata in one Yjs transaction" is the
core behavior the default file tools cannot provide.

#### Why these tools exist instead of default file tools

DocWriter does not use built-in `Edit` / `Write` for open tabs because
those tools operate on plain files, while the app's source of truth for
an open document is the live server-side Y.Doc. The custom tools exist
so that:

- the agent edits the exact same document instance the browser is
  rendering
- `tool_result` reflects what actually landed in the live doc, not what
  was written to a shadow file
- content changes and pending review cards arrive atomically
- Reject works via `AGENT_ORIGIN` + `Y.UndoManager`
- scratch work can still use cheap plain filesystem I/O without being
  confused with user-facing tabs

The render prompt therefore disables built-in `Edit` / `Write` for
open-tab paths and steers explicitly toward `edit_doc` / `write_doc`;
`Read` / `Glob` / `Grep` remain available for general workspace reads.

### SSE stream

The browser subscribes to `/api/render` and receives:

- `tool_call_start`, `tool_call` — agent tool invocations.
- `assistant_text`, `assistant_thinking` — model output and thinking
  summaries.
- `rule_proposal`, `hook_proposal`, `ask_user` — sidebar UI events.
- `notification`, `cost` — status updates.
- `task` / `subagent` lifecycle events.
- `result` — the render is done. This event no longer carries markdown;
  the agent's content changes already reached the browser through the
  WebSocket.

## Review Model

### How a review round is created

When `edit_doc` or `write_doc` mutates a tab, the same
`document.transact` that rewrites the XmlFragment also appends a
`PendingReviewRound` to `Y.Map('review').pendingRounds`:

```ts
interface PendingReviewRound {
  id: string;
  beforeMd: string;
  afterMd: string;
  trigger: 'agent_edit_doc' | 'agent_write_doc' | ...;
  timestamp: number;
  kind: 'tiny' | 'big';   // from classifyRoundKind()
  stepCount: number;      // always 1 in the new model — each tool call
                          // is its own agent-origin transaction
}
```

Both the XmlFragment change and the review-map mutation carry
`AGENT_ORIGIN` inside the same Yjs transaction, so browsers receive the
combined update atomically.

### Accept

Pure Y.Map('review') mutation. Client-side:

```ts
const rounds = reviewMap.get('pendingRounds');
// Accept round(s) in order — accepting round[idx] drops rounds[0..=idx].
reviewMap.set('pendingRounds', rounds.slice(idx + 1));
```

The mutation propagates through Hocuspocus to every connected client.
The content itself stays in place.

### Reject

Use the per-tab `Y.UndoManager` (`src/lib/yjs-agent.ts`) that tracks only
`AGENT_ORIGIN`:

```ts
for (let i = 0; i < round.stepCount; i++) undoManager.undo();
reviewMap.set('pendingRounds', rounds.slice(idx + 1));
```

User keystrokes between / after the agent transactions survive, because
they were never on the UndoManager's tracked-origin set.

Because the UndoManager is per-browser and session-scoped, a browser
refresh rebuilds it from the Y.Doc's history state on next connect —
stack items are reconstructed from the replayed `yjs_updates` rows
through the server-side UndoManager's observer. (See "UndoManager
construction order" below.)

### Conflict

With the old 3-way merge gone, "conflict" reduces to `old_string not
found in live document` — the user changed the region after the agent
read it but before the `edit_doc` transact ran.

`edit_doc` returns `isError: true` with a message steering the agent to
`read_doc(path)` and retry against fresh content. There's no
auto-conflict-retry loop at the app level anymore; Yjs handles
structural convergence, and the agent handles content-level retries in
its own tool-call loop.

## Server-Side Y.Doc Lifecycle

### Cold start (first access of a tab)

`getTabYDoc(tabId)` in `src/lib/server/ydoc-registry.ts`:

1. Create a fresh `Y.Doc`.
2. Construct the `Y.UndoManager` on the `default` XmlFragment with
   `trackedOrigins: new Set([AGENT_ORIGIN])`. **This must happen before
   replay.**
3. Call `replayUpdatesInto(ydoc, tabId)`:
   - If `yjs_updates` has rows for this tab, replay each with
     `ydoc.transact(() => applyUpdate(ydoc, row.update), row.origin)`.
     The UndoManager, already attached, captures every AGENT_ORIGIN
     transaction onto its undo stack.
   - Otherwise, if a real workspace file exists, seed the Y.Doc from
     its content (origin `'system'`) and persist a single compacted
     `yjs_updates` row so the next load skips the disk read.

Swapping steps 2 and 3 leaves the undo stack empty at cold start —
Reject on a round from a prior session becomes a no-op.

### Write path (user keystroke)

1. Browser keystroke → Tiptap transaction → ySyncPlugin translates it
   to a Yjs update on the browser Y.Doc → HocuspocusProvider sends it
   over the WebSocket.
2. Hocuspocus applies it to the internal `Document`, fires `onChange`.
3. `ws-server.ts`'s `onChange`:
   - `appendUpdate(tabId, update, 'user')` — insert one `yjs_updates`
     row. (`'user'` is the default origin string when the transaction
     didn't carry one, which is true for browser-originated updates.)
   - `scheduleMarkdownFlush(tabId, document)` — debounce-1s a markdown
     serialize + `writeFileSync` of the tab's workspace file.

### Write path (agent edit)

1. Agent calls `edit_doc` via MCP.
2. `mcp-doc-tools.ts`:
   - `getHocuspocus().openDirectConnection(tabId)`.
   - Inside `direct.transact(document => ...)`:
     - Serialize current markdown, locate the unique `old_string` match.
     - `document.transact(() => { rebuildFragment(newMd);
       reviewMap.set('pendingRounds', [...]); }, AGENT_ORIGIN)`.
3. Hocuspocus fires `onChange`; `transactionOrigin` is the string
   `AGENT_ORIGIN`. `appendUpdate` writes a row tagged `agent`.
4. `scheduleMarkdownFlush` debounces a disk write.
5. Every connected client receives the Yjs update; their
   HocuspocusProvider applies it; their Tiptap editor renders the
   change and the new review card.

### Compaction

`yjs_updates` grows one row per keystroke. `compactTab(tabId)` in
`ydoc-persistence.ts` merges all rows for a tab into a single compacted
row with `origin = 'system'`. Not run on the hot path; currently called
from no scheduler, but the helper is in place for a timer / tab-close
hook.

## Feedback & Annotation Model

Text selection in the editor can open a feedback popup:

- pinned quick feedback
- custom feedback text
- LRU recent-feedback labels
- persistent submitted highlights
- hover popovers showing the submitted note

Submitted feedback becomes a transient annotation tied to tab id +
excerpt + comment + ProseMirror range + timestamp. Highlights stay
visible until an actual agent edit lands for that file, at which point
they're cleared.

## Agent History Model

The history pane is a unified event stream:

- user submissions
- assistant text / thinking summaries
- tool calls / tool progress
- task/subagent lifecycle
- hook executions
- annotations

Two display modes: `verbose` (full loop trace) and `minimal` (mostly
user actions, actual edits, end-state events). `/api/history` restores
prior history from the Claude SDK transcript.

## Server API Surface

### `/api/tabs`

Tab lifecycle. `GET` returns ordered/open tabs + active; `POST` opens
or creates a tab; `PATCH` focuses or renames; `DELETE` closes or
optionally deletes the file.

### `/api/document`

Per-tab document endpoint, now a thin shim:
- `GET` — reads the workspace file + metadata. Before reading, calls
  `flushTabMarkdownNow(tabId)` so the on-disk content reflects
  not-yet-flushed Y.Doc changes.
- `PUT` — accepts only a `meta` body (rules / agent settings). Any
  `userMd` in the body is ignored; the Y.Doc sync owns editor content.
- `POST` with `action: 'accept' | 'reject'` is **gone**. Accept and
  reject are pure Y.Map('review') mutations on the client.

### `/api/files`

Workspace file tree: listing, create, rename/move, delete. Guarded by
the workspace-path resolver.

### `/api/file-content`

Raw read/write for non-editor files.

### `/api/render`

SSE stream; see "Agent Render Pipeline" above.

### `/api/history`

Rehydrate the agent event timeline from the Claude SDK's transcript.

### `/api/session`

Session id, recent feedback actions, usage counts. `DELETE` clears
session-scoped state ("New session").

### `/api/hooks`

Read or replace the persisted hook configuration.

### `/api/live`

File-watch notifications so external edits (`--watch` mode) reach the
browser.

### `/api/ask-user-reply`

Feed a user answer back into an agent's blocked `AskUserQuestion` call.

### `/api/references`

Writing-style references index and samples.

## Workspace Safety Model

`src/lib/server/workspace-path.ts` enforces that file operations stay
inside `DOCWRITER_ROOT`. It resolves through the nearest existing real
ancestor, so `..` traversal and symlink escapes are blocked even for
paths that don't exist yet.

Hook configuration is never agent-writable. The agent can only
`propose_hook` via MCP; acceptance flows through the user and
`PUT /api/hooks`.

## Design Principles

1. **User edits must not be lost.** Per-tab Y.Docs, `AGENT_ORIGIN`
   isolation for undo, CRDT item-level merge for concurrent writes.
2. **Agent work must remain reviewable.** Every `edit_doc` / `write_doc`
   atomically pairs its content change with a `PendingReviewRound`
   entry in `Y.Map('review')`.
3. **The app works against a real folder, not a fake sandbox.**
   Workspace-relative tabs, filesystem-backed APIs, file tree + raw
   file endpoints, CLI root selection.
4. **Single source of truth.** The server Y.Doc owns editor content;
   SQLite owns the Yjs update log; `document.md` is a debounced backup.
   No IndexedDB, no shadow files, no 3-way merge.

## Key Files

- `bin/docwriter.js` — CLI launcher for packaged mode
- `bin/docwriter-dev.js` — dev launcher
- `src/hooks.server.ts` — SvelteKit startup hook; starts Hocuspocus
- `src/routes/+page.svelte` — app shell + render/review loop
- `src/lib/editor/TiptapEditor.svelte` — editor, feedback UI, idle timer
- `src/lib/yjs-doc.ts` — per-tab Y.Doc + HocuspocusProvider registry
- `src/lib/yjs-agent.ts` — client-side agent UndoManager + apply-key
- `src/lib/server/ydoc-registry.ts` — server per-tab Y.Doc + UndoManager
- `src/lib/server/ydoc-persistence.ts` — SQLite ↔ Y.Doc bridge, flush
- `src/lib/server/ws-server.ts` — Hocuspocus setup, `onChange` plumbing
- `src/lib/server/mcp-doc-tools.ts` — `edit_doc` / `read_doc` /
  `write_doc` custom MCP tools
- `src/lib/server/path-router.ts` — scratch vs. open-tab routing
- `src/lib/server/ydoc-markdown.ts` — Y.Doc ↔ markdown serializer
- `src/routes/api/render/+server.ts` — Claude Agent SDK orchestration
- `src/lib/server/document-io.ts` — rules / agentSettings meta I/O
- `src/lib/server/runtime-state.ts` — SQLite-backed runtime state
- `src/lib/server/workspace-path.ts` — sandboxing & symlink-safe resolver

## Bottom Line

DocWriter is a local multi-file writing environment with:

- per-tab CRDT editor state held authoritatively on the server and
  synced over WebSocket
- an append-only SQLite log of every Yjs update, origin-tagged
- a Claude Agent SDK loop that edits the live Y.Doc through custom MCP
  tools — no shadows, no 3-way merge, no post-hoc reconciliation
- a review queue whose entries are just items in a `Y.Map` inside the
  same Y.Doc
- `document.md` as a debounced backup for portability

Content convergence is the CRDT's job. Review, undo, and reject all
fall out of origin-tagged transactions on a single authoritative Y.Doc.
