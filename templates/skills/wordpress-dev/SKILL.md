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

## Root for Agents

[Root for Agents](https://github.com/soflyy/root-for-agents) gives you
root-equivalent operational access to this install through the `wordpress` MCP
server — shell commands, PHP eval in the live WordPress runtime, arbitrary file
read/write/delete/list, and environment inspection.

Treat it as a fallback, not a first resort: if a task can't be done through the
regular MCP tools and WP-CLI would be too cumbersome, reach for Root for Agents.
Its abilities aren't top-level MCP tools — discover them with
`mcp-adapter-discover-abilities` and run one (by name, e.g.
`root-for-agents/shell-exec`) via `mcp-adapter-execute-ability`.
