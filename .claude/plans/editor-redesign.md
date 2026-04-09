# Prose Editor Redesign

## Core Change
The prose pane becomes a real text editor (not read-only). Users type directly in it. The agent also edits it. Both coexist.

## Features

### 1. Editable Prose
- Use contenteditable or a lightweight editor (tiptap, prosemirror, or plain contenteditable with custom handling)
- Users can type, delete, paste — normal editing
- Agent edits show up as diffs (existing feature)
- The .atomz file's prose section stays in sync with what's in the editor

### 2. Pinned Words — Two Types
- **Atom-pinned** (from atom's `pinnedWords[]`): shown with indigo underline. Cannot be edited or deleted in the editor. Agent must preserve them.
- **Editor-pinned** (user pins directly in prose): shown with a different color (e.g., amber). Also cannot be edited or deleted. Stored separately — maybe `editorPinnedRanges` in the .atomz file.
- Example: user types "Dear Professor Smith," and pins it. The agent can't touch it during rewrites.

### 3. Markdown / Headings
- Prose renders as markdown — headings, bold, italic, lists
- **Headings are NOT atoms** — they're structural markers. They appear in the atoms pane as section dividers (like paragraph breaks but labeled)
- Editing a heading in either pane updates both
- Store headings in the .atomz format: `sections: [{ title: "Introduction", beforeAtomIndex: 0 }, ...]`

### 4. Auto-Queue on Typing Pause
- When user types in the editor, start a 15s idle timer
- If no keystrokes for 15s, queue the changes as feedback with the diff
- Agent decides what to do based on the nature of the edit:

**Style edit** (phrasing changed, meaning same): Leave atoms alone. The user just prefers different wording. Maybe pin the new words if they're distinctive.

**Content edit** (new meaning, new sentences): Create new atoms, update existing ones. E.g., user types a new paragraph → agent decomposes it into atoms and adds them.

**Deletion**: User removed text → agent removes or simplifies corresponding atoms.

The prompt to the agent includes the diff and says: "The user directly edited the prose. Determine if this changes the content (update atoms) or just adjusts the style (leave atoms, maybe pin distinctive words). Here's the diff: [before] → [after]"

The agent has full context from the session to make this judgment.

### 5. .atomz Format Changes
```json
{
  "atoms": [...],
  "rules": [...],
  "paraBreaks": [...],
  "sections": [
    { "title": "Introduction", "beforeAtomIndex": 0 },
    { "title": "Related Work", "beforeAtomIndex": 3 }
  ],
  "prose": [...],
  "editorPins": [
    { "text": "Dear Professor Smith,", "sentenceId": 0 }
  ]
}
```

### 6. Editor Choice
Options:
- **contenteditable + custom** — simplest, full control, but handling cursor/selection is painful
- **tiptap** (prosemirror-based) — mature, extensions for pinned words, markdown, collaborative editing
- **lexical** — Facebook's editor, lighter than prosemirror

Recommendation: **tiptap** — it has extensions for marks (pinned words), nodes (headings), and works well with Svelte.

### 7. Suggesting Mode — User Edits Look Different
- Agent-written text: normal appearance
- User-edited text: subtle distinct style — light colored background (e.g., light blue) or left border
- Like Google Docs "suggesting mode" but always on
- When the agent processes the edit and accepts it (updates atoms or decides it's a style preference), the highlighting fades and the text becomes "agent-accepted"
- Stored as a mark in tiptap: `userEdit` mark with a timestamp, cleared when agent processes it

## Implementation Order
1. Replace static prose display with tiptap editor
2. Sync editor content ↔ prose store ↔ .atomz file
3. Pinned word marks (two types, non-editable)
4. Markdown headings as section markers
5. Auto-queue on typing pause
6. Bidirectional heading sync with atoms pane
