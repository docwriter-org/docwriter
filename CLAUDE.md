# Working on DocWriter

Use this guide when you change DocWriter. Read [ARCHITECTURE.md](ARCHITECTURE.md) for more detail about the system.

## Commands

Use Node 22 or later; the repository pins its version in `.nvmrc`.

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

DocWriter is a Markdown editor where you write with an AI agent. Each text tab has a Yjs document in the Hocuspocus server; the browser syncs with that document over a WebSocket.

Read the live server document when it is available. To change it from the server, use `hocuspocus.openDirectConnection(...)`; do not change a temporary document rebuilt from SQLite while a live copy exists. The browser would not receive that change.

Agent tools use the same document. `edit_doc` and `write_doc` store proposed additions and deletions as marks on its text; each mark identifies a comment thread. The browser displays the marks with CSS.

Keep the editor content as plain Markdown. Use Document, Paragraph, Text, and HardBreak nodes; keep headings, links, and other Markdown syntax in the text. Display plugins handle their appearance.

## Store proposals

Use `src/lib/shared/proposals.ts` for proposal operations:

| If you need to | Use |
| --- | --- |
| Read text and map its offsets to document positions | `buildView` |
| Replace exact text in a proposal | `proposeReplacement` |
| Propose a complete document | `proposeText` |
| Accept, reject, or dismiss marked text | `resolveThreadMarks` |
| Read a thread's changes and position | `summarizeThreadMarks` |

Choose the text view that fits the operation. The committed view contains original text and accepted edits; the proposed view includes pending edits as if accepted. To revise a thread, build the proposed view with that thread's marks reverted, then compare it with the desired text.

Use word marks within a modified line. Use `suggest` and `suggestThread` paragraph attributes for added or removed lines, and for a line rewritten beyond the `WHOLE_LINE_CHURN` threshold. Existing HardBreak nodes in a structural deletion also carry proposal ownership.

Keep one thread per passage. If you touch a line held by another thread, return `overlap` with that thread's ID; the agent must use that thread. A new proposal on the same thread replaces its previous one.

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

Use SQLite for saved state. Append each Yjs update to `yjs_updates.payload` with its origin; the server also writes committed text to the workspace file on a 500 ms flush tick. That file lets you use Git and other tools, but it does not hold pending additions or comment data.

Use `documents-store.ts` for document identities. In schema v13, each row in `documents` stores its open or closed status, tab order, `last_seen` text, and missing-file timestamp. The foreign key on `yjs_updates.tab_id` cascades deletes and renames. Do not replace all identity rows with a delete and insert.

When you close a tab, change its status; retain its update log. Reopening it must restore text, comments, proposals, and AI authorship marks. If its file is missing, show that state during the grace window; restore from the log when possible instead of deleting the document.

Use `applyExternalText` to fold an external file edit into the committed text as one `SYSTEM_ORIGIN` update. Compare normalized text so a typography-only difference does not trigger a replacement. Keep proposals outside the changed area.

Delete log rows only for an explicit delete, a doctor repair, or compaction; take a backup first. Compact logs with more than 500 rows when the document unloads.

Keep binary files out of Yjs. `isBinaryTabPath` uses a list of binary extensions; LaTeX, Typst, and BibTeX remain editable text. Do not add per-tab shadow files, IndexedDB document storage, or a `state.json` mirror. Wait for the first WebSocket `synced` event before you display the editor.

## Find the UI code

- Use `OutlinePane` for the heading outline and `FileTree` for files on the left; keep a single outline instance.
- Use `TiptapEditor` for the document, `AgentDockShell` for agent controls, and `HistoryPane` for the activity log.
- Use `CommentGutter` for expanded comment cards beside the document. `ThreadOverlay` controls which proposal's additions you can see, the feedback selection, and the comment-count buttons.
- Use `TabBar` badges to count proposals and `ToastStack` for proposed rules and hooks.
- Use `AiProvenanceToggle` to show accepted AI text; `showAiProvenance` stores that display preference in localStorage.

Keep comment cards expanded. Show additions when you focus a card or click struck text; hide them when you return to writing, and keep the original text struck through. Do not add purple passage highlights or vertical diff borders.

Use `revealCard` to bring a waiting comment into view, but do not scroll while the editor has focus. Keep the message list capped at 300 px; show the newest reply and use `followNewMessages` as replies arrive.

Accepted additions receive `ai: true`; `AiProvenanceMark` displays them as `span[data-ai-text]`. Change their appearance with CSS. When you type a replacement, strip the AI mark from the text you add.

## Send an agent request

Start provider requests in `/api/render`. Build the prompt from open tabs and their `last_seen` text; send activity through server-sent events and document changes through Yjs sync.

1. List each text tab and whether it changed. Include a diff against `last_seen` when available; summarize diffs above roughly 8 KB. For a new tab, include its path and ask the agent to call `read_doc`. List binary tabs as previews.
2. Add the agency setting and current instructions. Send the full learned style instructions on the first turn of a session or when published style propositions change; otherwise send a reminder naming the style skill.
3. Create the tool servers for that query. `docwriter` provides rule and hook proposals; `docwriter-doc` provides document reads, edits, comments, replies, and thread lists.
4. Run the provider query. Document tools change the live Hocuspocus document; its updates sync to connected browsers.
5. Stream `tool_call_start`, `tool_call`, `assistant_text`, and `result` events to the activity log. Do not put document Markdown in the result event for the browser to apply.
6. Save the proposed view as `last_seen` for the tabs the agent saw.

Keep `last_render:session` with the prompt snapshots. If the session changes, treat those snapshots as absent; send full rules, references, agency, audience, and style instructions. Include the first request after warmup, since warmup can create a session without building that prompt.

Route tab paths through `docwriter-doc`; route `.docwriter/agent/scratch/` paths to normal file operations. Built-in file tools remain available where permitted, but open-tab edits must use the document tools.

## Explain an edit before proposing it

If a feedback thread already exists, use it. Reply with what you plan to change, then call `edit_doc` on that thread in the same turn. If no thread exists, create one with `comment_doc` before the edit. Ask a question when you need clarification about the change itself.

Do not add another approval step between that explanation and the pending edit. `comment-then-edit.test.ts` checks this behavior. Old `proposedEdit` data may remain on saved messages; do not restore it as a separate approval flow.

When you build a feedback trigger, identify the quoted passage as the current text. Do not phrase it as the requested replacement; that previously led the agent to compare the quote with itself and report no change.

Use `feedbackRetryPrompt` for an edit-mode feedback turn or thread reply that produces no changed proposal. It asks for one retry; its instructions allow the agent to stop if it already explained why no edit is needed or asked a question.

Use `openFeedbackThread` when you create feedback in the editor; set `openCommentThreadId` before the thread syncs back so its proposal can be shown on arrival.

Keep tool results in `describeTabWrite`, shared by the MCP and provider handlers. Say an edit was proposed and still needs acceptance; do not say it was applied. If the replacement changes nothing, report "No change proposed."

## Accept, reject, dismiss, and undo

Use `resolveTabThread(tabId, threadId, outcome)` in `ws-server.ts`. It runs `resolveThreadMarks` and `setThreadResolved` on the live document in one `USER_ORIGIN` transaction, then returns the Yjs update. Use `resolveAllTabThreads` for batch review.

Accept keeps additions as AI text and removes deletions. Reject and dismiss remove additions and restore the original text; preserve any author text in either case. Reopen changes the thread's status, while undo restores its proposal too.

On the client, keep the order in `postThreadAction`:

1. Wait for local edits to sync where required, then pause WebSocket sync.
2. Post to `/api/document` with `resolve_thread`, `resolve_all`, or `set_thread_resolution`.
3. Apply the returned update locally with `USER_ORIGIN`.
4. Reconnect the provider.

Return `ok: true` with successful batch responses too; the client checks it before applying the update for undo.

Use the custom `Y.UndoManager` in `editor-extensions.ts`, scoped to the text fragment and comments map. Keep `trackedOrigins = {ySyncPluginKey, USER_ORIGIN}` so typing and review actions are undoable, while agent proposals stay outside that history.

Use `LocalInputMarkStrip` to remove `ai`, `insertion`, and `deletion` marks from typed text. Keep HTML parse rules so existing marks survive DOM reconstruction; strip copied proposal marks in `transformPasted`.

## Agent settings and critique passes

Store `AgentSettings` from `src/lib/types.ts` under `agentSettings` in SQLite `kv`. The agency choice is `conservative`, `balanced`, or `aggressive`; use it when building the prompt. Muting hides agent comment cards and makes struck text faint, pending proposals remain stored. You can change these settings from the agent settings controls.

Use Settings, then **Critique pass**, to choose a reviewer. Built-in reviewers are in `src/lib/shared/reviewers.ts`; custom reviewers use the `reviewers` table and `/api/reviewers`. `ReviewerEditorDialog` collects the name, icon, color, and instructions.

Send `reviewerId` to `/api/render`. Use `buildCritiqueMessage` to ask the agent to read the draft and explain each edit before proposing it; keep the pass to at most six findings and allow a response with no findings. Critique passes use `effort: 'medium'`.

Never delegate document work to a subagent. The in-process `docwriter-doc` server belongs to the query that opened it; a subagent cannot use that connection and can cause "Stream closed" errors for the parent too. Keep critique and feedback-import work in the current query.

Use `setActiveReviewerId` to stamp the reviewer on each comment. Keep findings as ordinary comment threads and proposals. The `activeReviewer` store controls the name and icon in the agent dock and history; `CommentGutter` uses `ReviewerMascot` on attributed comments.

## Import feedback

Use Settings, then **Import feedback**, to bring in comments. You can upload a Word file or paste text.

For Word files, `docx-comments.ts` reads authors and comments from `word/comments.xml` with `jszip`; it reads selected passages from comment-range markers in `word/document.xml`. Show a preview in `FeedbackImportDialog` before importing.

For pasted text, pass the text to the agent with `buildRawFeedbackMessage`; the agent separates the comments and finds their passages. For extracted Word comments, use `buildFeedbackImportMessage` with numbered comments and their original passages. Run the import in one query without subagents; comments appear as they are created.

Pass `external_author` to `comment_doc` for an imported comment. `createAgentCommentThread` stores `author: 'external'` and the person's name in `externalAuthor`; the comment card displays that name with a message icon.

Store import progress under `feedbackImport` in SQLite `kv`. `FeedbackLedger` polls `/api/feedback-import` and shows each comment as applied, discussed, deferred, or untouched. Match imported comments to thread IDs when you create them; `edit_doc` changes their recorded disposition from discussed to applied.

## Conventions

- Use Svelte 5 runes in components. You can use `$store` subscriptions; if you subscribe manually, call the unsubscriber on destroy.
- Use Lora for prose, Inter for UI, and Geist Mono for plain text and code.
- Include `provider` and `model` in provider request bodies; supported providers are Claude, OpenAI, Codex, Cursor, and Pi.
- Keep the three-second idle countdown and 500 ms server file-flush tick. Command or Control plus Enter skips the countdown.
- Import transaction origins from `src/lib/shared/ydoc-codec.ts`; do not define local copies.

## Common mistakes

### Reconnecting after review

`disconnect()` starts a close handshake. If the HTTP response arrives before the socket closes, `connect()` can return early; the tab may then stay offline. Set `websocketProvider.shouldConnect = true` before calling `connect()` in the resume function.

Keep the five-second grace period in `onSyncConnectionChange`; report a tab that stays disconnected outside an intentional pause.

### Unloading before a file flush

Keep `onTabUnloaded` in `afterUnloadDocument`. If the tab is dirty, replay its log and flush its file before clearing the dirty flag; otherwise you can lose the last pending file write when the browser disconnects.

### Reloading server modules

Reuse `globalThis.__docwriterWsServer` across Vite reloads. Do not start a second server on the same port. Route handlers also use that instance to reach the live document.

### Importing the wrong sync key

Import `ySyncPluginKey` and relative position helpers from `src/lib/editor-extensions.ts`. The collaboration extension uses `@tiptap/y-tiptap`; the similarly named key in `y-prosemirror` is a different object. Mixing them breaks checks for local edits and comment positions.

### Replacing a whole comment thread

Keep each thread as a nested `Y.Map` with a `Y.Array` of messages. Do not call `commentsMap.set(id, {...})` with a plain object; a concurrent reply or dismissal can overwrite the other change.

Read with `readThreadValue`, `getThread`, or `readCommentThreads`. Write with `putThread`, `appendThreadMessage`, and `setThreadResolved`; use `observeDeep` on the client so you see nested changes. The load path converts older plain-object threads.

Locate threads through their text marks with `firstThreadPos` or `summarizeThreadMarks`. Check `threadUnderRange` before creating feedback so you can reply on an existing thread. Read legacy quote anchors only during migration; do not write new ones.

### Sharing state between requests

Keep the reviewer ID and feedback thread ID in the `AsyncLocalStorage` scope created by `runWithRenderScope`. Do not move them to module variables; overlapping requests would overwrite each other's IDs.

Build a fresh MCP server with `buildDocToolsMcp()` for each query. Keep `permissionMode: 'default'`; `acceptEdits` bypasses `canUseTool` for built-in file writes and can let an agent change a workspace file without review.

### Writing transcript messages

Write injected user messages as "I" and address the author as "you" in agent replies. Keep the system prompt in the author's voice. When you change trigger wording, update the matching code too; older saved messages may still use the previous wording.

### Reading formatted text

Use `Y.XmlText.toDelta()` to read text; `toString()` can include XML tags for format attributes. When you insert unformatted text, pass explicit empty attributes or use `applyDelta` with unformatted operations; a plain `insert` can inherit the preceding marks.

Use `serializeFragment` or `serializeYDoc` for committed text, and `proposedText` for agent reads and `last_seen`. Keep Markdown characters unchanged; omit proposal and AI attributes from the saved text. Use `buildView` for text-offset mapping.

Do not add StarterKit, Link, or Tiptap history to the editor. Undo is already configured through `Collaboration.configure({ yUndoOptions })` in `editor-extensions.ts`.
