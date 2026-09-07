# Hosting DocWriter

Runbook for the hosted deployment: one machine, one sandboxed DocWriter process per user, a supervisor in front. The design and its reasoning are in `docs/contribute/hosting.mdx`; the phased plan is in `docs/contribute/hosting-plan.mdx`.

## Layout

```
deploy/supervisor/   the supervisor (plain Node, no build step)
deploy/machine/      provision.sh, Caddyfile, systemd unit, release.sh
deploy/backup/       Litestream config, hourly rclone backup unit and timer
.github/workflows/deploy-hosted.yml   builds a release on push to main and installs it
```

On the machine:

```
/app/releases/<sha>/   one directory per release; /app/current is a symlink to the live one
/data/supervisor.db    user registry: uid and port pair per user
/data/users/<uid>/     workspace/ (DOCWRITER_ROOT), home/ (HOME), etc/ (passwd and group for the sandbox)
/etc/docwriter/        supervisor.env, allowlist
```

## Run it on a laptop

No sandbox, no real sign-in. Never expose this mode.

```bash
npm run build
SUPERVISOR_SANDBOX=none SUPERVISOR_AUTH=dev SUPERVISOR_DATA_DIR=/tmp/dw-data npm run supervisor
# open http://localhost:8080 and type any name
```

To try the real sign-in on a laptop, use a Clerk development instance (its keys work on any origin):

```bash
SUPERVISOR_SANDBOX=none SUPERVISOR_AUTH=clerk SUPERVISOR_PUBLIC_ORIGIN=http://localhost:8080 \
CLERK_PUBLISHABLE_KEY=pk_test_… CLERK_SECRET_KEY=sk_test_… \
SUPERVISOR_COOKIE_SECRET=$(head -c 32 /dev/urandom | base64) \
SUPERVISOR_DATA_DIR=/tmp/dw-data npm run supervisor
```

Open http://localhost:8080, sign in with any method the Clerk instance allows, and the editor should appear with a `dw_session` cookie set. `/auth/logout` ends both sessions.

With bubblewrap installed and running as root, `SUPERVISOR_SANDBOX=bwrap` uses the real sandbox on the laptop too. The data directory and every parent must be traversable by other users (`chmod 755`), because each process runs as its own uid.

## First deploy

1. Ubuntu 24.04 machine with a public IP, DNS `A` record for the domain pointing at it, ports 80 and 443 open.
2. Copy `deploy/` to the machine and run `DOMAIN=app.example.org bash deploy/machine/provision.sh` as root. It installs bubblewrap, Node, Caddy, Litestream, rclone, writes the services, opens the firewall, and prints what to fill in.
3. Sign-in. The default is Clerk, so anyone can sign in with email, a magic link, Google, or GitHub, whichever the Clerk dashboard enables. Create a Clerk application, add `https://app.example.org` under allowed origins, and put the publishable and secret keys in `/etc/docwriter/supervisor.env`. For a production Clerk instance, also add the DNS records Clerk asks for (its frontend API runs on a subdomain of yours, and the sign-in page loads ClerkJS from there). If everyone has GitHub and you would rather have no vendor, set `SUPERVISOR_AUTH=github` and create a GitHub OAuth app with callback `https://app.example.org/auth/callback` instead.
4. Decide on the model key. `ANTHROPIC_API_KEY` in `supervisor.env` gives every user the same key; leave it empty for bring-your-own, where each user pastes a key in DocWriter's API keys panel and it is stored in their own home directory.
5. Add invited users to `/etc/docwriter/allowlist`, one per line: email addresses with Clerk, GitHub logins with GitHub. An empty file lets everyone in.
6. Ship a release: set the repository variable `HOSTED_DEPLOY_ENABLED=true` and the secrets `HOSTED_HOST` and `HOSTED_SSH_KEY` (a private key whose public half is in root's `authorized_keys`), then push to `main` or run the "Deploy hosted" workflow. By hand instead: build locally, `tar -czf release.tgz build deploy bin package.json node_modules`, copy it over, and run `deploy/machine/release.sh release.tgz`.
7. `systemctl start docwriter-supervisor` and open the domain.

## Every deploy after that

Push to `main`. The workflow runs the checks and tests, builds, packs, and calls `release.sh`, which unpacks into a new release directory, flips the symlink, and restarts the supervisor. Running user processes keep the old release until they are reaped, because bubblewrap bound the real path at spawn. Nobody loses a session.

Roll back: `ln -sfn /app/releases/<older sha> /app/current && systemctl restart docwriter-supervisor`.

## Backups

- **Litestream** replicates every `docwriter.db` to the bucket continuously. Fill in `/etc/litestream.yml`, then `systemctl enable --now litestream`.
- **Hourly rclone** copies everything else under `/data/users` (references, PDFs, skills, hooks, scratch, homes). Configure a remote named `backup` with `rclone config`, then the timer installed by provisioning does the rest.
- **Restore drill**, before the first real user: on a scratch machine, `litestream restore -o docwriter.db s3://<bucket>/litestream/<path>` for one user, `rclone copy` their prefix, put both under `/data/users/<uid>/`, and open their document.

## Operations

- Logs: `journalctl -u docwriter-supervisor -f`. Supervisor lines are JSON; user process lines are prefixed `[login]`.
- Metrics: `curl -s localhost:8080/__supervisor/metrics` on the machine, or from elsewhere with `Authorization: Bearer $SUPERVISOR_METRICS_TOKEN`. Gauges: running and starting processes, WebSocket connections, users. Counters: spawns, spawn failures, reaps, OOM kills, proxy errors, denied sign-ins. Ready latency summary.
- Status: `curl -s localhost:8080/__supervisor/healthz`.
- Capacity: `SUPERVISOR_MAX_PROCESSES` caps concurrent users; past it, new sign-ins get a "busy" page that retries. `SUPERVISOR_MEMORY_MAX` and `SUPERVISOR_PIDS_MAX` are per process, enforced by a cgroup under the supervisor's unit (`Delegate=yes`).
- Idle: a process with no WebSocket for `SUPERVISOR_IDLE_SECONDS` (default 600) gets SIGTERM; the app flushes and exits; the next request respawns it in about a second.
- A crash-looping user is held back by `SUPERVISOR_RESPAWN_COOLDOWN_MS` and sees a "restarting" page.

## How sign-in works

Clerk is used only at the moment of sign-in. Its page posts one short-lived Clerk session token to `/auth/clerk/session`; the supervisor verifies it with Clerk, reads the user's primary email, checks the allowlist, and sets its own signed cookie for thirty days. Every later request, the WebSocket included, is authenticated by that cookie alone. This is why the app never needs ClerkJS: Clerk tokens expire after a minute and are refreshed by ClerkJS on the page, which the DocWriter page does not load. The user's workspace is keyed by the Clerk user id, so changing email keeps the same workspace. Sign-out clears our cookie and ends the Clerk session on the sign-out page.

## Security model

- Each user is a distinct Linux uid. Their files are owned by it.
- bubblewrap gives each process its own mount, pid, ipc, and uts namespace with only `/usr`, the release, and the user's own directories visible. Agent Bash, hooks, and synctex cannot see other users.
- The network namespace is shared, so localhost ports are reachable by every process. Each process gets a random `DOCWRITER_GATEWAY_SECRET` and refuses any HTTP request or WebSocket upgrade without it. Only the supervisor knows it. Verified by the integration tests and by hand under bubblewrap.
- The supervisor listens on 127.0.0.1 only; Caddy is the only public listener.
- The supervisor runs as root so it can drop to each uid. It holds no user data of its own beyond the registry.

## Limits of this setup

- One machine. Past its capacity the supervisor's spawner would need to start processes on other machines and route to them; the registry would gain a machine column. Nothing else moves.
- Idle processes still cost their memory until reaped, and a reaped user waits about a second on return.
- CPU is shared. A heavy render slows neighbours. Memory is capped per process; CPU is not, beyond the kernel scheduler's fairness.
