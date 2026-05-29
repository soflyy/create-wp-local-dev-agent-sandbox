#!/usr/bin/env bash
#
# Connect Claude Code (in the workspace) to the WordPress MCP server exposed by
# the mcp-adapter plugin, over stdio via WP-CLI — no HTTP, application password,
# or proxy needed, since Claude and WP-CLI share the same container and the same
# /wp files + database. Registered at user scope, so it persists in workspace/
# across rebuilds. Idempotent; skips if mcp-adapter isn't active.
#
# Run via `npm run setup`. Assumes WordPress is installed and plugins are in.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

NAME="wordpress"
SERVER="mcp-adapter-default-server"

if ! docker compose exec -T workspace wp plugin is-active mcp-adapter >/dev/null 2>&1; then
  echo "→ mcp-adapter plugin not active — skipping MCP connection."
  exit 0
fi

echo "→ Connecting Claude to the WordPress MCP server…"
# remove-then-add keeps the registration current (and idempotent) on re-runs.
docker compose exec -T workspace sh -c "
  claude mcp remove '$NAME' --scope user >/dev/null 2>&1 || true
  claude mcp add '$NAME' --scope user -- wp --path=/wp mcp-adapter serve --server='$SERVER' --user=admin
"
echo "✓ Claude is connected to the '$NAME' MCP server — run 'npm run claude' and use it right away."
