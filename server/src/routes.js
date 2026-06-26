// Endpoint handlers — thin: validate input, call the manager/session engine,
// shape the response. `sessions` bundles { store, engine, bus }.

import { readFile, rm } from 'node:fs/promises';
import { route } from './http.js';
import { addSecrets } from './log.js';
import { exec } from './docker.js';
import { systemHealth } from './health.js';
import { AllocationError } from './allocator.js';
import { openSse } from './sse.js';
import { makeStaticHandler } from './static.js';

export function buildRoutes(config, registry, manager, sessions, presets, settings) {
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
  // Fully remove a session: stop any active turn, drop its event stream + log
  // file, and delete the record. Used by DELETE /sessions/:id and env destroy.
  const deleteSession = async (s) => {
    sessions.engine.interrupt(s.id);
    sessions.bus.clear(s.id);
    await sessions.store.remove(s.id);
    if (s.eventLogPath) await rm(s.eventLogPath, { force: true }).catch(() => {});
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
      const h = await systemHealth(config, registry);
      ctx.send(200, { ...h, sessions: sessions.store.list().length });
    }),

    // ---- control panel (stop / shut down) ---------------------------------
    // Interrupt every running Claude turn (local client + the in-container
    // process, which otherwise survives). Leaves environments running.
    route('POST', '/control/interrupt-all', async (ctx) => {
      ctx.send(200, { interrupted: sessions.engine.interruptAll() });
    }),
    // Stop all environment containers (also interrupts their turns; stopping the
    // container kills anything inside it).
    route('POST', '/control/stop-all', async (ctx) => {
      sessions.engine.interruptAll();
      ctx.send(200, { stopped: await manager.stopAll() });
    }),
    // Full teardown: interrupt turns, stop every env's containers, then exit the
    // server process. The "shut down everything" button.
    route('POST', '/control/shutdown', async (ctx) => {
      sessions.engine.interruptAll();
      ctx.send(202, { shuttingDown: true });
      setTimeout(async () => {
        try { await manager.stopAll(); } catch { /* exiting anyway */ }
        process.exit(0);
      }, 150);
    }),

    // ---- environments -----------------------------------------------------
    route('POST', '/environments', async (ctx) => {
      try {
        // Compose any selected presets (in order) with optional custom fields.
        const presetIds = Array.isArray(ctx.body.presetIds) ? ctx.body.presetIds : [];
        const selected = presetIds.map((pid) => {
          const p = presets.get(pid);
          if (!p) throw httpErr(400, `unknown preset "${pid}"`);
          return p;
        });
        const custom = normalizeProvision(ctx.body.provision);
        const provision = composeProvision(selected, custom);
        const prompt = typeof ctx.body.prompt === 'string' ? ctx.body.prompt.trim() : '';
        const model = typeof ctx.body.model === 'string' && ctx.body.model.trim() ? ctx.body.model.trim() : undefined;
        const record = await manager.createEnvironment({ name: ctx.body.name, provision, prompt: prompt || undefined, model });
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
    // One-click passwordless wp-admin login: mint a one-time, 5-min link via the
    // agent-connector ability already installed in every env. Returns a localhost
    // URL with the token; the UI rebases the host:port (redemption uses the
    // browser's request host, so the token is host-agnostic).
    route('POST', '/environments/:id/admin-login', async (ctx) => {
      const env = envOr404(ctx);
      await assertUsable(env);
      let res;
      try {
        res = await exec(env, 'workspace', ['wp', 'eval', ADMIN_LOGIN_PHP], { timeout: 30_000 });
      } catch (err) {
        throw httpErr(502, `could not mint admin login link: ${String(err.stderr || err.message || '').trim().slice(0, 200)}`);
      }
      const url = String(res.stdout || '').trim();
      if (!/^https?:\/\/\S*acfw_login=/.test(url)) {
        throw httpErr(502, `admin login link unavailable: ${String(res.stderr || url || '').trim().slice(0, 200)}`);
      }
      ctx.send(200, { loginUrl: url });
    }),
    route('POST', '/environments/:id/stop', async (ctx) => ctx.send(200, await manager.stop(envOr404(ctx)))),
    route('POST', '/environments/:id/start', async (ctx) => ctx.send(200, await manager.start(envOr404(ctx)))),
    route('DELETE', '/environments/:id', async (ctx) => {
      const env = envOr404(ctx);
      // Sessions are tied to their environment: destroying it deletes them all.
      sessions.engine.killEnvSessions(env.id);
      for (const s of sessions.store.listByEnv(env.id)) await deleteSession(s);
      await manager.destroy(env);
      ctx.send(200, { deleted: true });
    }),

    // ---- settings (tokens + WP-admin defaults; secrets masked in responses) --
    route('GET', '/settings', async (ctx) => ctx.send(200, settings.publicView())),
    route('PUT', '/settings', async (ctx) => {
      const view = await settings.update(ctx.body || {});
      addSecrets(settings.secrets()); // keep the log redactor current
      ctx.send(200, view);
    }),

    // ---- provisioning presets (saved blueprints, stored in the data dir) ---
    route('GET', '/presets', async (ctx) => ctx.send(200, { presets: presets.list() })),
    route('POST', '/presets', async (ctx) => {
      const rec = await presets.create(validatePreset(ctx.body));
      ctx.send(201, rec);
    }),
    route('PUT', '/presets/:id', async (ctx) => {
      const rec = await presets.update(ctx.params.id, validatePreset(ctx.body));
      if (!rec) throw httpErr(404, `preset "${ctx.params.id}" not found`);
      ctx.send(200, rec);
    }),
    route('DELETE', '/presets/:id', async (ctx) => {
      if (!(await presets.remove(ctx.params.id))) throw httpErr(404, `preset "${ctx.params.id}" not found`);
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

    route('PATCH', '/sessions/:id', async (ctx) => {
      const s = sessionOr404(ctx);
      const title = String(ctx.body.title || '').replace(/\s+/g, ' ').trim();
      if (!title) throw httpErr(400, 'title is required');
      const updated = await sessions.store.update(s.id, { title: title.slice(0, 200) });
      ctx.send(200, publicSession(updated));
    }),

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
      await deleteSession(sessionOr404(ctx));
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

// Run inside the workspace via `wp eval`: mint a one-time admin login URL for the
// site's first administrator through the agent-connector ability's service. The
// FQCN is the same whether the companion ships as default- or universal-abilities.
const ADMIN_LOGIN_PHP = `
$admins = get_users(array('role' => 'administrator', 'number' => 1, 'orderby' => 'ID'));
$u = $admins ? $admins[0] : null;
if (!$u) { fwrite(STDERR, 'no administrator user'); exit(1); }
$cls = 'AgentConnectorForWp\\DefaultAbilities\\Services\\AdminLoginLink';
if (!class_exists($cls)) { fwrite(STDERR, 'abilities plugin (admin login) not active'); exit(1); }
$r = $cls::create($u->ID, 'index.php', 300);
if (is_wp_error($r)) { fwrite(STDERR, $r->get_error_message()); exit(1); }
echo $r['login_url'];
`;

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i; // plugin slug
const CONST_RE = /^[A-Za-z_][A-Za-z0-9_]*$/; // PHP constant name

// Validate the activate list + defines map shared by provision and presets.
// Throws 400 on a bad slug / constant name / defines shape.
function validateProvisionFields(body = {}) {
  const setupScript = typeof body.setupScript === 'string' ? body.setupScript : '';
  const devScript = typeof body.devScript === 'string' ? body.devScript : '';

  let activate = [];
  if (body.activate != null) {
    if (!Array.isArray(body.activate)) throw httpErr(400, 'activate must be an array of plugin slugs');
    activate = body.activate.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
    for (const s of activate) if (!SLUG_RE.test(s)) throw httpErr(400, `invalid plugin slug "${s}"`);
  }

  let defines = {};
  if (body.defines != null) {
    if (typeof body.defines !== 'object' || Array.isArray(body.defines)) {
      throw httpErr(400, 'defines must be a JSON object of { "WP_CONST": value } pairs');
    }
    defines = body.defines;
    for (const k of Object.keys(defines)) if (!CONST_RE.test(k)) throw httpErr(400, `invalid define name "${k}"`);
  }

  return { setupScript, devScript, activate, defines };
}

// A preset additionally carries name/description.
function validatePreset(body = {}) {
  const name = String((body && body.name) || '').trim();
  if (!name) throw httpErr(400, 'preset name is required');
  return { name, description: typeof body.description === 'string' ? body.description : '', ...validateProvisionFields(body) };
}

// Custom (ad-hoc) provision fields for a create. Returns null when nothing was
// specified (a blank WordPress env, or presets-only).
function normalizeProvision(body) {
  if (!body || typeof body !== 'object') return null;
  const { setupScript, devScript, activate, defines } = validateProvisionFields(body);
  if (!setupScript && !devScript && !activate.length && !Object.keys(defines).length) return null;
  return { setupScript, devScript, activate, defines };
}

// Compose selected presets (in order) + optional custom fields into one provision:
// setup scripts run sequentially, dev scripts run concurrently in the single dev
// container, defines merge (later wins), activate lists concatenate (deduped).
// Returns null when there's nothing to provision. Exported for testing.
export function composeProvision(presets, custom) {
  const parts = presets.map((p) => ({
    label: p.name, setupScript: p.setupScript, devScript: p.devScript, defines: p.defines, activate: p.activate,
  }));
  if (custom) parts.push({ label: 'Custom', ...custom });
  if (!parts.length) return null;

  const setupChunks = parts
    .filter((p) => p.setupScript && p.setupScript.trim())
    .map((p) => `# ===== ${p.label} =====\n${p.setupScript.trim()}\n`);
  const setupScript = setupChunks.length
    ? `#!/usr/bin/env bash\nset -euo pipefail\n\n${setupChunks.join('\n')}`
    : '';

  const devs = parts.filter((p) => p.devScript && p.devScript.trim());
  let devScript = '';
  if (devs.length === 1) devScript = devs[0].devScript;
  else if (devs.length > 1) {
    devScript = '#!/usr/bin/env bash\n# composed dev scripts — run concurrently in one dev container\n'
      + devs.map((d) => `# --- ${d.label} ---\n(\n${d.devScript.trim()}\n) &`).join('\n')
      + '\nwait\n';
  }

  const defines = Object.assign({}, ...parts.map((p) => p.defines || {}));
  const activate = [];
  for (const p of parts) for (const s of p.activate || []) if (!activate.includes(s)) activate.push(s);

  if (!setupScript && !devScript && !activate.length && !Object.keys(defines).length) return null;
  return { setupScript, devScript, defines, activate, presetName: presets.map((p) => p.name).join(' + ') || null };
}
