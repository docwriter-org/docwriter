#!/usr/bin/env bash
# Hourly copy of everything Litestream does not cover: references, PDFs,
# skills, hooks, scratch, and each user's home (Claude transcripts, keys).
# Requires an rclone remote named "backup" (rclone config, as root).
set -euo pipefail
exec rclone sync /data/users backup:docwriter/users \
  --exclude 'workspace/.docwriter/docwriter.db*' \
  --exclude 'workspace/.docwriter/backups/**' \
  --exclude 'home/.cache/**' \
  --transfers 8 --fast-list --stats-one-line --log-level NOTICE
