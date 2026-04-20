# DocWriter Architecture

DocWriter is a local writing environment built as:

- a CLI launcher (`bin/docwriter.js`, `bin/docwriter-dev.js`)
- a SvelteKit web app (`src/routes/+page.svelte`)
- a Yjs-backed editor runtime (per-tab `Y.Doc`s, persisted in IndexedDB)
- a filesystem-backed agent loop (Claude Agent SDK editing shadow files under `.docwriter/agent/`)

The current architecture is organized around one idea:

> The user edits a live CRDT document in the browser, while the agent works against filesystem shadows. The app reconciles the agent output back into the live document in a reviewable, conflict-aware way.

## System At A Glance

```text
CLI
  -> sets DOCWRITER_ROOT, PORT, model/auth defaults
  -> launches built SvelteKit server or Vite dev server

Browser
  -> Svelte page shell
  -> Tiptap editor
  -> per-tab Y.Doc + IndexedDB persistence
  -> review UI, file tree, agent history, hooks/rules panels

Server
  -> /api/document, /api/tabs, /api/files, /api/file-content
  -> /api/render streaming SSE
  -> /api/history, /api/session, /api/hooks, /api/references, /api/live, /api/ask-user-reply

Agent runtime
  -> Claude Agent SDK query()
  -> reads workspace files
  -> edits only .docwriter/agent/<tabId> shadows and .docwriter/agent/scratch/
  -> emits tool/status/progress events back to the UI
```

## Runtime Topology

### 1. Launch modes

DocWriter has two entrypoints:

- `bin/docwriter.js`
  Starts the built app, picks a port, sets `DOCWRITER_ROOT`, and optionally enables `--watch`, `--new-session`, and model/API-key overrides.
- `bin/docwriter-dev.js`
  Starts Vite directly against another workspace for live UI development.

In both modes, the app is pointed at an arbitrary workspace root via `DOCWRITER_ROOT`. The editor repo is just the application source; the actual writing happens in some other folder.

### 2. Workspace model

The app treats any workspace-relative text file as a potential tab.

- Markdown-like files (`.md`, `.markdown`, `.mdx`) use the markdown editor mode.
- Other recognized text extensions (`.txt`, `.json`, `.py`, `.html`, `.asciidoc`-style plain text via the plain mode path, etc.) use plain-text mode.

Tabs are stored in `.docwriter/state.json` as an ordered list plus an active tab pointer. They are not discovered by scanning a special `notes/` directory anymore.

## Persistence Layers

DocWriter persists state across three separate layers, each with a different job.

### 1. Workspace files

These are the actual user-facing files under the chosen workspace root.

Examples:

```text
workspace/
  ch12.asciidoc
  draft/intro.md
  scripts/cleanup.py
```

These files are the durable project content. The editor autosaves to them through `/api/document` or `/api/file-content`.

### 2. `.docwriter/`

This directory holds machine-managed runtime state:

```text
.docwriter/
  state.json
  references.json
  references/
  agent/
    <tab-relative-path>
    scratch/
```

- `state.json`
  Stores session metadata and app-level runtime state:
  - Claude SDK `sessionId`
  - `recentActions`
  - `actionUsageCounts`
  - `rules`
  - `agentSettings`
  - `tabs.order` and `tabs.active`

- `references.json`
  Stores user-curated style references. Each entry points at either:
  - a workspace-relative file path
  - a saved sample under `.docwriter/references/`
  - an external URL

- `.docwriter/references/`
  Optional saved writing samples created from pasted text in the UI. These are not inlined into the agent prompt; the prompt only lists them as available references the agent may read if useful.

- `.docwriter/agent/<tabId>`
  Per-tab shadow files that the agent can `Edit` and `Write`. These mirror the real workspace file paths.

- `.docwriter/agent/scratch/`
  Session-scoped scratch space for the agent’s own drafts and notes. It is writable by the agent but not surfaced as user tabs. It is wiped on “New session”.

### 3. IndexedDB + Yjs

The browser keeps a separate `Y.Doc` for each open tab. Each tab doc is persisted to IndexedDB via `y-indexeddb`.

Each per-tab `Y.Doc` contains:

- an `XmlFragment` named `default`
  - the actual editor content
- a `Y.Map` named `review`
  - review metadata such as `pendingRounds`, plus legacy compatibility fields like `baseline` and `preAgent`

This means:

- content survives reloads without waiting for the server
- review state also survives reloads
- switching tabs preserves per-tab undo/history state

## Client Architecture

The page shell lives in `src/routes/+page.svelte`. It orchestrates:

- theme setup
- tab loading and switching
- editor mount/remount per tab
- file tree state
- writing references panel state
- rule/hook/session settings panels
- the streaming render loop
- review accept/reject/retry flows
- agent history hydration and live updates

### Main UI regions

The current UI is split into:

- left sidebar
  - outline
  - files tree
- center
  - tab strip
  - editor
- right sidebar
  - agent history
  - pending review/rules/questions
- floating agent dock
  - wake button
  - cost
  - send-message popover

### Important Svelte components

- `src/lib/editor/TiptapEditor.svelte`
  The editor surface, autosave loop, idle-submit timer, feedback popup, and diff overlay integration.
- `src/lib/components/FileTree.svelte`
  Workspace explorer with inline create/rename interactions.
- `src/lib/components/OutlinePane.svelte`
  Outline plus review cards, proposed rules, hooks, and user questions.
- `src/lib/components/HistoryPane.svelte`
  Agent history, notifications, tool calls, thinking summaries, annotations.
- `src/lib/components/AgentDock.svelte`
  Wake button, cost pill, and direct-message popover.

### Stores

`src/lib/stores.ts` holds the app-level reactive state.

The important split is:

- document projections
  - `userMd`
  - `reviewBaseline`
  - `pendingReviewRounds`
  - `preAgentSnapshot`
- agent/review UI
  - `proposedRules`
  - `proposedHooks`
  - `pendingUserQuestions`
  - `agentHistory`
  - `annotations`
- preferences/session
  - `selectedModel`
  - `selectedTheme`
  - `historyVerbosity`
  - `showFilesPane`
  - `agentSettings`
  - `sessionCost`
- tab state
  - `tabs`
  - `activeTab`
  - `activeTabKind`

These stores are projections or UI wrappers around the real content state. The editor itself still lives in Yjs.

## Per-Tab Editor Model

`src/lib/yjs-doc.ts` manages a registry of per-tab documents.

For each tab:

- `getYDocForTab(tabId)` creates or reuses a `Y.Doc`
- IndexedDB hydration runs once and exposes a `readyPromise`
- `setCurrentTab(tabId)` switches which doc the live editor uses
- `destroyTab(tabId)` clears both in-memory and IndexedDB state for deleted tabs
- `renameTab(oldId, newId)` migrates the tab’s persisted Yjs state to the new key

This is a notable architectural change from older single-document versions: DocWriter is now a multi-tab workspace editor, not a one-document note pad.

## Editor Update Loop

`TiptapEditor.svelte` handles every ProseMirror update.

The important order is:

1. Ignore Yjs sync-originated transactions.
2. Serialize editor content back to markdown/plain text.
3. Update `userMd`.
4. Debounce a disk write via `PUT /api/document`.
5. If the update came from an agent apply, do not restart idle submit.
6. If it was a real user edit, record recent edit ranges.
7. Restart the idle countdown.
8. On timeout, call `submit()`.

This gives DocWriter its “just keep writing, agent wakes up after a pause” behavior.

## Agent Render Pipeline

The server-side render flow lives in `src/routes/api/render/+server.ts`.

### Prompt construction

The render endpoint:

- reads the active workspace tabs from state
- reads current user documents
- injects persistent writing rules
- lists available style references from `.docwriter/references.json`
- injects agent behavior settings (`conservative`, `balanced`, `aggressive`)
- includes diffs vs the last agent-seen snapshot when available
- exposes MCP tools for:
  - `propose_rule`
  - `propose_hook`

The prompt is multi-file. The active tab is marked, but the agent can edit multiple open tabs in one round.

Style references are intentionally lightweight:

- the prompt lists paths and URLs, not full sample contents
- the agent can choose to read those paths if they are actually relevant
- pasted samples are saved as normal files under `.docwriter/references/`, so they remain inspectable instead of being hidden inside a skill bundle

### Filesystem strategy

The Claude Agent SDK still edits real files, so the app cannot point it directly at the in-memory Yjs documents.

Instead:

1. Before each render, the server reads the existing `.docwriter/agent/<tabId>` shadow as the previous "last agent view".
2. `resetAllAgentDocs()` then copies each open tab into `.docwriter/agent/<tabId>` to give the SDK a fresh starting point for this round.
3. The SDK runs against those shadows.
4. Pre-tool hooks sync any late user edits from the real file into the shadow before each agent `Edit`/`Write`.
5. On completion, the server emits the final shadow contents back to the browser over SSE.

Shadows now outlive review. Accepting or rejecting an edit does not delete the shadow; it remains the baseline for the next render's "what changed since the agent last touched this file?" diff. Only New Session, tab close/delete, or tab rename cleanup removes or moves it.

### SSE stream

The browser receives a live stream of:

- tool-call starts and resolved tool inputs
- assistant text
- assistant thinking deltas
- SDK status/notifications
- task/subagent lifecycle events
- tool progress
- incremental agent applies
- rule proposals
- hook proposals
- ask-user questions
- per-round cost
- final render result

That stream drives both the visible history pane and the live review/apply behavior.

## Reconciliation And Review Model

This is the core of the app.

### Why reconciliation exists

The user edits the live Yjs document.

The agent edits filesystem shadows.

DocWriter has to merge those worlds back together without:

- wiping live user edits
- losing reviewability
- turning every render into a full-document replace

### Apply path

`src/lib/yjs-agent.ts` owns the apply path.

It:

1. Parses the incoming agent text into ProseMirror JSON.
2. Rehydrates it into the active schema.
3. Computes the minimal changed range.
4. Dispatches a targeted `replace(...)` transaction.
5. Wraps the transaction in a Yjs transaction with origin:
   - `agent` when track-changes is on
   - `ySyncPluginKey` when silent merge mode is on

So the app still uses CRDTs. The difference is that the CRDT now receives a carefully prepared merged document, not a blind overwrite.

### 3-way merge for overlap safety

The newer overlap-safe path lives in `src/lib/three-way-merge.ts`.

For each apply, the app compares:

- `base`
  The document snapshot from render start (or from the previous incremental agent shadow step).
- `current`
  The user’s current live document.
- `agent`
  The latest agent-proposed shadow content.

Then it:

- applies non-overlapping agent hunks into the current user document
- skips overlapping hunks when the user edited the same base range
- returns:
  - merged text
  - how many hunks were applied
  - how many conflicts were skipped

This prevents the agent from silently overwriting user typing in the same paragraph.

### Conflict handling

If overlapping edits are skipped:

- the app surfaces a history notification
- it queues one automatic retry against the new document state
- the retry is marked internally so it does not loop forever

This is intentionally app-level conflict policy. Yjs still handles structural convergence; the 3-way merge decides what content should be applied.

### Review rounds

When track-changes mode is on:

- each successful agent apply becomes a `PendingReviewRound`
- rounds are stored per tab in the tab’s Yjs review map
- the UI shows one review card per round
- the diff overlay composes all pending rounds against the earliest baseline

Each round records:

- `beforeMd`
- `afterMd`
- trigger
- timestamp
- round size classification (`tiny` vs `big`)
- `stepCount`

`stepCount` matters because a single render can contain:

- multiple streaming `incremental_apply` edits
- one final result apply

Reject needs to know how many Yjs undo steps belong to that round.

### Accept / reject

- Accept
  - removes the round(s)
  - leaves the merged content in the live Yjs doc
  - deletes the shadow file on the server

- Reject
  - uses a dedicated `Y.UndoManager` that tracks only agent-origin transactions
  - rewinds just the agent edits when still in the same session
  - falls back to re-applying the round baseline if the undo stack is gone after refresh

This is what makes “review mode” a real state machine instead of a visual diff only.

## Feedback And Annotation Model

Text selection in the editor can open a feedback popup.

That flow now supports:

- pinned quick feedback
- custom feedback text
- LRU recent feedback labels
- persistent submitted highlights
- hover popovers showing the submitted note

Submitted feedback becomes a transient annotation tied to:

- tab id
- excerpt
- comment
- ProseMirror range
- timestamp

Those highlights stay visible until an actual agent edit lands for that file, at which point they are cleared.

## Agent History Model

The history pane is not just a chat log. It is a unified event stream over:

- user submissions
- assistant text
- assistant thinking summaries
- tool calls
- tool progress
- task/subagent lifecycle
- hook executions
- retry/conflict notifications
- annotations

The app can restore prior history from the Claude SDK transcript using `/api/history`.

There are two display modes:

- `verbose`
  - full loop trace
- `minimal`
  - mostly user actions, actual edits, and end-state events

## File And Workspace APIs

### `/api/tabs`

Manages open tabs:

- `GET`
  - returns ordered/open tabs and active tab
- `POST`
  - opens or creates a tab
- `PATCH`
  - focus or rename a tab
- `DELETE`
  - close or optionally delete a file

### `/api/document`

Per-tab editor persistence:

- `GET`
  - current file content + meta
- `PUT`
  - autosave editor content and/or metadata
- `POST`
  - accept/reject cleanup for agent shadows

### `/api/files`

Workspace file tree:

- safe directory listing
- create file/folder
- rename/move
- delete

### `/api/file-content`

Raw arbitrary file read/write for plain file viewing outside the tab-specific editor path.

### `/api/session`

Session lifecycle:

- read session id and recent feedback actions
- persist recent actions / usage counts
- clear session-scoped state on “New session”

### `/api/hooks`

Reads/writes hook configuration.

### `/api/live`

Used by `--watch` to notify the browser of external file changes.

### `/api/ask-user-reply`

Feeds answers back into a blocked Claude `AskUserQuestion` flow.

## Workspace Safety Model

`src/lib/server/workspace-path.ts` enforces that file operations stay inside the workspace root.

The important detail is that it resolves through the nearest existing real ancestor, which means:

- path traversal with `..` is blocked
- symlink escapes are blocked even when the final file does not exist yet

This protection is used by file APIs so writes like `linked/new.txt` cannot escape the workspace through a symlinked directory.

## Hook Architecture

Hooks are persisted separately from general runtime state.

The agent cannot edit hook config directly. Instead it proposes hooks through the `propose_hook` MCP tool, and the user reviews them in the sidebar.

When accepted, hooks are written through `/api/hooks` and then participate in later agent runs.

This keeps automation powerful without giving the agent silent authority to mutate its own execution policy.

## Design Principles In The Current Architecture

### 1. User edits must not be lost

This drives:

- per-tab Yjs docs
- agent-origin undo isolation
- 3-way merge on apply
- overlap skip + retry instead of overwrite

### 2. Agent work must remain reviewable

This drives:

- per-tab shadows
- pending review rounds
- diff overlay
- explicit accept/reject state

### 3. The app should work against a real folder, not a fake sandbox project

This drives:

- workspace-relative tabs
- filesystem-backed APIs
- file tree and raw file endpoints
- CLI root selection

### 4. Local-first editing should survive refreshes

This drives:

- per-tab IndexedDB persistence
- history/session restoration
- Yjs review metadata stored in the tab doc itself

## Key Files

If you want the shortest accurate map of the app, read these first:

- `bin/docwriter.js`
  CLI launcher for packaged mode
- `bin/docwriter-dev.js`
  dev launcher for watch mode against another workspace
- `src/routes/+page.svelte`
  the main application shell and render/review loop
- `src/lib/editor/TiptapEditor.svelte`
  editor behavior, autosave, feedback popup, diff integration
- `src/lib/yjs-doc.ts`
  per-tab Yjs + IndexedDB registry
- `src/lib/yjs-agent.ts`
  agent apply / undo path
- `src/lib/three-way-merge.ts`
  overlap-safe merge policy
- `src/routes/api/render/+server.ts`
  Claude Agent SDK orchestration and SSE stream
- `src/lib/server/document-io.ts`
  server-side file and shadow synchronization
- `src/lib/server/runtime-state.ts`
  `.docwriter/state.json` model

## Bottom Line

DocWriter is no longer “a markdown editor with an AI button.”

It is a local, multi-file writing environment with:

- per-tab CRDT-backed editor state
- a filesystem-based agent shadow workspace
- a streaming agent loop
- a review queue
- conflict-aware merge logic that favors the user’s live edits

That architecture is what lets the app feel interactive and forgiving while still using the Claude Agent SDK’s real file-edit tools under the hood.
