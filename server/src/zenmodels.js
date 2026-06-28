// OpenCode Zen model list, fetched live from the gateway so the model dropdown
// always reflects what a Zen key can actually use — no hardcoded slugs to drift.
// Cached in memory with a TTL; warmed on startup and refreshed lazily when stale.
// Fails soft: on any error the cache is left as-is (empty at boot → the UI offers
// only "Default" + "Custom…"). The list is public per-key, so no auth is sent.
import { log } from './log.js';

const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
const TTL_MS = 60 * 60 * 1000; // refresh at most hourly
const TIMEOUT_MS = 10_000;

let cache = []; // slugs like 'opencode/claude-sonnet-4-6'
let fetchedAt = 0;
let inflight = null;

// Fetch + replace the cache. Concurrent calls share one request (inflight dedupe).
// Never throws — logs and leaves the prior cache intact on failure.
export function refreshZenModels() {
  if (inflight) return inflight;
  inflight = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(ZEN_MODELS_URL, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const ids = Array.isArray(body?.data) ? body.data.map((m) => m && m.id).filter((s) => typeof s === 'string' && s) : [];
      if (!ids.length) throw new Error('no models in response');
      cache = ids.map((id) => `opencode/${id}`);
      fetchedAt = Date.now();
      log.info(`fetched ${cache.length} OpenCode Zen models`);
    } catch (err) {
      log.warn(`OpenCode Zen model fetch failed (dropdown offers only Default + Custom): ${err.message}`);
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
}

// The cached list (possibly empty). Synchronous — never blocks.
export function zenModelsList() {
  return cache;
}

// Return the list, fetching first if the cache is empty or stale. Bounded by the
// fetch timeout; returns whatever the cache holds (empty on persistent failure).
export async function ensureZenModels() {
  if (cache.length && Date.now() - fetchedAt <= TTL_MS) return cache;
  await refreshZenModels();
  return cache;
}
