# DocWriter

AI-assisted writing editor you run against any local folder.

**[Documentation](https://ucberkeley-8d9be701.mintlify.app)**

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
