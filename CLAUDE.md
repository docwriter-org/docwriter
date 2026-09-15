# Working on DocWriter

Use this guide when you change DocWriter. Read [ARCHITECTURE.md](ARCHITECTURE.md) for more detail about the system.

## Commands

Use Node 22 or later; the pinned version is in `.nvmrc`.

```bash
npm run dev          # Start Vite with hot reload
npm run build        # Build for production
npm run check        # Check TypeScript and Svelte
npm run check:watch  # Keep type checks running
npm run test:unit    # Run Vitest
npm run doctor       # Inspect or repair .docwriter state
```

Run both `npm run check` and `npm run test:unit` before you finish. You can find the document lifecycle tests in `src/lib/server/state-consistency.test.ts`.

## Work with the live document

DocWriter is a Markdown editor where you write with an AI agent. Each text tab has a Yjs document in the Hocuspocus server; you access that document over a WebSocket in the browser.

Read the live server document when it is available. To change it from the server, use `hocuspocus.openDirectConnection(...)`; do not change a temporary document rebuilt from SQLite while a live copy is available. Your change would not be visible in the browser.

Use the same document for agent tools. In `edit_doc` and `write_doc`, store proposed additions and deletions as marks on its text; each mark has a comment thread ID. Display the marks with CSS in the browser.

Keep the editor content as plain Markdown. Use Document, Paragraph, Text, and HardBreak nodes; keep headings, links, and other Markdown syntax in the text. Use display plugins for their appearance.

## Store proposals

Use `src/lib/shared/proposals.ts` for proposal operations:

| If you need to | Use |
| --- | --- |
| Read text and map its offsets to document positions | `buildView` |
| Replace exact text in a proposal | `proposeReplacement` |
| Propose a complete document | `proposeText` |
| Accept, reject, or dismiss marked text | `resolveThreadMarks` |
| Read a thread's changes and position | `summarizeThreadMarks` |

Choose the text view for your operation. In the committed view, you have original text and accepted edits; in the proposed view, you have pending edits as if accepted. To revise a thread, build the proposed view with that thread's marks reverted, then compare it with the desired text.

Use word marks within a modified line. Use `suggest` and `suggestThread` paragraph attributes for added or removed lines, and for a line rewritten beyond the `WHOLE_LINE_CHURN` threshold. Existing HardBreak nodes in a structural deletion also have proposal ownership attributes.

Keep one thread per passage. If you touch a line with another thread's marks, return `overlap` with that thread's ID; request a revision on that thread. When you have a new proposal on the same thread, replace its previous one.

Keep author text in the committed view even when it is inside a proposed paragraph. When you reject or accept that proposal, preserve any text and line breaks the author added.

## Save document state

You will find workspace state in these locations:

| Path | Contents |
| --- | --- |
| `document.md`, or another workspace file | Plain text written from the committed view |
| `.docwriter/docwriter.db` | Documents, Yjs updates, rules, reviewers, sessions, activity, and runtime settings |
| `.docwriter/workspace.json` | The workspace path recorded at startup |
| `.docwriter/backups/` | Snapshots before file deletion, external edits, migration, or repairs; keep the newest 40 |
| `.docwriter/hooks.json` | Shell hooks read by `hooks-config.ts` |
| `.docwriter/agent/scratch/` | Agent scratch files; created on demand and cleared on New session |

Use SQLite for saved state. Append each Yjs update to `yjs_updates.payload` with its origin; committed text is also saved to the workspace file on a 500 ms flush tick. You can use that file with Git and other tools; it has no pending additions or comment data.

Use `documents-store.ts` for document identities. In schema v13, each row in `documents` has its open or closed status, tab order, `last_seen` text, and missing-file timestamp. Deletes and renames are cascaded through the foreign key on `yjs_updates.tab_id`. Do not replace all identity rows with a delete and insert.

When you close a tab, change its status; retain its update log. When you reopen it, restore text, comments, proposals, and AI authorship marks. If its file is missing, show that state during the grace window; restore from the log when possible instead of deleting the document.

Use `applyExternalText` to fold an external file edit into the committed text as one `SYSTEM_ORIGIN` update. Compare normalized text so you do not replace a passage for a typography-only difference. Keep proposals outside the changed area.

Delete log rows only for an explicit delete, a doctor repair, or compaction; take a backup first. Compact logs with more than 500 rows when the document is unloaded.

Keep binary files out of Yjs. Use the binary extension list in `isBinaryTabPath`; LaTeX, Typst, and BibTeX are editable text. Do not add per-tab shadow files, IndexedDB document storage, or a `state.json` mirror. Wait for the first WebSocket `synced` event before you display the editor.

## Find the UI code

- Use `OutlinePane` for the heading outline and `FileTree` for files on the left; keep a single outline instance.
- Use `TiptapEditor` for the document, `AgentDockShell` for agent controls, and `HistoryPane` for the activity log.
- Use `CommentGutter` for expanded comment cards beside the document. Use `ThreadOverlay` for visible additions, the feedback selection, and the comment-count buttons.
- Use `TabBar` badges to count proposals and `ToastStack` for proposed rules and hooks.
- Use `AiProvenanceToggle` to show accepted AI text; store that display preference in localStorage through `showAiProvenance`.

Keep comment cards expanded. Show additions when you focus a card or click struck text; hide them when you return to writing, and keep the original text struck through. Do not add purple passage highlights or vertical diff borders.

Use `revealCard` to show a comment, but do not scroll while the editor has focus. Keep the message list capped at 300 px; show the newest reply and use `followNewMessages` for new replies.

Give accepted additions `ai: true`; display them as `span[data-ai-text]` through `AiProvenanceMark`. Change their appearance with CSS. When you type a replacement, strip the AI mark from the text you add.

## Send an agent request

Start provider requests in `/api/render`. Build the prompt from open tabs and their `last_seen` text; send activity through server-sent events and document changes through Yjs sync.

1. List each text tab and whether its content is different. Include a diff against `last_seen` when available; summarize diffs above roughly 8 KB. For a new tab, include its path and ask the agent to call `read_doc`. List binary tabs as previews.
2. Add the agency setting and current instructions. Send the full learned style instructions on the first turn of a session or when published style propositions are different; otherwise send a reminder naming the style skill.
3. Create the tool servers for that query. Use `docwriter` for rule and hook proposals; use `docwriter-doc` for document reads, edits, comments, replies, and thread lists.
4. Run the provider query. Use document tools to change the live Hocuspocus document; those changes will be available in connected browsers.
5. Stream `tool_call_start`, `tool_call`, `assistant_text`, and `result` events to the activity log. Do not put document Markdown in the result event to apply in the browser.
6. Save the proposed view as `last_seen` for the tabs you included in the agent request.

Keep `last_render:session` with the prompt snapshots. If you have a different session, treat those snapshots as absent; send full rules, references, agency, audience, and style instructions. Include the first request after warmup, since you can have a new session after warmup without that prompt.

Route tab paths through `docwriter-doc`; route `.docwriter/agent/scratch/` paths to normal file operations. You can use built-in file tools where permitted; use the document tools for open-tab edits.

## Explain an edit before proposing it

If you already have a feedback thread, use it. Reply with what you plan to change, then call `edit_doc` on that thread in the same turn. If you have no thread, create one with `comment_doc` before the edit. Ask a question when you need clarification about the change itself.

Do not add another approval step between that explanation and the pending edit. Check this behavior with `comment-then-edit.test.ts`. Old `proposedEdit` data may be on saved messages; do not restore it as a separate approval flow.

When you build a feedback trigger, identify the quoted passage as the current text. Do not phrase it as the requested replacement; you may otherwise get a comparison of the quote with itself and a report of no change.

Use `feedbackRetryPrompt` after an edit-mode feedback turn or thread reply with no changed proposal. Ask for one retry; allow the agent to stop if you already have an explanation of why no edit is needed or a question to answer.

Use `openFeedbackThread` when you create feedback in the editor; set `openCommentThreadId` before the thread is synced so you can show its proposal once available.

Keep tool results in `describeTabWrite`, shared by the MCP and provider handlers. Say an edit was proposed and is pending acceptance; do not say it was applied. If the proposed text is unchanged, report "No change proposed."

## Accept, reject, dismiss, and undo

Use `resolveTabThread(tabId, threadId, outcome)` in `ws-server.ts`. Within that function, run `resolveThreadMarks` and `setThreadResolved` on the live document in one `USER_ORIGIN` transaction, then return the Yjs update. Use `resolveAllTabThreads` for batch review.

When you accept, keep additions as AI text and remove deletions. When you reject or dismiss, remove additions and restore the original text; preserve any author text in either case. When you reopen, change the thread's status; when you undo, restore its proposal too.

On the client, keep the order in `postThreadAction`:

1. Wait for local edits to be synced where required, then pause WebSocket sync.
2. Post to `/api/document` with `resolve_thread`, `resolve_all`, or `set_thread_resolution`.
3. Apply the returned update locally with `USER_ORIGIN`.
4. Reconnect the provider.

Return `ok: true` with successful batch responses too; check it on the client before applying the update for undo.

Use the custom `Y.UndoManager` in `editor-extensions.ts`, scoped to the text fragment and comments map. Keep `trackedOrigins = {ySyncPluginKey, USER_ORIGIN}` so typing and review actions are undoable, while agent proposals are outside that history.

Use `LocalInputMarkStrip` to remove `ai`, `insertion`, and `deletion` marks from typed text. Keep HTML parse rules so existing marks are preserved during DOM reconstruction; strip copied proposal marks in `transformPasted`.

## Agent settings and critique passes

Store `AgentSettings` from `src/lib/types.ts` under `agentSettings` in SQLite `kv`. The agency choice is `conservative`, `balanced`, or `aggressive`; use it when building the prompt. When you mute the agent, its comment cards are hidden and the struck text is faint; pending proposals are still stored. You can change these settings from the agent settings controls.

Use Settings, then **Critique pass**, to choose a reviewer. Built-in reviewers are in `src/lib/shared/reviewers.ts`; use the `reviewers` table and `/api/reviewers` for custom reviewers. Collect the name, icon, color, and instructions in `ReviewerEditorDialog`.

Send `reviewerId` to `/api/render`. Use `buildCritiqueMessage` to ask the agent to read the draft and explain each edit before proposing it; keep the pass to at most six findings and allow a response with no findings. Use `effort: 'medium'` for critique passes.

Never delegate document work to a subagent. The in-process `docwriter-doc` server is bound to its original query; you can have "Stream closed" errors in the parent query if you delegate document work. Keep critique and feedback-import work in the current query.

Use `setActiveReviewerId` to stamp the reviewer on each comment. Keep findings as ordinary comment threads and proposals. Use `activeReviewer` for the name and icon in the agent dock and history; use `ReviewerMascot` on attributed comments in `CommentGutter`.

## Import feedback

Use Settings, then **Import feedback**, to bring in comments. You can upload a Word file or paste text.

For Word files, read authors and comments from `word/comments.xml` with `jszip` in `docx-comments.ts`; read selected passages from comment-range markers in `word/document.xml`. Show a preview in `FeedbackImportDialog` before importing.

For pasted text, pass the text to the agent with `buildRawFeedbackMessage`; ask the agent to separate the comments and find their passages. For extracted Word comments, use `buildFeedbackImportMessage` with numbered comments and their original passages. Run the import in one query without subagents; show each comment once it is available.

Pass `external_author` to `comment_doc` for an imported comment. In `createAgentCommentThread`, store `author: 'external'` and the person's name in `externalAuthor`; show that name with a message icon on the comment card.

Store import progress under `feedbackImport` in SQLite `kv`. Poll `/api/feedback-import` in `FeedbackLedger`; show each comment as applied, discussed, deferred, or untouched. Match imported comments to thread IDs when you create them; in `edit_doc`, change their recorded disposition from discussed to applied.

## Conventions

- Use Svelte 5 runes in components. You can use `$store` subscriptions; if you subscribe manually, call the unsubscriber on destroy.
- Use Lora for prose, Inter for UI, and Geist Mono for plain text and code.
- Include `provider` and `model` in provider request bodies; supported providers are Claude, OpenAI, Codex, Cursor, and Pi.
- Keep the three-second idle countdown and 500 ms server file-flush tick. Press Command or Control plus Enter to skip the countdown.
- Import transaction origins from `src/lib/shared/ydoc-codec.ts`; do not define local copies.

## Common mistakes

### Reconnecting after review

With `disconnect()`, you start a close handshake. If the socket is still open when you receive the HTTP response, you can have an early return from `connect()`; the tab may then be offline. Set `websocketProvider.shouldConnect = true` before calling `connect()` in the resume function.

Keep the five-second grace period in `onSyncConnectionChange`; report a tab that is still disconnected outside an intentional pause.

### Unloading before a file flush

Keep `onTabUnloaded` in `afterUnloadDocument`. If the tab is dirty, replay its log and flush its file before clearing the dirty flag; otherwise you can lose the last pending file write after a browser disconnect.

### Reloading server modules

Reuse `globalThis.__docwriterWsServer` across Vite reloads. Do not start a second server on the same port. Use that instance in route handlers to access the live document too.

### Importing the wrong sync key

Import `ySyncPluginKey` and relative position helpers from `src/lib/editor-extensions.ts`. The key in the collaboration extension is from `@tiptap/y-tiptap`; the similarly named key in `y-prosemirror` is a different object. If you mix them, you can have incorrect checks for local edits and comment positions.

### Replacing a whole comment thread

Keep each thread as a nested `Y.Map` with a `Y.Array` of messages. Do not call `commentsMap.set(id, {...})` with a plain object; you can overwrite a concurrent reply or dismissal.

Read with `readThreadValue`, `getThread`, or `readCommentThreads`. Write with `putThread`, `appendThreadMessage`, and `setThreadResolved`; use `observeDeep` on the client so you see nested changes. Convert older plain-object threads during loading.

Locate threads through their text marks with `firstThreadPos` or `summarizeThreadMarks`. Check `threadUnderRange` before creating feedback so you can reply on an existing thread. Read legacy quote anchors only during migration; do not write new ones.

### Sharing state between requests

Keep the reviewer ID and feedback thread ID in the `AsyncLocalStorage` scope created by `runWithRenderScope`. Do not move them to module variables; you could overwrite the IDs of another request.

Build a fresh MCP server with `buildDocToolsMcp()` for each query. Keep `permissionMode: 'default'`; with `acceptEdits`, built-in file writes are not checked through `canUseTool` and you can have workspace edits without review.

### Writing transcript messages

Write injected user messages as "I" and address the author as "you" in agent replies. Keep the system prompt in the author's voice. When you change trigger wording, update the matching code too; older saved messages may still have the previous wording.

### Reading formatted text

Use `Y.XmlText.toDelta()` to read text; the output of `toString()` can have XML tags for format attributes. When you insert unformatted text, pass explicit empty attributes or use `applyDelta` with unformatted operations; with a plain `insert`, your text can have the preceding marks.

Use `serializeFragment` or `serializeYDoc` for committed text, and `proposedText` for agent reads and `last_seen`. Keep Markdown characters unchanged; omit proposal and AI attributes from the saved text. Use `buildView` for text-offset mapping.

Do not add StarterKit, Link, or Tiptap history to the editor. Undo is already configured through `Collaboration.configure({ yUndoOptions })` in `editor-extensions.ts`.
