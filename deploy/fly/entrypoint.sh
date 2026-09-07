#!/bin/sh
# Container entrypoint for the Fly image: prepare /data, self-test the
# sandbox, start backups when configured, then run the supervisor as PID of
# record so Fly's stop signal reaches it (it stops every user process first).
set -eu

mkdir -p /data/users
chmod 755 /data /data/users
touch /data/allowlist

# bubblewrap must work for an unprivileged uid, which is how every user
# process runs. A failure here means the kernel blocks user namespaces.
if setpriv --reuid=65534 --regid=65534 --clear-groups \
     bwrap --unshare-user --ro-bind / / -- /bin/true 2>/tmp/bwrap.err; then
  echo '{"level":"info","msg":"bwrap self-test passed for an unprivileged uid"}'
else
  echo "{\"level\":\"error\",\"msg\":\"bwrap self-test FAILED: $(tr -d '\n' </tmp/bwrap.err)\"}"
  echo '{"level":"error","msg":"refusing to start without a working sandbox; set SUPERVISOR_SANDBOX=none only for a throwaway test"}'
  [ "${SUPERVISOR_SANDBOX:-bwrap}" = "none" ] || exit 1
fi

# Continuous SQLite replication, when a bucket is configured (see litestream.yml).
if [ -n "${LITESTREAM_ACCESS_KEY_ID:-}" ]; then
  litestream replicate -config /app/deploy/backup/litestream.yml &
  echo '{"level":"info","msg":"litestream started"}'
fi

# Hourly copy of everything else, when an rclone remote named "backup" is
# configured through RCLONE_CONFIG_BACKUP_* variables.
if [ -n "${RCLONE_CONFIG_BACKUP_TYPE:-}" ]; then
  ( while :; do sleep 3600; /app/deploy/backup/backup.sh || echo '{"level":"warn","msg":"backup failed"}'; done ) &
  echo '{"level":"info","msg":"hourly backup loop started"}'
fi

exec node /app/deploy/supervisor/main.js
