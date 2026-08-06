<p align="center">
  <img src="static/docwriter-mark.svg" width="88" alt="DocWriter" />
</p>

<h1 align="center">DocWriter</h1>

<p align="center">
  Write with an AI agent in the same draft while keeping control of every change.
</p>

<p align="center">
  <a href="https://docwriter.org">Website</a>
  ·
  <a href="https://docs.docwriter.org">Documentation</a>
  ·
  <a href="https://docs.docwriter.org/quickstart">Quickstart</a>
</p>

<p align="center">
  <img src="docs/images/intro-flow.gif" width="900" alt="A writer keeps working while reviewing an agent edit in DocWriter" />
</p>

DocWriter is a local writing app where you and an AI agent work in the same draft. You can keep writing while the agent researches, comments, or proposes changes. Every proposed edit appears beside the text so you can accept it, reject it, or reply.

Your writing stays in ordinary project files that you can open with other editors, track with Git, and move between computers.

## Quick start

DocWriter supports macOS and Linux. Windows users can run it through WSL. Install [Git](https://git-scm.com) and [nvm](https://github.com/nvm-sh/nvm) first.

```sh
git clone https://github.com/docwriter-org/docwriter.git
cd docwriter
nvm use
npm install
npm run build
npm link

docwriter ~/writing/my-project
```

The last command opens the chosen folder in your browser. You can create and edit files without an AI account.

Connect Claude, OpenAI, Codex, Cursor, or Pi when you want to use the agent. Follow [Connect a provider](https://docs.docwriter.org/connect-provider), then [Make your first edit](https://docs.docwriter.org/quickstart).

## How the agent helps

- **Ask from the text.** Select a passage, leave an inline instruction, reply in a comment, or send a Chat request.
- **Keep writing during longer work.** The agent can research sources or revise other files while you continue with the draft.
- **Review changes in place.** Proposed edits show the words the agent wants to add or remove beside the affected passage. Your project file changes after you accept an edit.
- **Save writing preferences.** Rules tell the agent what to preserve or avoid, and references give it examples to follow.
- **Choose how proactive the agent can be.** Low, Medium, and High autonomy control what the agent may do without a direct request. Autonomy does not change how you review proposed edits.
- **Work with a whole project.** Open Markdown, plain text, LaTeX, source files, images, and PDFs in one workspace.

## Start with the documentation

- [Install DocWriter](https://docs.docwriter.org/install) and open a project folder.
- [Make your first edit](https://docs.docwriter.org/quickstart) and review the proposed change.
- [Tour the interface](https://docs.docwriter.org/tour/interface) to find files, comments, reviews, and agent activity.
- [Control agent behavior](https://docs.docwriter.org/agent/agent-behavior) to set autonomy or pause the agent.
- [Add writing rules](https://docs.docwriter.org/customize/rules) for preferences that should apply across requests.
- [Fix common problems](https://docs.docwriter.org/help/recovery) after a crash, stale proposal, or blank editor.

## Development

Use Node.js 22.22.2, which is pinned in `.nvmrc`.

```sh
nvm use
npm install
npm run dev
npm run check
npm run build
```

Use `npm run docs` to preview the documentation. Read the [contributor setup](https://docs.docwriter.org/contribute/setup) before submitting a code change.

## About the project

DocWriter is an open source research project from the [Carnegie Mellon University Computer Science Department](https://cs.cmu.edu) and [UC Berkeley EECS](https://eecs.berkeley.edu).
