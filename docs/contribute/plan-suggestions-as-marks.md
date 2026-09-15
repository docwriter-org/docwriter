# Store proposed edits in the document

Implemented in `src/lib/shared/proposals.ts`. This note describes the current design and the reasons for it.

## What you can do

You can read the agent's comments while you write; each comment card stays open. Click a card or the red struck text to see the suggested additions, click elsewhere to hide them. Your original text stays struck through until you accept or reject the edit.

You can revise a suggestion by replying on its comment thread. You can also accept, reject, or dismiss it; one undo restores the proposal and reopens the thread.

## Why the storage changed

Previously, you stored a proposal as a pair of strings in `PendingReviewRound`. After each keystroke, the browser had to match those strings to the current document and rebuild the diff. That could leave you with red text without a strikethrough, changes split inside words, or an edit still visible after you dismissed its comment.

You now store added and removed text in Yjs with marks identifying its comment thread. You compute the diff when the agent proposes an edit; the browser displays those marks as the document changes.

## Rules to keep

When you change proposal handling, keep these rules:

- Give every proposal mark a `threadId`; locate the comment by its marks on the text.
- Keep one thread per passage; refuse an edit that touches another thread's text and return that thread's ID.
- Keep text you type free of proposal marks; it must survive accepting or rejecting the surrounding suggestion.
- Replace a thread's previous proposal when the agent revises it.
- Change the text and close the thread in the same transaction when you accept, reject, or dismiss an edit.

## Stored fields

| Where you store it | Value | What it means |
| --- | --- | --- |
| Text attribute | `insertion: { threadId }` | Words the agent proposes to add |
| Text attribute | `deletion: { threadId }` | Words the agent proposes to remove |
| Text attribute | `comment: { threadId }` | Text with a comment |
| Paragraph attributes | `suggest: 'ins'` or `'del'`, plus `suggestThread: threadId` | A whole line added or removed |
| HardBreak attributes | `suggest: 'del'`, plus `suggestThread: threadId` | An existing line break removed by a structural edit |
| Text attribute | `ai: true` | Wording you accepted from the agent |
| Thread fields | `resolved`, plus `outcome` when closed | Whether you accepted, rejected, or dismissed the thread |

Keep messages in `Y.Map('comments')`; each thread is a nested `Y.Map` with a `Y.Array` of messages. The old `Y.Array('rounds')` is used only when you migrate saved proposals.

Use paragraph attributes for whole-line changes because paragraph boundaries cannot carry text marks. A paragraph usually represents one Markdown line; a paragraph with HardBreak nodes can contain several lines.

## Choose a text view

The agent reads strings, but you store paragraphs and marked text. Use `buildView` to get the text for a particular view and map its character offsets back to the document.

| View | What you get | Where you use it |
| --- | --- | --- |
| `committed` | Original text and accepted edits; pending additions are omitted | Workspace files and external file comparisons |
| `proposed` | Text as if you accepted all pending edits | `read_doc`, `old_string` matching, and the agent's last-seen comparison |
| `proposed` with `except: threadId` | Proposed text with that thread's suggestion reverted | The base for a revision on that thread |

If you type into a proposed new paragraph, keep your text in the committed view. That paragraph must also count when you map later edits to paragraph positions; otherwise a revision can duplicate your text or change the wrong paragraph.

## Create or revise a proposal

Use `proposeReplacement` for an exact text replacement, or `proposeText` for a complete proposed document.

1. Match `old_string` in the proposed view; apply `new_string` to get the desired text. For `write_doc`, use its content directly.
2. Build the base with the current thread's proposal reverted.
3. Check for another thread on the changed lines; if you find one, return an overlap error before changing anything.
4. Revert the current thread's old marks.
5. Compare the base with the desired text; write insertion and deletion marks for the changes.
6. Save the marks and any new thread in one `AGENT_ORIGIN` transaction.

For a modified line, compare words so the marks start and end at word boundaries. If the changed share exceeds `WHOLE_LINE_CHURN`, currently 0.8, strike the whole line and add its replacement as a new paragraph. The changed share is the number of added and removed characters divided by the combined length of the old and new lines.

For structural changes, mark whole paragraphs. If several changes touch one paragraph with HardBreak nodes, combine them before replacing the paragraph; otherwise you can insert its replacement more than once. Apply word edits from the end backwards so an earlier insertion does not shift the positions of later edits.

An explicit thread ID must refer to a thread in that document. If no thread ID is supplied, you create a thread for the proposal; if the supplied ID is missing, return an error.

## Accept, reject, or dismiss

Use `resolveThreadMarks` with the requested outcome:

- On `accepted`, remove the deleted text and line breaks; keep additions and mark them `ai: true`.
- On `rejected` or `dismissed`, remove additions and restore deleted text and line breaks.
- Clear the thread's comment marks in either case.

Remove a suggested paragraph only if it has no surviving text or line breaks from the author. Close the thread and set its outcome in the same `USER_ORIGIN` transaction.

For batch review, resolve every open thread with a proposal in one transaction. Return `ok: true` and the Yjs update; the browser needs both to record the action for undo.

You can reopen a closed thread to continue the conversation; use undo if you also want its proposal back.

## Keep typing and pasting predictable

Use `LocalInputMarkStrip` to remove `ai`, `insertion`, and `deletion` marks from text you type. If you type in the middle of a marked passage, the existing text on either side keeps its marks.

You can delete marked text yourself. Deleting struck text removes that part of the original; deleting green text removes that part of the suggestion.

Keep `parseHTML` rules for proposal marks and paragraph attributes; the browser can rebuild their DOM while you type. Strip proposal and comment marks in `transformPasted` instead, so copied text does not become another pending edit.

## Display comments and edits

Use CSS to color the marks and strike removed text. Keep comment cards expanded; `ThreadOverlay` controls which proposal's additions you can see.

When you focus a card or click struck text, show that thread's additions. When you click elsewhere or start typing, hide additions and keep the original text struck through. Keep the proposal data unchanged when you switch views.

Place each card beside its first marked passage. If its passage is gone, keep the card visible near the top so you can reply or dismiss it. Do not scroll to a card while you are typing in the editor.

Keep search highlights and feedback selections as browser display state. You do not need to store them with the shared document.

## Handle edits from another app

Compare the changed file with the committed view. Use `applyExternalText` to replace the changed area with the file's text; proposals outside that area stay in place.

If you replace an area containing a proposal, its marked text can disappear too. Keep the comment thread so you can ask the agent to suggest the edit again.

## Preserve undo and concurrent edits

Store agent proposals with `AGENT_ORIGIN`; do not add them to your typing undo history. Use `USER_ORIGIN` for review actions so you can undo the text change and the thread closure together.

Keep proposals in the same Yjs document as the text. If you type while an agent edit arrives, Yjs merges those document updates. If the agent's `old_string` no longer matches, return an error so it can read the current text and try again.

## Load older documents

Write a backup before you migrate pending rounds. Carry over each round whose text still matches and whose thread is open; if you cannot carry one over, leave a note on its thread. Keep the original round payload in the backup.

Use legacy comment quotes to create initial comment marks. New comments use marks for their positions; do not write new quote anchors. The document tables remain at schema version 13.

## Check changes to this code

Run `npm run check` and `npm run test:unit`. The regression tests cover word and line edits, blank lines, proposal revisions, overlaps, accept and reject, author text inside suggestions, and edits around HardBreak nodes.

In the browser, check that you can open a diff from a card or struck text; click elsewhere and make sure only the additions disappear. Reject all edits, undo once, then reload; you should have the same proposals and text you started with.
