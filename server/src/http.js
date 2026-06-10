// Bare node:http server with a tiny regex router, JSON body parsing (size
// limited), uniform error envelope, and optional bearer auth. No framework —
// this component controls Docker, so we keep its dependency surface at zero.

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { log } from './log.js';

const MAX_BODY = 1 << 20; // 1 MiB

export function createServer(config, routes) {
  const server = http.createServer(async (req, res) => {
    try {
      if (config.apiToken && !authorized(req, config.apiToken)) {
        return send(res, 401, { error: 'unauthorized' });
      }
      const url = new URL(req.url, 'http://localhost');
      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) return send(res, 404, { error: 'not found' });

      const params = url.pathname.match(match.re).groups || {};
      const body = await readJson(req);
      const ctx = { params, query: url.searchParams, body, send: (code, data) => send(res, code, data) };
      await match.handler(ctx);
    } catch (err) {
      if (err.status) return send(res, err.status, { error: err.message });
      log.error('request error:', err);
      send(res, 500, { error: 'internal error', detail: String(err.message || err) });
    }
  });
  return server;
}

function authorized(req, token) {
  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'DELETE') return resolve({});
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, data) {
  const payload = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(payload);
}

// Build a route table entry; `path` uses :param segments turned into named groups.
export function route(method, path, handler) {
  const re = new RegExp(
    '^' + path.replace(/:[a-zA-Z]+/g, (m) => `(?<${m.slice(1)}>[^/]+)`) + '/?$',
  );
  return { method, path, re, handler };
}
