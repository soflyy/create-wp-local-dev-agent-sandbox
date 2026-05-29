#!/usr/bin/env bash
#
# Enable Root for Agents (https://github.com/soflyy/root-for-agents) for this
# sandbox. The plugin registers root-equivalent WordPress abilities (file ops,
# env-inspect, shell, PHP eval) that the mcp-adapter plugin surfaces to agents.
# Run via `npm run setup`. Idempotent.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

echo "→ Enabling Root for Agents…"
# A single wp-config.php constant gates all of the plugin's abilities. We enable
# it — this is a trusted, throwaway dev sandbox (Claude already runs here with
# --dangerously-skip-permissions, and the plugin itself refuses to run on a
# production environment type).
docker compose exec -T workspace wp config set ROOT_FOR_AGENTS_ENABLED true --raw --type=constant >/dev/null

# Root for Agents isn't on wordpress.org — install it from GitHub (latest master).
# --force makes re-running setup reinstall cleanly; --activate switches it on
# (the constant above is its gate).
docker compose exec -T workspace wp plugin install \
  https://github.com/soflyy/root-for-agents/archive/refs/heads/master.zip \
  --force --activate

echo "✓ Root for Agents enabled (file ops, env-inspect, shell, PHP eval)."
