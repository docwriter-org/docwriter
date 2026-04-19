# Release Checklist

## Before Publishing

1. Install and build.

```sh
npm install
npm run build
```

2. Run the static checks.

```sh
npm run check
```

3. Run the test suite you trust for the release.

```sh
npm test
```

4. Verify the packaged CLI from a separate workspace folder, not this repo.

```sh
npm pack
npm install -g ./docwriter-0.0.1.tgz
mkdir -p ~/tmp/docwriter-release-smoke
docwriter --new-session ~/tmp/docwriter-release-smoke
```

5. Confirm these flows manually:

- create and edit a markdown tab
- create and edit a plain-text tab
- reload and confirm persistence
- agent Accept and Reject flow
- switch tabs after an agent edit, then Reject
- `New agent session` keeps tabs/files/settings
- `--watch` reload path works

## Packaging Constraints

The package only includes:

- `bin/`
- `build/`

So a release must always be built first.

## Publish

When ready:

```sh
npm publish
```

If you want a dry run first:

```sh
npm publish --dry-run
```
