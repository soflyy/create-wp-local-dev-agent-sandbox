// Start / stop / health-check the named Cursor self-hosted worker inside an
// environment's workspace container.
//
// The worker connects OUTBOUND to Cursor only (no inbound port). We launch it
// detached (`compose exec -d`) writing to /home/node/.worker.log (persisted in
// the bind mount, so the host can read it at <dir>/workspace/.worker.log). The
// control server's reconcile loop is the supervisor: it re-launches a worker
// whose process has died while its containers are up.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exec } from './docker.js';

const WORKER_MATCH = 'cursor-agent worker'; // pgrep pattern for liveness

// Build the `cursor-agent worker … start` argv. Flags live on the `worker`
// command (before `start`); CURSOR_API_KEY is read from the env by the binary.
function workerCommand(env, config) {
  const parts = [
    'cursor-agent',
    'worker',
    '--name',
    quote(env.name),
    '--worker-dir',
    config.workerDir,
  ];
  if (config.workerIdleReleaseTimeout) {
    parts.push('--idle-release-timeout', String(config.workerIdleReleaseTimeout));
  }
  parts.push('start');
  // Append (don't truncate) the log so restarts keep history.
  return `${parts.join(' ')} >> /home/node/.worker.log 2>&1`;
}

function quote(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

export async function start(env, config) {
  const cmd = workerCommand(env, config);
  // `sh -lc` so PATH/profile are loaded; detached so it outlives the exec.
  await exec(env, 'workspace', ['sh', '-lc', cmd], {
    detach: true,
    envNames: ['CURSOR_API_KEY'],
    envValues: { CURSOR_API_KEY: config.cursorApiKey },
  });
}

// Liveness: is the worker process running in the workspace container?
export async function isRunning(env) {
  try {
    await exec(env, 'workspace', ['pgrep', '-f', WORKER_MATCH], { timeout: 10_000 });
    return true; // pgrep exits 0 when a match exists
  } catch {
    return false;
  }
}

// Stop the worker process without touching the container.
export async function stop(env) {
  try {
    await exec(env, 'workspace', ['pkill', '-f', WORKER_MATCH], { timeout: 10_000 });
  } catch {
    /* no process / already gone */
  }
}

// Read the connection state from the tail of the worker log (host-side, since
// the log lives in the bind-mounted workspace dir). Best-effort.
export async function logState(env) {
  try {
    const text = await readFile(join(env.dir, 'workspace', '.worker.log'), 'utf8');
    const tail = text.slice(-4000);
    if (/invalid api key/i.test(tail)) return 'invalid-api-key';
    if (/connected|registered|listening|ready/i.test(tail)) return 'connected';
    if (/error|failed/i.test(tail)) return 'error';
    return 'starting';
  } catch {
    return 'unknown';
  }
}

export async function health(env) {
  const [running, state] = await Promise.all([isRunning(env), logState(env)]);
  return { running, healthy: running && state === 'connected', state };
}
