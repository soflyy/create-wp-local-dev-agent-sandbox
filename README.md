# create-wp-local-dev-agent-sandbox

Scaffold a local **WordPress + AI-agent** development environment (Docker Compose) — WordPress + MariaDB plus an isolated **workspace** container with Node, [Claude Code](https://claude.com/claude-code), the [Cursor CLI](https://cursor.com/docs/cli), PHP, and WP-CLI ready to go.

It scaffolds the project **and runs the initial setup** for you — `docker compose up`, then installs WordPress and the configured plugins — so you land on a working site. Pass `--scaffold-only` to just write files and skip Docker. The generated project ships npm scripts (`npm run start`, `npm run bash`, `npm run claude`, `npm run cursor`, …) for everyday use.

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

Docker must be running. When it finishes you have a live site at **http://localhost:8080** — log in at `/wp-admin` with `admin` / `password` (the default; configurable in `.env` via `WP_ADMIN_USER` / `WP_ADMIN_PASSWORD`). Then:

```bash
cd my-site
npm run start      # bring the stack up next time (it stays up otherwise)
npm run bash       # shell into the workspace container
npm run claude     # launch Claude Code in the workspace
npm run cursor     # launch the Cursor CLI agent in the workspace
```

**Claude auto-login (same as [agent-sandbox](https://github.com/louisreingold/agent-sandbox)):** mint a token once on your host with `claude setup-token` and save it to `~/.agent-sandbox/oauth-token` (or `export CLAUDE_CODE_OAUTH_TOKEN=<token>`). `npm run claude` resolves the token from either source and forwards it into the workspace by name (so the value never appears on the command line), and the workspace's entrypoint pre-clears Claude's three first-run gates (login picker, `--dangerously-skip-permissions` warning, trust-folder dialog) — so Claude lands **straight at the prompt**, logged in, no `/login`. No token found? Claude just starts and you `/login` once; it persists in `workspace/` across rebuilds.

**Cursor auto-login:** the same flow with a Cursor API key — generate one in the Cursor dashboard (**Settings → API Keys**) and save it to `~/.agent-sandbox/cursor-api-key` (or `export CURSOR_API_KEY=<key>`). `npm run cursor` resolves and forwards it by name, then launches with `--force --approve-mcps` so the agent runs commands and uses the sandbox's MCP servers without prompting. No key found? Cursor starts unauthenticated and you can `cursor-agent login` once; it persists in `workspace/`.

## What gets scaffolded

```
my-site/
├── docker-compose.yml      # db + wordpress + workspace + playwright services
├── workspace.Dockerfile    # Node + Claude Code + Cursor CLI + PHP + WP-CLI (runs as non-root)
├── .env                    # DB creds + WP_PORT
├── .gitignore              # ignores the bind-mounted data dirs
├── package.json            # the npm-scripts UX (setup/start/stop/bash/claude/cursor/wp/reset)
├── sandbox.config.json     # plugins to install on `npm run setup` (+ future params)
├── php/php.ini             # custom PHP overrides for the wordpress container (upload limits, etc.)
├── scripts/                # provisioning steps run by initial-setup.sh (install-wp, plugins, root-for-agents, mcp, skills) + in-workspace.sh (credential-resolving launcher for bash/claude/cursor)
├── bin/                    # cursor-wp-mcp-helper — Node CLI for the WordPress MCP server, baked onto the workspace PATH
├── skills/                 # agent skills installed into the workspace (wordpress-dev, cursor-wp-mcp-helper) — copied to both ~/.claude/skills and ~/.cursor/skills
└── README.md
```

WordPress data, the database, and the workspace home are bind-mounted into `wp/`, `db/`, and `workspace/` in the project, so everything is visible on your machine and survives restarts.

## Requirements

- Node.js >= 18 (to run the CLI and the project's npm scripts)
- Docker with Compose v2 (to actually run the environment)

## User config (defaults for every sandbox)

Set defaults once and they apply to every project you scaffold (and every environment the devbox server creates) — at `~/.config/create-wp-local-dev-agent-sandbox/config.json` (or `$XDG_CONFIG_HOME/...`):

```json
{
  "wpAdminUser": "admin",
  "wpAdminPassword": "change-me",
  "wpAdminEmail": "you@example.com"
}
```

At scaffold time these seed the new project's `.env` (`WP_ADMIN_USER` / `WP_ADMIN_PASSWORD` / `WP_ADMIN_EMAIL`); with no config file they fall back to `admin` / `password`. To override for a single project, edit that project's `.env` and `npm run reset`. (Keep the password free of shell metacharacters, or quote it in `.env` — the setup scripts source `.env`.)

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

   They get the full sandbox (WordPress + Claude Code + Cursor CLI + the WordPress & Playwright MCP servers + Root for Agents) **plus your plugins**, installed and activated on the first `npm run setup`.

Your preset's plugins are **appended** to the defaults, so `mcp-adapter` and `root-for-agents` are always present. Everything else — templates, Docker setup, the `npm run …` UX — is inherited from this package, so improvements here flow to every `create-<brand>` that depends on it.

> **Premium plugins:** a *public* `create-<brand>` can only bake in a `.zip` URL that's publicly reachable. For licensed plugins, point at a gated endpoint you control, or have your wrapper read the URL from a prompt or an env var instead of hardcoding it.

## Contributing

Working on the scaffolder itself, or cutting a release? See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GPL-2.0-or-later
