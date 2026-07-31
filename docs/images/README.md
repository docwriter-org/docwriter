# Documentation visual assets

The documentation uses Playwright captures from a seeded temporary workspace. Structural states do not need a provider credential. Agent, research, and LaTeX states use the credentials and tools listed below.

The standard viewport is 1400 by 900 pixels. The introduction recording uses 1200 by 780 pixels.

## Asset inventory

| Asset | Owning page | Scenario | Requirements |
| --- | --- | --- | --- |
| `intro-flow.gif` | Overview | Writer keeps typing while a seeded proposal waits | `ffmpeg` |
| `intro-flow.mp4` and `intro-flow.webm` | Overview | Video formats for the same concurrent writing sequence | `ffmpeg` |
| `review-workflow.mp4` and `review-workflow.webm` | Review edits | Hover, accept, and reject seeded proposals | None |
| `agent-controls.mp4` and `agent-controls.webm` | Ask and steer | Pause, resume, Chat, and Plan first | None |
| `mute-proposals.mp4` and `mute-proposals.webm` | Ask and steer | Hide and restore proposal layers | None |
| `plan-workflow.mp4` and `plan-workflow.webm` | Plans and long tasks | Review a plan and choose Run it | Provider credential |
| `split-preview.mp4` and `split-preview.webm` | Generated previews | Open, resize, and reload a split HTML preview | None |
| `tour-interface-overview.png` | Interface tour | Major regions with generated labels | None |
| `tour-interface-clean.png` | Interface tour | Same state without labels | None |
| `quickstart-essay-open.png` | Make your first edit | Seed essay open in the editor | None |
| `quickstart-pending-edit.png` | Make your first edit | One pending edit in the comment gutter | Provider credential |
| `editor-tabs.png` | Files and tabs | Several open tabs | None |
| `editor-find-bar.png` | Find and appearance | Find bar with matches | None |
| `inline-directives-in-doc.png` | Selected text and directives | Directive in source | None |
| `inline-feedback-popup.png` | Selected text and directives | Selected passage and feedback controls | None |
| `freeze-selection-popup.png` | Selected text and directives | Freeze action in the feedback popup | None |
| `freeze-passage.png` | Customize the agent | Frozen paragraph and lock | None |
| `freeze-unlock-menu.png` | Customize the agent | Unlock menu | None |
| `chat-popover.png` | Ask and steer | Chat panel with a draft request | None |
| `agent-wakeup-button.png` | Ask and steer | Close crop of the agent pill | None |
| `agent-paused.png` | Ask and steer | Expanded dock while paused | None |
| `agent-paused-pill.png` | Ask and steer | Collapsed paused pill | None |
| `agent-behavior-panel.png` | Ask and steer | Low, Medium, and High autonomy | None |
| `reviewing-edits-pending.png` | Review edits | One expanded proposal | Provider credential |
| `agent-accept-reject-all.png` | Review edits | Batch review actions | None |
| `comment-thread.png` | Comments and critique | Anchored discussion | None |
| `critique-pass-menu.png` | Comments and critique | Built in reviewer menu | None |
| `transcript-overview.png` | Sessions and history | Transcript event list | None |
| `transcript-detail.png` | Sessions and history | Search and tool filter | None |
| `writing-rules-panel.png` | Customize the agent | Rules toolbar popover | None |
| `writing-references-panel.png` | Customize the agent | References settings | None |
| `skills-panel.png` | Customize the agent | Skills settings | None |
| `hooks-panel.png` | Hooks | Hook settings | None |
| `blog-post-open.png` | Example projects | Research draft before the run | Provider credential |
| `blog-pending-edit.png` | Example projects | Research results in the gutter | Provider credential with web search |
| `overleaf-tex-open.png` | LaTeX and SyncTeX | TeX source before the run | `pdflatex` |
| `overleaf-pending-edit.png` | LaTeX and SyncTeX | Proposed TeX edit | Provider credential and `pdflatex` |
| `overleaf-pdf-preview.png` | LaTeX and SyncTeX | Rebuilt PDF preview | Provider credential and `pdflatex` |

The overview keeps a GIF fallback for browsers that cannot play MP4 or WebM. The shorter workflow recordings use MP4 first and WebM second.

## Commands

Run every scenario:

```sh
npm run docs:assets
```

Run deterministic screenshots only:

```sh
npm run docs:assets:structural
```

Run credentialed agent screenshots:

```sh
npm run docs:assets:agent
```

Run the introduction recording:

```sh
npm run docs:assets:videos
```

The video command also records the review and agent control workflows from deterministic fixtures.

Check references, file sizes, and dimensions:

```sh
npm run docs:assets:verify
```

Install Chromium once with `npx playwright install chromium`. Video conversion also needs `ffmpeg`. The LaTeX scenario needs `pdflatex` and `synctex`.

## Capture flags

* `SKIP_AGENT=1` skips agent work.
* `SKIP_BLOG=1` skips the research scenario.
* `SKIP_LATEX=1` skips the LaTeX scenario.
* `SKIP_GIF=1` skips the introduction recording.
* `SKIP_STRUCTURAL=1` skips deterministic screenshots.
* `AGENT_TIMEOUT_MS=...` changes the pending review timeout.
* `KEEP_FIXTURE=1` keeps the temporary workspace for inspection.

The capture script adds labels in the browser before taking the annotated screenshot. It also saves a clean version of the same interface state.
