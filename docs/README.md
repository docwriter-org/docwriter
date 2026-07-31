# DocWriter documentation

The public site is available at https://docs.docwriter.org.

## Preview locally

From the repo root:

```sh
npm run docs
```

This runs `npx mintlify dev` against `docs/` on port 3333. Open
http://localhost:3333 in a browser; pages reload on save.

If this is your first time, `npx` will download the Mintlify CLI on
demand.

## Validate the documentation

Run the feature, navigation, redirect, link, and image checks:

```sh
npm run docs:catalog
npm run docs:validate
npm run docs:assets:verify
```

## Regenerate visual assets

One-time setup:

```sh
npx playwright install chromium
```

Generate deterministic screenshots without a provider credential:

```sh
npm run docs:assets:structural
```

The capture script starts DocWriter against a seeded temporary workspace
and writes files under `docs/images/`. Agent scenarios need a provider
credential. The recording scenario also needs `ffmpeg`, and the LaTeX
scenario needs `pdflatex`.

See [`docs/images/README.md`](./images/README.md) for the asset inventory,
requirements, and focused commands.

## Editing

Pages are MDX, and navigation lives in [`docs.json`](./docs.json). To add
a new page:

1. Create the `.mdx` file under the appropriate group folder.
2. Add its slug to the `pages` array in `docs.json`.
3. Run `npm run docs` to preview.

Every shipped feature in [`feature-catalog.json`](./feature-catalog.json)
must have one target page. Update
[`scripts/generate-feature-catalog.mjs`](../scripts/generate-feature-catalog.mjs),
run `npm run docs:catalog`, and then run `npm run docs:validate`.
