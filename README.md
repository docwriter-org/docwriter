# DocWriter

AI-assisted writing editor you run against any local folder.

DocWriter is a local web app plus CLI. You point it at a workspace directory, open text files as tabs, edit them in the browser, and ask an agent to revise or review the writing. The intended usage is:

- write in some separate folder like `~/writing/essay-draft`
- launch `docwriter ~/writing/essay-draft`
- use the browser UI to edit, review, and accept/reject agent changes

This repo contains the source for the CLI and app. End users should use the packaged CLI, not run the editor inside this repo.

## Documentation

**[https://ucberkeley-8d9be701.mintlify.app](https://ucberkeley-8d9be701.mintlify.app)**

The source for the docs is in [`docs/`](./docs/). To preview locally:

```sh
npm run docs
```

Opens at http://localhost:3333. See [`docs/README.md`](./docs/README.md)
for editing notes and regenerating screenshots.

## Status

The npm package is not published yet.

Today there are three realistic ways to run it:

- install a local tarball with `npm pack` and `npm install -g`
- use `npm link` during development
- run `node bin/docwriter.js <workspace>` directly from this repo

## Auth

DocWriter uses Anthropic through the Claude Agent SDK.

You can authenticate in either of these ways:

- `claude login`
  This uses credentials from your Claude subscription.
- `ANTHROPIC_API_KEY=...`
  Or pass `--api-key`.

## Install

### Option 1: Local packaged install

This is the closest thing to the real end-user flow before publishing to npm.

```sh
npm install
npm run build
npm pack
npm install -g ./docwriter-0.0.1.tgz
```

Then run it anywhere:

```sh
docwriter ~/tmp/docwriter-test
```

### Option 2: Linked development install

Good for repeated local testing while changing the code.

```sh
npm install
npm run build
npm link
```

Then:

```sh
docwriter ~/tmp/docwriter-test
```

### Option 3: Run directly from the repo

Good for quick local testing without installing globally.

```sh
npm install
npm run build
node bin/docwriter.js ~/tmp/docwriter-test
```

## Smoke Test

Use a folder outside this repo so you are testing the real workflow.

Create a clean workspace:

```sh
mkdir -p ~/tmp/docwriter-test
cat > ~/tmp/docwriter-test/essay.md <<'EOF'
# Essay Draft

This is the first paragraph.

This is the second paragraph.
EOF

cat > ~/tmp/docwriter-test/outline.md <<'EOF'
# Outline

- intro
- argument
- conclusion
EOF

mkdir -p ~/tmp/docwriter-test/notes
cat > ~/tmp/docwriter-test/notes/todo.txt <<'EOF'
fix intro
trim paragraph 2
EOF
```

Launch the app:

```sh
docwriter --new-session ~/tmp/docwriter-test
```

Or, if you are not using a `claude login` session:

```sh
ANTHROPIC_API_KEY=your_key_here docwriter --new-session ~/tmp/docwriter-test
```

What to verify:

1. Open `essay.md`, type some text, reload the page, and confirm the text persists.
2. Open `outline.md`, switch between tabs, and confirm content stays isolated.
3. Open `notes/todo.txt` and confirm plain text stays literal, not markdown-rendered.
4. Add a style reference from `Settings -> Writing references` by using the current file, pasting a sample, or saving a URL.
5. Ask the agent to revise one paragraph, then Accept and Reject to confirm review mode works.
6. After an agent edit, switch tabs, come back, and Reject. Your later typing should still remain.
7. Use `New agent session`, reload, and confirm your files and tabs still exist.
8. Run with `--watch`, edit a file from another terminal, and confirm the browser reload path works.

## CLI Usage

```sh
docwriter [options] [directory]
```

Common examples:

```sh
docwriter
docwriter ~/projects/mybook
docwriter --new-session ~/projects/mybook
docwriter --watch ~/projects/mybook
docwriter --host --watch ~/projects/mybook
docwriter --model opus ~/projects/mybook
```

Useful flags:

- `--new-session`
  Start a fresh AI conversation without wiping the workspace.
- `--watch`
  Reload the UI when workspace files change on disk.
- `--host`
  Expose the app on your local network.
- `--no-open`
  Do not auto-open a browser.
- `--model <name>`
  Set the default model for the session.
- `--api-key <key>`
  Override `ANTHROPIC_API_KEY`.

## Development

Install dependencies:

```sh
npm install
```

Run checks:

```sh
npm run check
```

Run the dev server:

```sh
npm run dev
```

Build the packaged app:

```sh
npm run build
```

Run Playwright tests:

```sh
npm test
```

## Packaging Notes

The package publishes only:

- `bin/`
- `build/`

That means you must build before creating a tarball or publishing.

See [RELEASE.md](/Users/shreyashankar/Documents/projects/docwriter/RELEASE.md) for a release checklist.
