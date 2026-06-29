# Provider e2e smoke tests

Playwright-driven smoke tests that boot DocWriter against a temp workspace,
wake each agent backend, and verify two paths:

1. **Directive edit** — `essay.md` contains a `[[ … ]]` note; clicking **Agent**
   produces a pending review card (`.gutter-card`).
2. **Chat reply** — sending `Reply with exactly PONG` via the chat popover yields
   assistant text in the history pane.

## API keys

DocWriter has five provider backends. For **GitHub Actions** you need explicit
env vars (desktop logins like `claude login` / Codex CLI auth do not work in CI).

| Provider | SDK | CI secret / env var | Required? | Default e2e model |
|----------|-----|-------------------|-----------|-------------------|
| **claude** | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | `ANTHROPIC_API_KEY` | Yes in CI | `claude-sonnet-4-6` |
| **openai** | OpenAI Agents SDK (`@openai/agents`) | `OPENAI_API_KEY` | Yes | `gpt-5.4-mini` |
| **codex** | Codex SDK (`@openai/codex-sdk`) | `OPENAI_API_KEY` | Yes in CI | `gpt-5.4-mini` |
| **cursor** | Cursor SDK (`@cursor/sdk`) | `CURSOR_API_KEY` | Yes | `composer-2.5` |
| **pi** | Pi coding agent (`@earendil-works/pi-coding-agent`) | `TOGETHER_API_KEY` | Yes in CI | `together/zai-org/GLM-5.2` |

Notes:

- **Codex** is separate from the OpenAI Agents SDK provider but reuses
  `OPENAI_API_KEY` (or Codex CLI login locally). A dedicated `CODEX_API_KEY` is optional.
- **Pi** default e2e model is **GLM-5.2 on Together** (`together/zai-org/GLM-5.2`)
  via `TOGETHER_API_KEY` (same as the in-app Pi key). Override with `E2E_MODEL` if needed.
- Avoid **Claude Opus 4.8** in CI — the bundled Claude Agent SDK currently errors on
  extended thinking for that model. Haiku / Sonnet are fine.

### Minimum secret set for all five matrix jobs

Add these as **repository secrets** (Settings → Secrets and variables → Actions):

```
ANTHROPIC_API_KEY   # claude
OPENAI_API_KEY      # openai + codex providers
CURSOR_API_KEY      # cursor provider
TOGETHER_API_KEY    # pi (GLM-5.2 on Together)
```

Fork PRs from outside collaborators do not receive secrets unless you enable
**Settings → Actions → General → Fork pull request workflows** to pass secrets
(or run the workflow only on `pull_request_target` / internal branches).

## Local usage

```bash
nvm use                    # Node 22.22.2
npm ci
npx playwright install chromium
rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl  # Linux glibc

# All providers that have credentials (parallel)
npm run test:e2e

# Single provider
E2E_PROVIDER=claude npm run test:e2e

# Override model / timeout
E2E_PROVIDER=openai E2E_MODEL=gpt-5.4-mini AGENT_TIMEOUT_MS=180000 npm run test:e2e
```

## GitHub Actions

Workflow: [`.github/workflows/e2e-providers.yml`](../.github/workflows/e2e-providers.yml)

- Runs on every **pull request** and pushes to **main**.
- `check` job: `npm run check` (svelte-check).
- `provider-smoke` matrix: one job per provider, each with its own Playwright session.
- Jobs are skipped as failures when the required secret for that provider is missing
  (single-provider mode treats missing keys as an error).

Tune `AGENT_TIMEOUT_MS` in the workflow if your models are slow.
