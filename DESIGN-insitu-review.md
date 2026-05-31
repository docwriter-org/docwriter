# Design note: in-situ review + Google-Docs-style layout

Status: **implemented** (full overhaul). Captures the discussion around
[issue #16](https://github.com/shreyashankar/docwriter/issues/16) —
"couple the pending edits to the text, in situ, better."

## Problem

Today the same agent edit is shown in two places:

- the **inline diff** in the document (center pane, in situ), and
- a **pending card** in the right `showReview` sidebar (Accept / Reject / Retry).

To give feedback you have to leave the edit and hunt for its card in the
sidebar, or instantiate a fresh comment. The user wants to treat DocWriter
like a Google-Docs collaborator: click an edit in place and respond to it
right there, like commenting on a suggestion.

## Current layout (for reference)

`OutlinePane` is one component mounted twice (see `+page.svelte:2306` and
`:2393`):

- **Left** (`showOutline`): TOC from headings, with `FileTree` below it.
- **Right** (`showReview`, under `HistoryPane`): five disjoint blocks —
  review cards, comments, proposed rules, proposed hooks, and a
  "nothing pending" empty state (`OutlinePane.svelte:273–471`).

Key fact that constrains the redesign: the `showReview` sidebar is a
**cross-tab aggregate**. It subscribes to `allTabPendingRounds` and
`allTabCommentThreads` (`OutlinePane.svelte:106,109`) and sums rounds across
every open tab (`totalRounds`, `:138`). `onNavigateToRound(tabId, round)`
switches tabs to jump you to a card's home (`+page.svelte:2403`). So the
sidebar's genuinely useful job is **awareness of pending work on tabs you
aren't currently looking at** — something a pure in-situ gutter cannot do,
because the gutter can only render the tab on screen.

## Proposed layout

Five surfaces. Center is document-only — nothing non-anchored floats over it.

```
┌─ chapter-1 ─┬─ chapter-2 ● ────┬─ notes ──┐   (tab strip unchanged; pending tabs get a subtle dot)
├─────────────┴──────────────────┴──────────┤
│ TOC      │                      │ RIGHT GUTTER:        │
│          │   centered document  │  edit + comment cards│
│ Files ●  │                      │  for THIS tab only   │
│  ├ ch-1  │   ~~old~~ new ───────┼▶ (anchored, stacked) │
│  ├ ch-2 ●│                      │                      │
│  └ notes │                      │            ┌────────┐│
│          │                      │            │ 🐱 ●3  ││  collapsible
└──────────┴──────────────────────┴────────────└────────┘┘  agent dock
                       ⌃ sticky toast: "proposed a rule" → opens in dock
```

1. **Left nav column** — TOC + `FileTree`, both collapsible. Unchanged from
   today, except the FileTree gains per-file **dots** marking files with
   pending edits/comments (VS-Code style).
2. **Center** — the document only. The in-situ diff lives here; the diff is
   shown exactly once, in place.
3. **Right gutter** — anchored cards for the **active tab**: each pending
   edit and each comment thread gets a margin card next to its text, holding
   the *verb* (✓ accept / ✗ reject / reply box + thread), **not** a second
   copy of the diff. Reuses the existing `CommentGutter` machinery (Yjs
   `RelativePosition` anchoring + stacking/collision logic).
4. **Bottom-right dock** — collapsible (pill ↔ panel). Holds the agent log /
   wake / controls (today's `HistoryPane` + `AgentDock`), plus the
   **cross-tab roll-up count** so awareness survives when the FileTree is
   collapsed.
5. **Sticky toasts** — proposed rules/hooks arrive as toasts that persist
   until acted on (they need an accept/reject) and open into the dock, which
   is where you actually triage them. No separate floating proposals panel.

## Where each `showReview` block goes

| Today (`showReview` block) | Anchored? | New home |
| --- | --- | --- |
| Review cards (edits) | yes | Right gutter (active tab) |
| Comments | yes | Right gutter (active tab) — already has a gutter home |
| Proposed rules | no | Sticky toast → dock |
| Proposed hooks | no | Sticky toast → dock |
| "Nothing pending" empty state | — | Disappears (no dedicated sidebar) |
| *(cross-tab awareness, implicit)* | — | Tab dots (primary) + FileTree dots + optional dock count |

Net effect: the `showReview` `OutlinePane` instance dissolves entirely.
`OutlinePane` collapses back to a pure TOC component (and could be split out
from the review code for clarity — they share no markup today).

## Cross-tab awareness (the multi-tab wrinkle)

The gutter only shows the active tab. Pending work exists **only on open
tabs** (the agent edits live Y.Docs via `DirectConnection`; only open tabs
have one), so a file with a pending edit is always already an open tab — and
therefore always already in the tab bar.

- **Primary signal:** a subtle **dot on the tab** in the existing tab bar.
  The tab bar is always visible (the FileTree can be collapsed), the set of
  tabs is exactly the set of files that can have pending work, and the dot is
  right where you'd click to jump there. A light dot, not a count badge —
  keeps the strip clean.
- **Secondary signal:** dot on the file in the FileTree (matches the
  file-explorer mental model when the pane is open).
- **Optional:** a single roll-up count in the dock for "everything pending
  everywhere," if one number is wanted.

## Constraints / risks

- **Never float over the prose.** Anchored cards live in a *reserved* gutter
  column, never on top of the text. Only the dock and toasts float, and only
  over side/corner whitespace.
- **Expanded dock vs. low gutter cards.** Expanding the bottom-right dock
  temporarily covers the lowest gutter cards. Acceptable on-demand; if it
  grates, expand the dock as a left-ward drawer instead of straight up.
- **Stacked edits.** A paragraph with several tiny edits crowds the margin.
  `CommentGutter` already has stacking logic, but density is a real limit.
- **Narrow viewports.** Centered-doc + wide-gutter math breaks on small
  screens; need a collapse-to-strip fallback like Google Docs.

## Open decisions

1. **Does replying to an edit block its application?** Can you comment on a
   pending edit *and* still accept it (Google-Docs style), or does
   commenting mean "hold off, don't apply yet"?
2. **Roll-up placement.** Cross-tab count lives inside the dock (4 surfaces)
   vs. its own treatment (5 surfaces). Leaning: inside the dock.
3. **Does the TOC stay fixed, or also collapse** to widen the gutter lane on
   narrow screens?
