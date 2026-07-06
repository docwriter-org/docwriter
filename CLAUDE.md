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

## Layout

- **Left (`OutlinePane`, 260px):** auto-generated TOC from headings only
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

`src/lib/yjs-agent.ts` on the client keeps a minimal mirror: a per-tab
UndoManager (same tracked-origin set) so Reject can be local-first
without round-tripping through the server, plus the `AGENT_APPLY_KEY`
ProseMirror plugin key used by the editor update handler to distinguish
agent-origin transactions from user typing.

## Agent settings

`AgentSettings` in `src/lib/types.ts`, persisted to `.docwriter/state.json`
(JSON mirror) and dual-written into the SQLite `kv` / rules tables:
- **autonomy** (`agency: 'conservative' | 'balanced' | 'aggressive'`) —
  prompt rewiring.
- **trackChanges** — review mode on/off. (Track-changes off bypasses the
  pending-round UI; edits still flow through `AGENT_ORIGIN` so Undo
  continues to isolate them.)

Edited via the `AgentDock` settings popover (click the gear icon pinned to
the mascot card).

## Conventions

- **Svelte 5 runes** (`$state`, `$derived`, `$effect`) in components.
  Stores are subscribed manually with `.subscribe()`, not `$store` syntax.
- **Font:** Lora (serif) for editor prose, Inter for UI.
- **Model selection:** Opus / Sonnet / Haiku, passed as `model` in request
  bodies.
- **Timing:** 3s idle countdown to auto-submit, 1s markdown-flush debounce
  on the server, Cmd/Ctrl+Enter skips the countdown.
- **Origin constants must match:** `AGENT_ORIGIN = 'agent'` in
  `src/lib/yjs-agent.ts` (client) and `src/lib/server/ydoc-registry.ts`
  (server). Any drift and the UndoManager stops recognizing agent
  transactions.

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
- **`AGENT_ORIGIN` and `AGENT_APPLY_KEY` must agree across boundaries.**
  Server sets `AGENT_ORIGIN` on `DirectConnection.transact`; the update
  streams to the browser as a Yjs origin string; the client's
  UndoManager matches by string equality. Separately, the browser's
  editor-update handler reads the ProseMirror `AGENT_APPLY_KEY` meta to
  decide whether to restart the idle timer. Don't rename one without the
  other.
- **Hocuspocus's internal Document is authoritative.** `onLoadDocument`
  copies state out of the registry Y.Doc into Hocuspocus's own
  `Document`. Once a client has connected, the registry Y.Doc goes stale.
  Server code that wants to mutate a tab MUST go through
  `server.hocuspocus.openDirectConnection(tabId)` — not
  `getTabYDoc(tabId).ydoc`. The registry's sole remaining job is
  cold-start hydration before any client connects.
- **UndoManager construction order.** In `ydoc-registry.ts`, the
  `Y.UndoManager` is constructed BEFORE `replayUpdatesInto` runs so that
  every replayed `ydoc.transact(..., origin)` fires through the
  UndoManager's observer with its original origin. Swap the order and
  the stack is empty on every cold start — Reject silently does nothing.
- **Tiptap-markdown escapes brackets.** The markdown serializer escapes
  `[` → `\[` when serializing the Y.Doc. `read_doc` returns those
  escaped forms, and `edit_doc`'s `old_string` must also be escaped if
  the text originally contained a bracket. If an agent edit complains
  that `old_string` isn't found in a place it visibly is, check for
  un-escaped brackets.
- **`undoRedo: false` in StarterKit.** Collaboration ships its own Yjs
  undo and double-registering corrupts plugin state.
- **`Link` bundled via StarterKit.** Don't import
  `@tiptap/extension-link` separately.
