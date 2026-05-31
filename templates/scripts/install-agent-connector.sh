#!/usr/bin/env bash
#
# Install & enable Agent Connector for WP (https://github.com/soflyy/agent-connector-for-wp)
# — the plugin that exposes root-equivalent abilities (shell, WP-CLI, PHP eval,
# filesystem) to agents over MCP. It bundles wordpress/mcp-adapter, so the
# separate "MCP Adapter" plugin is no longer needed; it does need the Abilities
# API, which the wordpress.org "ai" plugin provides. Run via `npm run setup`.
# Idempotent.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

# Abilities API — Agent Connector registers its abilities through it (provided by
# the "ai" plugin). Already-installed is a no-op; --activate is idempotent.
echo "→ Installing the Abilities API (the \"ai\" plugin)…"
docker compose exec -T workspace wp plugin install ai --activate

echo "→ Enabling Agent Connector for WP…"
# A single wp-config.php constant gates all of the plugin's abilities — it's inert
# without it. We enable it: this is a trusted, throwaway dev sandbox (Claude
# already runs here with --dangerously-skip-permissions, and the plugin itself
# refuses to run on a production environment type).
docker compose exec -T workspace wp config set AGENT_CONNECTOR_FOR_WP_ENABLED true --raw --type=constant >/dev/null

# Install from the packaged release zip — vendor/ (incl. the bundled mcp-adapter)
# is baked in, so no composer step is needed. --force reinstalls cleanly on
# re-run; --activate switches it on (the constant above is its gate).
docker compose exec -T workspace wp plugin install \
  https://github.com/soflyy/agent-connector-for-wp/releases/download/v1.1.0/agent-connector-for-wp.zip \
  --force --activate

echo "✓ Agent Connector for WP enabled (shell, WP-CLI, PHP eval, filesystem)."
