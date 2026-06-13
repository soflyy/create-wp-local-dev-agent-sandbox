// Best-effort enrichment from Cursor's fleet API. NEVER load-bearing: failures
// (or a plan that doesn't expose non-pool named workers) just yield null and the
// local registry + docker + worker health remain the source of truth.

import { log } from './log.js';

let cache = { at: 0, byName: null };
const TTL_MS = 10_000;

async function fetchWorkers(config) {
  const now = Date.now();
  if (cache.byName && now - cache.at < TTL_MS) return cache.byName;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    // Service-account key via HTTP Basic (key as username, empty password).
    const auth = Buffer.from(`${config.cursorApiKey}:`).toString('base64');
    const res = await fetch(config.fleetApiUrl, {
      headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`fleet API ${res.status}`);
    const body = await res.json();
    const workers = Array.isArray(body) ? body : body.workers || body.privateWorkers || [];
    const byName = new Map();
    for (const w of workers) {
      const name = w.name || w.displayName || w.workerName;
      if (name) byName.set(name, w);
    }
    cache = { at: now, byName };
    return byName;
  } finally {
    clearTimeout(timer);
  }
}

// Returns the fleet record for a worker name, or null on any failure.
export async function lookup(name, config) {
  try {
    const byName = await fetchWorkers(config);
    const w = byName.get(name);
    if (!w) return null;
    return { id: w.id || w.workerId || null, status: w.status || null, lastSeen: w.lastSeenAt || w.lastSeen || null };
  } catch (err) {
    log.warn('fleet API lookup failed (best-effort):', err.message);
    return null;
  }
}
