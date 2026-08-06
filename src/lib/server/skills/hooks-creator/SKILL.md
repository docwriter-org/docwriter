---
name: hooks-creator
description: Use when the user asks to automate something on agent events (e.g. "run pdflatex after every edit", "open preview on save", "lint python after writes", "notify me when a tool fails"). Teaches you to propose a shell hook for user review via the propose_hook tool rather than editing .docwriter/hooks.json directly.
---

# hooks-creator

The workspace has a file at `.docwriter/hooks.json` that binds shell commands to Claude Agent SDK events. The user wants to manage these by asking you in natural language, then accepting or rejecting your proposal in the sidebar.

## When to use this skill

The user describes an automation they want triggered by agent activity:

- "Run pdflatex after every Edit"
- "Lint the file I just saved"
- "Open Preview.app when I accept an edit"
- "Echo done after the agent finishes responding"
- "Notify me if a tool fails"
- "Snapshot a git commit after each response"
- "Format with Prettier after every Write"

Also use it when the user references build steps they want tied to edits (e.g. "recompile the manuscript", "rebuild the typst PDF").

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
  - `{{stem}}` — the file path without its final extension
  - `{{tool}}` — the tool name
- **output** (optional): workspace-relative output path produced by the command. Set this for previewable output such as `main.pdf` or `{{stem}}.html`.
- **reason** (required): one sentence explaining what the hook does. Shown to the user on the proposal card.

## Available events

Pick the event that matches *when* the user wants the command to run:

| Event                | Fires when                                          | Typical use                           |
| -------------------- | --------------------------------------------------- | ------------------------------------- |
| `PreToolUse`         | A tool is about to run                              | Validate input, short-circuit         |
| `PostToolUse`        | A tool finished successfully (most common)          | Build, lint, format, log              |
| `PostToolUseFailure` | A tool errored                                      | Notifications, retries                |
| `UserPromptSubmit`   | The user sends a new prompt                         | Start a timer, log the prompt         |
| `Stop`               | The agent finishes its response                     | Compile, open preview, commit         |
| `SubagentStop`       | A subagent (spawned via `Task`) finishes            | Aggregate subagent results            |
| `SessionStart`       | A new agent session begins                          | Log a banner, set up state            |
| `SessionEnd`         | A session ends                                      | Tear down state, flush logs           |
| `Notification`       | SDK emits a notification (permission, idle, etc.)   | Forward to Slack/PagerDuty            |

Default to `PostToolUse` if the user's intent is unclear — it's the most common.

## Examples

See `examples/` next to this skill for reference shapes:

- `pdflatex-on-edit.json` — Stop event + preview output, rebuild a PDF after a turn
- `ruff-lint-edited-file.json` — PostToolUse + `{{file}}` placeholder
- `typst-watch-stop.json` — Stop event (no matcher)

Mirror the shape of the closest example when you propose. In particular, match the `reason` field style: short, single-sentence, describes what the user will observe.

## DO NOT

- DO NOT write directly to `.docwriter/hooks.json` via Edit/Write. The user wants to review hooks before they're saved.
- DO NOT propose multiple hooks per request unless the user explicitly asked for several. Ask clarifying questions first if ambiguous.
- DO NOT propose a hook whose command you're unsure about — ask the user to confirm the exact command instead of guessing.
- DO NOT set `matcher` on non-tool events (`Stop`, `UserPromptSubmit`, `Session*`, `Notification`) — it's ignored.

## After proposing

Keep your text response brief: "Proposed a hook that runs pdflatex after edits — accept in the sidebar to save it." The user reviews and accepts it from the OutlinePane.
