FROM node:22-bookworm-slim

# PHP + the extensions WP-CLI needs (mysql for DB, curl/zip for installs, etc.)
# plus the mysql client for `wp db ...`, and curl for general use.
RUN apt-get update && apt-get install -y --no-install-recommends \
        php-cli php-mysql php-curl php-xml php-mbstring php-zip \
        default-mysql-client curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# WP-CLI, wrapped so `wp` always runs with --allow-root (harmless for non-root).
# 0755 so the non-root user below can read the phar (PHP must read it to run it).
ADD https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar /usr/local/bin/wp-cli.phar
RUN chmod 0755 /usr/local/bin/wp-cli.phar \
    && printf '#!/bin/sh\nexec php /usr/local/bin/wp-cli.phar --allow-root "$@"\n' > /usr/local/bin/wp \
    && chmod +x /usr/local/bin/wp

RUN npm install -g @anthropic-ai/claude-code

# Run as the image's built-in non-root user (uid 1000) so
# `claude --dangerously-skip-permissions` is allowed (it refuses to run as root).
USER node
WORKDIR /wp

# Keep the container alive so you can `docker compose exec` into it.
CMD ["sleep", "infinity"]
