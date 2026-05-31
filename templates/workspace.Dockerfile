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

RUN npm install -g @anthropic-ai/claude-code

# Run as the image's built-in non-root user (uid 1000) so
# `claude --dangerously-skip-permissions` is allowed (it refuses to run as root).
USER node
# The workspace root: WordPress lives at ./wp, and you can check out plugins/
# themes as siblings and symlink them into wp/wp-content/ (both this container
# and the wordpress container see them at the same path — see docker-compose.yml).
WORKDIR /home/node

# Keep the container alive so you can `docker compose exec` into it.
CMD ["sleep", "infinity"]
