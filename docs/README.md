# DocWriter docs

Mintlify documentation for DocWriter.

## Preview locally

From the repo root:

```sh
npm run docs
```

This runs `npx mintlify dev` against `docs/` on port 3333. Open
http://localhost:3333 in a browser; pages reload on save.

If this is your first time, `npx` will download the Mintlify CLI on
demand.

## Regenerate screenshots

One-time setup:

```sh
npx playwright install chromium
```

Then any time you want to regenerate:

```sh
npm run docs:screenshots
```

This runs `docs/capture-screenshots.mjs`, which spawns a fresh
`vite dev` against a seeded temp workspace, drives Chromium through a
few structural UI states, and writes PNGs into `docs/images/`. It picks
free HTTP and WebSocket ports automatically, so it works even when you
have another DocWriter open.

Captures three states out of the box: the empty interface, an essay open
in the editor, and the Hooks panel under the Settings menu. The other
images referenced in the docs (pending-review cards, the Overleaf
side-by-side) require agent output and are captured manually. See
[`docs/images/README.md`](./images/README.md).

## Editing

Pages are MDX. The navigation lives in [`docs.json`](./docs.json). To
add a new page:

1. Create the `.mdx` file under the appropriate group folder.
2. Add its slug to the `pages` array in `docs.json`.
3. Run `npm run docs` to preview.
