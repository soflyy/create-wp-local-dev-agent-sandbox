#!/usr/bin/env bash
#
# Run the user-provided setup script (sandbox.config.json "setupScript") inside
# the workspace container as the `node` user — the same place `npm run bash`
# drops you, with the WordPress tree at /home/node/wp. Use it to clone a repo
# and run its installer, build a plugin/theme, seed content, etc. Run via
# `npm run setup`, after wp-config defines and before plugin activation, so a
# plugin the script drops into wp-content can then be activated.
#
# The script is piped in over stdin (bash -s) and runs with cwd /home/node, so
# `gh repo clone <repo>` lands a checkout right next to ./wp. Re-runnability is
# up to the script — `npm run setup` may run it again, so guard side effects
# (e.g. skip a clone if the directory already exists).
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

CONFIG="sandbox.config.json"
if [ ! -f "$CONFIG" ]; then
  echo "→ No $CONFIG — skipping setup script."
  exit 0
fi

SCRIPT="$(node -e '
  const fs = require("fs");
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(typeof cfg.setupScript === "string" ? cfg.setupScript : "");
' "$CONFIG")"

if [ -z "$SCRIPT" ]; then
  echo "→ No setupScript in $CONFIG — skipping."
  exit 0
fi
if [ ! -f "$SCRIPT" ]; then
  echo "✖ setupScript \"$SCRIPT\" not found (relative to the project root)." >&2
  exit 1
fi

echo "→ Running setup script ($SCRIPT) in the workspace as node…"

# Forward GitHub credentials from the host env when present, so the script can
# clone private repos (gh / git) without an interactive login in the container.
# (`gh auth login` inside the workspace also works and persists in workspace/.)
exec_args=(-T -w /home/node)
for v in GH_TOKEN GITHUB_TOKEN; do
  if [ -n "${!v:-}" ]; then exec_args+=(-e "$v"); fi
done

docker compose exec "${exec_args[@]}" workspace bash -s < "$SCRIPT"

echo "✓ Setup script complete."
