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
  // Credentials (GitHub + Claude tokens, WP admin defaults) are managed on the
  // Settings page now and stored in data/settings.json — env vars only SEED that
  // file on first run, so none are required to boot. (DEVBOX_API_TOKEN is the
  // exception — it gates this very API, so it must be set before start.)
  const dataDir = abs(env.DEVBOX_DATA_DIR, join(SERVER_ROOT, 'data'));

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
    presetsPath: join(dataDir, 'presets.json'),
    settingsPath: join(dataDir, 'settings.json'),
    // Server-scoped XDG_CONFIG_HOME handed to the scaffolder so the WP-admin
    // defaults from Settings seed new sites WITHOUT touching the operator's real
    // ~/.config/create-wp-local-dev-agent-sandbox/config.json.
    scaffolderConfigHome: join(dataDir, 'xdg'),
    // Scratch space where the server materializes a create's setup-script /
    // defines files to hand the scaffolder as --setup-script / --defines paths.
    // The scaffolder copies their contents into the project (scripts/user-setup.sh
    // + sandbox.config.json), so these are throwaway and cleaned up after scaffold.
    scratchDir: join(dataDir, 'scratch'),

    // Allocation / limits
    portRange: parseRange(env.WP_PORT_RANGE, '9000-9999'),
    maxEnvironments: parseInt(env.MAX_ENVIRONMENTS || '25', 10),
    buildConcurrency: Math.max(1, parseInt(env.BUILD_CONCURRENCY || '2', 10)),
    reconcileIntervalMs: parseInt(env.RECONCILE_INTERVAL_MS || '45000', 10),

    // Cursor key stays env-sourced (optional; the worker reads it). GitHub +
    // Claude tokens are managed in Settings — these env values only seed the
    // settings file on first run.
    cursorApiKey: env.CURSOR_API_KEY || null,
    seedGithubToken: env.GITHUB_TOKEN || '',
    seedClaudeToken: env.CLAUDE_CODE_OAUTH_TOKEN || '',
    gitAuthorName: env.GIT_AUTHOR_NAME || 'devbox',
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL || 'devbox@localhost',

    // Worker launch tuning. The worker operates from the home dir by default
    // (provisioning — incl. checking out a plugin repo — is done by presets now;
    // set WORKER_DIR to point the worker at a specific checkout if desired).
    workerDir: env.WORKER_DIR || '/home/node',
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
    // Default model for sessions. Defaults to the latest Opus (the `opus` alias
    // → opus 4.8) rather than Claude Code's built-in headless default (Sonnet),
    // since these are throwaway dev boxes where capability matters. Override with
    // any model id via CLAUDE_DEFAULT_MODEL, or per-session in the UI/API.
    claudeDefaultModel: env.CLAUDE_DEFAULT_MODEL || 'opus',
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

  // Initial secret strings for the log redactor (env-seeded). Tokens managed in
  // Settings are added to the redactor after the settings store loads.
  config.secrets = [config.cursorApiKey, config.seedGithubToken, config.seedClaudeToken].filter(Boolean);
  return Object.freeze(config);
}
