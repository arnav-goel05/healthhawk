// Hosted Cockpit issue 03 — push cron end-to-end tests (PRD Testing Decisions
// seam 3). node:test, zero deps. Fixture roots ONLY in os.tmpdir — never the
// real repo runs/. Local fixture HTTP server on an ephemeral port mirrors the
// D5 ingest contract (Bearer + sha256 timingSafeEqual, 256 KB cap, 200
// {ok:true,receivedAt}) and — fix round 1 B1 — validates bodies with the REAL
// page validator + guard imports, so the sanitize→validate composition is
// exercised in seam 3 too (supersedes the old self-contained schema mirror).
// The guard-drift test (R2-2) imports BOTH production guard copies and runs
// one identical planted corpus (incl. mixed-case plants, B2). Planted-error
// discipline: token leak scan, out-of-scope write plants, founder.mjs
// invocation canary, freeze-state hash check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  readlinkSync, utimesSync, symlinkSync, existsSync,
} from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitize, assertSafe as pushGuard } from '../scripts/hosted-cockpit/sanitize.mjs';
import { assertSafe as pageGuard } from '../hosted-cockpit-page/guard.mjs';
import { validateSnapshot } from '../hosted-cockpit-page/validate.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const PUSH = join(ROOT, 'scripts', 'hosted-cockpit', 'push.mjs');
const NOW = '2026-11-22T23:55:00.000Z'; // 07:55 SGT 2026-11-23 (UTC date differs)
const NOW_COMPACT = '2026-11-22T23-55-00-000Z';
const SGT_DATE = '2026-11-23';
const RECEIVED = '2026-11-22T23:55:09.999Z'; // distinctive: proves evidence copies the response
const TOKEN = 'PLANTED-TOKEN-9f3c2e1d4b5a6789abcdef0123456789';
const DAY_MS = 24 * 60 * 60 * 1000;

function baseAggregate() {
  return {
    schema: 'p2-18-digest/1',
    generatedAt: '2026-11-22T23:30:00.000Z',
    digestDateSGT: SGT_DATE,
    agents: { freeze: { frozen: true, frozenAt: '2026-11-21T07:20:58.298Z' } },
    coverage: { rated: 57, total: 80, per100g: 71 },
    funnel: { cumulative: { proposed: 122, guardsPassed: 122, consensus: 120, published: 85, overruled: 0, greyZone: 35, outcomes: { publish: 85, unverified: 35, withheld: 0, rejected: 2 } } },
    founderQueue: { items: [{ kind: 'checklist', title: 'Fixture item', why: 'Fixture reason text', status: 'open', expiresWhen: null, stale: false }] },
    loop: { stages: [{ id: 'test', name: 'Test', state: 'static-proof', label: 'Last proof (static)', value: 1643 }] },
    traffic: { totals: { views: 17, visitors: 9, sessions: 10 }, fetchedAt: '2026-11-22T03:06:24Z', status: 'stale' },
    weekly: { forms: { count: 0 } },
    alerts: { items: [{ severity: 'high' }, { severity: 'medium' }] },
    revenueReadiness: { status: 'not-live' },
  };
}

function fixtureRoot({ aggregate = baseAggregate(), token = TOKEN, writeToken = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-hosted-push-'));
  mkdirSync(join(dir, 'runs', 'p2-18'), { recursive: true });
  if (aggregate !== null) {
    writeFileSync(join(dir, 'runs', 'p2-18', 'aggregate.json'), typeof aggregate === 'string' ? aggregate : JSON.stringify(aggregate));
  }
  writeFileSync(join(dir, 'runs', 'freeze-state.json'), JSON.stringify({ frozen: true, frozenAt: '2026-11-21T07:20:58.298Z', reason: 'prototype sign-off' }));
  for (const d of ['data', 'app', 'pending', 'scripts', 'docs']) {
    mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, d, 'marker.txt'), 'fixture marker\n');
  }
  // Canary: if push ever invokes founder.mjs, this marker appears and tests fail.
  writeFileSync(join(dir, 'scripts', 'founder.mjs'),
    "import { writeFileSync } from 'node:fs'; import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url'; writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'FOUNDER-INVOKED'), 'invoked');\n");
  const tokenPath = `${dir}-token.txt`; // OUTSIDE the repo root, like the real token file
  if (writeToken) writeFileSync(tokenPath, `${token}\n`);
  return { dir, tokenPath };
}

// Async spawn: the fixture server lives in THIS process, so a synchronous
// spawnSync would block the event loop and deadlock the ingest request.
function runPush(dir, tokenPath, url, extra = [], now = NOW) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [PUSH, '--root', dir, '--token-file', tokenPath, '--url', url, '--now', now, ...extra]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ status, signal, stdout, stderr });
    });
  });
}

// --- fixture ingest server: D5 transport mirror + the REAL page validator ---
// (fix round 1 B1: validateSnapshot + pageGuard are imported from the page
// directory, so a sanitizer/validator contract drift fails these tests too.)

async function withServer({ token = TOKEN, mode = 'ok' } = {}, fn) {
  const state = { requests: 0, bodies: [], auths: [] };
  const stored = createHash('sha256').update(token).digest();
  const server = http.createServer((req, res) => {
    state.requests += 1;
    if (mode === 'destroy') { req.socket.destroy(); return; }
    if (mode === '500') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"internal error"}'); return; }
    const chunks = [];
    let size = 0;
    let oversize = false;
    req.on('data', (c) => { size += c.length; if (size > 256 * 1024) { oversize = true; chunks.length = 0; } else if (!oversize) chunks.push(c); });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/api/ingest') { res.writeHead(404); res.end(); return; }
      if (oversize) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"invalid snapshot"}'); return; }
      const body = Buffer.concat(chunks).toString('utf8');
      state.auths.push(req.headers.authorization ?? null);
      const match = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '');
      const presented = match ? createHash('sha256').update(match[1]).digest() : null;
      if (!presented || !timingSafeEqual(presented, stored)) { res.writeHead(401); res.end(); return; }
      if (mode === '400') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"invalid snapshot"}'); return; }
      let parsed;
      try {
        parsed = JSON.parse(body);
        validateSnapshot(parsed);
        pageGuard(parsed);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"invalid snapshot"}'); return;
      }
      state.bodies.push(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, receivedAt: RECEIVED }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(url, state);
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
  }
}

async function closedPortUrl() {
  const server = http.createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  server.close();
  server.closeAllConnections();
  await once(server, 'close');
  return url;
}

// --- scope enumeration + leak scan helpers ---
function inventory(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      const rel = relative(root, p).split(sep).join('/');
      if (entry.isSymbolicLink()) out.set(rel, `link:${readlinkSync(p)}`);
      else if (entry.isDirectory()) walk(p);
      else out.set(rel, createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

const inScope = (p) => p.startsWith('runs/hosted-cockpit/') || /^runs\/12-alert-hosted-cockpit-[^/]*\.json$/.test(p);

function scopeViolations(before, after) {
  const violations = [];
  for (const [p, h] of after) {
    if (!before.has(p)) { if (!inScope(p)) violations.push(`new:${p}`); }
    else if (before.get(p) !== h && !inScope(p)) violations.push(`changed:${p}`);
  }
  for (const p of before.keys()) {
    if (!after.has(p) && !inScope(p)) violations.push(`deleted:${p}`);
  }
  return violations;
}

function allFileTexts(root) {
  const texts = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) texts.push(readFileSync(p, 'utf8'));
    }
  };
  walk(root);
  return texts;
}

function assertNoToken(root, ...streams) {
  for (const text of [...allFileTexts(root), ...streams]) {
    assert.ok(!text.includes(TOKEN), 'planted token leaked into an output');
  }
}

function readAlerts(dir) {
  const runsDir = join(dir, 'runs');
  return readdirSync(runsDir)
    .filter((f) => /^12-alert-hosted-cockpit-.*\.json$/.test(f))
    .map((f) => ({ name: f, json: JSON.parse(readFileSync(join(runsDir, f), 'utf8')) }));
}

function assertFailureAlert(dir, step) {
  const alerts = readAlerts(dir);
  assert.equal(alerts.length, 1, 'exactly one inbox alert at runs/ top level');
  const { name, json } = alerts[0];
  assert.match(name, /^12-alert-.*\.json$/); // real inbox scan regex (founder-queue.mjs)
  assert.equal(name, `12-alert-hosted-cockpit-${NOW_COMPACT}.json`);
  assert.deepEqual(Object.keys(json).sort(), ['alert', 'alertAt', 'reason', 'step']);
  assert.equal(json.alert, 'hosted-push-failed');
  assert.equal(json.alertAt, NOW);
  assert.equal(json.step, step);
  assert.equal(typeof json.reason, 'string');
  assert.ok(json.reason.length > 0 && !/[\r\n]/.test(json.reason), 'reason is one line');
  return json;
}

function assertNoFounderInvocation(dir) {
  assert.ok(!existsSync(join(dir, 'FOUNDER-INVOKED')), 'founder.mjs must never be invoked');
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// --- success path ---

test('success: evidence + dated report inside runs/hosted-cockpit, exact fields, sanitized POST, no alert', async () => {
  const { dir, tokenPath } = fixtureRoot();
  const freezeBefore = sha(join(dir, 'runs', 'freeze-state.json'));
  await withServer({}, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(state.requests, 1);
    assert.equal(state.auths[0], `Bearer ${TOKEN}`);
    const body = state.bodies[0];
    assert.equal(body.schema, 'hosted-cockpit-snapshot/1');
    assert.equal(body.needsYou[0].why, 'Fixture reason text');
    for (const item of body.needsYou) {
      assert.ok(!('command' in item) && !('id' in item) && !('source' in item) && !('nextStep' in item));
    }
    const evidencePath = join(dir, 'runs', 'hosted-cockpit', `push-${NOW_COMPACT}.json`);
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.deepEqual(evidence, {
      schema: 'hosted-push-evidence/1',
      pushedAt: NOW,
      aggregateGeneratedAt: '2026-11-22T23:30:00.000Z',
      digestDateSGT: SGT_DATE,
      receivedAt: RECEIVED,
      url,
      ok: true,
    });
    const reportPath = join(dir, 'runs', 'hosted-cockpit', `hosted-push-${SGT_DATE}.md`);
    const report = readFileSync(reportPath, 'utf8');
    assert.ok(report.includes(SGT_DATE) && report.includes(RECEIVED) && report.includes('result: ok'));
    assert.deepEqual(readAlerts(dir), []);
    assert.deepEqual(readdirSync(join(dir, 'runs', 'hosted-cockpit')).sort(), [`hosted-push-${SGT_DATE}.md`, `push-${NOW_COMPACT}.json`].sort());
    assert.equal(sha(join(dir, 'runs', 'freeze-state.json')), freezeBefore);
    assertNoFounderInvocation(dir);
    assert.ok(r.stdout.includes(RECEIVED));
  });
});

test('degraded digest day (traffic unavailable, forms absent): push succeeds end-to-end against the REAL page validator (B1)', async () => {
  const aggregate = baseAggregate();
  aggregate.traffic = { status: 'unavailable', source: 'fixture-source', reason: 'fetch failed' };
  delete aggregate.weekly;
  const { dir, tokenPath } = fixtureRoot({ aggregate });
  await withServer({}, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(state.requests, 1);
    const body = state.bodies[0];
    assert.deepEqual(body.traffic, { views: null, visitors: null, sessions: null, asOf: null, status: 'unavailable' });
    assert.deepEqual(body.forms, { count: null });
    assert.deepEqual(readAlerts(dir), []);
    assertNoFounderInvocation(dir);
  });
});

test('digestDateSGT mismatch: recorded honestly, push still succeeds, no alert (F13)', async () => {
  const aggregate = baseAggregate();
  aggregate.digestDateSGT = '2020-01-01';
  const { dir, tokenPath } = fixtureRoot({ aggregate });
  await withServer({}, async (url) => {
    const r = await runPush(dir, tokenPath, url);
    assert.equal(r.status, 0, r.stderr);
    const evidence = JSON.parse(readFileSync(join(dir, 'runs', 'hosted-cockpit', `push-${NOW_COMPACT}.json`), 'utf8'));
    assert.equal(evidence.digestDateSGT, '2020-01-01');
    assert.deepEqual(readAlerts(dir), []);
    const report = readFileSync(join(dir, 'runs', 'hosted-cockpit', `hosted-push-${SGT_DATE}.md`), 'utf8');
    assert.ok(report.includes('differs'));
  });
});

test('custom --aggregate relative path is honored', async () => {
  const { dir, tokenPath } = fixtureRoot();
  mkdirSync(join(dir, 'runs', 'alt'), { recursive: true });
  const aggregate = baseAggregate();
  aggregate.generatedAt = '2026-11-22T22:00:00.000Z';
  writeFileSync(join(dir, 'runs', 'alt', 'agg.json'), JSON.stringify(aggregate));
  await withServer({}, async (url) => {
    const r = await runPush(dir, tokenPath, url, ['--aggregate', join('runs', 'alt', 'agg.json')]);
    assert.equal(r.status, 0, r.stderr);
    const evidence = JSON.parse(readFileSync(join(dir, 'runs', 'hosted-cockpit', `push-${NOW_COMPACT}.json`), 'utf8'));
    assert.equal(evidence.aggregateGeneratedAt, '2026-11-22T22:00:00.000Z');
  });
});

// --- failure paths: alert shape, non-zero exit, NO retry ---

test('401 (wrong token): top-level inbox alert, exact shape, non-zero exit, exactly one request', async () => {
  const { dir, tokenPath } = fixtureRoot();
  const freezeBefore = sha(join(dir, 'runs', 'freeze-state.json'));
  await withServer({ token: 'a-different-server-token' }, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    assert.equal(state.requests, 1, 'no retry against a block');
    const alert = assertFailureAlert(dir, 'ingest');
    assert.ok(alert.reason.includes('401'));
    assert.ok(!existsSync(join(dir, 'runs', 'hosted-cockpit')) || readdirSync(join(dir, 'runs', 'hosted-cockpit')).length === 0);
    assert.equal(sha(join(dir, 'runs', 'freeze-state.json')), freezeBefore);
    assertNoFounderInvocation(dir);
  });
});

test('400: inbox alert + non-zero exit + exactly one request', async () => {
  const { dir, tokenPath } = fixtureRoot();
  await withServer({ mode: '400' }, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    assert.equal(state.requests, 1);
    const alert = assertFailureAlert(dir, 'ingest');
    assert.ok(alert.reason.includes('400'));
    assertNoFounderInvocation(dir);
  });
});

test('500: inbox alert + non-zero exit + exactly one request', async () => {
  const { dir, tokenPath } = fixtureRoot();
  await withServer({ mode: '500' }, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    assert.equal(state.requests, 1);
    const alert = assertFailureAlert(dir, 'ingest');
    assert.ok(alert.reason.includes('500'));
    assertNoFounderInvocation(dir);
  });
});

test('network error (destroyed socket): inbox alert + non-zero exit + exactly one attempt', async () => {
  const { dir, tokenPath } = fixtureRoot();
  await withServer({ mode: 'destroy' }, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    assert.equal(state.requests, 1, 'no retry on network error');
    assertFailureAlert(dir, 'ingest');
    assertNoFounderInvocation(dir);
  });
});

test('network error (connection refused): inbox alert + non-zero exit', async () => {
  const { dir, tokenPath } = fixtureRoot();
  const url = await closedPortUrl();
  const r = await runPush(dir, tokenPath, url);
  assert.notEqual(r.status, 0);
  assertFailureAlert(dir, 'ingest');
  assertNoFounderInvocation(dir);
});

test('missing aggregate: inbox alert + fail-closed exit, zero requests', async () => {
  const { dir, tokenPath } = fixtureRoot({ aggregate: null });
  await withServer({}, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    assert.equal(state.requests, 0);
    assertFailureAlert(dir, 'read-aggregate');
  });
});

test('corrupt aggregate: inbox alert + fail-closed exit, zero requests, no raw parse text in reason', async () => {
  const { dir, tokenPath } = fixtureRoot({ aggregate: '{"schema": "p2-18-digest/1", broken' });
  await withServer({}, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    assert.equal(state.requests, 0);
    const alert = assertFailureAlert(dir, 'read-aggregate');
    assert.ok(!alert.reason.includes('broken'), 'reason must not echo aggregate content');
  });
});

test('aggregate parses but is not an object: sanitize fail-closed alert', async () => {
  const { dir, tokenPath } = fixtureRoot({ aggregate: '[]' });
  await withServer({}, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    assert.equal(state.requests, 0);
    assertFailureAlert(dir, 'sanitize');
  });
});

test('missing freeze in aggregate: sanitize fail-closed alert (never guess)', async () => {
  const aggregate = baseAggregate();
  delete aggregate.agents;
  const { dir, tokenPath } = fixtureRoot({ aggregate });
  await withServer({}, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    assert.equal(state.requests, 0);
    assertFailureAlert(dir, 'sanitize');
  });
});

test('missing token file: inbox alert + fail-closed exit, zero requests', async () => {
  const { dir, tokenPath } = fixtureRoot({ writeToken: false });
  await withServer({}, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    assert.equal(state.requests, 0);
    assertFailureAlert(dir, 'read-token');
  });
});

test('empty token file: inbox alert + fail-closed exit, zero requests', async () => {
  const { dir, tokenPath } = fixtureRoot({ token: '' });
  await withServer({}, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    assert.equal(state.requests, 0);
    assertFailureAlert(dir, 'read-token');
  });
});

test('planted email in queue why: guard throws before POST, alert reason never echoes the email', async () => {
  const aggregate = baseAggregate();
  aggregate.founderQueue.items[0].why = 'contact visitor@secret-example.com now';
  const { dir, tokenPath } = fixtureRoot({ aggregate });
  await withServer({}, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    assert.equal(state.requests, 0);
    const alert = assertFailureAlert(dir, 'sanitize');
    assert.ok(!alert.reason.includes('visitor@secret-example.com'));
    assert.ok(!r.stdout.includes('visitor@secret-example.com') && !r.stderr.includes('visitor@secret-example.com'));
  });
});

test('planted path fragment in loop value: guard throws before POST', async () => {
  const aggregate = baseAggregate();
  aggregate.loop.stages[0].value = 'see runs/secret-place for detail';
  const { dir, tokenPath } = fixtureRoot({ aggregate });
  await withServer({}, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    assert.equal(state.requests, 0);
    assertFailureAlert(dir, 'sanitize');
  });
});

test('planted UUID in queue why: guard throws before POST', async () => {
  const aggregate = baseAggregate();
  aggregate.founderQueue.items[0].why = 'cron c5105f5a-0a7d-4745-afd2-73738759c537 failed';
  const { dir, tokenPath } = fixtureRoot({ aggregate });
  await withServer({}, async (url, state) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    assert.equal(state.requests, 0);
    assertFailureAlert(dir, 'sanitize');
  });
});

// --- token leak scans (planted token across ALL outputs) ---

test('token leak scan: success run leaves no token in any file, stdout, or stderr', async () => {
  const { dir, tokenPath } = fixtureRoot();
  await withServer({}, async (url) => {
    const r = await runPush(dir, tokenPath, url);
    assert.equal(r.status, 0, r.stderr);
    assertNoToken(dir, r.stdout, r.stderr);
  });
});

test('token leak scan: 401, network error, and missing-token runs leave no token anywhere', async () => {
  const a = fixtureRoot();
  await withServer({ token: 'a-different-server-token' }, async (url) => {
    const r = await runPush(a.dir, a.tokenPath, url);
    assert.notEqual(r.status, 0);
    assertNoToken(a.dir, r.stdout, r.stderr);
  });
  const b = fixtureRoot();
  await withServer({ mode: 'destroy' }, async (url) => {
    const r = await runPush(b.dir, b.tokenPath, url);
    assert.notEqual(r.status, 0);
    assertNoToken(b.dir, r.stdout, r.stderr);
  });
  const c = fixtureRoot({ writeToken: false });
  await withServer({}, async (url) => {
    const r = await runPush(c.dir, c.tokenPath, url);
    assert.notEqual(r.status, 0);
    assertNoToken(c.dir, r.stdout, r.stderr);
  });
});

// --- write-scope enumeration ---

test('scope enumeration: success run file set stays inside runs/hosted-cockpit/**', async () => {
  const { dir, tokenPath } = fixtureRoot();
  const before = inventory(dir);
  await withServer({}, async (url) => {
    const r = await runPush(dir, tokenPath, url);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(scopeViolations(before, inventory(dir)), []);
  });
});

test('scope enumeration: failure run touches only the top-level inbox alert pattern', async () => {
  const { dir, tokenPath } = fixtureRoot();
  const before = inventory(dir);
  await withServer({ mode: '500' }, async (url) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    assert.deepEqual(scopeViolations(before, inventory(dir)), []);
  });
});

test('scope enumeration harness self-test: a planted out-of-scope write IS detected', () => {
  const { dir } = fixtureRoot();
  const before = inventory(dir);
  writeFileSync(join(dir, 'data', 'rogue.json'), '{}'); // planted violation
  const violations = scopeViolations(before, inventory(dir));
  assert.deepEqual(violations, ['new:data/rogue.json']);
  const before2 = inventory(dir);
  writeFileSync(join(dir, 'app', 'marker.txt'), 'tampered');
  assert.deepEqual(scopeViolations(before2, inventory(dir)), ['changed:app/marker.txt']);
});

test('planted out-of-scope write vector: runs/hosted-cockpit symlink into data/ is refused fail-closed', async () => {
  const { dir, tokenPath } = fixtureRoot();
  symlinkSync(join(dir, 'data'), join(dir, 'runs', 'hosted-cockpit'));
  const before = inventory(dir);
  await withServer({}, async (url) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0, 'push must refuse to write through the symlink');
    assertFailureAlert(dir, 'evidence');
    assert.deepEqual(readdirSync(join(dir, 'data')), ['marker.txt'], 'nothing written through the link');
    assert.deepEqual(scopeViolations(before, inventory(dir)), []);
  });
});

// --- evidence retention (F16) ---

test('pruning: own evidence/report older than 14 days removed; newer, unrelated, and out-of-scope files kept', async () => {
  const { dir, tokenPath } = fixtureRoot();
  const scopeDir = join(dir, 'runs', 'hosted-cockpit');
  mkdirSync(scopeDir, { recursive: true });
  const nowMs = Date.parse(NOW);
  const plant = (rel, ageDays) => {
    const p = join(dir, rel);
    writeFileSync(p, rel.endsWith('.json') ? '{}' : '# old report');
    const t = new Date(nowMs - ageDays * DAY_MS);
    utimesSync(p, t, t);
    return p;
  };
  const oldEvidence = plant(join('runs', 'hosted-cockpit', 'push-2026-11-07T23-55-00-000Z.json'), 15);
  const oldReport = plant(join('runs', 'hosted-cockpit', 'hosted-push-2026-11-07.md'), 15);
  const freshEvidence = plant(join('runs', 'hosted-cockpit', 'push-2026-11-21T23-55-00-000Z.json'), 2);
  const freshReport = plant(join('runs', 'hosted-cockpit', 'hosted-push-2026-11-22.md'), 1);
  const unrelated = plant(join('runs', 'hosted-cockpit', 'notes.txt'), 30);
  const oldAlert = plant(join('runs', '12-alert-hosted-cockpit-2026-11-01T00-00-00-000Z.json'), 30);
  await withServer({}, async (url) => {
    const r = await runPush(dir, tokenPath, url);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(oldEvidence), '15-day-old evidence pruned');
    assert.ok(!existsSync(oldReport), '15-day-old report pruned');
    assert.ok(existsSync(freshEvidence), '2-day-old evidence kept');
    assert.ok(existsSync(freshReport), '1-day-old report kept');
    assert.ok(existsSync(unrelated), 'non-evidence file never pruned');
    assert.ok(existsSync(oldAlert), 'alert files outside prune scope kept');
    assert.deepEqual(readdirSync(scopeDir).sort(), [
      'hosted-push-2026-11-22.md', `hosted-push-${SGT_DATE}.md`, 'notes.txt',
      'push-2026-11-21T23-55-00-000Z.json', `push-${NOW_COMPACT}.json`,
    ].sort());
  });
});

test('same-day re-push: report overwritten in scope, second evidence file added, enumeration clean', async () => {
  const { dir, tokenPath } = fixtureRoot();
  const before = inventory(dir);
  await withServer({}, async (url) => {
    const r1 = await runPush(dir, tokenPath, url);
    assert.equal(r1.status, 0, r1.stderr);
    const later = new Date(Date.parse(NOW) + 60 * 60 * 1000).toISOString(); // 08:55 SGT, same SGT date
    const r2 = await runPush(dir, tokenPath, url, [], later);
    assert.equal(r2.status, 0, r2.stderr);
    const files = readdirSync(join(dir, 'runs', 'hosted-cockpit')).sort();
    assert.deepEqual(files, [`hosted-push-${SGT_DATE}.md`, 'push-2026-11-23T00-55-00-000Z.json', `push-${NOW_COMPACT}.json`].sort());
    assert.deepEqual(scopeViolations(before, inventory(dir)), []);
  });
});

// --- inbox compatibility (R2-1) ---

test('failure alert is readable by the real inbox reader fields (alertAt + reason, ^12-alert- name)', async () => {
  const { dir, tokenPath } = fixtureRoot();
  await withServer({ mode: '400' }, async (url) => {
    const r = await runPush(dir, tokenPath, url);
    assert.notEqual(r.status, 0);
    const [{ name, json }] = readAlerts(dir);
    assert.match(name, /^12-alert-.*\.json$/);
    assert.ok(Number.isFinite(Date.parse(json.alertAt)), 'alertAt parseable as timestamp');
    assert.equal(typeof json.reason, 'string');
    assert.ok(json.reason.length > 0);
    assert.equal(json.alert, 'hosted-push-failed');
  });
});

// --- usage errors (no writes at all) ---

test('missing required args: non-zero exit, no files written', () => {
  const { dir, tokenPath } = fixtureRoot();
  const before = inventory(dir);
  const r = spawnSync(process.execPath, [PUSH, '--root', dir, '--token-file', tokenPath], { encoding: 'utf8', timeout: 30000 });
  assert.notEqual(r.status, 0);
  assert.deepEqual(scopeViolations(before, inventory(dir)), []);
});

test('invalid --now: non-zero exit, no files written', () => {
  const { dir, tokenPath } = fixtureRoot();
  const before = inventory(dir);
  const r = spawnSync(process.execPath, [PUSH, '--root', dir, '--token-file', tokenPath, '--url', 'http://127.0.0.1:1', '--now', 'not-a-date'], { encoding: 'utf8', timeout: 30000 });
  assert.notEqual(r.status, 0);
  assert.deepEqual(scopeViolations(before, inventory(dir)), []);
});

test('--aggregate escaping root or absolute: refused, no files written', () => {
  const { dir, tokenPath } = fixtureRoot();
  const before = inventory(dir);
  for (const rel of ['../outside.json', join(tmpdir(), 'absolute.json')]) {
    const r = spawnSync(process.execPath, [PUSH, '--root', dir, '--token-file', tokenPath, '--url', 'http://127.0.0.1:1', '--now', NOW, '--aggregate', rel], { encoding: 'utf8', timeout: 30000 });
    assert.notEqual(r.status, 0);
  }
  assert.deepEqual(scopeViolations(before, inventory(dir)), []);
});

// --- guard drift (R2-2): ONE identical planted corpus through BOTH copies ---

const DRIFT_CORPUS = [
  { name: 'clean string', value: 'Coverage rated 57 of 80', safe: true },
  { name: 'clean ISO date', value: '2026-11-23T07:12:55.019Z', safe: true },
  { name: 'clean nested object', value: { a: ['ok', { b: 12, c: null }], d: true }, safe: true },
  { name: 'numbers/null/booleans', value: { n: 0, x: null, b: false }, safe: true },
  { name: 'email', value: 'visitor@example.com', safe: false },
  { name: 'email nested in why', value: { why: 'contact founder@healthhawk.sg please' }, safe: false },
  { name: 'email deep in array', value: [{ deep: ['a@b.co'] }], safe: false },
  { name: 'fragment /Users/', value: '/Users/example/secret', safe: false },
  { name: 'fragment runs/', value: 'see runs/p2-18 for detail', safe: false },
  { name: 'fragment pending/', value: 'pending/queue item', safe: false },
  { name: 'fragment scripts/', value: 'node scripts/founder.mjs status', safe: false },
  { name: 'fragment .json', value: 'aggregate.json content', safe: false },
  { name: 'UUID', value: 'c5105f5a-0a7d-4745-afd2-73738759c537', safe: false },
  { name: 'UUID nested', value: { loop: [{ label: 'id 84694ef5-0888-4623-9207-fb6e39f63ecb' }] }, safe: false },
  { name: 'violation in object KEY', value: { 'runs/secret': 1 }, safe: false },
  { name: 'email in object KEY', value: { 'a@b.co': 'clean' }, safe: false },
  { name: 'fragment Runs/ mixed case (B2)', value: 'See Runs/p2-18 for detail', safe: false },
  { name: 'fragment RUNS/ uppercase (B2)', value: 'SEE RUNS/P2-18', safe: false },
  { name: 'fragment /users/ lowercase (B2)', value: '/users/example/secret', safe: false },
  { name: 'fragment .JSON uppercase (B2)', value: 'aggregate.JSON content', safe: false },
  { name: 'fragment SCRIPTS/ uppercase (B2)', value: 'node SCRIPTS/founder.mjs status', safe: false },
  { name: 'fragment Pending/ mixed case (B2)', value: 'Pending/queue item', safe: false },
  { name: 'email uppercase (B2)', value: 'VISITOR@EXAMPLE.COM', safe: false },
  { name: 'mixed-case fragment in object KEY (B2)', value: { 'Runs/secret': 1 }, safe: false },
];

function verdict(guard, value) {
  try { guard(value); return 'accept'; } catch { return 'refuse'; }
}

test('guard drift (R2-2): push-side and page-side guards give identical verdicts on one planted corpus', () => {
  for (const item of DRIFT_CORPUS) {
    const pushVerdict = verdict(pushGuard, item.value);
    const pageVerdict = verdict(pageGuard, item.value);
    assert.equal(pushVerdict, pageVerdict, `guards disagree on: ${item.name}`);
    assert.equal(pushVerdict, item.safe ? 'accept' : 'refuse', `wrong verdict on: ${item.name}`);
  }
  assert.ok(DRIFT_CORPUS.some((i) => i.safe) && DRIFT_CORPUS.some((i) => !i.safe), 'corpus must contain both classes');
});

test('guard drift: synthetic snapshot accepted by BOTH guards; cyclic input safe in both', () => {
  const snapshot = sanitize(baseAggregate());
  assert.equal(pushGuard(snapshot), true);
  assert.equal(pageGuard(snapshot), true);
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.equal(verdict(pushGuard, cyclic), 'accept');
  assert.equal(verdict(pageGuard, cyclic), 'accept');
});