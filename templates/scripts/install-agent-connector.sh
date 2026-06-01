#!/usr/bin/env bash
#
# Install & enable Agent Connector for WP (https://github.com/soflyy/agent-connector-for-wp)
# — the plugin that exposes root-equivalent abilities (shell, WP-CLI, PHP eval,
# filesystem) to agents over MCP. It bundles wordpress/mcp-adapter (no separate
# "MCP Adapter" plugin needed) and registers its abilities through the WordPress
# Abilities API, which is in core as of WordPress 7.0. Run via `npm run setup`.
# Idempotent.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

echo "→ Enabling Agent Connector for WP…"
# The plugin is inert until explicitly switched on. That switch is a WordPress
# option (flipped from its Settings screen in the admin) — there is no wp-config
# constant anymore. We set the option directly: this is a trusted, throwaway dev
# sandbox (Claude already runs here with --dangerously-skip-permissions). The
# stack marks the site as WP_ENVIRONMENT_TYPE=local (see docker-compose.yml), so
# the enable toggle alone activates it — no production override needed.
docker compose exec -T workspace wp option update agent_connector_for_wp_enabled 1 >/dev/null

# Install from the latest packaged release zip — vendor/ (incl. the bundled
# mcp-adapter) is baked in, so no composer step is needed. The /releases/latest/
# URL always resolves to the newest release's asset, so we never pin a version.
# --force reinstalls cleanly on re-run; --activate activates the plugin (the
# option set above is what actually exposes its abilities).
docker compose exec -T workspace wp plugin install \
  https://github.com/soflyy/agent-connector-for-wp/releases/latest/download/agent-connector-for-wp.zip \
  --force --activate

echo "✓ Agent Connector for WP enabled (shell, WP-CLI, PHP eval, filesystem)."
