#!/usr/bin/env bash
# One-time server setup for automatic deploys (.github/workflows/deploy.yml). Run as a sudoer:
#   sudo bash deploy/setup-server.sh https://vivairium.seah.world <SSH hostname of the Cloudflare Tunnel>
# The SSH hostname is the tunnel's public hostname for ssh://localhost:22 (deploy/DEPLOY.md), never the server IP.
# Safe to run again: existing users, keys, .env and data are kept.
set -euo pipefail

PUBLIC_URL="${1:?usage: setup-server.sh <PUBLIC_URL> <tunnel SSH hostname>}"
SSH_HOST="${2:?usage: setup-server.sh <PUBLIC_URL> <tunnel SSH hostname>}"
APP_DIR=/var/www/seah.world/vivarium
DEPLOY_USER=deploy
SERVICE_USER=vivarium
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }

# Node 22.13+ (node:sqlite).
if [ ! -x /usr/bin/node ] || ! /usr/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Node.js 22.13+ is required at /usr/bin/node (found: $(/usr/bin/node --version 2>/dev/null || echo none))." >&2
  echo "Install it, e.g. from https://github.com/nodesource/distributions, then run this script again." >&2
  exit 1
fi
command -v rsync > /dev/null || apt-get install -y rsync
command -v curl > /dev/null || apt-get install -y curl
[ -f /etc/ssh/ssh_host_ed25519_key.pub ] || { echo "No ed25519 SSH host key (/etc/ssh/ssh_host_ed25519_key.pub)." >&2; exit 1; }

# Users: "deploy" copies files and may only restart the service; "vivarium" runs it and owns the database.
id "$SERVICE_USER" > /dev/null 2>&1 || adduser --system --group --no-create-home --home "$APP_DIR" "$SERVICE_USER"
id "$DEPLOY_USER" > /dev/null 2>&1 || adduser --disabled-password --gecos "GitHub Actions deploy" "$DEPLOY_USER"

# Code (written by deploy, read by vivarium), data and settings (vivarium only).
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$APP_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$APP_DIR/data"
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" << EOF
PUBLIC_URL=$PUBLIC_URL
EOF
fi
chown root:"$SERVICE_USER" "$APP_DIR/.env"
chmod 640 "$APP_DIR/.env"

# Service. Started by the first deploy (no code yet).
install -m 644 "$HERE/vivarium.service" /etc/systemd/system/vivarium.service
systemctl daemon-reload
systemctl enable vivarium

# The deploy user may restart the service and read its logs, nothing else.
cat > /etc/sudoers.d/vivarium-deploy << EOF
$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart vivarium, /usr/bin/journalctl -u vivarium -n 50 --no-pager
EOF
chmod 440 /etc/sudoers.d/vivarium-deploy
visudo -cf /etc/sudoers.d/vivarium-deploy

# SSH key for GitHub Actions, used only to log in as deploy.
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 700 "$DEPLOY_HOME/.ssh"
KEY_OUT=""
if ! grep -q "github-actions-vivarium" "$DEPLOY_HOME/.ssh/authorized_keys" 2>/dev/null; then
  KEY_OUT="$(mktemp -d)/vivarium_deploy_key"
  ssh-keygen -q -t ed25519 -N "" -C "github-actions-vivarium" -f "$KEY_OUT"
  cat "$KEY_OUT.pub" >> "$DEPLOY_HOME/.ssh/authorized_keys"
  rm -f "$KEY_OUT.pub"
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_HOME/.ssh/authorized_keys"
chmod 600 "$DEPLOY_HOME/.ssh/authorized_keys"

# known_hosts line so the workflow only talks to this server.
KNOWN_HOSTS="$SSH_HOST $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"

echo
echo "Server ready. Add these secrets in GitHub: repo > Settings > Secrets and variables > Actions"
echo "  DEPLOY_HOST              $SSH_HOST"
echo "  DEPLOY_KNOWN_HOSTS       $KNOWN_HOSTS"
if [ -n "$KEY_OUT" ]; then
  echo "  DEPLOY_SSH_KEY           the whole content of $KEY_OUT"
  echo "                           sudo cat $KEY_OUT   # copy it, then: sudo rm -r $(dirname "$KEY_OUT")"
else
  echo "  DEPLOY_SSH_KEY           (already set up earlier; to replace it, remove the github-actions-vivarium line"
  echo "                           from $DEPLOY_HOME/.ssh/authorized_keys and run this script again)"
fi
echo "  CF_ACCESS_CLIENT_ID      Client ID of the Cloudflare Access service token"
echo "  CF_ACCESS_CLIENT_SECRET  Client Secret of the same token"
echo
echo "Then run the Deploy workflow (Actions tab > Deploy > Run workflow) or push to main."
