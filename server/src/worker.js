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

// Build the `cursor-agent worker … start` argv. Flags live on the `worker`
// command (before `start`); CURSOR_API_KEY is read from the env by the binary.
// --management-addr exposes /readyz inside the container for liveness checks.
function workerCommand(env, config) {
  const parts = [
    'cursor-agent',
    'worker',
    '--name',
    quote(env.name),
    '--worker-dir',
    config.workerDir,
    '--management-addr',
    config.workerManagementAddr,
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

function readyzUrl(config) {
  return `http://${config.workerManagementAddr}/readyz`;
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

// Liveness via the worker's own /readyz endpoint (the slim image has no
// pgrep/ps; curl is present). Exit 0 from curl --fail means up + ready.
export async function isRunning(env, config) {
  try {
    await exec(env, 'workspace', ['curl', '-fsS', '-m', '3', readyzUrl(config)], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// No process-kill tool in the image; the container stop in manager.stop() reaps
// the worker. Kept as a hook (best-effort) for callers that only stop the worker.
export async function stop() {
  /* no-op: container stop reaps the worker (no pkill in the slim image) */
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

export async function health(env, config) {
  const [running, state] = await Promise.all([isRunning(env, config), logState(env)]);
  return { running, healthy: running && state === 'connected', state };
}
