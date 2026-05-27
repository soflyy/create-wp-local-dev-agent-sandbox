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

```bash
npm run start     # build + start everything (first run pulls images & installs WordPress)
```

Then open **http://localhost:__WP_PORT__** and finish the WordPress installer.

| Script | What it does |
| --- | --- |
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

## Notes

- **Working on a plugin/theme?** It lives at `wp/wp-content/plugins/…` (or `themes/…`). Edit it on your machine or from inside the workspace container — same files, served live.
- **First Claude run:** inside the workspace, run `npm run claude` and use `/login` once. Your login persists in `workspace/` across rebuilds.
- **WP-CLI** talks to the database automatically over the Docker network.
- **MCP:** if you use the WordPress MCP stack, point agents at `http://wordpress/wp-json/...` from inside the workspace container (the host port `__WP_PORT__` is not reachable between containers).
