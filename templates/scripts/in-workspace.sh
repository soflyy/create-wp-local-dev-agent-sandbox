#!/usr/bin/env bash
#
# Run a command in the workspace container with Claude's OAuth token resolved the
# same way the standalone agent-sandbox does, so `npm run claude` / `npm run bash`
# auto-login without you exporting anything.
#
# Token resolution (first hit wins):
#   1. $CLAUDE_CODE_OAUTH_TOKEN in your shell
#   2. the file at $CLAUDE_SANDBOX_TOKEN_FILE
#   3. ~/.agent-sandbox/oauth-token   (the same file agent-sandbox uses — mint it
#      once on your host with `claude setup-token`)
#
# The token is exported into THIS process's env and forwarded to the container by
# name (`docker compose exec -e CLAUDE_CODE_OAUTH_TOKEN`), so its value never lands
# on the command line / process args. Combined with the workspace ENTRYPOINT that
# seeds ~/.claude.json, an authenticated session lands straight at the prompt.
#
# Usage: bash scripts/in-workspace.sh <command> [args…]
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
TOKEN_FILE="${CLAUDE_SANDBOX_TOKEN_FILE:-$HOME/.agent-sandbox/oauth-token}"
if [ -z "$TOKEN" ] && [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
fi

if [ -z "$TOKEN" ]; then
  echo "ℹ No Claude token found (\$CLAUDE_CODE_OAUTH_TOKEN or $TOKEN_FILE)." >&2
  echo "  Claude will start unauthenticated — run /login once inside (it persists in workspace/)." >&2
  echo "  To auto-login next time: run 'claude setup-token' on your host and save the token to" >&2
  echo "  $TOKEN_FILE (one line), or 'export CLAUDE_CODE_OAUTH_TOKEN=<token>'." >&2
fi

# Export so the value is inherited by the container via name-only -e (off argv).
export CLAUDE_CODE_OAUTH_TOKEN="$TOKEN"
exec docker compose exec -e CLAUDE_CODE_OAUTH_TOKEN workspace "$@"
