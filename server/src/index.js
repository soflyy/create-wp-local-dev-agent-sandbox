#!/usr/bin/env node
// Devbox control server entrypoint: load .env, load config, init the registry,
// wire routes, start the HTTP server and the reconcile/supervision loop.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { loadConfig } from './config.js';
import { initLog, log } from './log.js';
import { Registry } from './registry.js';
import { Manager } from './manager.js';
import { SessionStore } from './sessions.js';
import { SessionBus } from './sessionbus.js';
import { ClaudeEngine } from './claude.js';
import { buildRoutes } from './routes.js';
import { createServer } from './http.js';

// Load server/.env (or $DEVBOX_ENV_FILE) into process.env if present, using
// Node's built-in loader (no dependency). Real environment variables already
// set take precedence, so systemd/export-based setups keep working.
function loadDotenv() {
  const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const envFile = process.env.DEVBOX_ENV_FILE || join(serverRoot, '.env');
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
    return envFile;
  }
  return null;
}

async function main() {
  const envFile = loadDotenv();
  const config = loadConfig();
  initLog(config.secrets);
  if (envFile) log.info(`loaded env from ${envFile}`);

  const registry = await new Registry(config.registryPath).load();
  const manager = new Manager(config, registry);

  // Claude session subsystem.
  const sessionStore = await new SessionStore(config.sessionsPath).load();
  await sessionStore.reconcile(); // running → interrupted (resumable; jsonl persists)
  const sessionBus = new SessionBus(config.sessionRingBufferSize);
  const claudeEngine = new ClaudeEngine(config, sessionStore, sessionBus);
  const sessions = { store: sessionStore, engine: claudeEngine, bus: sessionBus };

  const routes = buildRoutes(config, registry, manager, sessions);
  const server = createServer(config, routes);

  server.listen(config.port, config.bind, () => {
    log.info(`devbox-server listening on http://${config.bind}:${config.port}`);
    log.info(
      `envs dir: ${config.envsDir} | port range: ${config.portRange.lo}-${config.portRange.hi} | ` +
        `max: ${config.maxEnvironments} | auth: ${config.apiToken ? 'bearer' : 'none'} | ` +
        `worker autostart: ${config.cursorWorkerAutostart ? 'on' : 'off'} | UI: http://${config.bind}:${config.port}/`,
    );
    manager.startReconcileLoop();
  });

  const shutdown = () => {
    log.info('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // A long-running control plane must never die on a stray async error.
  process.on('unhandledRejection', (err) => log.error('unhandledRejection:', err));
  process.on('uncaughtException', (err) => log.error('uncaughtException:', err));
}

main().catch((err) => {
  // Pre-log-init failures (e.g. missing config) print plainly.
  console.error(`devbox-server failed to start: ${err.message}`);
  process.exit(1);
});
