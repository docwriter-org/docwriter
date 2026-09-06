#!/usr/bin/env bash
# One-time setup of a hosting machine for DocWriter. Ubuntu 24.04, run as root.
# Idempotent: safe to re-run. Does not deploy a release; see deploy/README.md.
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN, e.g. app.docwriter.org}"
NODE_MAJOR="${NODE_MAJOR:-22}"

echo "== packages"
apt-get update -q
apt-get install -y -q bubblewrap rclone curl ca-certificates gnupg ufw

if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1)" != "v${NODE_MAJOR}" ]]; then
  echo "== node ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "== caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

if ! command -v litestream >/dev/null; then
  echo "== litestream"
  LS_VER="$(curl -fsSL https://api.github.com/repos/benbjohnson/litestream/releases/latest | grep -oP '"tag_name": "v\K[^"]+')"
  curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LS_VER}/litestream-v${LS_VER}-linux-amd64.deb" -o /tmp/litestream.deb
  dpkg -i /tmp/litestream.deb
fi

echo "== unprivileged user namespaces (bubblewrap needs them)"
# Ubuntu 24.04 restricts unprivileged userns under AppArmor; the bubblewrap
# package ships a profile that allows /usr/bin/bwrap. Make sure it is loaded
# and that the sysctl is not disabling userns outright.
sysctl -w kernel.unprivileged_userns_clone=1 >/dev/null 2>&1 || true
if [[ -f /etc/apparmor.d/bwrap-userns-restrict ]]; then apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict || true; fi
su -s /bin/sh nobody -c 'bwrap --unshare-user --ro-bind / / -- /bin/true' && echo "bwrap ok for unprivileged users"

echo "== layout"
mkdir -p /app/releases /data/users /etc/docwriter
chmod 755 /app /app/releases /data /data/users
touch /etc/docwriter/allowlist
[[ -f /etc/docwriter/supervisor.env ]] || cat > /etc/docwriter/supervisor.env <<ENV
# Filled in by hand once. Restart docwriter-supervisor after editing.
SUPERVISOR_PUBLIC_ORIGIN=https://${DOMAIN}
SUPERVISOR_BIND=127.0.0.1
SUPERVISOR_PORT=8080
SUPERVISOR_DATA_DIR=/data
SUPERVISOR_APP_DIR=/app/current
SUPERVISOR_SANDBOX=bwrap
# clerk (email, magic link, Google, GitHub via the Clerk dashboard) or github (OAuth app only)
SUPERVISOR_AUTH=clerk
SUPERVISOR_ALLOWLIST=/etc/docwriter/allowlist
SUPERVISOR_MAX_PROCESSES=60
SUPERVISOR_MEMORY_MAX=1500M
CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
SUPERVISOR_COOKIE_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | head -c 48)
SUPERVISOR_METRICS_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '=+/' | head -c 32)
# Shared model key for every user, or leave empty for bring-your-own-key.
ANTHROPIC_API_KEY=
ENV
chmod 600 /etc/docwriter/supervisor.env

echo "== services"
HERE="$(cd "$(dirname "$0")" && pwd)"
install -m 644 "$HERE/docwriter-supervisor.service" /etc/systemd/system/
sed "s/__DOMAIN__/${DOMAIN}/g" "$HERE/Caddyfile" > /etc/caddy/Caddyfile
install -m 644 "$HERE/../backup/litestream.yml" /etc/litestream.yml
install -m 644 "$HERE/../backup/docwriter-backup.service" "$HERE/../backup/docwriter-backup.timer" /etc/systemd/system/
install -m 755 "$HERE/../backup/backup.sh" /usr/local/bin/docwriter-backup
systemctl daemon-reload
systemctl enable caddy docwriter-supervisor docwriter-backup.timer
systemctl restart caddy

echo "== firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo
echo "Done. Next: fill in /etc/docwriter/supervisor.env, add logins to /etc/docwriter/allowlist,"
echo "deploy a release (deploy/machine/release.sh), then: systemctl start docwriter-supervisor litestream"
