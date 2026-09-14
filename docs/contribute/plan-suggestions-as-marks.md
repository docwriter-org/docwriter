# Plan: proposals as marks in the document

Status: implemented (see `src/lib/shared/proposals.ts`). Replaced the pending-round model.

## The problem

Three user-visible bugs (red text with no strike, sub-word diff fragments,
a diff left behind after its thread was dismissed) are each a symptom of
one of three structural facts:

1. **A proposal is a pair of strings, not document content.** A
   `PendingReviewRound` holds `beforeMd` / `afterMd` and the editor keeps
   the pre-edit text. On every keystroke the client re-derives where the
   proposal lives: align the round against a baseline, line-diff, then a
   character diff per paragraph, then ghost widgets for the added text.
   That is `diff-overlay.ts` (1,200 lines), the `stale` concept (33 files),
   and the reveal / collapse state that hides additions until a card is
   focused.
2. **Threads and proposals are two tables joined by a soft key.**
   `feedbackThreadId` is set by whichever of three code paths made the
   round. When it points at the wrong thread the proposal is orphaned, and
   the comment overlay and the diff overlay each paint the same text with
   no knowledge of the other.
3. **Diff granularity is chosen at paint time** by a character-level
   algorithm, so "makes this" renders as `mak~~es~~ th~~is~~` with the
   replacement hidden.

Threads also anchor three ways at once (quote, occurrence index, and
optional relative positions the client backfills), and 118 call sites
reconcile them.

## The model

A proposal is track changes inside the CRDT, the way Word and Google Docs
represent a suggestion. Nothing is computed at render time.

Prior art, so the shape is not novel: in the Google Docs data model the
body holds both the suggested text and the text suggested for removal,
each text run carries `suggestedInsertionIds` / `suggestedDeletionIds`,
and a read specifies a view mode (inline, preview as accepted, preview
without). Word's tracked changes are `w:ins` / `w:del` runs with an
author. The ProseMirror suggest-changes packages use insertion and
deletion marks with ids. This plan is that model with two deliberate
narrowings, called out below: one thread per passage, and a paragraph
attribute where Docs uses a `\n` character.

Invariants:

- **A thread owns its marks.** Every mark carries a `threadId`. A thread's
  anchor is the set of its marks. There is no other anchor field and no
  separate proposal record.
- **Text belongs to exactly one thread or to no thread.** A proposal may
  not touch text that carries another thread's marks. The server rejects
  the write and names the thread to use.
- **Author text is never inside a proposal.** Text the author types
  carries no `insertion` or `deletion` mark, the same rule the `ai` mark
  already follows.
- **A thread's proposal is replaced whole.** A new proposal on a thread
  first reverts that thread's marks, then applies.
- **Accept, Reject and Dismiss are one operation:** resolve the thread
  with an outcome (`accepted` / `rejected` / `dismissed`), and convert or
  revert its marks in the same `USER_ORIGIN` transaction.

Data:

| Where | What | Meaning |
| --- | --- | --- |
| text format `insertion: {threadId}` | proposed new text | green |
| text format `deletion: {threadId}` | text proposed for removal | red, struck |
| text format `comment: {threadId}` | a comment with no edit | amber underline |
| paragraph attr `suggest: {threadId, op: 'ins' \| 'del'}` | a whole line added or removed | whole-line green / red |
| text format `ai: true` | accepted agent text | provenance color (exists today) |
| thread `outcome` | `open` / `accepted` / `rejected` / `dismissed` | replaces `resolved`; keeps history |

Whole-line marks exist because a paragraph boundary is not a character:
a blank line, a split, or a join cannot be expressed with text marks.
One paragraph node is one markdown line (`serializeFragment` joins nodes
with `\n`), so line-level and paragraph-level are the same thing.

The `Y.Array('review')` goes away. `Y.Map('comments')` stays for messages
but loses `anchor` and gains `outcome`.

## Views of a document

The agent speaks in strings (`old_string`, `new_string`, what `read_doc`
returns) and the document is a tree of paragraphs with marked text, so
something has to turn the tree into a string and map a match in that
string back to tree positions. Today that is done in three places:
`serializeFragment` on the server, `buildCharIndex` in the browser, and
`materializePendingReviewText`. This is not a new layer; it is the
existing `ydoc-codec.ts` serializer made view-aware, and it becomes the
only such place. One function walks the fragment once and returns three
strings with a char-to-position map for each:

- **committed**: no `insertion` text, with `deletion` text, no `ins`
  paragraphs. What the author has actually accepted. `document.md`,
  the external-edit rebase, and the markdown backup use this. It is what
  they see today.
- **proposed**: with `insertion` text, no `deletion` text. What `read_doc`
  returns and what the prompt's `last_seen` diff is taken over. Unchanged
  from today's `materializePendingReviewText`.
- **proposed except thread T**: `proposed` with T's marks reverted. The
  base a revision of T is diffed against.

Nothing else in the codebase may convert between text offsets and
document positions.

## Writing a proposal

`edit_doc` and `write_doc` reduce to one server function:

```
propose(doc, threadId, after: string)
```

1. `old_string` is matched in the **proposed** view (the text the agent
   read). `after` is that view with the replacement applied. `write_doc`
   passes its content as `after` directly.
2. Compute `base = proposedExcept(threadId)`.
3. If the changed span of `base` intersects any mark from another thread,
   fail with: "that passage is under thread X; call `edit_doc` with
   `thread_id: X`, or reply there first." This is the existing
   reply-before-edit bounce, extended to cover the one-thread-per-passage
   rule.
4. Revert `threadId`'s marks.
5. Line-diff `base` against `after`. For a one-to-one modified line, word
   diff it and write `deletion` / `insertion` text marks; if the churn is
   above the existing 80% threshold, mark the whole old line `del` and
   insert the new line marked `ins` instead. Added and removed lines get
   the paragraph attr. Blank-line changes are paragraph-attr changes.
6. One `AGENT_ORIGIN` transaction; the thread is created first if it does
   not exist.

Granularity is decided here, once, and stored. The word diff is a real
word tokenizer, not `diff-match-patch` on characters.

Mute mode (agent threads hidden) is a CSS class on the editor root that
renders the marks neutrally and hides the cards. It never hides text.

## Resolving a thread

```
resolve(doc, threadId, outcome)
```

- `accepted`: `insertion` marks become `ai: true`; `deletion` text and
  `del` paragraphs are removed; `ins` paragraphs lose the attr.
- `rejected` / `dismissed`: `insertion` text and `ins` paragraphs are
  removed; `deletion` and `del` marks are stripped; `comment` marks are
  stripped.
- Thread `outcome` is set. One `USER_ORIGIN` transaction, so undo brings
  the marks and the open thread back together.

Batch accept is a loop. There is no stale case: a proposal is content, so
there is nothing to fail to match later. The stale-accept rebase flow, the
`baseHash`, the batch `skippedStale` report and the prompt's rebase
instructions are deleted.

A thread that has been accepted or rejected is resolved. That is what
Word and Google Docs do, and the gutter already has a resolved view
(`include_dismissed` for the agent, Reopen for the author). Today
`followAcceptedEdits` re-anchors the thread to the inserted text instead;
that code goes.

## Author typing

- Typed text strips `insertion` and `deletion` (the `ai` rule, extended).
  Typing inside a proposal splits it; both halves still belong to the
  thread and resolve together.
- Typing inside a `comment` range extends it (inclusive mark), except at
  its edges.
- The author deleting marked text is allowed. Deleting `deletion` text
  accepts that piece by hand; deleting `insertion` text rejects it. Both
  are consistent because the marks are on content.
- Clipboard: the three marks define no `parseHTML`, so copied proposal
  text pastes as plain text and never re-enters as a proposal.

## Rendering

- Three Tiptap marks and one paragraph attribute, all pure CSS. Strike is
  `text-decoration`, highlights use `background-color`, so no rule can
  erase another (the cause of the red-without-strike bug).
- No diff overlay, no comment overlay decorations, no baseline, no
  revealed set, no insertion caret. Additions are always visible.
- The gutter positions a card at the first document position carrying the
  thread's marks, found by one walk of the document per version. A thread
  with no marks (its text was deleted around it) is parked at the top, as
  today.
- Transient view state (find-in-doc, the selection highlight while the
  feedback popup is open) stays a decoration.

## What this removes

- `src/lib/editor/diff-overlay.ts`, the decoration half of
  `comment-overlay.ts`, `review-rounds.ts`, `review-diff.ts`, `diff.ts`.
- `PendingReviewRound`, the review `Y.Array`, `materializePendingReviewText`,
  `applyEditToFragment`, `narrowWriteOperation`, `followAcceptedEdits`.
- `stale-accept.ts`, `requeueStaleAccept`, the revise-in-place re-base in
  `runTabWrite`, `baseHash`, `skippedStale`.
- `CommentThreadAnchor` (quote, occurrence, relative positions) and
  `resolveAnchorPMRange` / `resolveThreadRange` / occurrence counting.
- The reveal / pin / expanded state and the "Proposed text moves below"
  note.

What stays untouched: Hocuspocus, the update log, `documents`,
`last_seen`, the render route, the provider layer, the feedback ledger,
critique passes, the `ai` provenance mark, the undo manager, hooks,
scratch files, binary tabs.

## Issues considered

**Structural edits.** Text marks alone cannot add or remove a line. Docs
avoids this because its paragraph break is a character that can carry a
suggestion id; ProseMirror has no boundary character. The paragraph
attribute covers it, and the accept / reject rules for a `del` / `ins`
paragraph are the same as for marked text. This is the one addition to
"everything is a text mark" and it is unavoidable here.

**Overlapping proposals.** Docs and Word let one author suggest deleting
another author's suggested insertion and render it nested. Any model
that allows that needs an ordering and a rebase story; that is where
today's stale machinery came from. There is one agent here, so the
one-thread-per-passage rule removes the case rather than handling it.
Cost: an agent that wants to change a passage another thread covers must
use that thread. That is already what the prompt tells it to do.

**Which view the agent reads.** `read_doc` keeps returning the proposed
view so the agent reasons about the resulting text and `old_string`
keeps its meaning. The alternative (CriticMarkup in `read_doc`) would put
markup inside `old_string` and was rejected. The thread listing shows
each thread's proposal as before / after text derived from its marks.

**The revision base.** When the agent revises thread T it read the
proposed view, which includes T's own insertions. Diffing against
`proposedExcept(T)` after reverting T's marks reconstructs a valid
proposal from `after` alone. This is the one piece of subtle logic and it
is server-side and unit-testable. Today's revise-in-place re-base is the
same idea done with strings and a special case.

**External edits.** The rebase folds the file's text into the committed
view. A file edit that rewrites a passage under proposal takes the
proposal's text with it; the thread parks and the author sees "passage no
longer in the document". Same outcome as today, but it happens through
the CRDT rather than a failed string match.

**Undo.** Proposals land with `AGENT_ORIGIN` and are not on the author's
undo stack, as today. Resolve is one `USER_ORIGIN` transaction. The
review array leaves the undo scope; nothing else changes.

**Big rewrites.** A `write_doc` that replaces most of the document marks
most of the document. That is what the author asked for and it reads as
a tracked-changes draft. No special case.

**Concurrency.** Marks are on content, so an author typing while a
proposal lands converges by Yjs item merge. There is no baseline to drift
from.

**Performance.** No diff runs in the browser. Rendering marks is native
ProseMirror work. The gutter walk is one linear pass per document
version.

**`Y.Text.insert` inherits the preceding format** (documented gotcha).
Server writes go through `applyDelta` with explicit attributes, as the
provenance code does today.

**Migration.** On first load of a document with a review array, each
pending round whose `old_string` still matches is converted to marks on
its thread; any that does not match is dropped and its thread gets a
system message saying so. A backup is written first (the `backups/`
mechanism). Legacy `anchor` fields are read once to set an initial
`comment` mark, then ignored. Schema bumps to v14.

**Mute.** Cannot hide content. It renders marks neutrally and hides the
cards. A true "preview as accepted" view is possible later as CSS, but
`display: none` on inline text breaks caret movement, so it is not in
this plan.

## Decisions

1. **Accept resolves the thread.** Matches Word and Google Docs. The
   alternative, keeping it open re-anchored to the new text, is what
   `followAcceptedEdits` does today and is the source of the parked
   orphan cards. An author who wants to continue the conversation
   reopens the thread.
2. **An overlap is an error to the agent**, naming the covering thread.
   Silently attaching to that thread would skip the reply-before-edit
   contract, which is what keeps a bare diff from landing with no
   explanation.

## Sequence

1. **Server, additive.** Codec: the three views, `propose`, `resolve`,
   the paragraph attribute. Unit tests for word-level, line-level, blank
   lines, revision of an existing proposal, the overlap error, accept and
   reject round trips, and the committed / proposed views. No UI change.
2. **Cutover.** Tools and provider handlers call `propose`. The client
   registers the marks and attribute, the gutter reads marks, resolve
   replaces accept / reject / dismiss. Migration on load. Prompt text loses
   the rebase instructions and the tool schema says to pass the thread id
   from `comment_doc`. `state-consistency.test.ts` invariants updated.
3. **Delete.** Everything under "What this removes". `npm run check` and
   `npm run test:unit` green with the removed files gone. CLAUDE.md and
   `docs/contribute/architecture.mdx` rewritten for the new model.

Done means: the three bugs cannot be reproduced, the document never
shows an un-actionable proposal, and no client code diffs strings.
