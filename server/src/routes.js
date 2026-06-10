// Endpoint handlers — thin: validate input, call the manager, shape the response.

import { route } from './http.js';
import { hostInfo } from './docker.js';
import { AllocationError } from './allocator.js';

export function buildRoutes(config, registry, manager) {
  const findOr404 = (ctx) => {
    const rec = registry.get(ctx.params.id) || registry.getByName(ctx.params.id);
    if (!rec) {
      const e = new Error(`environment "${ctx.params.id}" not found`);
      e.status = 404;
      throw e;
    }
    return rec;
  };

  return [
    route('GET', '/health', async (ctx) => ctx.send(200, { ok: true, version: 1 })),

    route('GET', '/host', async (ctx) => {
      const info = await hostInfo();
      ctx.send(200, {
        ...info,
        environments: registry.list().length,
        maxEnvironments: config.maxEnvironments,
        loadavg: (await import('node:os')).loadavg(),
      });
    }),

    route('POST', '/environments', async (ctx) => {
      try {
        const record = await manager.createEnvironment({ name: ctx.body.name });
        ctx.send(202, {
          id: record.id,
          name: record.name,
          port: record.port,
          wpUrl: record.wpUrl,
          status: record.status,
        });
      } catch (err) {
        if (err instanceof AllocationError) {
          const e = new Error(err.message);
          e.status = err.status;
          throw e;
        }
        throw err;
      }
    }),

    route('GET', '/environments', async (ctx) => {
      ctx.send(200, { environments: await manager.list() });
    }),

    route('GET', '/environments/:id', async (ctx) => {
      ctx.send(200, await manager.describe(findOr404(ctx)));
    }),

    route('GET', '/environments/:id/logs', async (ctx) => {
      const which = ctx.query.get('which') || 'all';
      const tail = Math.min(parseInt(ctx.query.get('tail') || '200', 10) || 200, 5000);
      ctx.send(200, await manager.logs(findOr404(ctx), which, tail));
    }),

    route('POST', '/environments/:id/stop', async (ctx) => {
      ctx.send(200, await manager.stop(findOr404(ctx)));
    }),

    route('POST', '/environments/:id/start', async (ctx) => {
      ctx.send(200, await manager.start(findOr404(ctx)));
    }),

    route('DELETE', '/environments/:id', async (ctx) => {
      await manager.destroy(findOr404(ctx));
      ctx.send(200, { deleted: true });
    }),
  ];
}
