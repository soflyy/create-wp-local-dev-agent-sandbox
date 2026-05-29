#!/usr/bin/env bash
#
# Install the sandbox's Claude skills (the project's skills/ dir) into the
# workspace's personal skills dir, ~/.claude/skills. We copy rather than
# bind-mount because a bind mount nested inside the ./workspace mount is
# unreliable on Docker Desktop. Re-run safe (overwrites). Run via `npm run setup`.
#
# ./workspace is the workspace container's /home/node, so writing here lands at
# /home/node/.claude/skills where Claude loads personal skills.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

if [ -d skills ] && [ -n "$(ls -A skills 2>/dev/null)" ]; then
  mkdir -p workspace/.claude/skills
  cp -R skills/. workspace/.claude/skills/
  echo "✓ Skills installed into the workspace (~/.claude/skills)."
else
  echo "→ No skills/ to install — skipping."
fi
