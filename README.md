# create-wp-local-dev-agent-sandbox

Scaffold a local **WordPress + AI-agent** development environment (Docker Compose) — WordPress + MariaDB plus an isolated **workspace** container with Node, [Claude Code](https://claude.com/claude-code), PHP, and WP-CLI ready to go.

It scaffolds the project **and runs the initial setup** for you — `docker compose up`, then installs WordPress and the configured plugins — so you land on a working site. Pass `--scaffold-only` to just write files and skip Docker. The generated project ships npm scripts (`npm run start`, `npm run bash`, `npm run claude`, …) for everyday use.

## Usage

```bash
# npm create form (the create- prefix enables this):
npm create wp-local-dev-agent-sandbox@latest my-site

# or directly with npx:
npx create-wp-local-dev-agent-sandbox my-site

# choose a host port (default 8080):
npx create-wp-local-dev-agent-sandbox my-site --port=8090

# just write files, don't touch Docker:
npx create-wp-local-dev-agent-sandbox my-site --scaffold-only
```

Docker must be running. When it finishes you have a live site at **http://localhost:8080** — log in at `/wp-admin` with `admin` / `password`. Then:

```bash
cd my-site
npm run start      # bring the stack up next time (it stays up otherwise)
npm run bash       # shell into the workspace container
npm run claude     # launch Claude Code in the workspace
```

## What gets scaffolded

```
my-site/
├── docker-compose.yml      # db + wordpress + workspace + playwright services
├── workspace.Dockerfile    # Node + Claude Code + PHP + WP-CLI (runs as non-root)
├── .env                    # DB creds + WP_PORT
├── .gitignore              # ignores the bind-mounted data dirs
├── package.json            # the npm-scripts UX (setup/start/stop/bash/claude/wp/reset)
├── sandbox.config.json     # plugins to install on `npm run setup` (+ future params)
├── php/php.ini             # custom PHP overrides for the wordpress container (upload limits, etc.)
├── scripts/                # provisioning steps run by initial-setup.sh (install-wp, plugins, root-for-agents, mcp, skills)
├── skills/                 # Claude skills installed into the workspace (e.g. wordpress-dev)
└── README.md
```

WordPress data, the database, and the workspace home are bind-mounted into `wp/`, `db/`, and `workspace/` in the project, so everything is visible on your machine and survives restarts.

## Requirements

- Node.js >= 18 (to run the CLI and the project's npm scripts)
- Docker with Compose v2 (to actually run the environment)

## Contributing

Working on the scaffolder itself, or cutting a release? See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GPL-2.0-or-later
