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

**Tip — skip `/login`:** if you export a `CLAUDE_CODE_OAUTH_TOKEN` in your shell (mint one with `claude setup-token`), `npm run claude` forwards it into the workspace container and Claude is logged in automatically. It's passed by name (`docker compose exec -e CLAUDE_CODE_OAUTH_TOKEN`), so the value never appears on the command line. Otherwise just run `/login` once inside the workspace — it persists in `workspace/` across rebuilds.

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

## Build your own `npm create` command

This package is also a library. If you ship a WordPress plugin (or a stack of them), you can publish your **own** `create-<brand>` command that scaffolds this same sandbox with your plugins pre-installed — no fork, you just depend on this package.

1. Create a package named `create-<brand>` and add this one as a dependency:

   ```bash
   mkdir create-oxygen-wp && cd create-oxygen-wp
   npm init -y
   npm install create-wp-local-dev-agent-sandbox
   ```

2. Point its `bin` at a one-file script that calls `create()` with a preset. A preset adds plugins — each entry is a wordpress.org slug, or `{ source, activate?, version? }` where `source` is a slug or a URL/path to a `.zip` (the same format the generated project's `sandbox.config.json` uses):

   ```js
   #!/usr/bin/env node
   import { create } from 'create-wp-local-dev-agent-sandbox';

   create({
     preset: {
       name: 'oxygen-wp', // so messages read `npm create oxygen-wp`
       plugins: [
         { source: 'https://example.com/oxygen.zip', activate: true },
       ],
     },
   });
   ```

   ```json
   {
     "name": "create-oxygen-wp",
     "type": "module",
     "bin": { "create-oxygen-wp": "index.js" },
     "dependencies": { "create-wp-local-dev-agent-sandbox": "^0.3.0" }
   }
   ```

3. Publish it. Now anyone can run:

   ```bash
   npm create oxygen-wp my-site
   ```

   They get the full sandbox (WordPress + Claude Code + the WordPress & Playwright MCP servers + Root for Agents) **plus your plugins**, installed and activated on the first `npm run setup`.

Your preset's plugins are **appended** to the defaults, so `mcp-adapter` and `root-for-agents` are always present. Everything else — templates, Docker setup, the `npm run …` UX — is inherited from this package, so improvements here flow to every `create-<brand>` that depends on it.

> **Premium plugins:** a *public* `create-<brand>` can only bake in a `.zip` URL that's publicly reachable. For licensed plugins, point at a gated endpoint you control, or have your wrapper read the URL from a prompt or an env var instead of hardcoding it.

## Contributing

Working on the scaffolder itself, or cutting a release? See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GPL-2.0-or-later
