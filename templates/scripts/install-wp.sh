#!/usr/bin/env bash
#
# Install WordPress (admin / password) via WP-CLI in the workspace container
# (run via `npm run setup`). Idempotent: no-ops if WordPress is already
# installed. Assumes the stack is up.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

# Load .env for the host port, used as the site URL.
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
WP_PORT="${WP_PORT:-8080}"

if docker compose exec -T workspace wp core is-installed >/dev/null 2>&1; then
  echo "✓ WordPress is already installed — nothing to do."
  exit 0
fi

echo "→ Installing WordPress…"
docker compose exec -T workspace wp core install \
  --url="http://localhost:${WP_PORT}" \
  --title="WordPress Dev" \
  --admin_user="admin" \
  --admin_password="password" \
  --admin_email="admin@example.com" \
  --skip-email

cat <<EOF
✓ WordPress installed.
    Site:     http://localhost:${WP_PORT}
    Admin:    http://localhost:${WP_PORT}/wp-admin/  (admin / password)
EOF
