// Thin wrappers over `docker` / `docker compose`. Everything uses execFile with
// an argv array (no shell) so the only user-controlled value (the env name,
// already charset-restricted) can't inject. Secrets are passed to children via
// the `env` option and referenced by name with `-e NAME` — never on argv.

import { execFile } from 'node:child_process';
import { join } from 'node:path';

const DEFAULT_TIMEOUT = 15_000;

export function run(file, args, { cwd, env, timeout = DEFAULT_TIMEOUT, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { cwd, env: env ? { ...process.env, ...env } : process.env, timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          err.message = `${file} ${args.join(' ')} failed: ${err.message}\n${stderr || ''}`.trim();
          return reject(err);
        }
        resolve({ stdout, stderr });
      },
    );
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

// Compose invocation pinned to a project + its dir (so we never depend on cwd).
function composeArgs(env, rest) {
  return ['compose', '-p', env.project, ...rest];
}

export function compose(env, rest, opts = {}) {
  return run('docker', composeArgs(env, rest), { cwd: env.dir, ...opts });
}

// `docker compose ps --format json` → array of service status objects.
export async function ps(env) {
  try {
    const { stdout } = await compose(env, ['ps', '--format', 'json', '--all']);
    // Compose emits either a JSON array or newline-delimited JSON objects.
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) return JSON.parse(trimmed);
    return trimmed
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function up(env, { build = true, timeout = 600_000 } = {}) {
  return compose(env, ['up', '-d', ...(build ? ['--build'] : [])], { timeout });
}

export function stop(env) {
  return compose(env, ['stop'], { timeout: 120_000 });
}

export function down(env, { volumes = false } = {}) {
  return compose(env, ['down', ...(volumes ? ['-v'] : [])], { timeout: 180_000 });
}

// Run a command inside a service. `detach` uses `-d` (fire-and-forget); envNames
// are forwarded by name only (their values come from the spawned child's env).
export function exec(env, service, argv, { detach = false, envNames = [], envValues = {}, tty = false, timeout } = {}) {
  const flags = [];
  if (detach) flags.push('-d');
  if (!tty) flags.push('-T');
  for (const name of envNames) flags.push('-e', name);
  return compose(env, ['exec', ...flags, service, ...argv], { env: envValues, timeout });
}

// List compose projects currently known to the daemon (for name-collision checks).
export async function listProjects() {
  try {
    const { stdout } = await run('docker', ['compose', 'ls', '--all', '--format', 'json']);
    const arr = JSON.parse(stdout.trim() || '[]');
    return arr.map((p) => p.Name);
  } catch {
    return [];
  }
}

// Host pressure snapshot for GET /host.
export async function hostInfo() {
  const out = {};
  await Promise.all([
    run('docker', ['system', 'df', '--format', 'json'])
      .then(({ stdout }) => {
        out.dockerDf = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      })
      .catch(() => {
        out.dockerDf = null;
      }),
    run('docker', ['ps', '-q'])
      .then(({ stdout }) => {
        out.runningContainers = stdout.trim() ? stdout.trim().split('\n').length : 0;
      })
      .catch(() => {
        out.runningContainers = null;
      }),
    run('df', ['-h', '/'])
      .then(({ stdout }) => {
        out.diskRoot = stdout.trim().split('\n').slice(1).join('\n');
      })
      .catch(() => {
        out.diskRoot = null;
      }),
  ]);
  return out;
}

export { join };
