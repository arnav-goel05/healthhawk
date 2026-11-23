// Hosted cockpit page server (PRD D1/D5/D6/D7). Node built-ins only.
// Exports createServer({ db, configDir, now }) for tests; listens only when
// run directly. Routes: POST /api/ingest, GET /api/snapshot, GET /.
// No response ever contains the token hash or env values.

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDb } from './db.mjs';
import { validateSnapshot } from './validate.mjs';
import { assertSafe } from './guard.mjs';
import { renderPage, renderEmpty } from './render.mjs';

export const DEFAULT_PORT = 8081;
const BODY_CAP = 256 * 1024;
const RETENTION = 14;
const BODY_INACTIVITY_MS = 10_000; // fix round 1 B3: stalled body → 408 + destroy
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_DIR = dirname(fileURLToPath(import.meta.url));

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendEmpty(res, status) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end();
}

async function storedTokenHash(db, configDir) {
  let hash = null;
  try {
    hash = await db.getTokenHash();
  } catch {
    hash = null;
  }
  if (typeof hash !== 'string' || hash.length === 0) {
    try {
      hash = readFileSync(join(configDir, 'token-hash.txt'), 'utf8').trim();
    } catch {
      hash = null;
    }
  }
  if (typeof hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hash)) return null;
  return hash;
}

function tokenMatches(authorization, storedHash) {
  if (storedHash === null) return false;
  const match = /^Bearer (.+)$/i.exec(authorization ?? '');
  if (!match) return false;
  const presented = createHash('sha256').update(match[1]).digest();
  const stored = Buffer.from(storedHash, 'hex');
  return timingSafeEqual(presented, stored);
}

function readBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (!res.headersSent) sendJson(res, 408, { error: 'request timeout' });
      req.destroy();
      resolve({ handled: true });
    }, BODY_INACTIVITY_MS);
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_CAP) {
        // Oversize: answer 400 once, then destroy — never drain the rest (B3).
        settled = true;
        clearTimeout(timer);
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'invalid snapshot' }), () => req.destroy());
        resolve({ handled: true });
        return;
      }
      chunks.push(chunk);
      timer.refresh();
    });
    req.on('end', () => settle({ handled: false, body: Buffer.concat(chunks) }));
    req.on('error', () => settle({ handled: true }));
    req.on('close', () => settle({ handled: true }));
  });
}

export function createServer({ db, configDir = PAGE_DIR, now = () => Date.now() } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = (req.url ?? '').split('?')[0];

      if (req.method === 'POST' && url === '/api/ingest') {
        const result = await readBody(req, res);
        if (result.handled) return;
        let parsed;
        try {
          parsed = JSON.parse(result.body.toString('utf8'));
        } catch {
          return sendJson(res, 400, { error: 'invalid snapshot' });
        }
        const hash = await storedTokenHash(db, configDir);
        if (!tokenMatches(req.headers.authorization, hash)) return sendEmpty(res, 401);
        try {
          validateSnapshot(parsed);
          assertSafe(parsed);
        } catch {
          return sendJson(res, 400, { error: 'invalid snapshot' });
        }
        const { receivedAt } = await db.insertSnapshot(parsed);
        await db.pruneSnapshots(RETENTION);
        return sendJson(res, 200, { ok: true, receivedAt });
      }

      if (req.method === 'GET' && url === '/api/snapshot') {
        const row = await db.latestSnapshot();
        if (!row) return sendJson(res, 404, { error: 'no snapshot' });
        return sendJson(res, 200, row.data);
      }

      if (req.method === 'GET' && url === '/') {
        const row = await db.latestSnapshot();
        if (!row) return sendHtml(res, 200, renderEmpty());
        return sendHtml(res, 200, renderPage(row, now()));
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch {
      return sendJson(res, 500, { error: 'internal error' });
    }
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  const db = createDb({
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    instanceId: process.env.SUPABASE_INSTANCE_ID,
  });
  const server = createServer({ db });
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? '0.0.0.0';
  server.listen(port, host, () => {
    const addr = server.address();
    console.log(`hosted-cockpit listening on ${addr.address}:${addr.port}`);
  });
}