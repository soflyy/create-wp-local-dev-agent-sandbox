# Devbox Server — how to create and manage WordPress + Cursor environments

You are talking to a **devbox control server** over plain HTTP (JSON). It manages
many self-contained **WordPress dev environments** on one Docker host. Creating
one gives you:

- a live **WordPress site** (URL returned to you; admin login `admin` / `password`),
- a workspace container with WP-CLI, Node, `git`, `gh`, Claude Code, and the
  Cursor CLI,
- a **named Cursor worker** connected to Cursor's cloud, so work can be dispatched
  to it from GitHub (comment `@cursor <name> …` on an issue/PR) or the Cursor
  dashboard.

By default each environment also checks out a **target plugin repo** as a live
git working copy (cloned into the workspace, `composer install`-ed, and symlinked
into `wp-content/plugins` so it runs live in WordPress) — the worker operates on
that repo and commits/pushes to it. The default is Agent Connector for WP at
`/home/node/agent-connector-for-wp`; the operator can change or disable it.

You do **not** need a special client — every action is an HTTP request you can
make with `curl` (or any HTTP library).

## Connection

Two values the operator gives you (fill these in):

- **Base URL** — e.g. `http://<host>:4000`
- **API token** — the value of `DEVBOX_API_TOKEN`. If the server has one set, you
  MUST send `Authorization: Bearer <token>` on **every** request (you'll get
  `401` otherwise). If the operator says there's no token, omit the header.

For the examples below:

```bash
BASE="http://<host>:4000"      # e.g. http://127.0.0.1:4000
TOK="<DEVBOX_API_TOKEN>"        # ask the operator; omit the -H lines if none
```

## Quick start — create an environment and wait until it's ready

Creation is **asynchronous**: `POST /environments` returns immediately with
`202` and `status: "scaffolding"`. The server then builds + boots the stack and
starts the worker in the background (typically ~20s–3min depending on image
cache). **Poll `GET /environments/<name>` until `status` is `running`.**

```bash
# 1. Create (name is optional; if omitted, the server assigns a unique one).
curl -s -H "Authorization: Bearer $TOK" \
  -X POST "$BASE/environments" \
  -d '{"name":"my-devbox"}'
# → {"id":"env_…","name":"my-devbox","port":9000,"wpUrl":"http://localhost:9000","status":"scaffolding"}

# 2. Poll until running (or failed). Repeat this every ~10s.
curl -s -H "Authorization: Bearer $TOK" "$BASE/environments/my-devbox"
# → {... "status":"running","worker":{"running":true,"healthy":true,"state":"connected"} ...}
```

A ready environment looks like:

```json
{
  "id": "env_dc9d01082c",
  "name": "my-devbox",
  "port": 9000,
  "wpUrl": "http://localhost:9000",
  "status": "running",
  "worker": { "running": true, "healthy": true, "state": "connected" },
  "createdAt": "…",
  "workerStartedAt": "…",
  "lastError": null,
  "fleet": { "id": "…", "status": null, "lastSeen": null }
}
```

When `status` is `running` and `worker.state` is `connected`, the worker is live
in Cursor's cloud under the name you chose. Dispatch work to it by commenting
`@cursor my-devbox <task>` on a GitHub repo where Cursor's GitHub app is
installed, or from the Cursor agents dashboard.

## Endpoints

| Method & path | What it does |
| --- | --- |
| `POST /environments` | Create an env. Body: `{"name":"<optional>"}`. Returns `202` + `{id,name,port,wpUrl,status:"scaffolding"}`. |
| `GET /environments` | List all envs with live status: `{"environments":[…]}`. |
| `GET /environments/:id` | One env by **name or id**. Full status + worker health (+ best-effort `fleet`). |
| `GET /environments/:id/logs?which=setup\|worker\|all&tail=N` | Setup and/or worker logs (`tail` defaults 200, max 5000). |
| `POST /environments/:id/stop` | Stop the containers + worker (data preserved). → `status:"stopped"`. |
| `POST /environments/:id/start` | Bring a stopped env back up + reconnect the worker. → `status:"running"`. |
| `DELETE /environments/:id` | Destroy: stop, remove containers + volumes, delete the dir. → `{"deleted":true}`. |
| `GET /host` | Host pressure (running containers, disk, load, env count vs cap). Check before mass-creating. |
| `GET /health` | Liveness of the control server itself. |

Examples:

```bash
# List everything
curl -s -H "Authorization: Bearer $TOK" "$BASE/environments"

# Tail the worker log (did it connect? did it pick up a task?)
curl -s -H "Authorization: Bearer $TOK" \
  "$BASE/environments/my-devbox/logs?which=worker&tail=50"

# Stop / start / destroy
curl -s -H "Authorization: Bearer $TOK" -X POST   "$BASE/environments/my-devbox/stop"
curl -s -H "Authorization: Bearer $TOK" -X POST   "$BASE/environments/my-devbox/start"
curl -s -H "Authorization: Bearer $TOK" -X DELETE "$BASE/environments/my-devbox"
```

## Status values

- `scaffolding` → `setting-up` → `configuring` → `starting-worker` → **`running`** — the create pipeline; wait it out.
- `running` — containers up and the worker process is alive. Check `worker.state`:
  - `connected` — worker is authenticated and connected to Cursor (ready for tasks).
  - `starting` — worker process up but not yet confirmed connected; poll again.
  - `invalid-api-key` / `error` — the worker can't authenticate (operator's `CURSOR_API_KEY` problem). Surface this; don't retry blindly.
- `degraded` — containers are up but the worker isn't alive/connected. Check `worker.state` and the worker log.
- `stopped` — explicitly stopped; use `POST …/start` to resume.
- `failed` — setup errored; see `lastError` and `GET …/logs?which=setup`. Usually `DELETE` and recreate.

## Rules and gotchas

- **Names** must match `^[a-z0-9][a-z0-9-]{1,38}$` (lowercase letters, digits,
  hyphens; 2–39 chars) and be **unique**. Reusing a live name → `409`. Omit
  `name` to get an auto-generated unique one.
- **Create is async.** Don't treat the `202` as "ready" — poll until `running`.
- **One WordPress port per env** is the only host port; the server allocates it
  for you and returns it as `wpUrl`. The worker needs no inbound port.
- **The site URL** (`wpUrl`, e.g. `http://localhost:9000`) is reachable from the
  Docker host. Inside the environment's own containers the site is
  `http://wordpress`.
- **Capacity:** each env is ~4 containers. Call `GET /host` before creating many;
  respect `503 at capacity` (raise via the operator's `MAX_ENVIRONMENTS`). Stop
  or delete envs you no longer need.
- **Credentials are the operator's, server-side.** You never send Cursor or
  GitHub tokens — the server injects them. Don't ask the user for them.
- **Errors** come back as `{"error":"…"}` with a 4xx/5xx status. `401` = missing/
  wrong bearer token; `404` = unknown env; `409` = name taken; `503` = at
  capacity or no free port.

## Driving Claude in an environment (optional)

Besides the Cursor worker, you can run **headless Claude sessions** inside an env and stream them:

```bash
# start a session (env must be running) → 202 {id, claudeSessionId, status, ...}
curl -s -H "Authorization: Bearer $TOK" -X POST "$BASE/environments/my-devbox/sessions" \
  -d '{"prompt":"List the plugin files and summarize them.","model":null}'
# watch it live (Server-Sent Events; token via query since EventSource can't set headers)
curl -N "$BASE/sessions/<id>/stream?access_token=$TOK"
# continue the same conversation
curl -s -H "Authorization: Bearer $TOK" -X POST "$BASE/sessions/<id>/messages" -d '{"prompt":"now write tests"}'
# full transcript / interrupt
curl -s -H "Authorization: Bearer $TOK" "$BASE/sessions/<id>/transcript?tail=500"
curl -s -H "Authorization: Bearer $TOK" -X POST "$BASE/sessions/<id>/interrupt"
```

The stream is newline-delimited `stream-json`: a `system`/`init` event (with `session_id`), `stream_event` token deltas, `assistant`/`user` messages (incl. `tool_use`/`tool_result`), and a terminal `result` (with `total_cost_usd`). One turn at a time per session (a second `messages` while running → `409`). There's also a web UI at `/`.

## Typical end-to-end flow

1. `POST /environments {"name":"feature-x"}` → `202`.
2. Poll `GET /environments/feature-x` until `status:"running"`, `worker.state:"connected"`.
3. Use the environment: open `wpUrl` for the site, and/or dispatch a task to the
   worker via `@cursor feature-x …` on GitHub.
4. Watch progress with `GET /environments/feature-x/logs?which=worker`.
5. When done: `POST …/stop` to pause (resume later) or `DELETE …` to remove it.
