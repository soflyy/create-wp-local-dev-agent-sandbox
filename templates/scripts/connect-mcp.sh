#!/usr/bin/env bash
#
# Connect Claude Code (in the workspace) to the MCP servers in this sandbox, at
# user scope so they persist in workspace/ across rebuilds. Idempotent
# (remove-then-add). Run via `npm run setup`.
#
#   - wordpress: the mcp-adapter plugin's server, over stdio via WP-CLI — no HTTP,
#     application password, or proxy needed, since Claude and WP-CLI share the
#     same container and the same /wp files + database.
#   - playwright: the prebaked Playwright MCP service, over HTTP, for driving a
#     headless browser against the site at http://wordpress.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

# WordPress MCP server (skipped if mcp-adapter isn't active).
if docker compose exec -T workspace wp plugin is-active mcp-adapter >/dev/null 2>&1; then
  echo "→ Connecting Claude to the WordPress MCP server…"
  docker compose exec -T workspace sh -c "
    claude mcp remove wordpress --scope user >/dev/null 2>&1 || true
    claude mcp add wordpress --scope user -- wp --path=/wp mcp-adapter serve --server=mcp-adapter-default-server --user=admin
  "
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
