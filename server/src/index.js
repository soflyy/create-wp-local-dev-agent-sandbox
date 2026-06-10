#!/usr/bin/env node
// Devbox control server entrypoint: load config, init the registry, wire routes,
// start the HTTP server and the reconcile/supervision loop.

import { loadConfig } from './config.js';
import { initLog, log } from './log.js';
import { Registry } from './registry.js';
import { Manager } from './manager.js';
import { buildRoutes } from './routes.js';
import { createServer } from './http.js';

async function main() {
  const config = loadConfig();
  initLog(config.secrets);

  const registry = await new Registry(config.registryPath).load();
  const manager = new Manager(config, registry);
  const routes = buildRoutes(config, registry, manager);
  const server = createServer(config, routes);

  server.listen(config.port, config.bind, () => {
    log.info(`devbox-server listening on http://${config.bind}:${config.port}`);
    log.info(
      `envs dir: ${config.envsDir} | port range: ${config.portRange.lo}-${config.portRange.hi} | ` +
        `max: ${config.maxEnvironments} | auth: ${config.apiToken ? 'bearer' : 'none'}`,
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
