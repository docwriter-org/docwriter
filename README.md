<p align="center">
  <img src="static/docwriter-mark.svg" width="88" alt="DocWriter" />
</p>

<h1 align="center">DocWriter</h1>

<p align="center">
  <strong>Reimagining AI-assisted writing to let you:</strong>
</p>

<p align="center">
  Keep more of your voice and reduce AI slop.<br />
  Work alongside the agent in the same live draft, at the same time.<br />
  Dynamically reconfigure agency as the writing process changes.
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

DocWriter is a local writing app where you and an AI agent work alongside each other in the same draft. Write while the agent researches, comments, or proposes changes. Review agent work beside the text, then accept, reject, or respond.

Your writing stays in ordinary project files that you can open with other editors, track with Git, and move between computers.

## Quick start

The interface opens in your browser, but the `docwriter` command runs on your computer so it can work with local files. Install [Git](https://git-scm.com) and Node.js 22.22.2 first.

```sh
git clone https://github.com/docwriter-org/docwriter.git
cd docwriter
npm install
npm run build
npm link

docwriter ~/writing/my-project
```

The last command opens the chosen folder in your browser. You can create and edit files without an AI account.

Connect Claude, OpenAI, Codex, Cursor, or Pi when you want to use the agent. Follow [Connect a provider](https://docs.docwriter.org/connect-provider), then complete [Your first writing workflow](https://docs.docwriter.org/quickstart).

## How the agent helps

- **Guide the agent from the draft.** Select a passage for feedback, leave an inline instruction, reply to a comment, or send the agent a request through Chat.
- **Keep writing during longer work.** The agent can research sources or revise other files while you continue with the draft.
- **Review changes in place.** Proposed edits show the words the agent wants to add or remove beside the affected passage. Your project file changes after you accept an edit.
- **Save writing preferences.** Rules tell the agent what to preserve or avoid, and references give it examples to follow.
- **Choose how proactive the agent can be.** Low, Medium, and High autonomy control what the agent may do without a direct request. Autonomy does not change how you review proposed edits.
- **Use your project files as context.** Open a project folder so the agent can use your drafts, notes, sources, images, PDFs, and other files while it works.

## Start with the documentation

- [Install DocWriter](https://docs.docwriter.org/install) and open a project folder.
- [Complete your first writing workflow](https://docs.docwriter.org/quickstart) with references, rules, and critique passes.
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
