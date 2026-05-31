#!/usr/bin/env bash
#
# Install WordPress (admin / password) via WP-CLI in the workspace container and
# enable pretty permalinks (run via `npm run setup`). Idempotent. Assumes the
# stack is up.
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
else
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
fi

# Pretty permalinks (idempotent). Needed so the REST API is reachable at the
# clean /wp-json/ paths (e.g. the WordPress MCP server). WP-CLI runs in the
# workspace, not the Apache container, so its --hard flush can't write the
# .htaccess — we write the standard rules ourselves (Apache has mod_rewrite +
# AllowOverride All, so they take effect).
echo "→ Enabling pretty permalinks…"
docker compose exec -T workspace wp rewrite structure '/%postname%/' >/dev/null
cat > workspace/wp/.htaccess <<'HT'
# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteBase /
RewriteRule ^index\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
HT
echo "✓ Pretty permalinks enabled."
