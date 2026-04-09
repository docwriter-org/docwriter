# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Requires Node 22+ (use `nvm use 22` if needed)
npm run dev          # Start Vite dev server (hot reload)
npm run build        # Production build
npm run check        # TypeScript + Svelte type checking
npm run check:watch  # Watch mode type checking
```

No test framework is configured yet. Use `npm run check` for validation.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system architecture, data flow, consistency model, and future directions. Below is a summary.

**atomz** is a writing editor that separates content (atoms) from presentation (prose). Users define atomic claims in a left pane; an AI agent renders them into essay prose in the center pane.

### Core Concept: Atoms → Prose

An **atom** (Fragment) is an atomic claim with a `subject` (what the sentence is about) and a `label` (the claim). Atoms are compressed notes, NOT literal text. The agent expands them into natural essay prose. The prompt explicitly instructs: "A sentence should say MUCH MORE than its atom."

### Three-Pane Layout

- **Left (ContentPane, 360px)**: Hierarchical atom editor with drag-to-reorder, inline edit, paragraph break toggles
- **Center (ProsePane, flex)**: Rendered prose with bidirectional highlighting, inline feedback/annotations, word-level diffs with accept/reject
- **Right (HistoryPane, 300px, toggleable)**: Read-only agent activity log with collapsible tool calls and timing

### Agent SDK Integration

Both server endpoints use `@anthropic-ai/claude-agent-sdk`'s `query()` with built-in tools:

- **`/api/render`** — Uses `Read` + `Edit` tools on `.atomz-render.json`, a temporary working copy derived from the current document snapshot. The server strips heading rows before Claude edits, then merges headings back in and atomically commits the final merged result to `document.atomz`. Session metadata lives in `.atomz-state.json`.

- **`/api/atomize`** — Uses `Write` to create a fresh `document.atomz`-shaped result from raw text, then the client hydrates stores from the returned atoms/prose.

Both endpoints stream responses as SSE with events: `tool_call_start`, `text_streaming`, `tool_call`, `assistant_text`, `result`, `error`, `done`.

### State Management

All state is in Svelte writable stores (`src/lib/stores.ts`). Key stores:
- `fragments`, `prose`, `rules`, `paraBreaks` — document state
- `renderingSentences`, `sentenceTransitions` — rendering UI state
- `agentHistory` — agent activity log
- `documentOps` — durable semantic document changes and reconciliation requests

User actions now emit semantic `DocumentOp` entries rather than pushing directly into a separate action queue. `+page.svelte` processes unresolved ops, resolves purely local ones after save, and runs `/api/render` only for ops that still require Claude reconciliation.

### Diff & Transitions

`src/lib/diff.ts` implements word-level LCS diff. During rendering, the `Edit` tool's `new_string` is extracted from streaming `input_json_delta` events and fed into `sentenceTransitions` for word-by-word typewriter display. Diffs persist with accept/reject buttons until the user acts.

### Theme System

`src/lib/themes.ts` defines 5 themes (Light, Dark, Solarized Light/Dark, Monokai) as CSS variable maps. `applyTheme()` sets variables on `document.documentElement`. Components use `var(--text)`, `var(--bg)`, etc. Not all component styles are fully converted to CSS variables yet.

### File Format (.atomz)

`src/lib/atomz.ts` — JSON format bundling `{ version, fragments, prose, rules, paraBreaks }`. Save/load/import via browser file picker. The import flow uploads text → `/api/atomize` → agent decomposes → populates stores.

### Durable Sync Model
The app persists unresolved `DocumentOp` entries to `.atomz-ops.jsonl` and replays them on refresh before resuming background processing. `DocumentOp` is the single durable intent model for both structural document mutations and durable feedback requests. Claude renders use `.atomz-render.json` as a working copy and only atomically commit back to `document.atomz` at the end of a successful render.

### Atom Features
- **Add atom/group**: `+ Add atom` at bottom, `+ add sub-atom` inside groups
- **Pin words**: Click words in predicates to pin them (must appear verbatim in prose)
- **Alternatives carousel**: Sparkle icon on atoms → generates 4 alternative phrasings via Haiku
- **Delete**: Trash icon on hover

### Onboarding / Style References
- Upload reference writing via "Style" button → `/api/import-reference` → saved to `.claude/skills/atomz-style/examples/`
- Render endpoint loads the Skill via `settingSources: ['project']` so the agent matches style

## Key Conventions

- Svelte 5 runes (`$state`, `$derived`, `$effect`) — NOT Svelte 4 stores syntax in components
- Stores are subscribed manually in components (`.subscribe()`) rather than using `$store` syntax
- Font: Lora (Google Fonts, serif)
- Model selection: Opus (default), Sonnet, Haiku — passed as `model` in request bodies
- Playwright MCP is configured for browser testing (`claude mcp add playwright`)
