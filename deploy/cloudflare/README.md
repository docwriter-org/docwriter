# docwriter.org on Cloudflare + Vercel

The marketing site lives on the **`landing`** branch only. `main` is the editor CLI and does not ship `/welcome`.

## Branch workflow

```bash
# Work on the landing page
git checkout landing
git merge main          # pull editor fixes; never merge landing → main

# Local preview of the landing page (root redirects to /welcome)
LANDING_DEPLOY=1 npm run dev
```

Vercel should deploy **only** the `landing` branch (`vercel.json` disables `main`).

Never merge `landing` into `main`. To pull editor fixes into the landing branch:

```bash
git checkout landing
git merge main
```

## Cloudflare: add the domain before transferring

If you see **“Gaining account must first add the domain as a website”**:

1. Log into the **destination** Cloudflare account.
2. **Websites → Add a site →** enter `docwriter.org` and finish onboarding (free plan is fine).
3. Retry the domain move from the source account.

The gaining account must own the zone before a transfer can complete.

## Vercel

1. Import this repo in Vercel.
2. Set **Production Branch** to `landing`.
3. Add custom domains `docwriter.org` and `www.docwriter.org`.
4. Copy the domain verification / DNS targets Vercel shows (usually apex `A` + `www` `CNAME`).

`vercel.json` already sets `buildCommand` to `npm run build:landing` and redirects `/` → `/welcome`.

## Cloudflare DNS (Wrangler + API script)

Install deps once (`wrangler` is already in `package.json`):

```bash
npm install
npx wrangler login
```

Set credentials (Dashboard → My Profile → API Tokens → Edit zone DNS):

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ZONE_ID=...   # zone id for docwriter.org
```

Point DNS at Vercel:

```bash
npm run cf:dns
```

Defaults:

| Record | Value |
|--------|-------|
| `@` A | `76.76.21.21` (Vercel apex) |
| `www` CNAME | `cname.vercel-dns.com` |

Override with `VERCEL_APEX_IP` / `VERCEL_CNAME` if Vercel shows different targets.

**DNS only (grey cloud)** on `www` is recommended while Vercel provisions SSL. You can proxy later once HTTPS is green.

## Wrangler

`deploy/cloudflare/wrangler.toml` scopes the Cloudflare CLI to this zone. Use it for future Workers or DNS experiments:

```bash
npx wrangler whoami
npx wrangler --config deploy/cloudflare/wrangler.toml
```
