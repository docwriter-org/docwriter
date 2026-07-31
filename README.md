# DocWriter

DocWriter is a shared writing workspace where you and an AI agent work alongside each other in the same live draft.

Keep writing while the agent researches, comments, or proposes changes. You can respond to its work, and it can respond to yours.

**[Documentation](https://docs.docwriter.org)**

## Development

```sh
npm install
npm run dev     # dev server
npm run build   # production build
npm run check   # type-check
```

When you run `npm install`, you also download the pinned PDF.js viewer
used for local PDF previews. We exclude the generated files under
`static/pdfjs/` from Git.

Docs preview:

```sh
npm run docs    # http://localhost:3333
```
