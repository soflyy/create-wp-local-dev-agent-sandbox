#!/usr/bin/env bash
#
# Run a command in the workspace container with the agents' credentials resolved
# the same way the standalone agent-sandbox does, so `npm run claude` /
# `npm run cursor` / `npm run bash` auto-login without you exporting anything.
#
# Claude — OAuth token (first hit wins):
#   1. $CLAUDE_CODE_OAUTH_TOKEN in your shell
#   2. the file at $CLAUDE_SANDBOX_TOKEN_FILE
#   3. ~/.agent-sandbox/oauth-token   (the same file agent-sandbox uses — mint it
#      once on your host with `claude setup-token`)
#
# Cursor — API key (first hit wins):
#   1. $CURSOR_API_KEY in your shell
#   2. the file at $CURSOR_API_KEY_FILE
#   3. ~/.agent-sandbox/cursor-api-key   (one line — generate a key in the Cursor
#      dashboard: Settings → API Keys)
#
# Each credential is exported into THIS process's env and forwarded to the
# container by name (`docker compose exec -e NAME`), so its value never lands on
# the command line / process args. Combined with the workspace ENTRYPOINT that
# seeds ~/.claude.json, an authenticated session lands straight at the prompt.
#
# Usage: bash scripts/in-workspace.sh <command> [args…]
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

# --- Claude OAuth token ---
CLAUDE_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
CLAUDE_TOKEN_FILE="${CLAUDE_SANDBOX_TOKEN_FILE:-$HOME/.agent-sandbox/oauth-token}"
if [ -z "$CLAUDE_TOKEN" ] && [ -f "$CLAUDE_TOKEN_FILE" ]; then
  CLAUDE_TOKEN="$(tr -d '[:space:]' < "$CLAUDE_TOKEN_FILE")"
fi

# --- Cursor API key ---
CURSOR_KEY="${CURSOR_API_KEY:-}"
CURSOR_KEY_FILE="${CURSOR_API_KEY_FILE:-$HOME/.agent-sandbox/cursor-api-key}"
if [ -z "$CURSOR_KEY" ] && [ -f "$CURSOR_KEY_FILE" ]; then
  CURSOR_KEY="$(tr -d '[:space:]' < "$CURSOR_KEY_FILE")"
fi

# Only nudge about the credential for the agent actually being launched, so
# `npm run bash` (and the other agent) stays quiet.
case "${1:-}" in
  claude)
    if [ -z "$CLAUDE_TOKEN" ]; then
      echo "ℹ No Claude token found (\$CLAUDE_CODE_OAUTH_TOKEN or $CLAUDE_TOKEN_FILE)." >&2
      echo "  Claude will start unauthenticated — run /login once inside (it persists in workspace/)." >&2
      echo "  To auto-login next time: run 'claude setup-token' on your host and save the token to" >&2
      echo "  $CLAUDE_TOKEN_FILE (one line), or 'export CLAUDE_CODE_OAUTH_TOKEN=<token>'." >&2
    fi
    ;;
  cursor|cursor-agent|agent)
    if [ -z "$CURSOR_KEY" ]; then
      echo "ℹ No Cursor API key found (\$CURSOR_API_KEY or $CURSOR_KEY_FILE)." >&2
      echo "  Cursor will start unauthenticated — run 'cursor-agent login' once inside (it persists in workspace/)." >&2
      echo "  To auto-login next time: create a key in the Cursor dashboard and save it to" >&2
      echo "  $CURSOR_KEY_FILE (one line), or 'export CURSOR_API_KEY=<key>'." >&2
    fi
    ;;
esac

# Export so the values are inherited by the container via name-only -e (off argv).
export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOKEN"
export CURSOR_API_KEY="$CURSOR_KEY"
exec docker compose exec \
  -e CLAUDE_CODE_OAUTH_TOKEN \
  -e CURSOR_API_KEY \
  workspace "$@"
