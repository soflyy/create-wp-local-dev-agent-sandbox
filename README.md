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

## Developing this scaffolder

The two things you edit:

- **`index.js`** — the CLI logic (arg parsing, file copying, substitutions)
- **`templates/`** — the files that get scaffolded (compose file, Dockerfile, the project's `package.json` scripts, etc.)

The scaffolder is a *file generator* — it never runs Docker, and it creates no `wp/`/`db/`/`workspace/` data. Those only appear when Docker runs inside a *generated* project.

### Test a change end to end

```bash
cd <this-repo>

# 1. Scaffold into a throwaway dir (use a port that won't clash with other instances)
node index.js /tmp/try-it --port=8090

# 2. Inspect the generated config files
ls /tmp/try-it

# 3. Actually boot it (Docker must be running)
cd /tmp/try-it
npm run start            # docker compose up -d --build
#   → open http://localhost:8090 and finish the WordPress installer

# 4. Get into the workspace container to test it (lands you in /wp)
npm run bash
#     inside the container, e.g.:
#       wp plugin list          # WP-CLI talks to the DB over the network
#       claude --version        # Claude Code is installed
#       php -v
#     type `exit` to leave
npm run claude           # or launch Claude Code directly

# 5. Useful while testing
npm run logs             # tail all service logs
npm run ps               # container status

# 6. Tear down — STOP CONTAINERS FIRST, then delete the dir
npm run down             # stop + remove containers (releases the bind-mounted folders)
cd ~
rm -rf /tmp/try-it       # now safe to delete (incl. the db/ wp/ workspace/ data)
```

> **Step 6 order matters:** always `npm run down` *before* `rm -rf`. Deleting the `db/`/`wp/` folders out from under running containers can corrupt the database. Stop first, then delete.

> **No clash with other instances:** Compose names containers after the directory, so `/tmp/try-it` gets its own `try-it-*` containers. Just keep the **port different** so multiple instances can run at once.

To exercise the real `bin` entry (not just the file), use `npm link`:

```bash
npm link
create-wp-local-dev-agent-sandbox /tmp/try-it
npm unlink -g create-wp-local-dev-agent-sandbox   # when done
```

## License

GPL-2.0-or-later
