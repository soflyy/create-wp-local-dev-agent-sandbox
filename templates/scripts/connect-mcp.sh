#!/usr/bin/env bash
#
# Connect the workspace's agents (Claude Code and Cursor) to the MCP servers in
# this sandbox, so both can use them out of the box. Idempotent — re-run safe.
# Run via `npm run setup`.
#
#   - wordpress: the site's MCP server (Agent Connector for WP, which bundles
#     mcp-adapter), reached through Automattic's mcp-wordpress-remote stdio proxy
#     run locally via npx — the broadly-supported way to reach a WordPress MCP
#     server. It authenticates with a WordPress application password (no direct
#     HTTP transport). Needs pretty permalinks (enabled by install-wp.sh).
#   - playwright: the prebaked Playwright MCP service, over HTTP, for driving a
#     headless browser against the site at http://wordpress.
#
# Claude reads user-scope registrations (`claude mcp add`); Cursor reads
# ~/.cursor/mcp.json. Both persist in workspace/ across rebuilds. Everything runs
# inside a single `docker compose exec` so the minted app password never leaves
# the container (it's not captured into a host-side variable).
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

# Is the WordPress MCP server available? (Agent Connector active.)
HAS_WP=0
if docker compose exec -T workspace wp plugin is-active agent-connector-for-wp >/dev/null 2>&1; then
  HAS_WP=1
else
  echo "→ agent-connector-for-wp plugin not active — skipping the WordPress MCP server (both agents)."
fi

# All registration happens in-container. HAS_WP is passed as $1 (to sh -s); the
# app password is minted and used here, never surfacing on the host.
docker compose exec -T workspace sh -s "$HAS_WP" <<'EOF'
set -e
HAS_WP="$1"
WP_MCP_URL="http://wordpress/wp-json/mcp/mcp-adapter-default-server"
PLAYWRIGHT_URL="http://playwright:8931/mcp"
APPPASS=""

if [ "$HAS_WP" = "1" ]; then
  # Reset admin's app passwords (the sandbox only uses them for this) and mint a
  # fresh one — the plaintext is only available at creation time.
  wp user application-password delete admin --all >/dev/null 2>&1 || true
  APPPASS=$(wp user application-password create admin "agent-sandbox" --porcelain)

  echo "→ Connecting Claude to the WordPress MCP server (mcp-wordpress-remote proxy)…"
  claude mcp remove wordpress --scope user >/dev/null 2>&1 || true
  claude mcp add wordpress --scope user \
    --env WP_API_URL="$WP_MCP_URL" \
    --env WP_API_USERNAME=admin \
    --env WP_API_PASSWORD="$APPPASS" \
    --env OAUTH_ENABLED=false \
    -- npx -y @automattic/mcp-wordpress-remote
fi

echo "→ Connecting Claude to the Playwright MCP server…"
claude mcp remove playwright --scope user >/dev/null 2>&1 || true
claude mcp add playwright --scope user --transport http "$PLAYWRIGHT_URL"

# Cursor reads ~/.cursor/mcp.json (same servers, its own format). Merge into any
# existing file so a manual /login or other servers aren't clobbered. The proxy
# command + the playwright HTTP url mirror the Claude registrations above.
echo "→ Connecting Cursor to the MCP servers (~/.cursor/mcp.json)…"
HAS_WP="$HAS_WP" APPPASS="$APPPASS" WP_MCP_URL="$WP_MCP_URL" PLAYWRIGHT_URL="$PLAYWRIGHT_URL" node -e '
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = path.join(os.homedir(), ".cursor");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "mcp.json");
  let c = {};
  try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  c.mcpServers = c.mcpServers || {};
  if (process.env.HAS_WP === "1") {
    c.mcpServers.wordpress = {
      command: "npx",
      args: ["-y", "@automattic/mcp-wordpress-remote"],
      env: {
        WP_API_URL: process.env.WP_MCP_URL,
        WP_API_USERNAME: "admin",
        WP_API_PASSWORD: process.env.APPPASS,
        OAUTH_ENABLED: "false",
      },
    };
  } else {
    delete c.mcpServers.wordpress;
  }
  c.mcpServers.playwright = { url: process.env.PLAYWRIGHT_URL };
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
'

echo "✓ MCP servers registered for Claude ('claude mcp list') and Cursor (~/.cursor/mcp.json)."
EOF

echo "✓ Run 'npm run claude' or 'npm run cursor' and use the MCP servers right away."
