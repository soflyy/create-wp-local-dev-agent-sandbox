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

echo "→ Enabling Root for Agents (ROOT_FOR_AGENTS_ENABLED)…"
# Master gate. Unlocks the file + env-inspect abilities. Shell + PHP eval are
# behind extra gates — uncomment if you want them (trusted dev sandbox only):
#   docker compose exec -T workspace wp config set ROOT_FOR_AGENTS_ALLOW_SHELL true --raw --type=constant
#   docker compose exec -T workspace wp config set ROOT_FOR_AGENTS_ALLOW_EVAL  true --raw --type=constant
docker compose exec -T workspace wp config set ROOT_FOR_AGENTS_ENABLED true --raw --type=constant >/dev/null

# Root for Agents isn't on wordpress.org yet. Once it is, uncomment to install +
# activate it (slug: root-for-agents) — the constant above is its master gate:
# docker compose exec -T workspace wp plugin install root-for-agents --activate

echo "✓ Root for Agents enabled (ROOT_FOR_AGENTS_ENABLED = true)."
