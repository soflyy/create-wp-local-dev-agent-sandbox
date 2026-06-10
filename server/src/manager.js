// Orchestrates the environment lifecycle: allocate → scaffold → setup → git auth
// → start worker → running, plus stop/start/destroy, status, logs, and a
// reconcile loop that supervises workers.

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { allocate } from './allocator.js';
import * as docker from './docker.js';
import * as workerMod from './worker.js';
import * as gitauth from './gitauth.js';
import * as fleet from './fleet.js';
import { computeStatus, coreUp, publicView } from './status.js';
import { log, redact } from './log.js';

// Counting semaphore to bound concurrent (heavy) docker builds.
class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async run(fn) {
    if (this.active >= this.max) await new Promise((r) => this.queue.push(r));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export class Manager {
  constructor(config, registry) {
    this.config = config;
    this.registry = registry;
    this.jobs = new Map(); // id -> transient state string
    this.buildSem = new Semaphore(config.buildConcurrency);
  }

  // ---- create -------------------------------------------------------------

  async createEnvironment({ name } = {}) {
    const record = await allocate(this.registry, this.config, { nameHint: name });
    this.jobs.set(record.id, 'scaffolding');
    // Fire-and-forget pipeline; status is observable via GET.
    this._pipeline(record).catch((err) => log.error(`[${record.name}] pipeline crashed:`, err));
    return record;
  }

  async _pipeline(record) {
    const { config, registry } = this;
    try {
      await mkdir(config.envsDir, { recursive: true });

      // 1. Scaffold (fast, files only).
      this.jobs.set(record.id, 'scaffolding');
      await this._spawnLogged(
        'node',
        [join(config.scaffolderDir, 'index.js'), record.dir, `--port=${record.port}`, '--scaffold-only'],
        { logPath: record.setupLogPath, truncate: true },
      );

      // 2. Build + boot + provision (heavy; bounded by the build semaphore).
      this.jobs.set(record.id, 'setting-up');
      await registry.update(record.id, { status: 'setting-up', setupStartedAt: new Date().toISOString() });
      await this.buildSem.run(() =>
        this._spawnLogged('npm', ['run', 'setup'], {
          cwd: record.dir,
          logPath: record.setupLogPath,
          // Pin the compose project so the env's own scripts and our commands agree.
          env: { COMPOSE_PROJECT_NAME: record.project },
          timeout: 30 * 60 * 1000,
        }),
      );
      await registry.update(record.id, { setupFinishedAt: new Date().toISOString() });

      // 3. Git auth (non-fatal).
      this.jobs.set(record.id, 'configuring');
      await registry.update(record.id, { status: 'configuring' });
      await gitauth.configure(record, config);

      // 4. Start the named worker.
      this.jobs.set(record.id, 'starting-worker');
      await registry.update(record.id, { status: 'starting-worker' });
      await workerMod.start(record, config);
      await registry.update(record.id, { status: 'running', workerStartedAt: new Date().toISOString(), lastError: null });
    } catch (err) {
      log.error(`[${record.name}] setup failed:`, err.message);
      await registry.update(record.id, { status: 'failed', lastError: truncate(redactErr(err)) });
    } finally {
      this.jobs.delete(record.id);
    }
  }

  // ---- status / describe --------------------------------------------------

  async _gather(record) {
    const ps = await docker.ps(record);
    const up = coreUp(ps);
    const worker = up ? await workerMod.health(record) : { running: false, healthy: false, state: 'down' };
    const jobState = this.jobs.get(record.id) || null;
    const status = computeStatus({ record, jobState, ps, worker });
    return { ps, worker, status };
  }

  async describe(record, { fleetLookup = true } = {}) {
    const { worker, status } = await this._gather(record);
    let fleetInfo;
    if (fleetLookup) fleetInfo = await fleet.lookup(record.name, this.config);
    return publicView(record, { status, worker, fleet: fleetInfo });
  }

  async list() {
    return Promise.all(this.registry.list().map((r) => this.describe(r, { fleetLookup: false })));
  }

  // ---- lifecycle ----------------------------------------------------------

  async stop(record) {
    await workerMod.stop(record);
    await docker.stop(record);
    await this.registry.update(record.id, { status: 'stopped' });
    return this.describe(record);
  }

  async start(record) {
    this.jobs.set(record.id, 'starting-worker');
    try {
      await docker.up(record, { build: false });
      await gitauth.configure(record, this.config);
      await workerMod.start(record, this.config);
      await this.registry.update(record.id, { status: 'running', workerStartedAt: new Date().toISOString(), lastError: null });
    } finally {
      this.jobs.delete(record.id);
    }
    return this.describe(record);
  }

  async destroy(record) {
    this.jobs.set(record.id, 'destroying');
    try {
      await docker.down(record, { volumes: true }).catch((e) => log.warn(`[${record.name}] down failed:`, e.message));
      await rm(record.dir, { recursive: true, force: true }).catch((e) =>
        log.warn(`[${record.name}] dir removal failed:`, e.message),
      );
      await this.registry.mutate((data) => {
        delete data.environments[record.id];
      });
    } finally {
      this.jobs.delete(record.id);
    }
  }

  async logs(record, which = 'all', tail = 200) {
    const out = {};
    if (which === 'setup' || which === 'all') out.setup = await tailFile(record.setupLogPath, tail);
    if (which === 'worker' || which === 'all') out.worker = await tailFile(join(record.dir, 'workspace', '.worker.log'), tail);
    return out;
  }

  // ---- reconcile loop (supervisor) ----------------------------------------

  async reconcile() {
    for (const record of this.registry.list()) {
      if (this.jobs.has(record.id)) continue; // pipeline owns it
      try {
        const ps = await docker.ps(record);
        if (!coreUp(ps)) {
          // Containers down: a record left mid-pipeline by a crash is failed;
          // an explicitly stopped one stays stopped.
          if (['running', 'degraded', 'starting-worker', 'setting-up', 'configuring', 'scaffolding'].includes(record.status)) {
            if (record.status !== 'stopped') {
              const patch = record.status === 'running' || record.status === 'degraded'
                ? { status: 'stopped' }
                : { status: 'failed', lastError: record.lastError || 'interrupted (server restart or crash)' };
              await this.registry.update(record.id, patch);
            }
          }
          continue;
        }
        // Containers up but worker dead → relaunch (this is the supervision).
        const alive = await workerMod.isRunning(record);
        if (!alive && record.status !== 'stopped') {
          log.info(`[${record.name}] worker not running but stack is up — relaunching`);
          await gitauth.configure(record, this.config);
          await workerMod.start(record, this.config);
          await this.registry.update(record.id, { status: 'running', workerStartedAt: new Date().toISOString() });
        } else if (alive && record.status !== 'running') {
          await this.registry.update(record.id, { status: 'running' });
        }
      } catch (err) {
        log.warn(`[${record.name}] reconcile error:`, err.message);
      }
    }
  }

  startReconcileLoop() {
    const tick = () => this.reconcile().catch((e) => log.warn('reconcile loop error:', e.message));
    tick(); // run once at boot
    this.reconcileTimer = setInterval(tick, this.config.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

  // ---- helpers ------------------------------------------------------------

  _spawnLogged(cmd, args, { cwd, env, logPath, truncate = false, timeout } = {}) {
    return new Promise((resolve, reject) => {
      mkdirSync(dirname(logPath), { recursive: true });
      const stream = createWriteStream(logPath, { flags: truncate ? 'w' : 'a' });
      stream.on('error', (err) => reject(err)); // never let a log FS error crash the server
      stream.write(`\n=== ${new Date().toISOString()} $ ${cmd} ${args.join(' ')} ===\n`);
      const child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
      });
      let timer;
      if (timeout) timer = setTimeout(() => child.kill('SIGKILL'), timeout);
      child.stdout.pipe(stream, { end: false });
      child.stderr.pipe(stream, { end: false });
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        stream.end();
        reject(err);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        stream.end();
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with code ${code} (see ${logPath})`));
      });
    });
  }
}

function truncate(s, n = 600) {
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
}
function redactErr(err) {
  return redact(err && err.message ? err.message : String(err));
}
async function tailFile(path, n) {
  try {
    const text = await readFile(path, 'utf8');
    return text.split('\n').slice(-n).join('\n');
  } catch {
    return null;
  }
}
