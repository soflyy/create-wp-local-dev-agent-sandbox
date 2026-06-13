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

  // Target repo defaults to Agent Connector for WP; empty string disables it.
  const DEFAULT_TARGET_REPO = 'https://github.com/soflyy/agent-connector-for-wp.git';
  const targetRepo = (env.TARGET_REPO !== undefined ? env.TARGET_REPO : DEFAULT_TARGET_REPO).trim();
  const targetPluginSlug = env.TARGET_PLUGIN_SLUG || 'agent-connector-for-wp';

  const config = {
    // HTTP
    port: parseInt(env.DEVBOX_PORT || '4000', 10),
    bind: env.DEVBOX_BIND || '127.0.0.1',
    apiToken: env.DEVBOX_API_TOKEN || null, // optional bearer auth

    // Paths
    scaffolderDir: abs(env.SCAFFOLDER_DIR, DEFAULT_SCAFFOLDER_DIR),
    uiRoot: join(SERVER_ROOT, 'ui'),
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

    // Target plugin repo: each environment replaces the release-zip plugin with
    // a live git checkout (cloned into the workspace, composer-installed, and
    // symlinked into wp-content/plugins) so the worker operates on — and commits
    // to — the real repo. Set TARGET_REPO="" to disable (general-purpose worker).
    targetRepo: targetRepo || null,
    targetRepoRef: env.TARGET_REPO_REF || null, // branch/tag/commit, optional
    targetPluginSlug,
    targetPluginSubdir: env.TARGET_PLUGIN_SUBDIR || 'plugin', // plugin lives in repo/<subdir>

    // Worker launch tuning. When a target repo is set, the worker operates inside
    // the checkout by default (so its git context is the repo); else the home dir.
    workerDir: env.WORKER_DIR || (targetRepo ? `/home/node/${targetPluginSlug}` : '/home/node'),
    workerIdleReleaseTimeout: env.WORKER_IDLE_RELEASE_TIMEOUT || null, // seconds, optional
    // Worker health endpoint, bound inside the container (not published to the
    // host — no host port consumed). Used for liveness via `curl /readyz`, since
    // the slim image has no pgrep/ps.
    workerManagementAddr: env.WORKER_MANAGEMENT_ADDR || '127.0.0.1:8930',

    // Start a Cursor worker automatically on env create (kept available, but the
    // focus is now Claude sessions). Set CURSOR_WORKER_AUTOSTART=0 to skip — then
    // an env runs no worker and "running" doesn't depend on worker liveness.
    cursorWorkerAutostart: env.CURSOR_WORKER_AUTOSTART !== '0',

    // Cursor fleet API (best-effort enrichment only)
    fleetApiUrl: env.CURSOR_FLEET_API_URL || 'https://api.cursor.com/v0/private-workers',

    // Claude headless sessions. NO Claude token here on purpose — Claude is
    // driven through the env's own scripts/in-workspace.sh, which resolves
    // CLAUDE_CODE_OAUTH_TOKEN from this server process's env (e.g. server/.env)
    // or ~/.agent-sandbox/oauth-token, exactly like `npm run claude`.
    sessionsPath: join(dataDir, 'sessions.json'),
    sessionsDir: join(dataDir, 'sessions'),
    claudeDefaultModel: env.CLAUDE_DEFAULT_MODEL || null, // null → claude's own default
    sessionRingBufferSize: parseInt(env.SESSION_RING_BUFFER || '500', 10),
  };

  // Exposing this API to the network means exposing root-equivalent control of
  // the Docker host. Refuse to bind a non-loopback address without a bearer
  // token — otherwise anyone who can reach the port can create/destroy envs.
  const loopback = new Set(['127.0.0.1', '::1', 'localhost']);
  if (!loopback.has(config.bind) && !config.apiToken) {
    throw new Error(
      `refusing to bind ${config.bind} (network-exposed) without DEVBOX_API_TOKEN. ` +
        `Set a bearer token (e.g. DEVBOX_API_TOKEN=$(openssl rand -hex 32)) and put this host behind a firewall/VPN.`,
    );
  }

  // The set of secret strings the logger must redact.
  config.secrets = [config.cursorApiKey, config.githubToken].filter(Boolean);
  return Object.freeze(config);
}
