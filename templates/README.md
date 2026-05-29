# __PROJECT_NAME__

Local WordPress + AI-agent development sandbox, running on Docker.

Three services:

- **db** — MariaDB
- **wordpress** — WordPress on `http://localhost:__WP_PORT__`
- **workspace** — an isolated dev container (Node + Claude Code + PHP + WP-CLI) that mounts the same WordPress files and reaches the site/DB over the Docker network

All data lives in bind-mounted folders in this directory (`db/`, `wp/`, `workspace/`), so it survives restarts and is browsable on your machine. They're git-ignored.

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
| `npm run down` | Stop + remove containers (data preserved in `db/`, `wp/`, `workspace/`) |
| `npm run restart` | Restart containers |
| `npm run logs` | Tail logs from all services |
| `npm run ps` | Show container status |
| `npm run bash` | Shell into the workspace container (lands in `/wp`) |
| `npm run claude` | Launch Claude Code in the workspace (`--dangerously-skip-permissions`, safe because it's contained) |
| `npm run wp` | Run WP-CLI, e.g. `npm run wp -- plugin list` |
| `npm run reset` | ⚠️ Wipe all data and rebuild from scratch |

## Plugins (`sandbox.config.json`)

The plugins installed during `npm run setup` are declared in `sandbox.config.json`:

```json
{
  "plugins": [
    { "source": "ai", "activate": true },
    { "source": "https://github.com/WordPress/mcp-adapter/releases/download/v0.5.0/mcp-adapter.zip", "activate": true }
  ]
}
```

- **`source`** — a [wordpress.org](https://wordpress.org/plugins/) slug (e.g. `"ai"`) or a URL/path to a plugin `.zip`.
- **`activate`** — activate after install (default `true`).
- **`version`** — optional, wordpress.org slugs only (e.g. `"5.3"`).

A bare string is shorthand for `{ "source": "<string>", "activate": true }`. After editing, re-run `npm run setup` (it's idempotent — already-installed plugins are skipped), or apply just the plugin step with `bash scripts/install-plugins.sh`.

## Notes

- **Working on a plugin/theme?** It lives at `wp/wp-content/plugins/…` (or `themes/…`). Edit it on your machine or from inside the workspace container — same files, served live.
- **First Claude run:** inside the workspace, run `npm run claude` and use `/login` once. Your login persists in `workspace/` across rebuilds.
- **WP-CLI** talks to the database automatically over the Docker network.
- **MCP:** `npm run setup` connects Claude to WordPress's MCP server (from the [`mcp-adapter`](https://github.com/WordPress/mcp-adapter) plugin) automatically. It uses the stdio transport via WP-CLI — Claude runs `wp mcp-adapter serve` locally in the workspace, so no application password, HTTP, or proxy is involved. The server is registered at user scope (`claude mcp list` shows it); re-add or tweak it with `bash scripts/connect-mcp.sh`.
