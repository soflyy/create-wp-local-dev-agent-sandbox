---
name: wordpress-dev
description: >-
  The sandbox's Docker containers (workspace, db, wordpress, playwright) and how
  to reach the WordPress site — http://wordpress from inside the network, not
  localhost. Load when working with this WordPress install or browsing it.
---

This WordPress install is split across Docker containers on a shared network:

- **workspace** — where you (Claude) run. Holds the WordPress files at `/wp`
  (shared with the `wordpress` container) plus WP-CLI, Node, and Claude Code. No
  web server runs here, but WP-CLI talks to the `db` container directly, so
  `wp …` works.
- **db** — MariaDB database (reachable on the network as host `db`).
- **wordpress** — the Apache/PHP web server serving the site at `http://wordpress/`.
- **playwright** — a headless-Chromium Playwright MCP server; point its browser
  at `http://wordpress/`.

**Reaching the site:** from inside any container (including the Playwright
browser) use `http://wordpress/`, e.g. `http://wordpress/wp-login.php`.
`http://localhost:__WP_PORT__` only works from the user's browser on the host —
it's a host port mapping, not reachable container-to-container. The wp-admin
login is `admin` / `password`.
