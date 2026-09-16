# Working on DocWriter

DocWriter is a local Markdown editor for writing with an AI agent. You work with SvelteKit, Svelte 5, Tiptap, Yjs, and SQLite.

Keep shared instructions in this file. `CLAUDE.md` is a relative symlink to `AGENTS.md`; edit this file when you change the instructions.

## Writing preferences

Apply these preferences to documentation, UI text, comments, commit messages, and PR descriptions:

- Address the reader as "you"; use second person and direct instructions.
- Use simple, everyday words and complete sentences. Explain necessary technical terms.
- Join closely related clauses with commas, semicolons, or "and"; keep each sentence easy to follow.
- Do not assign actions to inanimate subjects. Use "be" or "have" for them, or make a person the subject. Write "The original text will still have a strikethrough," not "The original text stays struck through."
- Be literal and specific. Avoid filler, hype, analogies, clever headings, invented compound words, and unnecessary jargon.
- Use straight quotes and sentence case. Avoid em dashes and en dashes.
- Explain what you changed, why, and how you checked it. Report any limits without claiming checks you did not run.

## Run the app

Use Node 22.22.2 from `.nvmrc`. From your checkout:

```sh
nvm use
npm install
node bin/docwriter-dev.js ~/writing/docwriter-test
```

If you do not have that Node version, run `nvm install` first. Keep the terminal open; save application code changes to see them in the browser at `http://127.0.0.1:5173`. Your writing is in the folder you specified.

Use `npm run dev` if you want the repository itself as your writing workspace. You need port 3001 for document sync; if the editor is blank, check the terminal for a sync server error.

Read [Contributor setup](docs/contribute/setup.mdx) for launcher options, restart instructions, and production builds. You can edit documents without provider credentials; see [Connect a provider](docs/connect-provider.mdx) when testing the agent.

## Work on a change

- Read the relevant code before editing; keep changes within the requested task.
- Complete authorized work without asking for the same permission again. Ask when you need information that you cannot infer safely.
- Keep the user's unrelated work. Do not revert, overwrite, or include it in your commit.
- Use the existing code and conventions; use Svelte 5 runes for component state.
- When you change behavior, add or update a focused test. For wording or visual changes, use the relevant documentation or browser checks.
- Write PR descriptions for someone who has not read the conversation. Describe the final change and the checks you ran.

## Preserve document and review behavior

Read [Architecture](docs/contribute/architecture.mdx) before changing the editor, sync, review, or storage. Read [Proposal handling](docs/contribute/plan-suggestions-as-marks.md) for edit and undo details.

- Read the live server Yjs document when available. Use `openDirectConnection` for server edits; do not change a temporary copy while a live document is available.
- Keep Markdown in Document, Paragraph, Text, and HardBreak nodes. Use display plugins for formatting; do not add StarterKit, Link, or Tiptap history.
- Use `src/lib/shared/proposals.ts` for proposals. Keep one thread per passage; revise a proposal on its existing thread. Preserve text and line breaks typed by the author when accepting or rejecting an edit.
- Store document state in SQLite and save committed text to workspace files. Keep pending additions and comment data out of those files. Back up data before deletion, migration, or repair; retain the update log when closing a tab.
- Resolve proposal marks and close the thread in one `USER_ORIGIN` transaction. Keep review actions undoable; exclude agent proposals from typing history. Import transaction origins from `src/lib/shared/ydoc-codec.ts` and sync helpers from `src/lib/editor-extensions.ts`.
- Keep comment cards expanded. Show additions when the user focuses a card or clicks struck text; hide additions when they click elsewhere or type. The original text must still have a strikethrough. Do not add purple passage highlights or vertical diff borders.
- In the app's agent workflow, explain an edit on its comment thread before proposing it. Use `docwriter-doc` tools for open documents, and keep request state in `AsyncLocalStorage`. Do not delegate document tool work to subagents; the tool connection is bound to its original query.

## Check your work

Before finishing, run:

```sh
npm run check
npm run test:unit
```

For application code changes, also run `npm run build`. For public documentation changes, run `npm run docs:validate`. Run provider smoke tests with the appropriate credentials when changing provider behavior; say if you could not run them.

For editor or review changes, check typing, accepting, rejecting, undo, and reloading in the browser. Take new screenshots only when the existing ones are outdated or you need to explain a new interaction.

## Where to look

- [README](README.md) for installation and project context.
- [Contributor setup](docs/contribute/setup.mdx) for local development.
- [Architecture](docs/contribute/architecture.mdx) for storage, sync, and a map of the code.
- [Providers and tools](docs/contribute/providers-and-tools.mdx) for agent integration.
- [Testing and documentation](docs/contribute/testing-and-docs.mdx) for browser tests and documentation assets.
