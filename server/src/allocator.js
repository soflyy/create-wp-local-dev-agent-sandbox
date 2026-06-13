// Allocates a unique {id, name, project, port, dir} for a new environment and
// writes the reservation into the registry — all inside the registry mutex, so
// concurrent POST /environments can't collide on names, ports, or projects.

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { listProjects } from './docker.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
const ADJECTIVES = ['brisk', 'calm', 'keen', 'bold', 'wise', 'swift', 'lucky', 'sunny', 'quiet', 'vivid'];
const NOUNS = ['otter', 'falcon', 'maple', 'cedar', 'comet', 'pixel', 'harbor', 'meadow', 'river', 'ember'];

export function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function randomName() {
  const a = ADJECTIVES[randomBytes(1)[0] % ADJECTIVES.length];
  const n = NOUNS[randomBytes(1)[0] % NOUNS.length];
  const suffix = randomBytes(2).toString('hex');
  return `${a}-${n}-${suffix}`;
}

// True if the port is free to bind on the loopback interface right now.
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

export class AllocationError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

// Returns the reservation record (already persisted into the registry with
// status "scaffolding").
export async function allocate(registry, config, { nameHint } = {}) {
  return registry.mutate(async (data) => {
    const envs = Object.values(data.environments);
    if (envs.length >= config.maxEnvironments) {
      throw new AllocationError(
        `at capacity: ${envs.length}/${config.maxEnvironments} environments (raise MAX_ENVIRONMENTS)`,
        503,
      );
    }

    const usedNames = new Set(envs.map((e) => e.name));
    const existingProjects = new Set(await listProjects());

    // Resolve a unique name.
    let name = nameHint;
    if (name !== undefined && name !== null && name !== '') {
      if (!isValidName(name)) {
        throw new AllocationError(
          `invalid name "${name}" — must match ${NAME_RE} (lowercase letters, digits, hyphens; 2-39 chars)`,
          400,
        );
      }
      if (usedNames.has(name) || existingProjects.has(name)) {
        throw new AllocationError(`name "${name}" is already in use`, 409);
      }
    } else {
      do {
        name = randomName();
      } while (usedNames.has(name) || existingProjects.has(name));
    }

    // Resolve a unique, currently-free port in the configured range.
    const usedPorts = new Set(envs.map((e) => e.port));
    let port = null;
    for (let p = config.portRange.lo; p <= config.portRange.hi; p += 1) {
      if (usedPorts.has(p)) continue;
      if (await isPortFree(p)) {
        port = p;
        break;
      }
    }
    if (port === null) {
      throw new AllocationError(`no free port in range ${config.portRange.lo}-${config.portRange.hi}`, 503);
    }

    const id = `env_${randomBytes(5).toString('hex')}`;
    const dir = join(config.envsDir, name);
    const record = {
      id,
      name,
      // Compose project name = the dir basename (the default), so the server's
      // `docker compose` calls, the project's own `npm run …` scripts, and
      // `scripts/in-workspace.sh` all target the same project.
      project: name,
      dir,
      port,
      wpUrl: `http://localhost:${port}`,
      status: 'scaffolding',
      createdAt: new Date().toISOString(),
      setupStartedAt: null,
      setupFinishedAt: null,
      workerStartedAt: null,
      lastError: null,
      // Setup log lives OUTSIDE the env dir (the scaffolder requires an empty
      // target dir). Worker log is written inside the container at this path,
      // visible on the host at <dir>/workspace/.worker.log.
      setupLogPath: join(config.dataDir, 'logs', `${name}.log`),
      workerLogPath: '/home/node/.worker.log',
    };
    data.environments[id] = record;
    return record;
  });
}
