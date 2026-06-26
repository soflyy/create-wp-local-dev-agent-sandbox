// Orchestrates the environment lifecycle: allocate → scaffold → setup → git auth
// → start worker → running, plus stop/start/destroy, status, logs, and a
// reconcile loop that supervises workers.

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { allocate } from './allocator.js';
import * as docker from './docker.js';
import * as workerMod from './worker.js';
import * as gitauth from './gitauth.js';
import * as agentConnector from './agent-connector.js';
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

  async createEnvironment({ name, provision } = {}) {
    const record = await allocate(this.registry, this.config, { nameHint: name });
    this.jobs.set(record.id, 'scaffolding');
    // Materialize the provisioning inputs to files the scaffolder can read, and
    // record the preset name (if any) for display. Done before the (async)
    // pipeline so a write error surfaces synchronously to the caller.
    let provisionPlan = null;
    if (provision) {
      provisionPlan = await this._materializeProvision(record, provision);
      if (provision.presetName) await this.registry.update(record.id, { preset: provision.presetName });
    }
    // Fire-and-forget pipeline; status is observable via GET.
    this._pipeline(record, provisionPlan).catch((err) => log.error(`[${record.name}] pipeline crashed:`, err));
    return record;
  }

  // Write the setup script + defines to the env's scratch dir and assemble the
  // scaffolder flags. Returns { args, scratchDir } or null when there's nothing
  // to provision. The scaffolder copies these into the project, so they're
  // throwaway (cleaned up after the scaffold step).
  async _materializeProvision(record, { setupScript, devScript, defines, activate }) {
    const scratchDir = join(this.config.scratchDir, record.name);
    const args = [];
    const hasDefines = defines && Object.keys(defines).length > 0;
    if (setupScript || devScript || hasDefines) await mkdir(scratchDir, { recursive: true });
    if (setupScript) {
      const p = join(scratchDir, 'user-setup.sh');
      await writeFile(p, setupScript);
      args.push(`--setup-script=${p}`);
    }
    if (devScript) {
      const p = join(scratchDir, 'dev.sh');
      await writeFile(p, devScript);
      args.push(`--dev-script=${p}`);
    }
    if (hasDefines) {
      const p = join(scratchDir, 'defines.json');
      await writeFile(p, JSON.stringify(defines, null, 2));
      args.push(`--defines=${p}`);
    }
    if (activate && activate.length) args.push(`--activate=${activate.join(',')}`);
    if (!args.length) return null;
    return { args, scratchDir };
  }

  async _pipeline(record, provisionPlan = null) {
    const { config, registry } = this;
    try {
      await mkdir(config.envsDir, { recursive: true });

      // 1. Create the environment the NORMAL way: the standard scaffolder
      //    scaffolds the project AND runs `npm run setup` (build + boot +
      //    provision) in one shot. Default compose project = dir basename =
      //    record.name, so the project's own scripts + in-workspace.sh agree.
      //    Bounded by the build semaphore; output captured to the setup log.
      this.jobs.set(record.id, 'setting-up');
      await registry.update(record.id, { status: 'setting-up', setupStartedAt: new Date().toISOString() });
      const scaffoldArgs = [
        join(config.scaffolderDir, 'index.js'),
        record.dir,
        `--port=${record.port}`,
        ...(provisionPlan ? provisionPlan.args : []),
      ];
      await this.buildSem.run(() =>
        this._spawnLogged('node', scaffoldArgs, {
          logPath: record.setupLogPath,
          truncate: true,
          timeout: 30 * 60 * 1000,
        }),
      );
      // The scaffolder has copied the provisioning inputs into the project
      // (scripts/user-setup.sh + sandbox.config.json); the scratch copies are
      // no longer needed. Re-runs (npm run setup/reset, "retry") use the
      // project's own copies, so this doesn't break recovery.
      if (provisionPlan) await rm(provisionPlan.scratchDir, { recursive: true, force: true }).catch(() => {});
      await registry.update(record.id, { setupFinishedAt: new Date().toISOString() });

      // 2. Git auth (non-fatal), then swap the target plugin to a live git
      //    checkout (fatal — that's the env's purpose).
      this.jobs.set(record.id, 'configuring');
      await registry.update(record.id, { status: 'configuring' });
      await gitauth.configure(record, config);
      await agentConnector.setup(record, config);

      // 3. Optionally start the named Cursor worker.
      if (config.cursorWorkerAutostart) {
        this.jobs.set(record.id, 'starting-worker');
        await registry.update(record.id, { status: 'starting-worker' });
        await workerMod.start(record, config);
      }
      await registry.update(record.id, {
        status: 'running',
        workerStartedAt: config.cursorWorkerAutostart ? new Date().toISOString() : null,
        lastError: null,
      });
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
    // worker === null means "no worker expected" (autostart off) → status ignores it.
    const worker = up && this.config.cursorWorkerAutostart
      ? await workerMod.health(record, this.config)
      : null;
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

  // Is the env's core stack up (so we can exec claude/agents in it)? Cheap.
  async usable(record) {
    return coreUp(await docker.ps(record));
  }

  // ---- lifecycle ----------------------------------------------------------

  // Lifecycle through the env's own npm scripts (default compose project).

  async stop(record) {
    await docker.npmRun(record, 'stop', { timeout: 120_000 });
    await this.registry.update(record.id, { status: 'stopped' });
    return this.describe(record);
  }

  async start(record) {
    this.jobs.set(record.id, 'starting-worker');
    try {
      await docker.npmRun(record, 'start', { timeout: 600_000 }); // up -d --build (cached)
      await gitauth.configure(record, this.config);
      if (this.config.cursorWorkerAutostart) await workerMod.start(record, this.config);
      await this.registry.update(record.id, {
        status: 'running',
        workerStartedAt: this.config.cursorWorkerAutostart ? new Date().toISOString() : null,
        lastError: null,
      });
    } finally {
      this.jobs.delete(record.id);
    }
    return this.describe(record);
  }

  async destroy(record) {
    this.jobs.set(record.id, 'destroying');
    try {
      // `npm run down` (compose down). Data is in bind mounts (no named volumes),
      // so removing the dir clears it.
      await docker.npmRun(record, 'down', { timeout: 180_000 }).catch((e) => log.warn(`[${record.name}] down failed:`, e.message));
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
        // Containers up. If no worker is expected, just keep status running.
        if (!this.config.cursorWorkerAutostart) {
          if (record.status !== 'running' && record.status !== 'stopped') {
            await this.registry.update(record.id, { status: 'running' });
          }
          continue;
        }
        // Worker expected but dead → relaunch (this is the supervision).
        const alive = await workerMod.isRunning(record, this.config);
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
