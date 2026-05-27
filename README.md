# create-wp-local-dev-agent-sandbox

Scaffold a local **WordPress + AI-agent** development environment (Docker Compose) — WordPress + MariaDB plus an isolated **workspace** container with Node, [Claude Code](https://claude.com/claude-code), PHP, and WP-CLI ready to go.

It only **scaffolds files**; it never runs Docker. The generated project ships npm scripts (`npm run start`, `npm run bash`, `npm run claude`, …) for that.

## Usage

```bash
# npm create form (the create- prefix enables this):
npm create wp-local-dev-agent-sandbox@latest my-site

# or directly with npx:
npx create-wp-local-dev-agent-sandbox my-site

# choose a host port (default 8080):
npx create-wp-local-dev-agent-sandbox my-site --port=8090
```

Then:

```bash
cd my-site
npm run start      # build + start (Docker must be running)
# open http://localhost:8080
npm run bash       # shell into the workspace container
npm run claude     # launch Claude Code in the workspace
```

## What gets scaffolded

```
my-site/
├── docker-compose.yml      # db + wordpress + workspace services
├── workspace.Dockerfile    # Node + Claude Code + PHP + WP-CLI (runs as non-root)
├── .env                    # DB creds + WP_PORT
├── .gitignore              # ignores the bind-mounted data dirs
├── package.json            # the npm-scripts UX (start/stop/bash/claude/wp/reset)
└── README.md
```

WordPress data, the database, and the workspace home are bind-mounted into `wp/`, `db/`, and `workspace/` in the project, so everything is visible on your machine and survives restarts.

## Requirements

- Node.js >= 18 (to run the CLI and the project's npm scripts)
- Docker with Compose v2 (to actually run the environment)

## License

GPL-2.0-or-later
