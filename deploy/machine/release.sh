#!/usr/bin/env bash
# Install a built release tarball and point /app/current at it.
# Usage: release.sh <tarball> [sha]   (run as root on the machine)
# The tarball is what .github/workflows/deploy-hosted.yml uploads: the repo's
# build/, deploy/, bin/, package.json and production node_modules.
set -euo pipefail
TARBALL="${1:?tarball}"
SHA="${2:-$(date +%Y%m%d%H%M%S)}"
DEST="/app/releases/${SHA}"
mkdir -p "$DEST"
tar -xzf "$TARBALL" -C "$DEST"
chmod -R a+rX "$DEST"   # every user uid must be able to read the app
ln -sfn "$DEST" /app/current.new && mv -Tf /app/current.new /app/current
# New spawns use the new release; running processes keep the old one until
# reaped (bwrap bound the real path at spawn), so nobody loses a session.
systemctl restart docwriter-supervisor
# Keep the five newest releases.
ls -1dt /app/releases/* | tail -n +6 | xargs -r rm -rf
echo "released ${SHA}"
