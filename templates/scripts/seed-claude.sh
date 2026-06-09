#!/usr/bin/env bash
#
# Pre-answer Claude Code's first-run interactive gates in the workspace so a
# token-authenticated session (CLAUDE_CODE_OAUTH_TOKEN) drops you straight to the
# prompt instead of stopping on onboarding screens. Run via `npm run setup`.
# Idempotent — merges into any existing ~/.claude.json, so it's safe across
# rebuilds and after a manual /login.
#
# We seed this with `docker compose exec` rather than the image ENTRYPOINT trick
# the standalone agent-sandbox uses, because this workspace is reached via
# `docker compose exec` (the main process is `sleep infinity`) — and exec does
# NOT run a container's ENTRYPOINT. So the seed has to be applied to the
# already-running container here.
#
# Without this, even with a valid token the first `npm run claude` shows the
# three gates: the "Select login method" picker, the --dangerously-skip-permissions
# acceptance warning, and the "Do you trust this folder?" dialog.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

echo "→ Seeding Claude onboarding flags so it logs in without prompts…"
# Home is /home/node (the workspace root and the image's non-root user) and that
# is also where `npm run claude` opens, so pre-trust that exact directory. Run as
# the `node` user so the file is written with the right ownership.
docker compose exec -T --user node workspace node -e '
  const fs = require("fs");
  const home = "/home/node";
  const p = home + "/.claude.json";
  let c = {};
  try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  c.hasCompletedOnboarding = true;
  c.bypassPermissionsModeAccepted = true;
  if (!c.theme) c.theme = "dark";
  c.projects = c.projects || {};
  c.projects[home] = { ...(c.projects[home] || {}), hasTrustDialogAccepted: true };
  fs.writeFileSync(p, JSON.stringify(c, null, 2));
'

echo "✓ Claude onboarding gates cleared — 'npm run claude' lands at the prompt (with a token set)."
