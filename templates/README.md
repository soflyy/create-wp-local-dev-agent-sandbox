# __PROJECT_NAME__

Local WordPress + AI-agent development sandbox, running on Docker.

Four services:

- **db** — MariaDB
- **wordpress** — WordPress on `http://localhost:__WP_PORT__`
- **workspace** — an isolated dev container (Node + Claude Code + PHP + WP-CLI + Composer) that mounts the same WordPress files and reaches the site/DB over the Docker network
- **playwright** — a [Playwright MCP](https://github.com/microsoft/playwright-mcp) server (headless Chromium) that Claude drives to browse the site

All data lives in bind-mounted folders in this directory (`db/` and `workspace/` — the latter holds WordPress at `workspace/wp` plus your checkouts), so it survives restarts and is browsable on your machine. They're git-ignored.

## Requirements

- Docker (with Compose v2)
- Node.js (only to run the npm scripts below)

## Usage

First time:

```bash
npm run setup     # build, start, and install WordPress
```

`npm run setup` brings the stack up, installs WordPress, and installs/activates the plugins listed in [`sandbox.config.json`](#plugins-sandboxconfigjson). It's idempotent — safe to re-run.

Then open **http://localhost:__WP_PORT__**. WordPress is already installed — log in at **/wp-admin** with:

- **Username:** `admin`
- **Password:** `password`

Day to day, just bring the containers up:

```bash
npm run start     # build + start containers
```

| Script | What it does |
| --- | --- |
| `npm run setup` | First-run: start the stack, install WordPress (`admin` / `password`), install plugins |
| `npm run start` | `docker compose up -d --build` |
| `npm run stop` | Stop containers (keep data) |
| `npm run down` | Stop + remove containers (data preserved in `db/`, `workspace/`) |
| `npm run restart` | Restart containers |
| `npm run logs` | Tail logs from all services |
| `npm run ps` | Show container status |
| `npm run bash` | Shell into the workspace container (lands in the workspace root `/home/node`, with WordPress at `wp/`) |
| `npm run claude` | Launch Claude Code in the workspace (`--dangerously-skip-permissions`, safe because it's contained) |
| `npm run wp` | Run WP-CLI, e.g. `npm run wp -- plugin list` |
| `npm run reset` | ⚠️ Wipe all data and rebuild from scratch |

## Plugins (`sandbox.config.json`)

Your own plugins to install during `npm run setup` are declared in `sandbox.config.json`. It ships empty (the MCP/agent plugins are installed separately — see [MCP](#notes) below) — add your own:

```json
{
  "plugins": [
    "woocommerce",
    { "source": "https://example.com/your-plugin.zip", "activate": true }
  ]
}
```

- **`source`** — a [wordpress.org](https://wordpress.org/plugins/) slug (e.g. `"ai"`) or a URL/path to a plugin `.zip`.
- **`activate`** — activate after install (default `true`).
- **`version`** — optional, wordpress.org slugs only (e.g. `"5.3"`).

A bare string is shorthand for `{ "source": "<string>", "activate": true }`. After editing, re-run `npm run setup` (it's idempotent — already-installed plugins are skipped), or apply just the plugin step with `bash scripts/install-plugins.sh`.

## Notes

- **Working on a plugin/theme?** Installed ones live at `workspace/wp/wp-content/plugins/…` (or `themes/…`) on your machine — `wp/wp-content/…` from inside the workspace container. Edit them either place — same files, served live.
- **Developing a plugin/theme from its own repo?** You land in the workspace root (`/home/node`) with WordPress nested at `wp/`, so check it out as a sibling of `wp` and symlink it into place — keeping your repo out of the WordPress tree:
  ```bash
  npm run bash                                  # land in the workspace root
  git clone <your-plugin-repo> my-plugin        # checked out next to wp/, not inside it
  composer install -d my-plugin                 # Composer is available globally
  ln -s /home/node/my-plugin wp/wp-content/plugins/my-plugin
  wp plugin activate my-plugin
  ```
  The workspace root is mounted into the wordpress container at the same path, so Apache follows the symlink and serves the plugin live.
- **Claude login:** if you have a `CLAUDE_CODE_OAUTH_TOKEN` exported in your host shell (mint one on your machine with `claude setup-token`), `npm run claude` passes it straight through to the workspace and Claude is logged in automatically — no `/login` step, and it lands straight at the prompt. Setup pre-clears Claude's first-run gates (the login-method picker, the `--dangerously-skip-permissions` warning, and the "trust this folder?" dialog) via `scripts/seed-claude.sh`, so a token-authenticated session isn't stopped by any onboarding screen. The token is passed by name (`docker compose exec -e CLAUDE_CODE_OAUTH_TOKEN`), so its value never lands on the command line. Otherwise, run `npm run claude` and use `/login` once; that login persists in `workspace/` across rebuilds.
- **WP-CLI** talks to the database automatically over the Docker network.
- **MCP:** `npm run setup` connects Claude to two MCP servers automatically (registered at user scope — `claude mcp list` shows them; re-add or tweak with `bash scripts/connect-mcp.sh`):
  - **wordpress** — the site's MCP server, provided by [Agent Connector for WP](https://github.com/soflyy/agent-connector-for-wp) (which bundles [`mcp-adapter`](https://github.com/WordPress/mcp-adapter) and registers its abilities through WordPress core's Abilities API, in core as of WordPress 7.0). Setup installs and enables it, then registers it with Claude through [Automattic's `mcp-wordpress-remote`](https://www.npmjs.com/package/@automattic/mcp-wordpress-remote) — a small stdio proxy Claude runs via `npx` that connects to the site's MCP endpoint (`http://wordpress/wp-json/mcp/mcp-adapter-default-server`) and authenticates with a WordPress Application Password setup mints for `admin`. It exposes root-equivalent abilities (shell, WP-CLI, PHP eval, filesystem) — but the workspace already has WP-CLI and direct filesystem access to `wp/`, so Claude prefers those and only reaches for this when it needs code to run inside the **live WordPress runtime** (e.g. PHP eval with plugins and hooks loaded). Fine to expose because this is a trusted, throwaway dev sandbox.
  - **playwright** — the [Playwright MCP](https://github.com/microsoft/playwright-mcp) server (a separate container with headless Chromium), over HTTP. Claude uses it to navigate, click, and screenshot the site. **From the browser, the site is `http://wordpress`** (the Docker-network address), not `localhost:__WP_PORT__` — the site URL is derived from the request host so both work without redirects.
