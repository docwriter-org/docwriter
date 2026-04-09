# Proposed Features v2

## Core Principle: Prose is a Reactive View of Atoms

The prose pane is NOT a separate document you manually sync with a refresh button. It's a **live view** — like a spreadsheet formula that recomputes when inputs change. Any change to atoms, feedback on prose, or user manipulation should automatically trigger the agent to update the view.

### The Queue Model

All user actions go into a queue. The agent continuously drains the queue:

```
User actions → Queue → Agent processes batch → Prose updates → Wait for next batch
                ↑                                    |
                |                                    ↓
                ←── Agent may also update atoms ←────
```

**Queue items** (any of these trigger an agent iteration):
- Atom edited (subject or predicate changed)
- Atom added / removed / reordered
- Feedback annotation added on prose text
- Word pinned/unpinned in predicate
- Rule added/removed
- Paragraph break toggled

**Batching**: The agent waits ~500ms after the last queue item before processing. If more items arrive during that window, they batch together. This prevents firing on every keystroke but stays responsive.

**Agent iteration**: Each batch becomes ONE follow-up message to the resumed session:
```
"Changes since last render:
- Atom f1: subject changed from 'LLMs' to 'Large language models'
- Annotation on sentence 2: 'too verbose'
- New atom f5 added after f4: subject='caching', predicate='reduces latency'
Please update the prose to reflect these changes."
```

The agent has full context from the session, so this is a short delta message — not a full re-prompt.

### Bidirectional Flow

Changes flow in BOTH directions:

**Atoms → Prose** (already works):
- Edit an atom → prose updates

**Prose → Atoms** (new):
- Pin a word in the prose → that word gets pinned in the atom's `pinnedWords`
- Add substantial text to prose → agent should suggest new atoms or update existing ones
- Feedback on prose ("too verbose") → agent rewrites that sentence AND may simplify the atom

**Atoms ↔ Prose are always in sync**. The refresh button becomes a "force full re-render" escape hatch, not the primary mechanism.

---

## Feature 1: Reactive Queue System

### Implementation

```typescript
// New store: action queue
interface QueueItem {
  type: 'atom_edit' | 'atom_add' | 'atom_remove' | 'atom_reorder' |
        'feedback' | 'pin_word' | 'rule_change' | 'para_break';
  description: string;  // Short delta for the agent
  timestamp: number;
}

export const actionQueue = writable<QueueItem[]>([]);
```

**In +page.svelte**: Subscribe to `actionQueue`. When it's non-empty, start a debounce timer (500ms). When timer fires:
1. Drain the queue
2. Compile items into one short follow-up message
3. Send to `/api/render` with `resume: sessionId`
4. Agent processes and updates prose
5. Stream results back (diffs, tool calls, etc.)

**Remove**: `pendingSelectiveRender` store. Replace with queue pushes from ContentPane, RulesPanel, ProsePane.

**Keep**: Refresh button as manual "force full re-render" (rebuilds from scratch, no queue).

---

## Feature 2: Agent Thought Sidebar (Always Updating)

### Design
- Stream EVERY text delta live as it arrives (not batched at end)
- Tool calls show streaming input (name appears on `tool_call_start`, args type in from `input_json_delta`)
- Bouncing atom indicator at bottom of sidebar while agent is working
- Queue status: show "3 pending changes..." when items are queued but not yet sent
- Compact: tool calls are one-line summaries, expandable on click

### Implementation
1. In `readSSE()`, push `assistant_text` entries on EVERY delta, appending to the last entry instead of batching
2. Add `tool_streaming` state: when `tool_call_start` arrives, show a live entry that accumulates `input_json_delta` text
3. Bouncing atom component: simple CSS animation, shown when `actionQueue` is non-empty or agent is rendering
4. Queue indicator: "2 changes queued • processing in 0.3s" above the entries list

---

## Feature 3: Atom Manipulation

### 3a. Add Atom / Atom Group
- **Add atom button**: "+" at bottom of atom list and between groups
- **Inline creation**: Opens a two-field form (subject, predicate) right where you clicked
- **Add to group**: "+" inside a group adds a child atom
- **Auto-trigger**: Adding an atom queues `atom_add` → agent writes a new sentence for it

### 3b. Rearrange Atoms
- **Drag within groups**: Reorder children (already works for top-level)
- **Drag between groups**: Move a child from one parent to another
- **Promote/demote**: Drag child to top-level, or top-level into a group
- **Auto-trigger**: Reorder queues `atom_reorder` → agent may adjust prose transitions

### 3c. Pin Words in Predicate
- **Click a word** in the atom's predicate text → it gets "pinned" (underlined, bolded)
- **Pinned words** are guaranteed to appear verbatim in the rendered prose
- **Storage**: `pinnedWords: string[]` on Fragment
- **Agent constraint**: Prompt includes: `"Words [paradigm, fundamentally] MUST appear verbatim."`
- **Bidirectional**: If you select a word in the PROSE and pin it, the atom's pinnedWords updates too

### 3d. Atom Alternatives Carousel
- **Click an atom** → popover shows 3-4 alternative (subject, predicate) pairs
- **Generated by agent** (use Haiku for speed — separate lightweight call, not the main session)
- **Carousel UI**: Horizontal cards, click one to adopt it
- **Context-aware**: The agent sees the surrounding atoms and prose, so alternatives fit the narrative
- **Implementation**: New `/api/alternatives` endpoint, takes atom + surrounding context, returns alternatives array

---

## Feature 4: LRU Actions Toolbar

### Current State
Pinned actions (Too verbose, AI smell, Clunky, Inaccurate, Add example) + recent custom actions.

### Design Questions
- Should applying an action auto-trigger the agent? (Yes — it goes into the queue as `feedback`)
- Should the toolbar show action frequency? (Maybe — fade actions that haven't been used recently)
- Should actions be tied to rules? After flagging "AI smell" 5 times, suggest promoting it to a permanent rule?

### Proposed Behavior
1. Select an action → highlight text → annotation created → `feedback` queued
2. Agent processes: reads the annotation, rewrites the sentence, clears the annotation
3. If the same action is used 5+ times in a session, sidebar suggests: "Promote 'AI smell' to a rule?"
4. Custom actions auto-populate from free-form feedback (already works)
5. Toolbar order: most-recently-used first, rarely-used fade to overflow

---

## Feature 5: Onboarding & Reference Imports

### Flow
1. User uploads inspo writing or own writing
2. A **subagent** atomizes it in the background (doesn't block main session)
3. Result stored in `.claude/skills/atomz-style/examples/` as reference
4. `SKILL.md` tells the render agent: "Read reference files to match the user's style"
5. Render endpoint includes `settingSources: ['project']` and `allowedTools: [..., 'Skill']`

### Subagent for Background Work
```typescript
query({
  prompt: "Atomize this text and analyze the writing style",
  options: {
    agents: {
      'style-analyzer': {
        description: 'Analyzes writing style and atomizes reference text',
        prompt: '...',
        tools: ['Read', 'Write']
      }
    },
    allowedTools: ['Agent']
  }
})
```

### Reference File Format
```json
{
  "source": "uploaded-essay.txt",
  "style_notes": "Short sentences, active voice, concrete examples, no hedging",
  "atoms": [...],
  "sentences": [...]
}
```

---

## Priority Order

1. **Reactive queue system** — Foundation for everything else. Remove manual refresh dependency.
2. **Agent thought sidebar** — Always-updating, bouncing atom, queue status. Makes latency feel acceptable.
3. **Add atom / atom group** — Can't use the tool without creating atoms.
4. **Pin words** — Unique differentiator, simple data model change.
5. **LRU toolbar auto-trigger** — Feedback → queue → agent rewrites. Closes the loop.
6. **Atom alternatives carousel** — Delightful discovery feature.
7. **Onboarding / reference imports** — Most complex, builds on everything above.

## Layout

Current: `[Atoms (left, 360px)] [Prose (center, flex)] [History (right, 300px)]`

**New**: `[Prose (left)] [Atoms (center, primary)] [History (right)]`

Atoms are the primary object of manipulation — they belong in the center. Prose is a view/output — it goes on the left. History is the agent log — stays on the right but wider.

**Resizable panels**: All three panel dividers are draggable. User can resize any panel. Store widths in localStorage. Implement with a simple drag handle on each border (cursor: col-resize, mousedown → track delta → update flex-basis).

## Architecture: Filesystem as Source of Truth

The UI is a VIEW into ONE file on disk. Not in-memory stores with manual save/load.

### One File: `document.atomz`

Everything lives in a single `.atomz` file. The prose is NOT a separate file — it's part of the document. The agent reads and edits this one file.

```
/project/document.atomz      # THE file. Contains atoms + prose + rules + metadata.
```

### `.atomz` File Format (JSON)

```json
{
  "atoms": [
    {
      "id": "f1",
      "subject": "LLMs",
      "label": "changed human-computer interaction",
      "pinnedWords": [],
      "children": [
        { "id": "f1a", "subject": "users", "label": "can express intent in natural language", "pinnedWords": [], "children": [] }
      ]
    }
  ],
  "rules": ["No em dashes", "No generic AI openers"],
  "paraBreaks": [1],
  "prose": [
    { "id": 0, "frags": ["f1"], "para": 0, "text": "Large language models have fundamentally changed how people interact with computers." },
    { "id": 1, "frags": ["f1a"], "para": 0, "text": "Users can now express complex intent in natural language." }
  ]
}
```

### Why JSON
- Agent is trained on JSON — most reliable format for Edit tool string replacements
- Zero parsing ambiguity — `JSON.parse()` always works
- Agent uses Edit to replace specific `"text"` values — doesn't need to rewrite the whole file
- File checkpointing covers the entire document state
- One file = one source of truth, no sync between separate files

### Flow
```
User edits atom in UI
  → writes updated document.atomz to disk (auto-save, debounced 100ms)
  → queues agent update
  → agent reads document.atomz, uses Edit to update the PROSE section
  → UI reads the file back, updates both atoms and prose views
```

### Agent Instructions
"The file `document.atomz` is JSON containing `atoms`, `rules`, and `prose`. Read the file, then use Edit to replace specific `"text"` values in the `prose` array to reflect the current atoms. Do not modify the atoms or rules sections."

### Implementation
1. On any change (atom edit, rule change, paraBreak toggle), serialize full state to `document.atomz` and write to disk
2. Agent gets: "Edit `document.atomz` — update prose text values to reflect the atoms"
3. After agent finishes, `JSON.parse()` the file, update UI from parsed data
4. `Save` button → "Save As" (export copy). The working file auto-saves
5. `Open` → loads `.atomz` file as the working document

## Architecture Notes

- **One persistent session per document**: `resume: sessionId` on every agent call. The session accumulates full editing history.
- **Short follow-up messages**: Never re-prompt with all atoms. Just send the delta: "Atom f1 changed, annotation added on sentence 2."
- **Queue batching**: 500ms debounce. Multiple rapid changes become one agent call.
- **Bidirectional sync**: Prose changes can update atoms (pin words, suggest new atoms). Atom changes update prose.
- **Filesystem is source of truth**: UI reads from files. Agent writes to files. No in-memory-only state.
