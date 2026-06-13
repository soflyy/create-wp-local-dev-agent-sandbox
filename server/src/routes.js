// Endpoint handlers — thin: validate input, call the manager/session engine,
// shape the response. `sessions` bundles { store, engine, bus }.

import { readFile } from 'node:fs/promises';
import { route } from './http.js';
import { hostInfo } from './docker.js';
import { AllocationError } from './allocator.js';
import { openSse } from './sse.js';
import { makeStaticHandler } from './static.js';

export function buildRoutes(config, registry, manager, sessions) {
  const staticHandler = makeStaticHandler(config.uiRoot);

  const envOr404 = (ctx) => {
    const rec = registry.get(ctx.params.id) || registry.getByName(ctx.params.id);
    if (!rec) throw httpErr(404, `environment "${ctx.params.id}" not found`);
    return rec;
  };
  const sessionOr404 = (ctx) => {
    const s = sessions.store.get(ctx.params.id);
    if (!s) throw httpErr(404, `session "${ctx.params.id}" not found`);
    return s;
  };
  const assertUsable = async (env) => {
    if (!(await manager.usable(env))) throw httpErr(409, `environment "${env.name}" is not running`);
  };
  const sshHint = (s) => {
    const env = registry.get(s.envId);
    if (!env || !s.claudeSessionId) return null;
    return `cd ${env.dir} && bash scripts/in-workspace.sh claude --resume ${s.claudeSessionId}`;
  };
  const publicSession = (s) => ({
    id: s.id,
    envId: s.envId,
    envName: s.envName,
    claudeSessionId: s.claudeSessionId,
    cwd: s.cwd,
    model: s.model,
    title: s.title,
    status: sessions.engine.isActive(s.id) ? 'running' : s.status,
    turnCount: s.turnCount,
    lastResult: s.lastResult,
    costUsd: s.costUsd,
    lastError: s.lastError,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    sshResumeHint: sshHint(s),
  });

  return [
    route('GET', '/health', async (ctx) => ctx.send(200, { ok: true, version: 1 })),

    route('GET', '/host', async (ctx) => {
      const info = await hostInfo();
      ctx.send(200, {
        ...info,
        environments: registry.list().length,
        sessions: sessions.store.list().length,
        maxEnvironments: config.maxEnvironments,
        loadavg: (await import('node:os')).loadavg(),
      });
    }),

    // ---- environments -----------------------------------------------------
    route('POST', '/environments', async (ctx) => {
      try {
        const record = await manager.createEnvironment({ name: ctx.body.name });
        ctx.send(202, { id: record.id, name: record.name, port: record.port, wpUrl: record.wpUrl, status: record.status });
      } catch (err) {
        if (err instanceof AllocationError) throw httpErr(err.status, err.message);
        throw err;
      }
    }),
    route('GET', '/environments', async (ctx) => ctx.send(200, { environments: await manager.list() })),
    route('GET', '/environments/:id', async (ctx) => ctx.send(200, await manager.describe(envOr404(ctx)))),
    route('GET', '/environments/:id/logs', async (ctx) => {
      const which = ctx.query.get('which') || 'all';
      const tail = Math.min(parseInt(ctx.query.get('tail') || '200', 10) || 200, 5000);
      ctx.send(200, await manager.logs(envOr404(ctx), which, tail));
    }),
    route('POST', '/environments/:id/stop', async (ctx) => ctx.send(200, await manager.stop(envOr404(ctx)))),
    route('POST', '/environments/:id/start', async (ctx) => ctx.send(200, await manager.start(envOr404(ctx)))),
    route('DELETE', '/environments/:id', async (ctx) => {
      const env = envOr404(ctx);
      sessions.engine.killEnvSessions(env.id);
      for (const s of sessions.store.listByEnv(env.id)) await sessions.store.update(s.id, { status: 'env-destroyed' });
      await manager.destroy(env);
      ctx.send(200, { deleted: true });
    }),

    // ---- claude sessions --------------------------------------------------
    route('POST', '/environments/:id/sessions', async (ctx) => {
      const env = envOr404(ctx);
      await assertUsable(env);
      const prompt = (ctx.body.prompt || '').trim();
      if (!prompt) throw httpErr(400, 'prompt is required');
      const record = await sessions.engine.newSession(env, { prompt, model: ctx.body.model });
      ctx.send(202, publicSession(record));
    }),

    route('POST', '/sessions/:id/messages', async (ctx) => {
      const s = sessionOr404(ctx);
      if (sessions.engine.isActive(s.id)) throw httpErr(409, 'a turn is already in progress for this session');
      const env = registry.get(s.envId);
      if (!env) throw httpErr(410, 'the environment for this session no longer exists');
      await assertUsable(env);
      const prompt = (ctx.body.prompt || '').trim();
      if (!prompt) throw httpErr(400, 'prompt is required');
      await sessions.engine.sendMessage(env, s, { prompt });
      ctx.send(202, publicSession(sessions.store.get(s.id)));
    }),

    route('GET', '/sessions', async (ctx) => {
      let list = sessions.store.list();
      const envId = ctx.query.get('envId');
      const status = ctx.query.get('status');
      if (envId) list = list.filter((s) => s.envId === envId);
      if (status) list = list.filter((s) => publicSession(s).status === status);
      ctx.send(200, { sessions: list.map(publicSession) });
    }),

    route('GET', '/sessions/:id', async (ctx) => ctx.send(200, publicSession(sessionOr404(ctx)))),

    route('GET', '/sessions/:id/transcript', async (ctx) => {
      const s = sessionOr404(ctx);
      const tail = Math.min(parseInt(ctx.query.get('tail') || '2000', 10) || 2000, 20000);
      let events = [];
      try {
        const text = await readFile(s.eventLogPath, 'utf8');
        events = text.split('\n').filter(Boolean).slice(-tail).map((l) => {
          try { return JSON.parse(l); } catch { return { type: 'raw', text: l }; }
        });
      } catch { /* no log yet */ }
      ctx.send(200, { events });
    }),

    route('GET', '/sessions/:id/stream', async (ctx) => {
      const s = sessionOr404(ctx);
      const sse = openSse(ctx.res);
      for (const e of sessions.bus.backlog(s.id)) sse.send(e);
      sse.send({ type: 'control', subtype: 'snapshot', session: publicSession(s) });
      const unsub = sessions.bus.subscribe(s.id, sse.send);
      ctx.req.on('close', () => { unsub(); sse.close(); });
    }, { kind: 'sse' }),

    route('POST', '/sessions/:id/interrupt', async (ctx) => {
      const s = sessionOr404(ctx);
      if (!sessions.engine.interrupt(s.id)) throw httpErr(409, 'no active turn to interrupt');
      ctx.send(200, publicSession(sessions.store.get(s.id)));
    }),

    route('DELETE', '/sessions/:id', async (ctx) => {
      const s = sessionOr404(ctx);
      sessions.engine.interrupt(s.id);
      sessions.bus.clear(s.id);
      await sessions.store.remove(s.id);
      ctx.send(200, { deleted: true });
    }),

    // ---- UI (static; shell unauthenticated, data APIs above are authed) ----
    route('GET', '/', staticHandler, { kind: 'static' }),
    route('GET', '/ui/:rest*', staticHandler, { kind: 'static' }),
  ];
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
