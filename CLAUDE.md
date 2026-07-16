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
    docwriter.db       ← SQLite: yjs_updates, tabs, rules,
                         recent_actions, action_usage_counts,
                         provider_session_entries, conversation_events,
                         kv (sessionId, agentSettings, last_seen:<tabId>…)
    hooks.json         ← user-defined shell hooks (read by hooks-config.ts)
    agent/scratch/     ← agent scratch workspace (lazy-created on first
                         scratch write; cleared on "New session")
```

SQLite is the single source of truth for runtime state — there is no
`state.json` JSON mirror (it was removed; only stale comments referenced it).

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

On the server, Accept/Reject run against the live Hocuspocus Document
(`acceptTabRounds` / `rejectTabRounds` in `ws-server.ts`; there is no
server-side UndoManager). Reject removes the round from the review
`Y.Array`; the doc fragment isn't touched. Accept walks each accepted
round and applies its `edit` op via `applyEditToFragment` (in
`ydoc-codec.ts`), which deletes + reinserts only the paragraphs the edit
covers. `write` ops fall back to wholesale `replaceYDocText`. Both paths
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
