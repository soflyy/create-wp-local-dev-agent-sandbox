#!/usr/bin/env bash
#
# Connect Claude Code (in the workspace) to the MCP servers in this sandbox, at
# user scope so they persist in workspace/ across rebuilds. Idempotent
# (remove-then-add). Run via `npm run setup`.
#
#   - wordpress: the site's MCP server (Agent Connector for WP, which bundles
#     mcp-adapter), reached through Automattic's mcp-wordpress-remote stdio proxy
#     run locally via npx — the broadly-supported way to reach a WordPress MCP
#     server. It authenticates with a WordPress application password (no direct
#     HTTP transport). Needs pretty permalinks (enabled by install-wp.sh).
#   - playwright: the prebaked Playwright MCP service, over HTTP, for driving a
#     headless browser against the site at http://wordpress.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

# WordPress MCP server (skipped if Agent Connector for WP isn't active).
if docker compose exec -T workspace wp plugin is-active agent-connector-for-wp >/dev/null 2>&1; then
  echo "→ Connecting Claude to the WordPress MCP server (mcp-wordpress-remote proxy)…"
  # Single exec so the app password stays inside the container. We reset admin's
  # app passwords (the sandbox only uses them for this) and mint a fresh one —
  # the plaintext is only available at creation time. The proxy runs via npx and
  # reaches the site over the Docker network at http://wordpress; it auths with
  # the application password (OAUTH_ENABLED=false selects that path).
  docker compose exec -T workspace sh -c '
    wp user application-password delete admin --all >/dev/null 2>&1 || true
    APPPASS=$(wp user application-password create admin "claude-code" --porcelain)
    claude mcp remove wordpress --scope user >/dev/null 2>&1 || true
    claude mcp add wordpress --scope user \
      --env WP_API_URL=http://wordpress/wp-json/mcp/mcp-adapter-default-server \
      --env WP_API_USERNAME=admin \
      --env WP_API_PASSWORD="$APPPASS" \
      --env OAUTH_ENABLED=false \
      -- npx -y @automattic/mcp-wordpress-remote
  '
else
  echo "→ agent-connector-for-wp plugin not active — skipping the WordPress MCP server."
fi

# Playwright MCP server (the playwright compose service, reached over HTTP).
echo "→ Connecting Claude to the Playwright MCP server…"
docker compose exec -T workspace sh -c "
  claude mcp remove playwright --scope user >/dev/null 2>&1 || true
  claude mcp add playwright --scope user --transport http http://playwright:8931/mcp
"

echo "✓ MCP servers registered — run 'npm run claude' and use them right away."
