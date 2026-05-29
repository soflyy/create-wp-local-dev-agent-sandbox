#!/usr/bin/env bash
#
# Connect Claude Code (in the workspace) to the MCP servers in this sandbox, at
# user scope so they persist in workspace/ across rebuilds. Idempotent
# (remove-then-add). Run via `npm run setup`.
#
#   - wordpress: the mcp-adapter plugin's server, over HTTP, authenticated with a
#     WordPress Application Password. (HTTP is more reliable than the stdio
#     transport, which tended to drop.) Works over plain HTTP because the site is
#     WP_ENVIRONMENT_TYPE=local; needs pretty permalinks (enabled by install-wp.sh).
#   - playwright: the prebaked Playwright MCP service, over HTTP, for driving a
#     headless browser against the site at http://wordpress.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

# WordPress MCP server (skipped if mcp-adapter isn't active).
if docker compose exec -T workspace wp plugin is-active mcp-adapter >/dev/null 2>&1; then
  echo "→ Connecting Claude to the WordPress MCP server (HTTP + application password)…"
  # Single exec so the app password stays inside the container. We reset admin's
  # app passwords (the sandbox only uses them for this) and mint a fresh one —
  # the plaintext is only available at creation time.
  docker compose exec -T workspace sh -c '
    wp user application-password delete admin --all >/dev/null 2>&1 || true
    APPPASS=$(wp user application-password create admin "claude-code" --porcelain)
    B64=$(printf "%s" "admin:$APPPASS" | base64 | tr -d "\n")
    claude mcp remove wordpress --scope user >/dev/null 2>&1 || true
    claude mcp add wordpress --scope user --transport http "http://wordpress/wp-json/mcp/mcp-adapter-default-server" --header "Authorization: Basic $B64"
  '
else
  echo "→ mcp-adapter plugin not active — skipping the WordPress MCP server."
fi

# Playwright MCP server (the playwright compose service, reached over HTTP).
echo "→ Connecting Claude to the Playwright MCP server…"
docker compose exec -T workspace sh -c "
  claude mcp remove playwright --scope user >/dev/null 2>&1 || true
  claude mcp add playwright --scope user --transport http http://playwright:8931/mcp
"

echo "✓ MCP servers registered — run 'npm run claude' and use them right away."
