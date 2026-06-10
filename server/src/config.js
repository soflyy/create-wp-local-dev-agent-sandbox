// Server configuration, read once from the environment and frozen.
//
// Secrets (CURSOR_API_KEY, GITHUB_TOKEN) live only here and in the env of the
// child processes we spawn — never in request bodies, responses, the registry,
// or logs. See log.js for the redactor that scrubs them if they ever leak.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..');
// The scaffolder repo root (this server lives in <repo>/server).
const DEFAULT_SCAFFOLDER_DIR = resolve(SERVER_ROOT, '..');

function abs(p, fallback) {
  const v = p || fallback;
  return isAbsolute(v) ? v : resolve(SERVER_ROOT, v);
}

function parseRange(raw, fallback) {
  const [lo, hi] = (raw || fallback).split('-').map((n) => parseInt(n.trim(), 10));
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi < lo || hi > 65535) {
    throw new Error(`Invalid WP_PORT_RANGE "${raw}" — expected "<lo>-<hi>", e.g. 9000-9999`);
  }
  return { lo, hi };
}

export function loadConfig(env = process.env) {
  const missing = [];
  if (!env.CURSOR_API_KEY) missing.push('CURSOR_API_KEY');
  if (!env.GITHUB_TOKEN) missing.push('GITHUB_TOKEN');
  if (missing.length) {
    throw new Error(
      `Missing required env: ${missing.join(', ')}. ` +
        `These are the shared Cursor + GitHub credentials applied to every environment.`,
    );
  }

  const dataDir = abs(env.DEVBOX_DATA_DIR, join(SERVER_ROOT, 'data'));

  const config = {
    // HTTP
    port: parseInt(env.DEVBOX_PORT || '4000', 10),
    bind: env.DEVBOX_BIND || '127.0.0.1',
    apiToken: env.DEVBOX_API_TOKEN || null, // optional bearer auth

    // Paths
    scaffolderDir: abs(env.SCAFFOLDER_DIR, DEFAULT_SCAFFOLDER_DIR),
    dataDir,
    envsDir: abs(env.DEVBOX_ENVS_DIR, join(dataDir, 'envs')),
    registryPath: join(dataDir, 'registry.json'),

    // Allocation / limits
    portRange: parseRange(env.WP_PORT_RANGE, '9000-9999'),
    maxEnvironments: parseInt(env.MAX_ENVIRONMENTS || '25', 10),
    buildConcurrency: Math.max(1, parseInt(env.BUILD_CONCURRENCY || '2', 10)),
    reconcileIntervalMs: parseInt(env.RECONCILE_INTERVAL_MS || '45000', 10),

    // Credentials (shared across all environments)
    cursorApiKey: env.CURSOR_API_KEY,
    githubToken: env.GITHUB_TOKEN,
    gitAuthorName: env.GIT_AUTHOR_NAME || 'devbox',
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL || 'devbox@localhost',

    // Worker launch tuning
    workerDir: env.WORKER_DIR || '/home/node',
    workerIdleReleaseTimeout: env.WORKER_IDLE_RELEASE_TIMEOUT || null, // seconds, optional

    // Cursor fleet API (best-effort enrichment only)
    fleetApiUrl: env.CURSOR_FLEET_API_URL || 'https://api.cursor.com/v0/private-workers',
  };

  // The set of secret strings the logger must redact.
  config.secrets = [config.cursorApiKey, config.githubToken].filter(Boolean);
  return Object.freeze(config);
}
