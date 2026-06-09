FROM node:22-bookworm-slim

# PHP + the extensions WP-CLI needs (mysql for DB, curl/zip for installs, etc.)
# plus the mysql client for `wp db ...`, git, and curl for general use.
RUN apt-get update && apt-get install -y --no-install-recommends \
        php-cli php-mysql php-curl php-xml php-mbstring php-zip \
        default-mysql-client curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (`gh`) from its official apt repo.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# WP-CLI, wrapped so `wp` always runs with --allow-root (harmless for non-root).
# 0755 so the non-root user below can read the phar (PHP must read it to run it).
ADD https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar /usr/local/bin/wp-cli.phar
RUN chmod 0755 /usr/local/bin/wp-cli.phar \
    && printf '#!/bin/sh\nexec php /usr/local/bin/wp-cli.phar --allow-root "$@"\n' > /usr/local/bin/wp \
    && chmod +x /usr/local/bin/wp

# You land in the workspace root (/home/node), with WordPress nested at ./wp.
# Point WP-CLI there by default so `wp` works from anywhere without --path. A
# global config file is used (not the wrapper) so an explicit --path still wins.
ENV WP_CLI_CONFIG_PATH=/etc/wp-cli.yml
RUN printf 'path: /home/node/wp\n' > /etc/wp-cli.yml

# Composer (PHP dependency manager), available globally as `composer`.
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer

# Claude Code, plus the mcp-wordpress-remote stdio proxy that the workspace's
# Claude uses to reach the site's MCP server. Pre-installing it means the
# `npx @automattic/mcp-wordpress-remote` in connect-mcp.sh resolves instantly
# (and offline) instead of fetching on first connection.
RUN npm install -g @anthropic-ai/claude-code @automattic/mcp-wordpress-remote

# Seed Claude's onboarding flags so a token-authenticated profile
# (CLAUDE_CODE_OAUTH_TOKEN) goes straight to the prompt instead of stopping on the
# three first-run gates: the "Select login method" picker, the
# --dangerously-skip-permissions acceptance warning, and the "trust this folder?"
# dialog. This is the same mechanism the standalone agent-sandbox uses — and it
# works here too: the ENTRYPOINT runs for the container's main process
# (`sleep infinity`) at startup, seeding the persisted /home/node BEFORE any
# `docker compose exec` reaches Claude. It re-runs on every start and merges into
# any existing config, so it stays correct across rebuilds and after a manual
# /login. The home dir is pinned to /home/node (the workspace root by design).
RUN printf '%s\n' \
  'const fs=require("fs"),h="/home/node",p=h+"/.claude.json";' \
  'let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}' \
  'c.hasCompletedOnboarding=true;c.bypassPermissionsModeAccepted=true;' \
  'if(!c.theme)c.theme="dark";' \
  'c.projects=c.projects||{};c.projects[h]={...(c.projects[h]||{}),hasTrustDialogAccepted:true};' \
  'fs.writeFileSync(p,JSON.stringify(c,null,2));' \
  > /usr/local/bin/seed-claude.js \
  && printf '%s\n' '#!/bin/sh' 'node /usr/local/bin/seed-claude.js 2>/dev/null || true' 'exec "$@"' \
  > /usr/local/bin/agent-entrypoint \
  && chmod 0755 /usr/local/bin/agent-entrypoint

# Run as the image's built-in non-root user (uid 1000) so
# `claude --dangerously-skip-permissions` is allowed (it refuses to run as root).
USER node
# The workspace root: WordPress lives at ./wp, and you can check out plugins/
# themes as siblings and symlink them into wp/wp-content/ (both this container
# and the wordpress container see them at the same path — see docker-compose.yml).
WORKDIR /home/node

# The entrypoint seeds Claude's onboarding flags, then hands off to the CMD.
ENTRYPOINT ["/usr/local/bin/agent-entrypoint"]
# Keep the container alive so you can `docker compose exec` into it.
CMD ["sleep", "infinity"]
