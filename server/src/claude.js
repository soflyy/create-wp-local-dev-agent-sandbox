// Claude headless turn engine. Each turn spawns the environment's OWN
// scripts/in-workspace.sh to run `claude -p … --output-format stream-json` in
// the workspace container — reusing the proven auth path (token resolution +
// -e forwarding + the onboarding seed). No Claude token is handled here; it's
// resolved by in-workspace.sh from this process's env (server/.env) or
// ~/.agent-sandbox/oauth-token, exactly like `npm run claude`.
//
// Claude runs with the container's default cwd (/home/node) every turn, so its
// session jsonl is consistently scoped and --resume works (and an operator can
// `bash scripts/in-workspace.sh claude --resume <id>` to take over).

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { exec } from './docker.js';
import { log, redact } from './log.js';

const CLAUDE_CWD = '/home/node'; // in-workspace.sh runs claude here (container WORKDIR)

// A `claude -p` turn runs INSIDE the workspace container (via `docker compose
// exec`), so it does NOT die when the server / the exec client dies — it's
// reparented to the container's init and keeps running. We must reap it
// explicitly on interrupt, shutdown, and restart; otherwise a later --resume
// spawns a SECOND claude that races the orphan over the same WordPress install.
// The slim image has no pkill, so sweep /proc. TERM, then KILL stragglers.
const REAP_CLAUDE = `self=$$
for sig in TERM KILL; do
  for d in /proc/[0-9]*; do
    pid=\${d#/proc/}; [ "$pid" = "$self" ] && continue
    c=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null)
    case "$c" in "claude -p "*) kill -$sig "$pid" 2>/dev/null ;; esac
  done
  [ "$sig" = TERM ] && sleep 1
done`;

// Kill any in-container claude turn for this env (best-effort; no-op if the
// container is down or nothing matches).
export async function reapClaude(env) {
  try {
    await exec(env, 'workspace', ['sh', '-c', REAP_CLAUDE], { timeout: 15_000 });
  } catch { /* container gone or nothing to kill */ }
}

export class ClaudeEngine {
  constructor(config, store, bus, settings) {
    this.config = config;
    this.store = store;
    this.bus = bus;
    this.settings = settings;
    this.active = new Map(); // sessionId -> { child, ndjson }
  }

  isActive(id) {
    return this.active.has(id);
  }

  // Start a brand-new session (turn 1, no --resume). Returns the session record.
  async newSession(env, { prompt, model }) {
    const id = `sess_${randomBytes(5).toString('hex')}`;
    const record = {
      id,
      envId: env.id,
      envName: env.name,
      claudeSessionId: null,
      cwd: CLAUDE_CWD,
      model: model || this.config.claudeDefaultModel || null,
      title: title(prompt),
      status: 'running',
      turnCount: 0,
      lastResult: null,
      costUsd: 0,
      lastError: null,
      eventLogPath: join(this.config.sessionsDir, `${id}.ndjson`),
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    await this.store.create(record);
    this._runTurn(env, record, prompt);
    return record;
  }

  // Continue an existing session (turn 2+, with --resume). Caller ensures the
  // session isn't already running.
  async sendMessage(env, session, { prompt }) {
    await this.store.update(session.id, { status: 'running', lastActivityAt: new Date().toISOString() });
    this._runTurn(env, { ...session, status: 'running' }, prompt);
  }

  _runTurn(env, session, prompt) {
    const args = [
      join(env.dir, 'scripts', 'in-workspace.sh'),
      'claude', '-p', prompt,
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--dangerously-skip-permissions',
    ];
    if (session.model) args.push('--model', session.model);
    if (session.claudeSessionId) args.push('--resume', session.claudeSessionId);

    mkdirSync(this.config.sessionsDir, { recursive: true });
    const ndjson = createWriteStream(session.eventLogPath, { flags: 'a' });
    ndjson.on('error', (e) => log.warn(`[${session.id}] event log write error:`, e.message));
    ndjson.write(`${JSON.stringify({ type: 'control', subtype: 'turn-start', at: new Date().toISOString() })}\n`);

    // `claude -p` doesn't echo the prompt in its output (it's argv), so record it
    // ourselves — to the ndjson (shows on transcript reload) and the live bus —
    // otherwise the UI only ever shows Claude's side, never the user's message.
    // uuid lets the UI dedupe the transcript-replay vs the SSE backlog copy.
    const promptEvt = { type: 'user_prompt', text: prompt, uuid: randomUUID() };
    ndjson.write(JSON.stringify(promptEvt) + '\n');
    this.bus.publish(session.id, promptEvt);

    // stdin ignored → in-workspace.sh sees a non-TTY → adds -T → clean stream-json.
    // Inject the Claude token from Settings (if set) so in-workspace.sh resolves
    // CLAUDE_CODE_OAUTH_TOKEN from it; otherwise it falls back to the host's env /
    // ~/.agent-sandbox/oauth-token exactly as before.
    const claudeToken = this.settings && this.settings.get().claudeToken;
    const childEnv = claudeToken ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: claudeToken } : process.env;
    const child = spawn('bash', args, { cwd: env.dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = { child, ndjson, interrupting: false, env };
    this.active.set(session.id, entry);

    let buf = '';
    let stderr = '';
    const pending = { claudeSessionId: session.claudeSessionId, lastResult: null, addCost: 0 };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this._handleLine(session, line, ndjson, pending);
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
      this.bus.publish(session.id, { type: 'stderr', text: redact(String(d)) });
    });

    const finalize = async (code, signal) => {
      if (buf.trim()) this._handleLine(session, buf, ndjson, pending); // trailing partial line
      buf = '';
      ndjson.end();
      this.active.delete(session.id);
      // docker compose exec translates SIGINT to a non-zero exit code, so detect
      // interruption from the flag we set, not the signal.
      const interrupted = entry.interrupting || signal === 'SIGINT' || signal === 'SIGTERM';
      const status = interrupted ? 'interrupted' : code === 0 ? 'idle' : 'error';
      const patch = {
        status,
        turnCount: (session.turnCount || 0) + 1,
        lastActivityAt: new Date().toISOString(),
        claudeSessionId: pending.claudeSessionId || session.claudeSessionId || null,
        costUsd: (session.costUsd || 0) + pending.addCost,
      };
      if (pending.lastResult != null) patch.lastResult = trunc(pending.lastResult, 4000);
      if (status === 'error') patch.lastError = trunc(redact(stderr) || `claude exited with code ${code}`, 800);
      else if (status === 'idle') patch.lastError = null;
      await this.store.update(session.id, patch);
      this.bus.publish(session.id, { type: 'control', subtype: 'turn-end', code, status });
      log.info(`[${session.id}] turn ended (${status}, code ${code})`);
    };

    child.on('error', (err) => {
      this.bus.publish(session.id, { type: 'control', subtype: 'spawn-error', error: redact(err.message) });
      finalize(-1, null).catch(() => {});
    });
    child.on('close', (code, signal) => finalize(code, signal).catch((e) => log.warn(`[${session.id}] finalize:`, e.message)));
  }

  // Record one stdout line: append to ndjson, publish to the bus, and capture
  // session_id / result / cost into `pending`.
  _handleLine(session, line, ndjson, pending) {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      evt = { type: 'raw', text: line };
    }
    ndjson.write(line + '\n');
    this.bus.publish(session.id, evt);

    if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id && !pending.claudeSessionId) {
      pending.claudeSessionId = evt.session_id;
      // Persist the resume id immediately so a crash mid-turn stays resumable.
      this.store.update(session.id, { claudeSessionId: evt.session_id }).catch(() => {});
    }
    if (evt.type === 'result') {
      if (typeof evt.result === 'string') pending.lastResult = evt.result;
      if (typeof evt.total_cost_usd === 'number') pending.addCost += evt.total_cost_usd;
      if (evt.session_id && !pending.claudeSessionId) pending.claudeSessionId = evt.session_id;
    }
  }

  interrupt(id) {
    const a = this.active.get(id);
    if (!a) return false;
    a.interrupting = true;
    a.child.kill('SIGINT'); // the local docker-exec client
    if (a.env) reapClaude(a.env).catch(() => {}); // the in-container turn (survives the client)
    return true;
  }

  // Interrupt every active turn (local client + in-container). Returns the count.
  interruptAll() {
    const ids = [...this.active.keys()];
    for (const id of ids) this.interrupt(id);
    return ids.length;
  }

  killEnvSessions(envId) {
    let env = null;
    for (const s of this.store.listByEnv(envId)) {
      const a = this.active.get(s.id);
      if (a) { a.interrupting = true; a.child.kill('SIGTERM'); env = a.env; }
    }
    if (env) reapClaude(env).catch(() => {});
  }
}

function title(prompt) {
  const t = String(prompt || '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t || '(empty)';
}
function trunc(s, n) {
  s = String(s);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
