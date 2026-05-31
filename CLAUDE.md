# CLAUDE.md

Guidance for Claude Code when working on **DocWriter**.

## Commands

```bash
# Requires Node 22+ (use `nvm use 22` if needed)
npm run dev          # Start Vite dev server (hot reload)
npm run build        # Production build
npm run check        # TypeScript + Svelte type checking
npm run check:watch  # Watch mode type checking
```

No test framework is configured. Use `npm run check` for validation.

## What DocWriter is

A plain-markdown writing editor with an AI side-channel. The user writes
markdown in a Tiptap editor. The editor state for every open tab is a CRDT
(Yjs `Y.Doc`) whose authoritative copy lives on the **server**; the browser
is a synced client. An agent proposes edits through custom MCP tools by
appending a `PendingReviewRound` to the server Y.Doc's review array; the
document content itself changes only when the user accepts that round.
Every Yjs update reaches the browser over a WebSocket and appears in the
UI as a reviewable round. The data model is flat markdown — no atoms, no
blocks, no pins.

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
  document.md          ← user-facing markdown (flushed from the server
                         Y.Doc on a 500ms tick; git-friendly)
  drafts/chapter-1.md  ← any workspace file can be an open tab
  .docwriter/
    docwriter.db       ← SQLite: yjs_updates, tabs, rules, hooks,
                         recent_actions, action_usage_counts, kv
                         (sessionId, last_seen:<tabId>, etc.)
    state.json         ← JSON mirror of rules / agent settings / tabs
                         (dual-written for portability)
    agent/scratch/     ← agent scratch workspace (lazy-created on first
                         scratch write; cleared on "New session")
```

No per-tab shadows (`.docwriter/agent/<tabId>`), no IndexedDB, no
in-browser persistence. A fresh browser paints only after the WebSocket's
first `synced` event — on localhost this is sub-20ms.

## Three-pane layout

- **Left (`OutlinePane`, 260px):** auto-generated TOC from headings only
  (`showOutline`), with the `FileTree` below it.
- **Center:** Tiptap editor + `AgentDock` in the top-right (Wake up button,
  sleeping-cat mascot, gear-icon settings popover).
- **Right (340px, toggleable):** `HistoryPane` (agent tool-call log) on top,
  and a second `OutlinePane` instance (`showReview`) below it holding the
  pending-edit cards with Accept / Reject / Retry, unread comments, and
  proposed rules / hooks.

`OutlinePane` is one component reused twice: `showOutline={true}
showReview={false}` for the left TOC, and `showOutline={false}
showReview={true}` for the right pending-review sidebar. The pending-edit
cards live in the **right** column, not the left.

## Agent SDK integration

`/api/render` streams a single `query()` call over SSE:

1. Build a multi-tab prompt:
   - Every tab: header (path + active marker) + diff vs `kv['last_seen:<tabId>']` if it changed, else "unchanged" note. No tab content is ever inlined; the agent calls `read_doc(path)` on demand.
   - First-render tab (no `last_seen`): path only — agent must `read_doc` to see content.
   Agency guidance (`conservative` / `balanced` / `aggressive`) rewires
   the "how to decide whether to edit" section.
2. `query()` runs with two MCP servers:
   - `docwriter` — `propose_rule` / `propose_hook` (user-review tools).
   - `docwriter-doc` — `edit_doc` / `read_doc` / `write_doc` on tab paths;
     these route scratch paths to plain filesystem I/O and tab paths to
     `DirectConnection.transact` against the live Hocuspocus document.
   Built-in `Edit` / `Write` / `Read` remain available for files outside
   the open-tab set; the prompt explicitly routes open-tab work through
   the custom tools.
3. Agent calls `edit_doc`: `runTabWrite` opens a `DirectConnection`,
   confirms the single `old_string` match against the current
   review-aware text, then in one `document.transact(..., AGENT_ORIGIN)`
   pushes a new `PendingReviewRound` onto the tab's `Y.Array('rounds')`.
   The round stores the `{ oldString, newString }` operation — it does
   NOT mutate the content fragment. The document text changes only later,
   on Accept (see "Agent reconciliation").
4. Hocuspocus syncs that update to every connected browser over
   WebSocket. The review card appears next to the Tiptap cursor; the
   underlying paragraphs are untouched until the user accepts.
5. SSE stream emits `tool_call_start`, `tool_call`, `assistant_text`,
   `result` — drives the HistoryPane. The `result` event does NOT carry
   markdown anymore; there's nothing to apply on the client.
6. After render completes, update `kv['last_seen:<tabId>']` to the current
   markdown for every tab the agent saw, so the next render's diff block
   reflects what changed since.

## Agent reconciliation

There is none — in the old sense. Agent edits flow as CRDT ops directly
through the live Hocuspocus document; the browser receives them like any
other remote update. No client-side 3-way merge, no clone-and-diff, no
rolling baselines. User keystrokes typed during a render converge with
agent ops via Yjs's item-level CRDT merge.

On the server, the per-tab Y.Doc + `Y.UndoManager` (tracking
`AGENT_ORIGIN` only) lives on the Hocuspocus Document (see
`ws-server.ts`). Reject removes the round from the review `Y.Array`;
the doc fragment isn't touched. Accept walks each accepted round and
applies its `edit` op via `applyEditToFragment` (in `ydoc-codec.ts`),
which deletes + reinserts only the paragraphs the edit covers. `write`
ops fall back to wholesale `replaceYDocText`. Both paths run in a single
`ydoc.transact(..., USER_ORIGIN)` along with the `reviewArr.delete`.

Because Accept's blast radius is bounded to the affected paragraphs,
the client doesn't need to disconnect + remount the editor to avoid
clobbering concurrent typing — the Yjs sync delivers the surgical
update over the existing WebSocket and ProseMirror re-renders only the
touched range. `acceptAgentEdit` / `rejectAgentEdit` in `+page.svelte`
just POST to `/api/document` and let the sync handle the UI update.

`src/lib/yjs-doc.ts` on the client owns the per-tab `Y.Doc` + provider
registry and the accept/reject plumbing: `pauseTabSync` disconnects the
provider for the duration of an accept/reject so the server's broadcast
can't race the HTTP response, and `applyUpdateToTab` applies the
server's returned delta locally with `USER_ORIGIN` so it lands as a real
editor undo-stack item. The editor's own undo lives in
`src/lib/editor-extensions.ts`: a `Y.UndoManager([fragment, reviewArray])`
whose `trackedOrigins` are `{ ySyncPluginKey, USER_ORIGIN }` — note this
is a DIFFERENT tracked set than the server's UndoManager (which tracks
`AGENT_ORIGIN`). The client UndoManager scoping both the fragment and the
review array is what lets ctrl+z after Accept resurrect the just-removed
review card.

## Agent settings

`AgentSettings` in `src/lib/types.ts`, persisted to `.docwriter/state.json`
(JSON mirror) and dual-written into the SQLite `kv` / rules tables:
- **autonomy** (`agency: 'conservative' | 'balanced' | 'aggressive'`) —
  prompt rewiring.
- **trackChanges** — review mode on/off. (Note: the edit path
  `runTabWrite` does not currently read this flag — agent edits always
  land as `PendingReviewRound`s regardless. The setting gates how the
  client surfaces rounds, not whether they're created. There is no
  silent-merge / auto-accept path in the code today.)
- **muted** — agent edits still land in the pending-review array, but the
  editor's inline diff overlay stays hidden until the user clicks a
  pending card.

Edited via the `AgentDock` settings popover (click the gear icon pinned to
the mascot card).

## Conventions

- **Svelte 5 runes** (`$state`, `$derived`, `$effect`) in components.
  Stores are subscribed manually with `.subscribe()`, not `$store` syntax.
- **Font:** Lora (serif) for editor prose, Inter for UI.
- **Model selection:** Opus / Sonnet / Haiku, passed as `model` in request
  bodies.
- **Timing:** 3s idle countdown to auto-submit, 500ms global
  markdown-flush tick on the server (`FLUSH_TICK_MS` in
  `ydoc-persistence.ts`), Cmd/Ctrl+Enter skips the countdown.
- **Origin constants are the single source of truth in
  `src/lib/shared/ydoc-codec.ts`** — `AGENT_ORIGIN = 'agent'`,
  `USER_ORIGIN = 'user'`, `SYSTEM_ORIGIN = 'system'` — imported by both
  client (`yjs-doc.ts`, `editor-extensions.ts`) and server
  (`ws-server.ts`, `ydoc-persistence.ts`). Because they're imported, not
  re-declared, they can't drift; the server UndoManager matches
  `AGENT_ORIGIN` by string equality across the WebSocket boundary.

## Gotchas

- **`globalThis.__docwriterWsServer` singleton.** Vite HMR re-executes
  `hooks.server.ts` on save; the module-scope guard keeps us from
  double-binding the Hocuspocus port (`ECONNREFUSED`-via-reconnect). The
  live server instance is also how route handlers (`mcp-doc-tools.ts`,
  `/api/document`'s flush path) reach `openDirectConnection`.
- **`yjs_updates.payload` column.** The blob column holding raw Yjs
  updates is named `payload`. (Historical: it was originally named
  `update`, a SQLite reserved word; migration v2 renamed it. Don't
  revive the old name.)
- **`AGENT_ORIGIN` must agree across the WebSocket boundary.** The server
  sets `AGENT_ORIGIN` on `DirectConnection.transact`; the update streams
  to the browser as a Yjs origin string; the server's per-doc
  UndoManager matches it by string equality. Both sides import the
  constant from `ydoc-codec.ts`, so the only way to break this is to edit
  that one definition.
- **Hocuspocus's internal Document is authoritative.** `onLoadDocument`
  hydrates Hocuspocus's own `Document` (from SQLite via
  `replayUpdatesInto`, or from the cold-start registry doc in
  `yjs-doc.ts`). Once a client has connected, any throwaway/registry
  Y.Doc goes stale. Server code that wants to mutate a tab MUST go
  through `server.hocuspocus.openDirectConnection(tabId)` (see
  `getHocuspocus()` in `mcp-doc-tools.ts` and `withLiveDoc` in
  `ws-server.ts`) — never a freshly replayed Y.Doc.
- **Server UndoManager is currently vestigial.** `ws-server.ts` builds
  one `Y.UndoManager` per live Document (`ensureUndoManager`, tracking
  `AGENT_ORIGIN`, constructed BEFORE `replayUpdatesInto` so replayed
  agent transactions would repopulate its stack). But **no server code
  calls `.undo()`/`.redo()`** — Reject is a plain `reviewArr.delete`
  under `USER_ORIGIN` (`rejectTabRounds`), and Accept applies the op +
  deletes the round, also under `USER_ORIGIN`. The construction-order
  invariant is kept for safety/future use, but breaking it no longer
  affects Reject. Don't add server-side undo back without re-checking
  this. Client-side ctrl+z is a separate mechanism (the editor's
  `Y.UndoManager` in `editor-extensions.ts`).
- **No markdown parser in the editor pipeline.** The editor uses a
  minimal plain-text extension set (`Document`, `Paragraph`, `Text`,
  `HardBreak`, `Placeholder`, `Collaboration`) — see
  `editor-extensions.ts`. There is NO `tiptap-markdown` and NO
  `StarterKit`. `# Heading` shows as literal `# Heading`, and the Y.Doc
  serializes byte-identically to disk (`serializeYDoc` in
  `ydoc-codec.ts` is paragraph-per-line plain text). So `read_doc`
  returns the raw source and `edit_doc`'s `old_string` matches it
  verbatim — no backslash-escaping of brackets to worry about. (The old
  "tiptap-markdown ate my backslash" / "big edit half-landed" failure
  modes were artifacts of a markdown round-trip that no longer exists.)
- **Collaboration owns undo; don't add another undo plugin.** The
  Collaboration extension is wired with a custom `Y.UndoManager` via
  `yUndoOptions`. There is no StarterKit, so there's no `undoRedo: false`
  to set and no bundled `Link` — if you need links or other marks, add
  the individual Tiptap extensions explicitly.
