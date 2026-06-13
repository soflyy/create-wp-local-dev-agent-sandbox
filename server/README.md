# devbox-server

A small HTTP control server (with a web UI) that manages many WordPress devbox environments — each a full [`create-wp-local-dev-agent-sandbox`](../README.md) stack — on a single Docker host, and **drives Claude Code headlessly inside each one** with live streaming to the browser. It also keeps the optional **named Cursor self-hosted worker** per env.

It is dependency-free on the server side (bare Node `http`) because it controls Docker and launches agents — keep its supply-chain surface at zero. The UI is buildless (Preact + htm via CDN). It is **not** published to npm (the root package's `files` allowlist excludes `server/`).

The server is a **thin orchestrator over the scaffolded project's own scripts**: it creates envs the normal way and drives them through `npm run …` and `scripts/in-workspace.sh` (the same proven path `npm run claude` uses), all on the **default compose project** (the dir basename) so the server and the project's scripts always agree.

## How it works

- **Create**: runs the standard scaffolder once — `node ../index.js <dir> --port=N` — which scaffolds **and** `npm run setup` (build + boot + provision). Default compose project = the env name. Bounded by a build semaphore.
- **Git auth**: configures `gh` + git identity inside the workspace from the shared `GITHUB_TOKEN` (non-fatal).
- **Target repo**: replaces the release-zip plugin with a live git checkout (clone → `composer install --no-dev` → symlink into `wp-content/plugins/<slug>` → activate), so agents operate on and commit to the real repo. Defaults to [Agent Connector for WP](https://github.com/soflyy/agent-connector-for-wp); `TARGET_REPO=` empty disables it.
- **Claude sessions**: each user message spawns `claude -p [--resume <id>] --output-format stream-json …` via the env's own `scripts/in-workspace.sh` (so auth = the proven token path; the server holds no Claude token). stdout is streamed to the browser over **SSE**; the session id + result + cost are persisted (`data/sessions.json`, raw events in `data/sessions/<id>.ndjson`). Resumable from the UI **and** by SSH (`bash scripts/in-workspace.sh claude --resume <id>`).
- **Cursor worker (optional)**: unless `CURSOR_WORKER_AUTOSTART=0`, launches `cursor-agent worker --name "<name>" … start` detached; a reconcile loop (boot + ~45s) re-launches it if it dies and reconciles statuses after a server restart.
- **Credentials are shared and server-side** (`CURSOR_API_KEY`, `GITHUB_TOKEN`, and the Claude token via in-workspace.sh) — never accepted in request bodies, returned, or logged.

## Configuration (env)

| Var | Default | Notes |
| --- | --- | --- |
| `CURSOR_API_KEY` | — | **required** — shared Cursor service-account key |
| `GITHUB_TOKEN` | — | **required** — shared GitHub token for clone/commit/push |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | for Claude sessions — forwarded by `in-workspace.sh` exactly like `npm run claude` (or put it in `~/.agent-sandbox/oauth-token`). The server keeps no Claude token of its own. |
| `CLAUDE_DEFAULT_MODEL` | — | optional default model for sessions (e.g. `claude-sonnet-4-6`) |
| `CURSOR_WORKER_AUTOSTART` | `1` | start a Cursor worker per env; `0` to skip |
| `SESSION_RING_BUFFER` | `500` | live events buffered per session for late SSE subscribers |
| `DEVBOX_PORT` | `4000` | API listen port |
| `DEVBOX_BIND` | `127.0.0.1` | bind address. `0.0.0.0` (or a specific IP) to reach it over the network — **requires `DEVBOX_API_TOKEN`** (the server refuses to start network-exposed without one) and a firewall/VPN |
| `DEVBOX_API_TOKEN` | — | if set, all routes require `Authorization: Bearer <token>` |
| `WP_PORT_RANGE` | `9000-9999` | host WP ports to allocate from |
| `MAX_ENVIRONMENTS` | `25` | hard cap on environments |
| `BUILD_CONCURRENCY` | `2` | simultaneous `docker build`/setup runs |
| `DEVBOX_ENVS_DIR` | `data/envs` | where stacks are scaffolded |
| `SCAFFOLDER_DIR` | repo root | path to the scaffolder (`index.js`) |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `devbox` / `devbox@localhost` | commit identity |
| `WORKER_DIR` | `/home/node` | worker `--worker-dir` |
| `WORKER_IDLE_RELEASE_TIMEOUT` | — | optional worker `--idle-release-timeout` (sec) |
| `RECONCILE_INTERVAL_MS` | `45000` | supervision loop interval |

## Run

Put your tokens in `server/.env` (next to `package.json`). It's gitignored and
loaded automatically on `npm start` (via Node's built-in env-file support — no
dependency). Real environment variables already set take precedence, so
systemd/`export` setups keep working.

```bash
cd server
cp .env.example .env      # then fill in CURSOR_API_KEY, GITHUB_TOKEN, DEVBOX_API_TOKEN
npm start
```

`.env` example:

```ini
CURSOR_API_KEY=sk_...
GITHUB_TOKEN=ghp_...
DEVBOX_API_TOKEN=$(openssl rand -hex 32)   # paste a generated value
```

Or pass them inline / via your process manager instead of a file:

```bash
CURSOR_API_KEY=… GITHUB_TOKEN=… DEVBOX_API_TOKEN=secret npm start
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/environments` | `{name?}` → 202 `{id,name,port,wpUrl,status}`; runs the async pipeline |
| `GET` | `/environments` | list with live status + worker health |
| `GET` | `/environments/:id` | one env (by id or name); includes best-effort `fleet` info |
| `GET` | `/environments/:id/logs?which=setup\|worker\|all&tail=N` | logs |
| `POST` | `/environments/:id/stop` | stop containers + worker |
| `POST` | `/environments/:id/start` | bring containers up + re-auth + restart worker |
| `DELETE` | `/environments/:id` | stop + remove the dir; cascades to its sessions |
| `POST` | `/environments/:id/sessions` | `{prompt,model?}` → 202; start a Claude session (env must be running) |
| `POST` | `/sessions/:id/messages` | `{prompt}` → 202; continue the session (`--resume`); 409 if a turn is active |
| `GET` | `/sessions` / `/sessions/:id` | list / one session (id, claudeSessionId, status, cost, `sshResumeHint`) |
| `GET` | `/sessions/:id/stream` | **SSE** live stream-json (auth: bearer or `?access_token=`) |
| `GET` | `/sessions/:id/transcript?tail=N` | full event history (ndjson) |
| `POST` | `/sessions/:id/interrupt` | SIGINT the active turn |
| `DELETE` | `/sessions/:id` | forget the session |
| `GET` | `/host` | host pressure (containers, disk, load, counts) |
| `GET` | `/` , `/ui/*` | the web UI (static; shell unauthenticated, data APIs authed) |

```bash
H='-H Authorization:Bearer secret'
curl -s $H -XPOST localhost:4000/environments -d '{"name":"my-devbox"}'
curl -s $H -XPOST localhost:4000/environments/my-devbox/sessions -d '{"prompt":"summarize the README"}'
curl -N $H localhost:4000/sessions/<id>/stream         # live stream-json
curl -s $H -XPOST localhost:4000/sessions/<id>/messages -d '{"prompt":"now add a CHANGELOG entry"}'
```

## Web UI

Open `http://<host>:<port>/` and enter the `DEVBOX_API_TOKEN`. List sessions across all devboxes, watch a session stream live (token-by-token, with tool calls), send messages, interrupt, start a new session (pick a devbox + model), and copy the SSH-resume command. Buildless (Preact + htm from a CDN) — to run fully offline, vendor those into `ui/vendor/`.

## Scale note

Each environment is ~4 containers (MariaDB, Apache/PHP, Node workspace, headless Chromium). Hundreds *running simultaneously* on one box is unrealistic — the registry can track 100s, but the running working-set is bounded by host RAM/CPU/disk. Use `MAX_ENVIRONMENTS`, the build semaphore, `GET /host`, and `stop` idle envs. Future optimization: build the (identical) workspace image once and reference it by tag instead of per-env `build:`.
