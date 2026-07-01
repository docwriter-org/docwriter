# DocWriter Pilot Deployment Plan

Deploy DocWriter as a multi-user pilot on Fly.io with Clerk auth, per-user
workspace isolation, and Claude Sonnet 4.6.

## Architecture

```
docwriter.org          (Vercel - unchanged)
  /welcome, /sign-in    landing page + Clerk sign-in

app.docwriter.org      (Fly.io - new)
  /                      SvelteKit editor (adapter-node)
  /ws                    Hocuspocus WebSocket (same port, upgrade routing)
  /data volume           persistent storage for all user workspaces
```

Vercel continues to serve the marketing/landing page from the `landing`
branch. The editor runs on Fly as a single persistent Node process with a
Fly Volume mounted at `/data`.

## DNS

Add a CNAME record in Cloudflare:

```
app.docwriter.org  CNAME  docwriter-app.fly.dev
```

Cloudflare proxy (orange cloud) handles TLS. Fly issues its own cert for
the custom domain via `fly certs add app.docwriter.org`.

## Auth (Clerk)

Already implemented in `src/lib/server/clerk-auth.ts`. The middleware
extracts `userId` from the Clerk session and sets `event.locals.auth`.

### Keys needed

| Env var | Source |
|---|---|
| `CLERK_SECRET_KEY` | Clerk dashboard > API Keys (`sk_live_...`) |
| `PUBLIC_CLERK_PUBLISHABLE_KEY` | Same page (`pk_live_...`) |
| `DOCWRITER_AUTHORIZED_EMAILS` | Comma-separated pilot user emails |

### Clerk dashboard config

- Allowed web origins: `https://app.docwriter.org`
- Sign-in URL: `https://app.docwriter.org/sign-in`
- Sign-up URL: `https://app.docwriter.org/sign-in`
- After sign-in and sign-up: `https://app.docwriter.org/`

## Per-user workspace isolation

Each Clerk user gets an isolated workspace on the Fly Volume:

```
/data/workspaces/<clerk_user_id>/
  document.md
  drafts/
  .docwriter/
    docwriter.db        (user's own SQLite)
    state.json
    agent/scratch/
    provider-cache/
      claude/           (Claude SDK local cache; DB remains durable source)
```

### What changes in the code

The core problem: `db.ts` and `document-files.ts` resolve paths as
module-level constants at import time. Every consumer calls `getDb()` with
no arguments. This must become request-scoped.

#### 1. Workspace resolver (new file)

A single helper that maps a Clerk user ID to a workspace:

```
getUserWorkspace(userId) -> {
  root:          /data/workspaces/<userId>/
  docwriterDir:  /data/workspaces/<userId>/.docwriter/
  db:            cached Database connection for this user
}
```

Lazily creates the directory and runs migrations on first access.

#### 2. Database - `src/lib/server/db.ts` (56 lines)

Replace the zero-arg `getDb()` singleton with `getDb(userId)` backed by a
`Map<string, Database>` keyed cache. Each entry opens its own
`better-sqlite3` connection to that user's `docwriter.db`. Add a shutdown
hook to close all connections.

#### 3. Filesystem paths - `src/lib/server/document-files.ts` (131 lines)

Replace module-level constants (`ROOT`, `WORKSPACE_ROOT`, `DOCWRITER_DIR`)
with functions that take a `userId` parameter:
`getWorkspaceRoot(userId)`, `getDocwriterDir(userId)`,
`tabFileForUser(userId, tabId)`.

#### 4. Database consumers - thread `userId` through

Every exported function in these files gets `userId` as its first param:

- **`db-writes.ts`** (234 lines) - all functions call `getDb()`, change to
  `getDb(userId)`.
- **`runtime-state.ts`** (193 lines) - calls `getDb()` at lines 99, 119,
  129, 177. Same change.
- **`ydoc-persistence.ts`** (220 lines) - calls `getDb()` and `tabFile()`.
  Add `userId` to `replayUpdatesInto`, `appendUpdate`, `compactTab`,
  `purgeTabUpdates`, `flushMarkdownNow`.

#### 5. API routes - extract user ID, pass through

Every route handler extracts `event.locals.auth.userId` (already set by
Clerk middleware) and passes it to the server functions above:

- **`/api/render` (1085 lines)** - the main one. Pass `userId` to every
  runtime-state / db-writes / persistence call.
- **`/api/document`**, **`/api/session`**, **`/api/history`**,
  **`/api/comments`**, **`/api/hooks`** - same pattern.

#### 6. WebSocket - `src/lib/server/ws-server.ts` (424 lines)

- **`onAuthenticate`**: validate the Clerk JWT from the connection's auth
  token. Extract `userId`. Attach to connection context. Reject if not on
  the allowlist.
- **Document namespacing**: document names become `<userId>:<tabId>`.
  `onLoadDocument` and `onChange` extract the userId from the doc name and
  pass it to persistence calls.
- Client sends its Clerk session token when opening the WebSocket
  connection.

#### 7. MCP tools - `src/lib/server/mcp-doc-tools.ts` (899 lines)

Currently uses module-level `WORKSPACE_ROOT` and bare `tabId` for
Hocuspocus connections. Change to:

- Build the MCP tool server per-request with the user's workspace root
  baked in.
- Hocuspocus `openDirectConnection` uses the namespaced
  `<userId>:<tabId>`.

#### 8. Agent provider - `src/lib/server/providers/claude.ts` (305 lines)

- Add `cwd: userWorkspaceRoot` to the `query()` options. This sandboxes
  the agent's built-in `Read`, `Edit`, `Write`, `Bash` tools to the
  user's workspace directory. The SDK enforces the restriction.
- Leave `additionalDirectories` empty so the agent cannot escape.
- Hardcode `model: 'claude-sonnet-4-6'`, ignore the client-provided model.

#### 9. No changes needed

- **`clerk-auth.ts`** - already works as-is.
- **`hooks.server.ts`** - WS server start and Clerk middleware chain are
  fine; user context is per-request/per-connection.

## Single-port WebSocket consolidation

Currently Hocuspocus binds its own port (3001). Fly exposes one port per
service. Fix: attach Hocuspocus to SvelteKit's HTTP server via the Node
`upgrade` event.

- In `hooks.server.ts`, after creating the HTTP server, intercept
  `upgrade` requests where `url.pathname === '/ws'` and hand them to
  Hocuspocus.
- Remove the separate port binding.
- Client connects to `wss://app.docwriter.org/ws` instead of
  `ws://hostname:3001`.

## Model lock

Hardcode `claude-sonnet-4-6` in `providers/claude.ts`. Ignore the `model`
field from the client request body. This controls cost and keeps the pilot
on a known-good model.

## Fly.io configuration

### `fly.toml`

```toml
app = "docwriter-app"
primary_region = "sjc"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  DOCWRITER_ROOT = "/data"
  PORT = "3000"

[http_service]
  internal_port = 3000
  force_https = true

  [[http_service.checks]]
    path = "/api/health"
    interval = "30s"
    timeout = "5s"

[[mounts]]
  source = "docwriter_data"
  destination = "/data"
```

### Secrets (set via `fly secrets set`)

```
ANTHROPIC_API_KEY=...
CLERK_SECRET_KEY=...
PUBLIC_CLERK_PUBLISHABLE_KEY=...
DOCWRITER_AUTHORIZED_EMAILS=user1@...,user2@...
DOCWRITER_RUNNER_TOKEN=...    # same random value as RUNNER_SHARED_TOKEN on docwriter-runner
```

## Hosted Bash runner

Hosted DocWriter does not expose Claude Code's built-in `Bash` tool inside
the main app process. Instead, the hosted Claude tool list swaps `Bash` for a
DocWriter MCP tool named `run_bash`.

`run_bash` posts a temporary bundle to a separate Fly app:

```
docwriter-runner
  Dockerfile.runner
  runner/server.js
```

The runner receives:

- user-visible workspace files
- `.docwriter/agent/scratch/**`
- no `.docwriter/docwriter.db`
- no provider cache
- no Clerk secrets
- no Anthropic key

The command runs from `/workspace` with HTTP/HTTPS network available. Changed
scratch files are copied back to `.docwriter/agent/scratch`. Changed user
workspace files are reported to the agent but are not written back; the agent
must still use `edit_doc` / `write_doc` for reviewable document changes.
Each run also writes a markdown log under `.docwriter/agent/outputs/` with
the command, exit status, stdout, stderr, and changed paths.

Deploy the runner:

```bash
fly apps create docwriter-runner
fly secrets set --app docwriter-runner RUNNER_SHARED_TOKEN=...
npm run deploy:fly:runner
```

Configure the main app:

```bash
fly secrets set --app docwriter-app DOCWRITER_RUNNER_TOKEN=...
```

`DOCWRITER_RUNNER_URL` defaults in `fly.toml` to
`https://docwriter-runner.fly.dev`.

### Dockerfile

```dockerfile
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV DOCWRITER_HOSTED=1
ENV PUBLIC_DOCWRITER_HOSTED=1
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
RUN npm install -g @anthropic-ai/claude-code
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server.js ./server.js
EXPOSE 3000
CMD ["node", "server.js"]
```

### Volume

```bash
fly volumes create docwriter_data --region sjc --size 1
```

## Tenant isolation summary

| Layer | Mechanism |
|---|---|
| Data at rest | Separate SQLite + filesystem per user |
| HTTP routes | Clerk session -> userId -> scoped workspace |
| WebSocket | Clerk JWT validated in onAuthenticate; doc names prefixed by userId |
| Agent built-in tools | `query({ cwd: userWorkspace })` - SDK enforces directory restriction |
| Agent MCP tools | Built per-request with user's workspace root |
| Cost | Per-user rate limiting + Anthropic dashboard budget cap |

## Implementation order

1. **Single-port WS** - consolidate Hocuspocus onto SvelteKit's HTTP
   server. Test locally that the editor still works over `/ws`.

2. **Workspace resolver + DB keying** - new `getUserWorkspace(userId)`
   helper, `getDb(userId)` keyed cache. No consumers changed yet, so
   nothing breaks.

3. **Thread userId through server layer** - update `db-writes`,
   `runtime-state`, `ydoc-persistence`, `mcp-doc-tools`. Each file is
   mechanical: add `userId` first param, pass to `getDb(userId)` and
   path functions.

4. **Update API routes** - extract `event.locals.auth.userId` in each
   route, pass to server functions.

5. **WS auth + doc namespacing** - Clerk JWT validation in
   `onAuthenticate`, `<userId>:<tabId>` document names, client sends
   token on connect.

6. **Lock model** - one-line change in `providers/claude.ts`.

7. **Fly deployment** - Dockerfile, `fly.toml`, volume, secrets, DNS.
   Use `npm run deploy:fly:runner`, then `npm run deploy:fly:app`.

8. **Smoke test** - two different Clerk accounts, verify they cannot see
   each other's documents.

## Cost estimate

| Item | Monthly |
|---|---|
| Fly (shared-cpu-1x, 1GB RAM) | ~$5 |
| Fly Volume (1GB) | ~$0.15 |
| Clerk (free tier, up to 10k MAU) | $0 |
| Anthropic API (Sonnet 4.6, pilot usage) | Usage-based |
| Cloudflare DNS | $0 |
| **Total (excl. API)** | **~$5** |

## Open questions

- **Workspace initialization**: should new users start with a blank
  `document.md`, or a template/welcome doc?
- **Rate limiting**: what per-user render limit? (e.g., 50 renders/hour)
- **Backups**: should we snapshot the Fly volume on a schedule?
- **Monitoring**: add a `/api/health` endpoint? Fly has built-in metrics.
