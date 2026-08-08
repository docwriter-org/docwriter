# Documentation visual assets

The documentation uses Playwright captures from a seeded temporary workspace. Structural states do not need a provider credential. Agent, research, and LaTeX states use the credentials and tools listed below.

The standard viewport is 1400 by 900 pixels. The introduction recording uses 1200 by 780 pixels.

## Asset inventory

| Asset | Owning page | Scenario | Requirements |
| --- | --- | --- | --- |
| `intro-flow.gif` | Overview | Writer keeps typing while a seeded proposal waits | `ffmpeg` |
| `intro-flow.mp4` and `intro-flow.webm` | Overview | Video formats for the same concurrent writing sequence | `ffmpeg` |
| `review-workflow.mp4` and `review-workflow.webm` | Review edits | Hover, accept, and reject seeded proposals | None |
| `agent-controls.mp4` and `agent-controls.webm` | Send and steer requests | Pause, resume, Chat, and Plan first | None |
| `mute-proposals.mp4` and `mute-proposals.webm` | Control agent behavior | Hide and restore proposal layers | None |
| `plan-workflow.mp4` and `plan-workflow.webm` | Plans and long tasks | Review a plan and choose Run it | Provider credential |
| `split-preview.mp4` and `split-preview.webm` | Generated previews | Open, resize, and reload a split HTML preview | None |
| `tour-interface-overview.png` | Interface tour | Major regions with generated labels | None |
| `tour-interface-clean.png` | Interface tour | Same state without labels | None |
| `quickstart-essay-open.png` | Your first writing workflow | Seed essay open in the editor | None |
| `quickstart-pending-edit.png` | Your first writing workflow | One pending edit in the comment gutter | Provider credential |
| `editor-tabs.png` | Files and tabs | Several open tabs | None |
| `file-tree-actions.png` | Files and tabs | File controls and context menu | None |
| `editor-find-bar.png` | Find and appearance | Find bar with matches | None |
| `appearance-settings.png` | Find and appearance | Theme and layout settings | None |
| `images-diagrams-preview.png` | Images and diagrams | Raw SVG rendered inside the editor | None |
| `provider-picker.png` | Connect a provider | Provider menu in the header | None |
| `model-picker.png` | Connect a provider | Searchable model menu in the header | None |
| `api-keys-panel.png` | Connect a provider | Provider credential settings and status | None |
| `inline-directives-in-doc.png` | Selected text and directives | Directive in source | None |
| `inline-feedback-popup.png` | Selected text and directives | Selected passage and feedback controls | None |
| `freeze-selection-popup.png` | Selected text and directives | Freeze action in the feedback popup | None |
| `freeze-passage.png` | Writing rules | Frozen paragraph and lock | None |
| `freeze-unlock-menu.png` | Writing rules | Unlock menu | None |
| `chat-popover.png` | Send and steer requests | Chat panel with a draft request | None |
| `agent-wakeup-button.png` | Send and steer requests | Close crop of the agent pill | None |
| `agent-dock-opener.png` | Interface tour | Collapsed agent pill highlighted in the lower right corner | None |
| `agent-paused.png` | Control agent behavior | Expanded dock while paused | None |
| `agent-paused-pill.png` | Control agent behavior | Collapsed paused pill | None |
| `agent-behavior-panel.png` | Control agent behavior | Low, Medium, and High autonomy | None |
| `reviewing-edits-pending.png` | Review edits | One expanded proposal | Provider credential |
| `agent-accept-reject-all.png` | Review edits | Batch review actions | None |
| `comment-thread.png` | Comments and critique | Anchored discussion | None |
| `critique-pass-menu.png` | Comments and critique | Built in reviewer menu | None |
| `transcript-overview.png` | Activity and transcript | Transcript event list | None |
| `transcript-detail.png` | Activity and transcript | Search and tool filter | None |
| `sessions-browser.png` | Sessions | Session search and switch dialog | None |
| `writing-rules-panel.png` | Writing rules | Rules toolbar popover | None |
| `writing-references-panel.png` | Writing references | References settings | None |
| `style-guidance-sources.png` | Writing references | Three pasted sources ready to analyze | None |
| `style-guidance-specialists.png` | Writing references | Lexis / Grammar / Discourse specialists mid-run | Provider credential |
| `style-guidance-preference.png` | Writing references | Preference A vs B calibration card | Provider credential |
| `style-guidance-skill.png` | Writing references | Style draft / active skill propositions | Provider credential |
| `style-guidance-editor-edit.png` | Writing references | Expanded pending edit after sounding-like-me directive | Provider credential |
| `intended-audience-panel.png` | Customize the agent | Audience settings | None |
| `skills-panel.png` | Customize the agent | Skills settings | None |
| `hooks-panel.png` | Hooks | Hook settings | None |
| `blog-post-open.png` | Example projects | Research draft before the run | Provider credential |
| `blog-pending-edit.png` | Example projects | Research results in the gutter | Provider credential with web search |
| `overleaf-tex-open.png` | LaTeX and SyncTeX | TeX source before the run | `pdflatex` |
| `latex-split-preview.png` | LaTeX and SyncTeX | TeX source beside its generated PDF | `pdflatex` |
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

Capture the Writing references walkthrough (sources → specialists → preference → skill → editor edit). Needs a provider credential and several minutes for analysis:

```sh
node docs/capture-style-guidance.mjs
```

If analysis already finished in a kept workspace, resume the last two shots with:

```sh
DOCWRITER_ROOT=/path/to/workspace node docs/capture-style-guidance-finish.mjs
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
