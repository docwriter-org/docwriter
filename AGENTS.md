# AGENTS.md

DocWriter is an AI-assisted markdown writing editor (SvelteKit + Svelte 5 +
Tiptap, server-owned Yjs CRDT, embedded SQLite). See `README.md` for the
standard dev commands and `CLAUDE.md` / `ARCHITECTURE.md` for the system design.

## Cursor Cloud specific instructions

Services & ports (single Node process):

- `npm run dev` starts Vite on **:5173** and auto-boots the Hocuspocus Y.Doc
  WebSocket sync server on **:3001** in-process (from `src/hooks.server.ts`).
  The browser only paints after the WS `synced` event, so a blank editor that
  never fills in usually means the :3001 WS server didn't start.
- `npm run dev` runs against the current working directory as the workspace
  root, so the file tree shows the whole repo. To run against a clean target
  folder instead, use `npm run dev:workspace -- [--no-open] [--host 0.0.0.0] /path/to/folder`.
- No test framework is configured; `npm run check` (svelte-check) is the
  validation command. `npm run build` is the production build.

Node version (important gotcha):

- `.npmrc` sets `engine-strict=true` and a dependency requires Node
  **>=22.19.0**; the repo pins **22.22.2** via `.nvmrc`. The system
  `/exec-daemon/node` is older (22.14.0) and sits ahead of nvm on `PATH`, so a
  raw `node`/`npm install` can fail with `EBADENGINE`. The update script and a
  one-time `~/.bashrc` pin already force nvm's 22.22.2 for new shells; if a
  shell still shows `node v22.14.0`, run `nvm use` (reads `.nvmrc`) first.

AI agent (for end-to-end testing of the headline feature):

- The editor loads and edits without any key, but the agent loop
  (Send → propose edit → review card) needs a provider credential.
- `OPENAI_API_KEY` is available; select **Settings → Provider → OpenAI**.
  NON-OBVIOUS: the OpenAI provider defaults to the **Codex Mini**
  (`codex-mini`) model, which is unavailable and errors with
  `Error 400 The requested model 'codex-mini' does not exist`. Switch to
  **Settings → Model → GPT-5.5** (or another listed GPT-5.x) before sending.
- The default provider is Claude, which needs `ANTHROPIC_API_KEY` or a
  `claude login` session (neither is present by default here).
- Prompt the agent via the **Send** button (top-right of the center pane);
  proposed edits appear as tracked changes plus an **Accept/Reject/Retry**
  review card in the right pane. Accept writes through to `document.md`.
