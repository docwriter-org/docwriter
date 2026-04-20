# DocWriter server-authoritative Y.Doc refactor — phased plan

This is the execution plan for the architectural refactor that moves DocWriter's Y.Doc from the browser (IndexedDB) to the server (SQLite), replaces the SDK's built-in `Edit`/`Write` on tab paths with custom MCP tools, and deletes the 3-way merge + shadow machinery.

Each phase is separately mergeable. Phase 3 is the point of no return — before it, both persistence paths exist; after it, the server is authoritative and rollback requires manual data work.

All new Yjs origin names use constants from `src/lib/yjs-agent.ts` (`AGENT_ORIGIN`, `AGENT_APPLY_KEY`). All new SQLite access goes through `src/lib/server/db.ts` (`getDb()`).

---

## Phase 1 — SQLite scaffolding ✅ SHIPPED (commit `ead57b5`)

Added `better-sqlite3`, schema for `yjs_updates` / `tabs` / `rules` / `hooks` / `recent_actions` / `action_usage_counts` / `kv`, a migrator (`PRAGMA user_version` based), a one-shot seeder that populates from existing `.docwriter/state.json` / `hooks.json`, and dual-write hooks in every writer of those JSON files. JSON remains the source of truth. DB is a verified mirror.

Verified working on a tmp workspace. No further action required.

---

## Phase 2 — WebSocket Y.Doc sync (additive, alongside IndexedDB)

**Goal:** Bring up a server-side Y.Doc registry backed by the `yjs_updates` SQLite table from Phase 1, plus a WebSocket sync endpoint. Client attaches a WebSocket provider *alongside* the existing `y-indexeddb` provider. Both sync the same Y.Doc. No existing behavior changes. This phase verifies that the server can persist and hydrate Y.Doc state correctly before Phase 3 flips the switch.

### Dependencies

- Server: `@hocuspocus/server`
- Client: `@hocuspocus/provider`

`npm install @hocuspocus/server @hocuspocus/provider`

### New files

**`src/lib/server/ydoc-persistence.ts`** — SQLite ↔ Y.Doc bridge.

```ts
import * as Y from 'yjs';
import { getDb } from './db';

/** Load a Y.Doc by replaying all its updates from yjs_updates in seq order.
 *  Preserves origin via `ydoc.transact(() => applyUpdate(...), origin)` so the
 *  UndoManager (constructed fresh) correctly observes agent vs. user origins. */
export function loadYDoc(tabId: string): Y.Doc {
  const ydoc = new Y.Doc();
  const rows = getDb()
    .prepare(`SELECT "update", origin FROM yjs_updates WHERE tab_id = ? ORDER BY seq`)
    .all(tabId) as Array<{ update: Buffer; origin: string }>;
  for (const row of rows) {
    ydoc.transact(() => Y.applyUpdate(ydoc, new Uint8Array(row.update)), row.origin);
  }
  return ydoc;
}

/** Append a single Yjs update. Called from Hocuspocus onChange. */
export function appendUpdate(tabId: string, update: Uint8Array, origin: string) {
  getDb()
    .prepare(`INSERT INTO yjs_updates (tab_id, "update", origin, created) VALUES (?, ?, ?, ?)`)
    .run(tabId, Buffer.from(update), origin, Date.now());
}

/** Merge a tab's update log into one compacted row. Run in a timer or on
 *  tab close; not on the hot path. */
export function compactTab(tabId: string) {
  const db = getDb();
  db.transaction(() => {
    const rows = db
      .prepare(`SELECT "update" FROM yjs_updates WHERE tab_id = ? ORDER BY seq`)
      .all(tabId) as Array<{ update: Buffer }>;
    if (rows.length < 2) return;
    const merged = Y.mergeUpdates(rows.map((r) => new Uint8Array(r.update)));
    db.prepare(`DELETE FROM yjs_updates WHERE tab_id = ?`).run(tabId);
    db.prepare(
      `INSERT INTO yjs_updates (tab_id, "update", origin, created) VALUES (?, ?, ?, ?)`
    ).run(tabId, Buffer.from(merged), 'system', Date.now());
  })();
}
```

Remember: `update` is a SQLite reserved word; always quote it as `"update"`.

**`src/lib/server/ydoc-registry.ts`** — in-memory Y.Doc + UndoManager per tab.

```ts
import * as Y from 'yjs';
import { loadYDoc } from './ydoc-persistence';

export const AGENT_ORIGIN = 'agent'; // match the browser's yjs-agent.ts

interface TabYDocEntry {
  ydoc: Y.Doc;
  undoManager: Y.UndoManager;
  reviewMap: Y.Map<unknown>;
}

const registry = new Map<string, TabYDocEntry>();

export function getTabYDoc(tabId: string): TabYDocEntry {
  let entry = registry.get(tabId);
  if (!entry) {
    const ydoc = loadYDoc(tabId);
    const xmlFragment = ydoc.getXmlFragment('default');
    const reviewMap = ydoc.getMap('review');
    const undoManager = new Y.UndoManager(xmlFragment, {
      trackedOrigins: new Set([AGENT_ORIGIN])
    });
    entry = { ydoc, undoManager, reviewMap };
    registry.set(tabId, entry);
  }
  return entry;
}

export function destroyTabYDoc(tabId: string) {
  const entry = registry.get(tabId);
  if (entry) {
    entry.undoManager.destroy();
    entry.ydoc.destroy();
    registry.delete(tabId);
  }
}
```

**`src/lib/server/ws-server.ts`** — Hocuspocus setup.

```ts
import { Server } from '@hocuspocus/server';
import { getTabYDoc } from './ydoc-registry';
import { appendUpdate } from './ydoc-persistence';

export function createWsServer(port: number) {
  return Server.configure({
    port,
    async onLoadDocument({ documentName: tabId }) {
      return getTabYDoc(tabId).ydoc;
    },
    async onChange({ documentName: tabId, update, context }) {
      const origin = (context as any)?.origin ?? 'user';
      appendUpdate(tabId, update, origin);
    }
  });
}
```

### Modified files

**`src/hooks.server.ts`** — start Hocuspocus on a separate port.

```ts
// After the existing seedFromJsonFilesIfNeeded() call:
import { createWsServer } from '$lib/server/ws-server';

const WS_PORT = parseInt(process.env.DOCWRITER_WS_PORT ?? '', 10) || 3001;
let wsServer: ReturnType<typeof createWsServer> | null = null;

if (!wsServer) {
  try {
    wsServer = createWsServer(WS_PORT);
    wsServer.listen();
    console.log(`[docwriter] Y.Doc sync listening on ws://localhost:${WS_PORT}`);
  } catch (err) {
    console.error('[docwriter] failed to start Y.Doc WebSocket server:', err);
  }
}
```

**`src/lib/yjs-doc.ts`** — attach `HocuspocusProvider` alongside the existing persistence.

```ts
import { HocuspocusProvider } from '@hocuspocus/provider';

// Alongside `new IndexeddbPersistence(tabId, ydoc)`:
const WS_URL = `ws://${location.hostname}:${import.meta.env.PUBLIC_DOCWRITER_WS_PORT || 3001}`;
const wsProvider = new HocuspocusProvider({
  url: WS_URL,
  name: tabId,
  document: ydoc
});
// Track in the registry so destroyTab() can clean up.
```

Expose the WS port via `PUBLIC_DOCWRITER_WS_PORT` env so dev/prod can set it.

### Out of scope for Phase 2

- Removing `IndexeddbPersistence` (that's Phase 3).
- Removing `PUT /api/document` autosave (Phase 3).
- Custom MCP tools (Phase 4).
- Shadow removal (Phase 6).
- Markdown flush from server (Phase 3 will add; for now, existing client autosave continues writing `document.md`).

### Acceptance criteria

- `npm run check` passes.
- `npm run dev` starts cleanly; log shows `Y.Doc sync listening on ws://localhost:3001`.
- Open a tab, type a few characters. `sqlite3 .docwriter/docwriter.db "SELECT COUNT(*) FROM yjs_updates WHERE tab_id = '<tabId>'"` returns a growing number.
- Restart the server. Browser reconnects (`y-websocket` handles this). Content is intact. (IndexedDB would've preserved it anyway, but the server-side path should also work standalone — verify by wiping IndexedDB in DevTools and refreshing.)
- Open a second browser tab to the same workspace; typing in one reaches the other via the WebSocket sync.

### Risks

- **Port conflict**: 3001 collides with whatever else is running. Document the env var.
- **Hocuspocus version skew**: make sure `@hocuspocus/server` and `@hocuspocus/provider` are aligned on a version.
- **Yjs version match**: `@hocuspocus/*` may bundle its own `yjs`; ensure it matches the app's `yjs` version to avoid cross-package isolate issues. If conflict, pin via `overrides` in `package.json`.

---

## Phase 3 — Cut over to server-authoritative

**Goal:** Flip the switch. WebSocket is the only Y.Doc transport. Drop IndexedDB on the client. Drop `PUT /api/document` autosave. Server writes `document.md` from its Y.Doc on a debounce.

### Modified files

**`src/lib/yjs-doc.ts`** — remove `IndexeddbPersistence`. Keep only `HocuspocusProvider`. `whenYDocReady(tabId)` now awaits the provider's `synced` promise instead of IndexedDB.

**`src/lib/editor/TiptapEditor.svelte`** — `onEditorUpdate` no longer calls `scheduleAutosave`. Remove `scheduleAutosave`, `writeToDisk`, `lastWrittenMd`, and related state. `userMd.set(md)` stays (the store still serves outline + local readers). Simplify the update policy table:

| Kind | Idle timer |
|---|---|
| `yjs-remote` | skip |
| `agent-apply` | skip |
| `user-edit` | restart |

No more autosave column.

**`src/lib/server/ydoc-persistence.ts`** — add a debounced markdown flush. When `appendUpdate` fires, schedule a 1s timer per tab: serialize the Y.Doc's XmlFragment to markdown and `writeFileSync` it to the tab's real workspace path.

```ts
const markdownFlushTimers = new Map<string, NodeJS.Timeout>();

export function scheduleMarkdownFlush(tabId: string, ydoc: Y.Doc) {
  const existing = markdownFlushTimers.get(tabId);
  if (existing) clearTimeout(existing);
  markdownFlushTimers.set(tabId, setTimeout(() => {
    const markdown = serializeYjsToMarkdown(ydoc, tabId);
    writeFileSync(workspacePathFor(tabId), markdown);
    markdownFlushTimers.delete(tabId);
  }, 1000));
}
```

Call from `ws-server.ts`'s `onChange`.

Serialization: use the existing markdown serializer (lives in `src/lib/yjs-markdown.ts` — same logic, just moved to the server). May need a small port since the server is Node and current serializer may depend on Tiptap/ProseMirror. Worst case, use `yjs-to-markdown` or render via a headless Tiptap instance.

**`src/routes/api/document/+server.ts`** — `PUT` becomes a no-op or 410 Gone. `POST { action: 'accept' | 'reject' }` still works (shadow cleanup — lives until Phase 6).

**`src/routes/+page.svelte`** — delete the autosave-initiated `loadTab` flow if it assumed IndexedDB was hydrated. The Hocuspocus provider's `synced` event replaces `whenYDocReady`'s IndexedDB signal.

### Deleted

- `IndexeddbPersistence` imports and usage across the client.
- `PUT /api/document` call sites in `TiptapEditor.svelte`.

### Acceptance criteria

- `npm run check` passes.
- Hard-refresh with IndexedDB cleared: content reloads via WebSocket.
- Server restart + browser refresh: content preserved.
- Type in editor; `document.md` updates within ~1s.
- No `PUT /api/document` requests in the Network panel during normal typing.

### Risks

- **Server-side markdown serialization parity**: the current serializer is client-side. If we can't easily port, Phase 3 may need a headless Tiptap on the server. Time-box: 2 hours. If it balloons, consider running the serializer in a worker via `jsdom`.
- **Refresh UX**: IndexedDB used to give instant paint. Now we wait for a WebSocket handshake. On localhost it's sub-20ms; verify it's not perceptible. Fallback: keep IndexedDB as a *secondary* provider for fast paint (Yjs supports multi-provider).

---

## Phase 4 — Custom MCP tools (edit_doc / read_doc / write_doc)

**Goal:** Agent edits tab files through custom MCP tools that operate on the server Y.Doc directly. Built-in `Edit`/`Write` removed from the agent's toolset. Agent's tool_result reflects reality.

### Prerequisite — Hocuspocus's internal Document is the real Y.Doc

Phase 2 uncovered a detail that rewrites how these tools need to be written: **the Y.Doc stored in `ydoc-registry.ts` is not the same Y.Doc that clients sync with.** Hocuspocus's `onLoadDocument` hook *copies state* from your Y.Doc into its own internal `Document` instance via `encodeStateAsUpdate` + `applyUpdate`. Once a tab has a live WebSocket connection, Hocuspocus's internal Document is authoritative; the registry Y.Doc is stale (a cold-start hydration source only).

If you do this in `edit_doc`:

```ts
const { ydoc } = getTabYDoc(tabId);
ydoc.transact(() => applyReplacement(...), AGENT_ORIGIN);
```

...nothing reaches the browser. You're mutating a dead copy.

**Correct approach:** use `server.openDirectConnection(name)` on the Hocuspocus instance to get a handle to the live Document. Transact against that.

```ts
const direct = await wsServer.openDirectConnection(tabId);
await direct.transact((ydoc) => {
  const ytext = ydoc.getXmlFragment('default');
  // ... apply CRDT ops here, with AGENT_ORIGIN
});
await direct.disconnect(); // or keep alive if doing multiple edits
```

`DirectConnection.transact` fires `onChange` just like a browser-originated update, so the SQLite persistence in `ydoc-persistence.ts` captures the change automatically. Browser clients also receive it via the normal sync.

**Implication for the tool shape:** the three custom tools need access to the `wsServer` instance (exported from `ws-server.ts`). Expose it as a module-level singleton or pass it into the tool factory.

Also: `edit_doc` needs to *read* the current Y.Doc state to find `old_string`, then mutate. Both should use DirectConnection so the read and write see the same authoritative state. The registry Y.Doc is fine for nothing except cold-start hydration — consider renaming it to something like `loadYDocForHydration` to prevent future confusion.

### New files

**`src/lib/server/mcp-doc-tools.ts`** — path-aware custom tools.

```ts
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getTabYDoc, AGENT_ORIGIN } from './ydoc-registry';
import { isTabPath, isScratchPath, parseTabIdFromWorkspacePath } from './path-router';

const AGENT_APPLY_KEY = 'agent-apply'; // matches client

export const editDoc = tool(
  'edit_doc',
  'Replace `old_string` with `new_string` in the given file. Fails if old_string is not found or is ambiguous.',
  z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
  async ({ path, old_string, new_string }) => {
    if (isScratchPath(path)) return editScratchFile(path, old_string, new_string);

    const tabId = parseTabIdFromWorkspacePath(path);
    if (!tabId || !isOpenTab(tabId)) {
      return toolError(`${path} is not an open tab. Ask the user to open it, or write to scratch.`);
    }

    const { ydoc, reviewMap } = getTabYDoc(tabId);
    const currentMd = serializeYjsToMarkdown(ydoc, tabId);
    const hits = findAllOccurrences(currentMd, old_string);
    if (hits.length === 0) return toolError('old_string not found — user may have edited this area.');
    if (hits.length > 1) return toolError('old_string matches multiple locations — be more specific.');

    ydoc.transact(() => {
      applyReplacementInYjs(ydoc, hits[0], old_string.length, new_string);
      appendReviewRoundEntry(reviewMap, { /* before, after, trigger, stepCount, timestamp */ });
    }, AGENT_ORIGIN);

    return toolSuccess('Edit applied.');
  }
);

export const readDoc = tool(
  'read_doc', 'Read the current content of a tab or scratch file.',
  z.object({ path: z.string() }),
  async ({ path }) => {
    if (isScratchPath(path)) return { content: [{ type: 'text', text: readFileSync(path, 'utf8') }] };
    const tabId = parseTabIdFromWorkspacePath(path);
    if (!tabId || !isOpenTab(tabId)) return toolError(`${path} is not an open tab.`);
    return { content: [{ type: 'text', text: serializeYjsToMarkdown(getTabYDoc(tabId).ydoc, tabId) }] };
  }
);

export const writeDoc = tool(
  'write_doc', 'Replace the entire content of a tab or scratch file.',
  z.object({ path: z.string(), content: z.string() }),
  async ({ path, content }) => {
    if (isScratchPath(path)) { writeFileSync(path, content); return toolSuccess('Written.'); }
    const tabId = parseTabIdFromWorkspacePath(path);
    if (!tabId || !isOpenTab(tabId)) return toolError(`${path} is not an open tab. write_doc does not create new tabs.`);

    const { ydoc, reviewMap } = getTabYDoc(tabId);
    ydoc.transact(() => {
      replaceYjsContent(ydoc, content);
      appendReviewRoundEntry(reviewMap, { /* ... */ });
    }, AGENT_ORIGIN);
    return toolSuccess('Written.');
  }
);
```

**`src/lib/server/path-router.ts`** — small utility.

```ts
export function isScratchPath(p: string): boolean {
  return p.includes('.docwriter/agent/scratch/'); // tighten per actual convention
}
export function isTabPath(p: string): boolean {
  return isOpenTab(parseTabIdFromWorkspacePath(p));
}
```

### Modified files

**`src/routes/api/render/+server.ts`** — register the three custom tools. Pass them in as MCP tools alongside existing ones. Do not include built-in `Edit` or `Write` in the agent's `allowedTools` for tab paths.

**Atomicity**: the replacement + review round insert must happen in a single `ydoc.transact`. The browser's Yjs sync delivers the combined change in one atomic update, and the review card appears alongside the content change — never half-applied.

### Out of scope for Phase 4

- Removing shadows (Phase 6). They still exist for the pre-tool sync hook used by the current (pre-refactor) flow; but the new custom tools don't touch them.
- Prompt-diff changes (Phase 5).

### Acceptance criteria

- Agent's `edit_doc` lands atomically: `isError: true` when conflicted, `isError: false` when applied.
- `read_doc` returns current content (matches what's visible in the browser).
- `write_doc` errors on unknown workspace paths, works for tabs and scratch.
- Review rounds still appear in the UI with correct `beforeMd` / `afterMd`.
- Reject still works.
- `npm run check` passes.

### Risks

- **Prompt regression**: the agent may try to use `Edit`/`Write` out of habit. Explicit prompt guidance + maybe a hook that denies built-in Edit/Write on tab paths with a helpful error steering it to `edit_doc`.
- **Server-side markdown serialization**: same concern as Phase 3. If already solved there, same machinery works here.
- **Scratch path convention**: `.docwriter/agent/scratch/` may not be universal. Check how it's derived today in `document-files.ts`.

---

## Phase 5 — Prompt-diff cutover

**Goal:** Shrink prompts. Active tab gets full content + diff since `last_seen`. Other open tabs get path + diff (if any). No full content for non-active tabs. Agent uses `read_doc` on demand.

### Modified files

**`src/routes/api/render/+server.ts`** — change `buildMultiTabPrompt` to:
- Active tab: full current content + diff vs `kv['last_seen:<tabId>']`.
- Other tabs with a diff: path + diff only.
- Other tabs without changes: path only (or omit entirely).
- First-render tabs (no `last_seen`): full content.

After the render completes (on `result`): for each tab the agent saw, update `kv['last_seen:<tabId>']` to the current markdown.

Prompt update: append an instruction block.

```
Tabs whose content isn't inlined above: you can read their current state with
`read_doc(path)` if you need it. It's free — no network round-trip.
```

### Deleted

- The `currentMdByTab` / `lastMarkdownByTab` POST body fields on `/api/render`, if still present. (Should already be gone from earlier work.)

### Acceptance criteria

- Single-tab renders unchanged in content, possibly marginally smaller.
- Multi-tab renders shrink substantially (non-active tabs drop their full-content block).
- Agent successfully calls `read_doc` when it needs content of a non-inlined tab.
- `npm run check` passes.

### Risks

- **Agent doesn't reach for `read_doc`** — plans against stale memory of earlier turn content, makes wrong edits. Tighten prompt guidance; monitor via the history pane.

---

## Phase 6 — Delete shadows, 3-way merge, and the old merge machinery

**Goal:** Remove obsolete code paths. Pure cleanup.

### Deleted files

- `src/lib/three-way-merge.ts`
- `src/lib/server/document-lock.ts`

### Deleted functions (`src/lib/server/document-io.ts`)

- `resetAgentDoc`, `resetAllAgentDocs`
- `syncUserEditsToAgent`
- `readAgentDoc`, `writeAgentDoc`
- `acceptAgentDoc`, `rejectAgentDoc`
- `clearShadowForTab`, `clearAllAgentDocs`
- `readAllAgentDocs`

Keep only what the new design needs (or delete the whole file if it's empty after removals).

### Deleted endpoints / state

- `POST /api/document` with `action: accept | reject` — shadow cleanup no longer needed; accept/reject is a pure Y.Doc operation (remove round from `Y.Map('review')` and optionally rewind undo stack).
- Client-side `mergeBaseByTab`, `preRenderMdByTab`, rolling-baseline machinery in `src/routes/+page.svelte`.
- `incremental_apply` SSE event handling on both server and client.
- Pre-tool sync hook in `src/routes/api/render/+server.ts`.
- Post-tool `incremental_apply` emit hook in the same file.

### Filesystem

- `.docwriter/agent/` directory should no longer be created. Delete any code that makes the directory.

### Acceptance criteria

- Grep: `three-way-merge`, `resetAgentDoc`, `syncUserEditsToAgent`, `incremental_apply`, `mergeBaseByTab`, `preRenderMdByTab` — all return zero hits.
- `.docwriter/agent/` is never created during a normal render.
- `npm run check` passes.
- Agent flow end-to-end: trigger a render, accept, reject, retry — all work.

### Risks

- **Hidden dependencies**: some obscure UI feature may rely on `incremental_apply` for live-streaming visuals. Search for references before deleting. Keep the `tool_call_start` / `assistant_text` / `result` events.

---

## Phase 7 — Undo persistence verification

**Goal:** Confirm undo survives server restart. No code changes expected if Phase 2's origin-preserving replay was correct; this phase is verification + targeted fix if something's off.

### Verification checklist

1. Type some text in a tab. Edit it a few times.
2. Trigger an agent render that changes the same region.
3. Without accepting, stop the server (`Ctrl+C`).
4. Restart the server. Refresh the browser.
5. Reject the pending round.
6. Verify:
   - Agent's changes are rewound.
   - User's pre-render typing is preserved.
   - `userMd` stores content matching pre-agent state.

If #6 fails, the UndoManager's state didn't reconstruct correctly. Likely cause: origin not preserved in `yjs_updates` replay, or `UndoManager` constructed before replay (so it misses the captured transactions).

### Modified files (if fix needed)

- `src/lib/server/ydoc-registry.ts` — ensure `UndoManager` is constructed *before* replay, so it observes each replayed transaction with its original origin.

### Acceptance criteria

- Reject-after-restart correctly rewinds only agent changes.
- Multiple pending rounds survive restart with correct `stepCount` semantics.

---

## Phase 8 — Cleanup + docs

**Goal:** Update all documentation to reflect the new architecture. Sweep up loose ends.

### Modified files

- **`CLAUDE.md`** — rewrite "Persistence layout", "The one big idea", "Agent SDK integration", "Agent reconciliation", "Gotchas" sections. Reflect: server-authoritative Y.Doc, SQLite, custom MCP tools, no shadows, no 3-way merge.
- **`ARCHITECTURE.md`** — rewrite "Persistence Layers", "Agent Render Pipeline", "Reconciliation And Review Model", "API Surface". Same points.
- **`architecture.html`** — mirror the markdown updates. The rendered engineering doc should describe the new topology (browser ↔ WebSocket ↔ server Y.Doc, SQLite persistence).
- **`README.md`** — if it references IndexedDB, shadows, or 3-way merge, update.

### Cleanup

- Grep for unused imports (`y-indexeddb`, `mergeAgentEditsIntoCurrent`, etc.).
- Grep for now-dead env vars or config.
- One final pass: `npm run check`, `npm run build`.

### Acceptance criteria

- Docs accurately describe the new architecture.
- No dead imports or unreferenced code.
- `npm run check` and `npm run build` both pass.

---

## Cross-phase concerns

### Yjs origin constants

- Client: `AGENT_ORIGIN` and `AGENT_APPLY_KEY` in `src/lib/yjs-agent.ts`.
- Server: same `AGENT_ORIGIN` string constant in `src/lib/server/ydoc-registry.ts`. Both sides must agree.

### Compaction

`yjs_updates` grows per keystroke. Compact with `Y.mergeUpdates` when a tab exceeds ~500 rows. Run on:
- A background timer (every 5 minutes).
- Tab close / New Session.
- Never in the hot path.

### Multi-client accidental exposure

Once the WebSocket is up, two browser tabs to the same workspace get live sync. For single-user DocWriter this is a bonus feature; for solo use it may surprise someone. Decide before Phase 3 whether to reject duplicate connections per `tabId` or allow them. Easy to gate via an `onConnect` hook.

### Migration one-way

Once Phase 3 ships, downgrading to pre-refactor DocWriter requires:
- Seeding `document.md` from the Y.Doc (already happens every 1s).
- Optionally rebuilding `.docwriter/state.json` from `state.json.bak` + current SQLite.

Document the rollback procedure in Phase 8.

### Known deferred issues

- **Diff overlay not highlighting additions** (spotted during Phase 1 manual testing — agent-added lines render without the green decoration, only removals show as strikethrough widgets). Fix or triage out-of-band; not part of the phased refactor.
- **Vestigial `recent_actions` schema** — currently stores only `label + used_at`. If we later want full Action objects in the DB, add a migration.
