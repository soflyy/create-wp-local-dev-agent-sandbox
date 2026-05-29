#!/usr/bin/env bash
#
# Enable Root for Agents (https://github.com/soflyy/root-for-agents) for this
# sandbox. The plugin registers root-equivalent WordPress abilities (file ops,
# env-inspect, and — behind extra gates — shell + PHP eval) that the mcp-adapter
# plugin surfaces to agents. Run via `npm run setup`. Idempotent.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

echo "→ Enabling Root for Agents…"
# Each ability is gated by a wp-config.php constant and only registers when its
# gate is true. We enable all of them — this is a trusted, throwaway dev sandbox
# (Claude already runs here with --dangerously-skip-permissions, and the plugin
# itself refuses to run on a production environment type):
#   ROOT_FOR_AGENTS_ENABLED     — master gate; file ops + env-inspect
#   ROOT_FOR_AGENTS_ALLOW_SHELL — shell-exec + process-exec
#   ROOT_FOR_AGENTS_ALLOW_EVAL  — php-eval
# Drop a line if you'd rather not expose that capability.
docker compose exec -T workspace sh -c '
  wp config set ROOT_FOR_AGENTS_ENABLED     true --raw --type=constant
  wp config set ROOT_FOR_AGENTS_ALLOW_SHELL true --raw --type=constant
  wp config set ROOT_FOR_AGENTS_ALLOW_EVAL  true --raw --type=constant
' >/dev/null

# Root for Agents isn't on wordpress.org yet. Once it is, uncomment to install +
# activate it (slug: root-for-agents) — the constant above is its master gate:
# docker compose exec -T workspace wp plugin install root-for-agents --activate

echo "✓ Root for Agents enabled (file ops, env-inspect, shell, PHP eval)."
