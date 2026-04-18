# DocWriter Architecture

This document describes the runtime and persistence model of **DocWriter**: the Yjs-backed client state, agent reconciliation via the CRDT, and how user + agent edits merge deterministically.

## Overview

`DocWriter` is a plain-markdown writing editor with an AI side-channel. The user writes markdown in a Tiptap editor; the agent proposes edits that get merged into the live document via Yjs operations the user can review and Accept or Reject. The data model is flat — no atoms, no blocks, no pins — just markdown text.

The defining property of the architecture is:

> **The Y.Doc is the canonical editor state.** User edits and agent edits both flow into it as CRDT operations, which merge deterministically. Disk storage is a long-term backing store and the agent's I/O surface, not the source of truth.

## Persistence

All persistent state lives in two places: the project root for user-facing files, and a hidden `.docwriter/` directory for machine-managed metadata.

```
project-root/
  document.md                 ← user-facing ground truth
  .docwriter/
    agent.md                  ← agent's shadow copy during a render (transient)
    state.json                 ← { sessionId, rules, userEditRegions,
                                   agentSettings, recentActions, actionUsageCounts }
```

On the client, the canonical editor state is a `Y.Doc` persisted to IndexedDB via `y-indexeddb`. IndexedDB is rehydrated on every page load so user edits survive a refresh even if they haven't yet been pushed to the server. The review baseline and pre-agent snapshots used to live in their own markdown files on disk but are now carried inside the same Y.Doc (`getReviewMap()` in `yjs-doc.ts`), so y-indexeddb persists them for free — no server-side baseline/pre-agent files to maintain.

| Store | Role | Read/Written by |
| --- | --- | --- |
| `document.md` | User-facing markdown. Re-written by the editor's autosave debounce. | Editor autosave → `PUT /api/document`; accept path never copies agent.md over it (the Y.Doc is authoritative). |
| `.docwriter/agent.md` | Shadow copy the agent edits during a render. Required because the Claude Agent SDK's `Edit` tool performs direct filesystem I/O against a real path — there is no virtual filesystem hook. Deleted on accept/reject. | `/api/render` → Claude Agent SDK `Edit` tool; accept/reject unlink it. |
| `.docwriter/state.json` | Everything else the server needs to know: `sessionId` (SDK session resume), `rules`, `userEditRegions`, `agentSettings` (autonomy + trackChanges), `recentActions`, `actionUsageCounts`. | `/api/session`, `/api/render`, `/api/document` (meta PUT). |
| IndexedDB `docwriter-doc` | The actual Y.Doc binary state, persisted on every Yjs transaction by `y-indexeddb`. Also carries the review baseline and pre-agent snapshot inside a Y.Map. | Client-only. Rehydrates on every page load. |

`ensureDocWriterDir` in `src/lib/server/document-files.ts` creates `.docwriter/` on first access. No legacy migration code — that was stripped once the rename settled.

## Client State Model

### Y.Doc as canonical state

`src/lib/yjs-doc.ts` owns a single `Y.Doc` with one `XmlFragment` named `default`. `y-indexeddb` persists every transaction to browser IndexedDB. The Tiptap editor binds into that fragment via `@tiptap/extension-collaboration`, which internally adds:

- `ySyncPlugin` — the bidirectional Y.XmlFragment ↔ ProseMirror document sync.
- `yUndoPlugin` — ctrl-z / ctrl-y undo/redo scoped to user edits (tracks `ySyncPluginKey` origin).
- `undo` / `redo` commands bound to `Mod-z` / `Mod-y` / `Shift-Mod-z`.

Because Collaboration ships these, StarterKit's `undoRedo` is disabled — double-registering corrupts the plugin state.

### Stores

The Svelte stores in `src/lib/stores.ts` are thin projections of the Y.Doc for components that don't interact with the editor directly:

- `userMd: Writable<string>` — the current markdown projection of the Y.Doc. Updated after every user-originated editor update and consumed by the Outline pane, the render submit, and the server autosave.
- `reviewBaseline: Writable<string | null>` — snapshot of `userMd` at render start. When non-null, the diff overlay is active and the Outline pane shows the Accept/Reject card. On boot, it's rehydrated from the server's `agentBaseline` if a pending shadow still exists.
- `rules`, `userEditRegions`, `agentSettings` — metadata from `.docwriter/state.json`.
- `isRendering`, `submitCountdown`, `showHistory`, `editorFontScale`, `selectedModel`, `selectedTheme`, `recentActions`, `agentHistory` — UI and session state.

There is no canonical/projected split — the Y.Doc is the one source of truth and the stores are thin projections for components that don't interact with the editor directly.

### Editor boot sequence

```
1. +page.svelte onMount:
   1a. applyTheme, clamp isRendering=false for HMR safety
   1b. GET /api/document → populate userMd, rules, userEditRegions, and
       (if present) reviewBaseline from agentBaseline
   1c. docLoaded = true

2. TiptapEditor mounts (gated on docLoaded so userMd is available):
   2a. await whenYDocReady()    ← y-indexeddb hydration complete
   2b. if isYDocEmpty() → seedYDocFromMarkdown(userMd current)
        via prosemirrorJSONToYXmlFragment (one-time only)
   2c. new Editor({ extensions: collaborativeExtensions(ydoc, ...) })
   2d. userMd.set(getEditorMarkdown()), lastWrittenMd = same
   2e. updateDiff()     ← primes the DiffOverlay plugin
```

Step 2b is critical: per y-prosemirror docs, `prosemirrorJSONToYXmlFragment` must only run on an *empty* fragment, otherwise the existing history is wiped.

### Autosave and idle submit

`TiptapEditor.svelte:onEditorUpdate` handles every PM transaction. The guard order matters:

```
if (transaction.getMeta(ySyncPluginKey) !== undefined) return;
    ← Skip Yjs-sync transactions entirely. These include initial Y.Doc
      hydration (which fires before state has fully applied and would
      otherwise write '' to document.md), remote updates, and Collaboration's
      built-in undo/redo. Nothing should be written back to the server
      for these — the sending side already persisted.

userMd.set(md)
writeDebounceTimer = setTimeout(() => writeToDisk(md), 50)
    ← Debounced PUT /api/document with the new userMd

if (isAgentApplyInProgress()) return;
    ← applyAgentMarkdown dispatches a non-sync PM replace, so the block
      above runs (good — we want agent edits persisted). But it should NOT
      restart the idle countdown, otherwise every render would queue
      another one 10s later in a loop.

startCountdown(); idleTimer = setTimeout(submit, IDLE_MS)
```

## Agent Reconciliation

### The Problem

The Claude Agent SDK's `Edit` and `Write` tools hit the filesystem directly — there's no way to redirect them to a virtual FS or substitute a custom implementation (confirmed via the SDK hook docs). So the agent edits a real file, `.docwriter/agent.md`, and the client reconciles after the fact.

Naively, reconciliation could be `editor.commands.setContent(agentMd)`. The problem: that runs a whole-document PM replace. The sync plugin translates it into "tombstone every Y item, insert a new stream of items". Concurrent user ops still exist in the Y.Doc, but they end up linked to tombstones at unpredictable positions. The CRDT technically merges, the result looks like garbage.

### The Solution

`src/lib/yjs-agent.ts:applyAgentMarkdown` does a **targeted** replace:

```
1. parseMarkdownForEditor(editor, md):
     - run the headless editor's setContent to get schema-free PM JSON
     - rehydrate into a real PM node using the LIVE editor's schema
       via editor.schema.nodeFromJSON(json)
     (the schema-identity round-trip is mandatory — slices tied to a
      different schema instance silently corrupt the live view)

2. if liveDoc.eq(agentDoc) return;    ← fast path

3. start   = liveDoc.content.findDiffStart(agentDoc.content)
   diffEnd = liveDoc.content.findDiffEnd(agentDoc.content)
     (both are ProseMirror Fragment helpers that compute the minimal
      prefix/suffix that matches)

4. slice = agentDoc.slice(start, diffEnd.b)
   tr    = editor.state.tr.replace(start, diffEnd.a, slice)

5. ydoc.transact(() => editor.view.dispatch(tr), 'agent')
     (the agent origin lets the UndoManager track this specific write)
```

The sync plugin translates the minimal PM replace into minimal Yjs ops, scoped to only the bytes that actually differ. Any user ops that happened at positions outside `[start, end]` are never touched and survive byte-for-byte. User ops inside the replaced range get re-ordered by the CRDT per its normal semantics.

### Agent-origin UndoManager

A dedicated `Y.UndoManager` is created on the `XmlFragment` with `trackedOrigins: new Set(['agent'])` and `captureTimeout: 0`. Because agent applies are wrapped in `ydoc.transact(..., 'agent')` and user edits use the default origin (undefined), this undo manager's stack contains *only* agent transactions.

`undoAgentChanges()` calls `undoManager.undo()`:

- In the same session → rewinds the most recent agent apply, preserving any user ops that were interleaved.
- After a refresh → returns `false` (the undo manager was freshly created on page load and has no history). `rejectAgentEdit` in `+page.svelte` detects this and falls back to `applyAgentMarkdown(editor, baseline)` — replaying the baseline through the same targeted-replace path. User edits made during the render are lost in this fallback but edits made after the refresh survive (they're outside the diff range).

### Pending review state machine

```
Idle:      reviewBaseline = null. Editor is editable. No diff overlay.

Rendering: isRendering = true. Editor still editable (CRDT will merge).
           reviewBaseline captured at submit time.
           Server: resetAgentDoc copies document.md → agent.md (client owns the baseline)
                   startRender sets renderActive = true
                   PreToolUse hook syncs user deltas to agent.md before
                   each agent Edit via syncUserEditsToAgent (still useful:
                   lets the agent see the user's latest text).

Pending:   isRendering = false, reviewBaseline !== null.
           applyAgentMarkdown has merged the agent's result into the Y.Doc
           via a targeted PM replace. Diff overlay compares live doc
           against reviewBaseline and renders green/red decorations.
           Autosave has already pushed the merged markdown to document.md.

Accept:    writeReviewState(null, null). Server deletes agent.md
           and clears userEditRegions. document.md already has the merged
           content from autosave.

Reject:    undoAgentChanges() (same session) OR
           applyAgentMarkdown(baseline) (after refresh).
           writeReviewState(null, null). Server deletes agent.md.
```

## Diff Overlay

`src/lib/editor/diff-overlay.ts` is a custom Tiptap Extension with a single ProseMirror plugin that renders three decoration layers against the current editor state:

1. **Agent additions (green inline class)** — text that exists in the editor but not in `reviewBaseline`. Rendered as `Decoration.inline(from, to, { class: 'diff-added' })` on existing text nodes. No widgets, no duplicates.
2. **Agent removals (ghost widgets)** — text that existed in `reviewBaseline` but is no longer in the editor. Rendered as `Decoration.widget(pos, span, { side: -1 })` injecting a `<span class="diff-removed-widget">…</span>` at the position the text used to occupy.
3. **User edit regions (orange inline class)** — ranges from `userEditRegions` rendered with `class: 'diff-user-edit'`.

The diff is computed with `diffWords` (from the `diff` package) against flattened plain text, with a block-boundary-aware splitter so decorations never span across list items or paragraphs.

## Server Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/document` | `GET` | Returns `{ userMd, agentMd, agentBaseline, meta }`. `agentBaseline` is consumed by the client on boot to rehydrate `reviewBaseline`. |
| `/api/document` | `PUT` | `{ userMd?, meta? }`. Debounced autosave of the editor's current markdown and/or rules. |
| `/api/document` | `POST` | `{ action: 'accept' \| 'reject' }`. Deletes `.docwriter/agent.md`; on `accept` also clears `meta.userEditRegions`. Does **not** copy `agent.md` over `document.md` — the client's Y.Doc is authoritative. |
| `/api/render` | `POST` | Runs a single Claude Agent SDK `query()` against `.docwriter/agent.md`, streaming SSE events (`tool_call_start`, `tool_call`, `assistant_text`, `result`, `done`). The `result` event carries `agentMd` and `agentBaseline` for the client to apply. |
| `/api/history` | `GET` | Recent agent session messages via the SDK's `getSessionMessages`. Client caps the load to the last 12 to avoid pollution after many rounds. |
| `/api/session` | `GET` / `PUT` / `DELETE` | Runtime state: `sessionId`, `recentActions`, `actionUsageCounts`. |
| `/api/references` | `GET` | Lists markdown style references from the docwriter-style skill. |
| `/api/references/[filename]` | `GET` | Reads a specific style reference. |
| `/api/import-reference` | `POST` | Saves uploaded text as a new style reference. |

### Server-side render lifecycle

The server still runs the shadow-copy dance during a render because the Claude Agent SDK needs a real file:

1. `resetAgentDoc()` — copy `document.md` to `.docwriter/agent.md`. The review baseline lives on the client in the Y.Doc review map, so no server-side baseline file is written.
2. `startRender(currentMarkdown)` — set in-memory `renderActive = true`, seed `lastSyncedUserMd`.
3. Build prompt: rules, unified diff vs. `lastMarkdown` if provided, `[[ note ]]` directive handling.
4. Install PreToolUse hooks matching `Edit|Write` → `syncUserEditsToAgent`, which patches any post-snapshot user edits to `.docwriter/agent.md` so the agent sees the latest text.
5. `query()` with tools `Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Task` and `settingSources: ['project']` (loads the project's docwriter-style skill).
6. On stream end: final `syncUserEditsToAgent`, read `.docwriter/agent.md`, emit `result { agentMd }`, `endRender()`, `done`, close stream.

The client receives `agentMd` and feeds it into `applyAgentMarkdown`. The client never looks at `agentBaseline` during the render — it already captured its own `preRenderMd` at submit time. `agentBaseline` is only consumed on *refresh*, to rehydrate a pending review.

## Concurrency

```
User                      Server                     Agent (SDK)        Filesystem
 |                          |                              |                   |
 | POST /api/render         |                              |                   |
 |------------------------->|                              |                   |
 |                          | resetAgentDoc()              |                   |
 |                          |----------------------------->| copy md → agent.md
 |                          | startRender()                |                   |
 |                          | query(prompt, hooks)         |                   |
 |                          |----------------------------->|                   |
 |                          |                              |                   |
 | keep typing              |                              |                   |
 | Y.Doc transaction        |                              |                   |
 | → ySyncPlugin → Y ops    |                              |                   |
 | → y-indexeddb persist    |                              |                   |
 | → onUpdate → writeToDisk |                              |                   |
 |------------------------->| writeUserDoc('…')            |                   |
 |                          |----------------------------->|---> document.md  |
 |                          | (renderActive, skip sync)    |                   |
 |                          |                              |                   |
 |                          |                              | Edit tool call    |
 |                          | PreToolUse hook              |                   |
 |                          | syncUserEditsToAgent()       |                   |
 |                          |----------------------------->|---> patch agent.md|
 |                          |                              | writes agent.md   |
 |                          |                              |------------------>|
 |                          |                              |                   |
 |                          | stream ends                  |                   |
 |                          | final sync                   |                   |
 |                          | SSE result { agentMd,        |                   |
 |<-------------------------|               agentBaseline} |                   |
 |                          | endRender()                  |                   |
 |                          |                              |                   |
 | applyAgentMarkdown       |                              |                   |
 | ydoc.transact('agent')   |                              |                   |
 |   → targeted PM replace  |                              |                   |
 |   → sync plugin → Y ops  |                              |                   |
 |   → CRDT merge with      |                              |                   |
 |     concurrent user ops  |                              |                   |
 | reviewBaseline set       |                              |                   |
 | Diff overlay renders     |                              |                   |
 |                          |                              |                   |
 | Accept or Reject         |                              |                   |
 | POST /api/document       |                              |                   |
 |------------------------->| acceptAgentDoc /             |                   |
 |                          |   rejectAgentDoc             |                   |
 |                          | (delete agent.md + baseline) |                   |
```

### Why there's no mutex

- User writes target `document.md`. Agent writes target `.docwriter/agent.md`. Two different files.
- Both files are written atomically via `writeTextAtomic` (tmp-file plus rename).
- The in-memory `renderActive` flag (in `document-lock.ts`) only gates one thing: whether `writeUserDoc` also mirrors into `agent.md` eagerly, or defers to the render endpoint's PreToolUse hook.
- Client-side conflict resolution is the Yjs CRDT, not a hand-written patch apply. The CRDT is what makes concurrent user and agent ops merge deterministically.

## Key Source Files

### Server

- `src/lib/server/document-files.ts` — file paths and `ensureDocWriterDir()` migration.
- `src/lib/server/document-io.ts` — `readUserDoc` / `writeUserDoc` / `readMeta` / `writeMeta` / `resetAgentDoc` / `acceptAgentDoc` / `rejectAgentDoc` / `syncUserEditsToAgent`.
- `src/lib/server/document-lock.ts` — `renderActive` flag and `lastSyncedUserMd` memo.
- `src/lib/server/runtime-state.ts` — `sessionId`, `recentActions`, `actionUsageCounts` in `.docwriter/state.json`.
- `src/lib/server/file-utils.ts` — `writeTextAtomic`, `writeJsonAtomic`.
- `src/routes/api/render/+server.ts` — prompt builder, PreToolUse hook, SSE stream.
- `src/routes/api/document/+server.ts` — `GET` / `PUT` / `POST` handlers.

### Client

- `src/routes/+page.svelte` — layout, store hydration, render submission, accept/reject, refresh-restore of `reviewBaseline`.
- `src/lib/stores.ts` — `userMd`, `reviewBaseline`, `rules`, `userEditRegions`, UI and session stores.
- `src/lib/yjs-doc.ts` — Y.Doc singleton with `y-indexeddb` persistence.
- `src/lib/yjs-markdown.ts` — `markdownToPMJson` + `seedYDocFromMarkdown` for one-time Y.Doc initialization from `document.md`.
- `src/lib/yjs-agent.ts` — `applyAgentMarkdown`, `undoAgentChanges`, agent-origin `Y.UndoManager`.
- `src/lib/editor-extensions.ts` — shared `baseExtensions()` and `collaborativeExtensions(ydoc)`.
- `src/lib/editor/TiptapEditor.svelte` — the Tiptap + Collaboration editor, `onEditorUpdate` guards, idle countdown.
- `src/lib/editor/diff-overlay.ts` — the three-layer decoration plugin (inline class for additions and user regions; widget for removals).
- `src/lib/components/OutlinePane.svelte` — TOC + pending-edit card + `diffLines`-driven summary.
- `src/lib/components/HistoryPane.svelte` — agent activity log.
- `src/lib/components/ActionToolbar.svelte` — selection feedback popup.
- `src/lib/components/RulesPanel.svelte` — rules editor.
- `src/lib/diff.ts` — `wordDiff`, `unifiedLineDiff`, `markdownToPlainText`.

## Follow-ups

- **Concurrent-edit stress testing.** The CRDT merge path works for simple cases; heavy concurrent typing during a render hasn't been stress-tested.
- **Pending-review persistence after refresh** works via a pre-agent snapshot captured right before `applyAgentMarkdown` dispatches and stored in the Y.Doc review map (IndexedDB-persisted). Reject-after-refresh replays that snapshot via the same targeted-replace path, so user edits made during the original render also survive the reject.
- **Agent behavior settings** — `AgentSettings` in `src/lib/types.ts`, persisted in `state.json` via `getAgentSettings`/`setAgentSettings`. The `agency` field (`conservative`/`balanced`/`aggressive`) rewires the prompt via `agencyGuidance()` in `/api/render`; the `trackChanges` field picks whether the agent's Yjs ops are wrapped in an `'agent'` origin (review mode) or left at the default origin (silent merge). Edited via the `AgentDock` popover in the top-right.
- **Schema migration.** If we add new node types later (tables, images), existing Y.Docs would need migration.
- **y-indexeddb compaction** is automatic after `PREFERRED_TRIM_SIZE = 500` updates, so Y.Doc growth is bounded.
