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

Docs preview:

```sh
npm run docs    # http://localhost:3333
```

## Vercel + Clerk

The Vercel build uses `@sveltejs/adapter-vercel`; local CLI builds keep using `@sveltejs/adapter-node`.

Required production environment variables:

```sh
APP_URL=https://docwriter.org
PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
```

On Vercel, auth is required automatically. For local auth testing, set `CLERK_AUTH_REQUIRED=1`. Use Clerk Restricted mode or invitations if access should be limited to specific users.
