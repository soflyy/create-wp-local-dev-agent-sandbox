#!/usr/bin/env bash
#
# Install & enable Agent Connector for WP (https://github.com/soflyy/agent-connector-for-wp)
# plus its Default Abilities companion, so agents get the root-equivalent built-in
# abilities (shell, WP-CLI, PHP eval, filesystem, env-inspect, admin-login-link)
# over MCP. The main plugin is the secured MCP gateway (it bundles
# wordpress/mcp-adapter); the abilities now live in a separate companion plugin
# and are off until you opt in. Run via `npm run setup`. Idempotent.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

# Install the gateway from its latest release zip (vendor/ + mcp-adapter baked
# in, so no composer step). --force reinstalls cleanly on re-run.
#
# Guard: if agent-connector-for-wp is already active, a setup script (e.g. a
# "develop from a git checkout" preset) put its own copy in place — keep it
# rather than clobbering the checkout with the release zip. The companion +
# options below still run (idempotent, and apply to either copy).
if docker compose exec -T workspace wp plugin is-active agent-connector-for-wp >/dev/null 2>&1; then
  echo "→ Agent Connector for WP already active (git checkout from a setup script) — keeping it, skipping the release-zip install."
else
  echo "→ Installing Agent Connector for WP (MCP gateway)…"
  docker compose exec -T workspace wp plugin install \
    https://github.com/soflyy/agent-connector-for-wp/releases/latest/download/agent-connector-for-wp.zip \
    --force --activate
fi

# Install the Default Abilities companion (the built-in abilities now live here).
# It declares `Requires Plugins: agent-connector-for-wp`, so the gateway must be
# active first (it is, above). Pinned `default-abilities-plugin` release tag.
echo "→ Installing the Default Abilities companion…"
docker compose exec -T workspace wp plugin install \
  https://github.com/soflyy/agent-connector-for-wp/releases/download/default-abilities-plugin/default-abilities-plugin.zip \
  --force --activate

# Switch it on. Two options set directly — the equivalent of the Connection
# screen's checkboxes — fine here: a trusted, throwaway dev sandbox marked
# WP_ENVIRONMENT_TYPE=local (Claude already runs with --dangerously-skip-permissions):
#   agent_connector_for_wp_enabled            → the gateway master switch
#   agent_connector_for_wp_builtin_abilities  → "Expose the built-in abilities over MCP"
echo "→ Enabling the gateway and exposing the built-in abilities over MCP…"
docker compose exec -T workspace wp option update agent_connector_for_wp_enabled 1 >/dev/null
docker compose exec -T workspace wp option update agent_connector_for_wp_builtin_abilities 1 >/dev/null

echo "✓ Agent Connector for WP + Default Abilities enabled (shell, WP-CLI, PHP eval, filesystem) over MCP."
