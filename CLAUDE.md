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
markdown in a Tiptap editor; an agent proposes edits that merge into the live
document via Yjs operations the user can review (accept/reject) or let merge
silently. The data model is flat markdown — no atoms, no blocks, no pins.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system.

## The one big idea

**The Y.Doc is canonical editor state.** Both user keystrokes and agent
writes flow into it as CRDT operations, which merge deterministically. The
on-disk `document.md` is a backing store for portability and git, not the
source of truth. The `.docwriter/agent.md` shadow file exists only because
the Claude Agent SDK's `Edit` tool requires a real filesystem path.

## Persistence layout

```
project-root/
  document.md          ← user-facing markdown (git-friendly)
  .docwriter/
    agent.md           ← agent's shadow copy during a render (transient)
    state.json         ← sessionId, rules, agentSettings,
                         recentActions, actionUsageCounts
```

Plus IndexedDB `docwriter-doc` on the client for the Y.Doc itself (edit
state, undo history, review snapshots — persisted by y-indexeddb).

## Three-pane layout

- **Left (`OutlinePane`, 260px):** auto-generated TOC from headings, plus the
  pending-edit card with Accept / Reject when a review is active.
- **Center:** Tiptap editor + `AgentDock` in the top-right (Wake up button,
  sleeping-cat mascot, gear-icon settings popover).
- **Right (`HistoryPane`, 340px, toggleable):** agent tool-call log.

## Agent SDK integration

`/api/render` streams a single `query()` call over SSE:

1. `resetAgentDoc()` — copy `document.md` → `.docwriter/agent.md`.
2. `startRender()` — set `renderActive = true`.
3. Build prompt (agency level rewrites the "how to decide whether to edit"
   section via `agencyGuidance()`).
4. `query()` with a PreToolUse hook that syncs user deltas into the shadow
   before each agent `Edit`/`Write`.
5. Stream SSE: `tool_call_start`, `tool_call`, `assistant_text`, `result`.
6. `result` carries `agentMd`; client calls `applyAgentMarkdown(editor, md,
   trackChanges)`.
7. `endRender()`.

## Agent reconciliation

`src/lib/yjs-agent.ts:applyAgentMarkdown`:

1. Clone the Y.Doc from a baseline snapshot captured at render start.
2. Run `setContent(agentMd)` on a headless editor bound to the clone; the
   ySyncPlugin translates that to minimal Yjs ops on the clone.
3. `Y.encodeStateAsUpdate(clone, liveStateVector)` produces the agent's
   delta.
4. `liveDoc.transact(() => Y.applyUpdate(liveDoc, delta), origin)` — CRDT
   merges with any user ops that happened during the render.

Origin is `'agent'` in review mode (UndoManager captures → Accept/Reject
works) or `ySyncPluginKey` in silent mode (no review UI, user undo stack).

## Agent settings

`AgentSettings` in `src/lib/types.ts`, persisted to `state.json`:
- **autonomy** (`agency: 'conservative' | 'balanced' | 'aggressive'`) —
  prompt rewiring.
- **trackChanges** — review mode on/off.

Edited via the `AgentDock` settings popover (click the gear icon pinned to
the mascot card).

## Conventions

- **Svelte 5 runes** (`$state`, `$derived`, `$effect`) in components. Stores
  are subscribed manually with `.subscribe()`, not `$store` syntax.
- **Font:** Lora (serif) for editor prose, Inter for UI.
- **Model selection:** Opus / Sonnet / Haiku, passed as `model` in request
  bodies.
- **Playwright MCP** configured for browser testing.
- **Timing:** 3s idle countdown to auto-submit, ~50ms autosave debounce,
  Cmd/Ctrl+Enter skips the countdown.

## Gotchas

- `undoRedo: false` in StarterKit — Collaboration ships its own Yjs undo and
  double-registering corrupts plugin state.
- `Link` bundled via StarterKit — don't import `@tiptap/extension-link`
  separately.
- Initial render gates on `docLoaded` before mounting `TiptapEditor` so the
  Y.Doc has `userMd` to seed from.
- In `onEditorUpdate`, skip side effects when
  `transaction.getMeta(ySyncPluginKey) !== undefined` — those are Yjs hydration
  transactions, and touching `userMd`/autosave during them can wipe
  `document.md` with an empty string.
