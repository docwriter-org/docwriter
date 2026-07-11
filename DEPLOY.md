# Deploying DocWriter

Operational runbook for the hosted pilot. Two Fly.io apps plus the Vercel
landing site.

## Fly apps

| App | Config | Image | Runs |
|---|---|---|---|
| `docwriter-app` | `fly.toml` | `Dockerfile` | SvelteKit editor (adapter-node) + Hocuspocus WebSocket on one port via `server.js` (`/ws` upgrade routing). Region `sjc`, 1 GB shared VM, `min_machines_running = 1`. Health check: `GET /api/health`. |
| `docwriter-runner` | `fly.runner.toml` | `Dockerfile.runner` | Sandboxed bash runner (`runner/server.js`) backing the hosted `run_bash` MCP tool. Scales to zero. Health check: `GET /health`. Refuses to start without `RUNNER_SHARED_TOKEN`. |

App names live in the fly TOML files (`app = ...`); deploy commands never
pass `--app`.

## Secrets

Set with `fly secrets set --app <app> KEY=value`.

`docwriter-app`:

- `ANTHROPIC_API_KEY` — agent renders (`src/lib/server/providers/claude.ts`).
- `CLERK_SECRET_KEY`, `PUBLIC_CLERK_PUBLISHABLE_KEY` — Clerk auth
  (`src/lib/server/clerk-auth.ts`).
- `DOCWRITER_AUTHORIZED_EMAILS` — comma-separated invite allowlist. Empty
  means no user is authorized.
- `RUNNER_SHARED_TOKEN` — bearer token for runner calls; the same value is
  set on the runner app. (Deployments configured with the old
  `DOCWRITER_RUNNER_TOKEN` name must rename the secret.)
- `APP_URL` (optional) — extra Clerk authorized-party origin.

`docwriter-runner`:

- `RUNNER_SHARED_TOKEN` — required; the runner exits at boot without it.

Non-secret env (`DOCWRITER_HOSTED`, `PUBLIC_DOCWRITER_HOSTED`,
`DOCWRITER_ROOT=/data`, `DOCWRITER_RUNNER_URL`) is pinned in `fly.toml`.

GitHub Actions secrets (used by `.github/workflows/vercel-production.yml`):
`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`,
`FLY_APP_DEPLOY_TOKEN`, `FLY_RUNNER_DEPLOY_TOKEN` (each exported as
`FLY_API_TOKEN` for its fly deploy step).

## Volume

`docwriter-app` mounts the `docwriter_data` volume at `/data` (all user
workspaces). Create it once before the first deploy:

```bash
fly volumes create docwriter_data --app docwriter-app --region sjc --size 1
```

The runner is stateless — no volume.

## Clerk dashboard

- Copy the live publishable/secret keys into the app secrets above.
- Allowed origins must include `https://app.docwriter.org`.
- Sign-in and sign-up URLs: `https://app.docwriter.org/sign-in`.
- Server-side `authorizedParties` = request origin + `APP_URL` +
  `VERCEL_URL`, so set `APP_URL` if Clerk requests arrive via another origin.

## DNS

- `docwriter.org` (apex A `76.76.21.21`) and `www` (CNAME
  `cname.vercel-dns.com`) point at Vercel — sync with `npm run cf:dns`
  (`deploy/cloudflare/sync-dns.sh`).
- `app.docwriter.org` CNAMEs to `docwriter-app.fly.dev`; issue the cert with
  `fly certs add app.docwriter.org`. The landing page's "User study login"
  link defaults to `https://app.docwriter.org` (override: `PUBLIC_APP_URL`).

## How deploys trigger

1. Push to `main` → `sync-landing.yml` merges main into `landing`, runs
   `npm ci` + `npm run check`, and pushes `landing` only if the check passes.
2. Push to `landing` → `vercel-production.yml`: Vercel production build
   (`LANDING_DEPLOY=1`, serves docwriter.org), then always deploys
   `docwriter-app`; deploys `docwriter-runner` only when `runner/**`,
   `Dockerfile.runner`, or `fly.runner.toml` changed.
3. Manual: dispatch "Deploy production" with `fly_target`
   (`app`/`runner`/`all`/`none`), or locally `npm run deploy:fly`,
   `deploy:fly:app`, `deploy:fly:runner` (`scripts/deploy-fly.sh`).
