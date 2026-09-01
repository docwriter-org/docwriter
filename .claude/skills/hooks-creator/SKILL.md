---
name: hooks-creator
description: Use when I ask to automate something on agent events (e.g. "run pdflatex after every edit", "open preview on save", "lint python after writes", "notify me when a tool fails"). Teaches you to propose a shell hook for my review via the propose_hook tool rather than editing .docwriter/hooks.json directly.
---

# hooks-creator

The workspace has a file at `.docwriter/hooks.json` that binds shell commands to Claude Agent SDK events. I want to manage these by asking you in natural language, then accepting or rejecting your proposal in the sidebar.

## When to use this skill

I describe an automation I want triggered by agent activity:

- "Run pdflatex after every Edit"
- "Lint the file I just saved"
- "Open Preview.app when I accept an edit"
- "Echo done after the agent finishes responding"
- "Notify me if a tool fails"
- "Snapshot a git commit after each response"
- "Format with Prettier after every Write"

Also use it when I reference build steps I want tied to edits (e.g. "recompile the manuscript", "rebuild the typst PDF").

## How to propose a hook

Call the `propose_hook` tool exactly once per user request. Arguments:

- **event** (required): see the full list below.
- **matcher** (optional): regex over the tool name. Only meaningful for `PreToolUse`, `PostToolUse`, and `PostToolUseFailure`. Common values:
  - `"Edit|Write"` — file mutations only
  - `"Edit"` — edits only
  - `"Bash"` — shell commands only
  - omit / empty — match every tool
- **command** (required): the shell command. Placeholders:
  - `{{file}}` — the edited file path (for tool-scoped events)
  - `{{tool}}` — the tool name
- **reason** (required): one sentence explaining what the hook does. Shown to me on the proposal card.

## Available events

Pick the event that matches *when* I want the command to run:

| Event                | Fires when                                          | Typical use                           |
| -------------------- | --------------------------------------------------- | ------------------------------------- |
| `PreToolUse`         | A tool is about to run                              | Validate input, short-circuit         |
| `PostToolUse`        | A tool finished successfully (most common)          | Build, lint, format, log              |
| `PostToolUseFailure` | A tool errored                                      | Notifications, retries                |
| `UserPromptSubmit`   | I send a new prompt                                 | Start a timer, log the prompt         |
| `Stop`               | The agent finishes its response                     | Compile, open preview, commit         |
| `SubagentStop`       | A subagent (spawned via `Task`) finishes            | Aggregate subagent results            |
| `SessionStart`       | A new agent session begins                          | Log a banner, set up state            |
| `SessionEnd`         | A session ends                                      | Tear down state, flush logs           |
| `Notification`       | SDK emits a notification (permission, idle, etc.)   | Forward to Slack/PagerDuty            |

Default to `PostToolUse` if my intent is unclear — it's the most common.

## Examples

See `examples/` next to this skill for reference shapes:

- `pdflatex-on-edit.json` — PostToolUse + matcher, rebuild a PDF after edits
- `ruff-lint-edited-file.json` — PostToolUse + `{{file}}` placeholder
- `typst-watch-stop.json` — Stop event (no matcher)

Mirror the shape of the closest example when you propose. In particular, match the `reason` field style: short, single-sentence, describes what I will observe.

## DO NOT

- DO NOT write directly to `.docwriter/hooks.json` via Edit/Write. I want to review hooks before they're saved.
- DO NOT propose multiple hooks per request unless I explicitly asked for several. Ask clarifying questions first if ambiguous.
- DO NOT propose a hook whose command you're unsure about — ask me to confirm the exact command instead of guessing.
- DO NOT set `matcher` on non-tool events (`Stop`, `UserPromptSubmit`, `Session*`, `Notification`) — it's ignored.

## After proposing

Keep your text response brief: "Proposed a hook that runs pdflatex after edits — accept in the sidebar to save it." I review and accept it from the OutlinePane.
