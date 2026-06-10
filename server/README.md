# devbox-server

A small HTTP control server that manages many **WordPress + Cursor worker** environments — each one a full [`create-wp-local-dev-agent-sandbox`](../README.md) stack — on a single Docker host. Each environment runs a **named Cursor self-hosted worker** (`cursor-agent worker … start --name "<name>"`) so you can dispatch work to it from GitHub (`@cursor <name> …`) and have it commit/push.

It is intentionally dependency-free (bare Node `http`) because it controls Docker and launches agents — keep its supply-chain surface at zero. It is **not** published to npm (the root package's `files` allowlist excludes `server/`).

## How it works

- **Scaffold + boot**: shells out to the scaffolder (`node ../index.js <dir> --port=N --scaffold-only`) then runs `npm run setup` asynchronously (bounded by a build semaphore). The compose project is pinned to `devbox-<name>` via `COMPOSE_PROJECT_NAME`.
- **Git auth**: configures `gh` + git identity inside the workspace from the shared `GITHUB_TOKEN` (non-fatal).
- **Worker**: launches `cursor-agent worker --name "<name>" --worker-dir /home/node start` detached inside the workspace container, logging to `/home/node/.worker.log`. The worker connects **outbound only** — no inbound port.
- **Supervision**: a reconcile loop (boot + every ~45s) re-launches a worker whose process died while its stack is up, and reconciles statuses after a server restart. The registry (`data/registry.json`) is the source of truth.
- **Credentials are shared and server-side** (`CURSOR_API_KEY`, `GITHUB_TOKEN`) — never accepted in request bodies, returned, or logged.

## Configuration (env)

| Var | Default | Notes |
| --- | --- | --- |
| `CURSOR_API_KEY` | — | **required** — shared Cursor service-account key |
| `GITHUB_TOKEN` | — | **required** — shared GitHub token for clone/commit/push |
| `DEVBOX_PORT` | `4000` | API listen port |
| `DEVBOX_BIND` | `127.0.0.1` | bind address (keep on loopback) |
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
| `DELETE` | `/environments/:id` | `compose down -v` + remove the dir |
| `GET` | `/host` | host pressure (containers, disk, load, counts) |

```bash
H='-H Authorization:Bearer secret'
curl -s $H -XPOST localhost:4000/environments -d '{"name":"my-devbox"}'
curl -s $H localhost:4000/environments/my-devbox | jq
curl -s $H 'localhost:4000/environments/my-devbox/logs?which=worker&tail=50'
```

## Scale note

Each environment is ~4 containers (MariaDB, Apache/PHP, Node workspace, headless Chromium). Hundreds *running simultaneously* on one box is unrealistic — the registry can track 100s, but the running working-set is bounded by host RAM/CPU/disk. Use `MAX_ENVIRONMENTS`, the build semaphore, `GET /host`, and `stop` idle envs. Future optimization: build the (identical) workspace image once and reference it by tag instead of per-env `build:`.
