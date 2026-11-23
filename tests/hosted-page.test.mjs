// Hosted cockpit page — issue 02 tests (seam 2: page HTTP behavior).
// node:test, zero deps. Real HTTP on ephemeral ports with an INJECTED fake db
// whose ordering + delete semantics are REAL (F11): rows are sorted by
// (receivedAt desc, id desc) for latest() and prune() actually removes rows.
// No real Supabase calls: the REST client is exercised only against a local
// stub server / injected fake fetch. Config-fallback files live in os.tmpdir,
// never in the page directory (token-hash.txt must ship absent).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createServer, DEFAULT_PORT } from '../hosted-cockpit-page/server.mjs';
import { createDb } from '../hosted-cockpit-page/db.mjs';
import { assertSafe } from '../hosted-cockpit-page/guard.mjs';
import { validateSnapshot } from '../hosted-cockpit-page/validate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_DIR = join(ROOT, 'hosted-cockpit-page');
const TOKEN = 'unit-test-token-0123456789abcdef0123456789abcdef';
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const OTHER_TOKEN = 'a-different-token-ffffffffffffffffffffffffffff';
const OTHER_HASH = createHash('sha256').update(OTHER_TOKEN).digest('hex');
const HOUR = 3600 * 1000;

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const sgtToday = (ms = Date.now()) => new Date(ms + 8 * HOUR).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Fixture: a valid hosted-cockpit-snapshot/1 (D3 shape, real-aggregate values).
// ---------------------------------------------------------------------------
function mkSnapshot(over = {}) {
  const base = {
    schema: 'hosted-cockpit-snapshot/1',
    dataAsOf: new Date().toISOString(),
    digestDateSGT: sgtToday(),
    freeze: { frozen: true, since: '2026-11-21T07:20:58.298Z' },
    coverage: { rated: 57, total: 80, per100g: 71 },
    funnel: {
      proposed: 122, guardsPassed: 122, consensus: 120, published: 85,
      overruled: 0, greyZone: 35,
      outcomes: { publish: 85, unverified: 35, withheld: 0, rejected: 2 },
    },
    needsYou: [
      { kind: 'unfreeze', title: 'Decide when to go live', why: 'Unfreezing resumes daily auto-publish before submission.', status: 'open', expiresWhen: null, stale: false },
      { kind: 'checklist', title: 'G4 content-hash rollout', why: 'Complete before unfreeze.', status: 'expired', expiresWhen: '2026-11-23T20:00:00+08:00', stale: true },
    ],
    loop: [
      { id: 'research', name: 'Research', state: 'ok', label: 'Aisle brief ready', value: '2026-11-23' },
      { id: 'find', name: 'Find', state: 'frozen-expected', label: 'Frozen — expected', value: '2026-11-21' },
      { id: 'execute', name: 'Execute', state: 'frozen-expected', label: 'Frozen — expected', value: '2026-11-21' },
      { id: 'review', name: 'Review', state: 'ok', label: '122 decisions, 0 overrules', value: 122 },
      { id: 'test', name: 'Test', state: 'static-proof', label: 'Last proof 2026-11-23 (static)', value: '2026-11-23' },
      { id: 'deploy', name: 'Deploy', state: 'frozen-expected', label: 'Frozen — expected', value: '2026-11-21' },
      { id: 'grow', name: 'Grow', state: 'frozen-expected', label: 'Frozen — expected', value: 9 },
    ],
    traffic: { views: 17, visitors: 9, sessions: 10, asOf: '2026-11-22T03:06:24Z', status: 'stale' },
    forms: { count: 0 },
    alerts: { high: 2, medium: 7, low: 0, info: 0 },
    revenue: { status: 'not-live' },
  };
  return { ...base, ...over };
}

// ---------------------------------------------------------------------------
// Fake db seam — REAL ordering + delete semantics (F11).
// latest = max(receivedAt, id); prune deletes every row outside the top `keep`.
// ---------------------------------------------------------------------------
class FakeDb {
  constructor({ tokenHash = HASH } = {}) {
    this.rows = [];
    this.nextId = 1;
    this.tokenHash = tokenHash;
    this.authThrows = false;
  }
  ordered() {
    return [...this.rows].sort((a, b) =>
      a.receivedAt === b.receivedAt ? b.id - a.id : (a.receivedAt < b.receivedAt ? 1 : -1));
  }
  async insertSnapshot(data) {
    const row = { id: this.nextId++, receivedAt: new Date().toISOString(), data: structuredClone(data) };
    this.rows.push(row);
    return { receivedAt: row.receivedAt };
  }
  seed(data, receivedAt) {
    this.rows.push({ id: this.nextId++, receivedAt, data: structuredClone(data) });
  }
  async latestSnapshot() {
    const top = this.ordered()[0];
    return top ? { receivedAt: top.receivedAt, data: top.data } : null;
  }
  async pruneSnapshots(keep) {
    const doomed = new Set(this.ordered().slice(keep).map((r) => r.id));
    this.rows = this.rows.filter((r) => !doomed.has(r.id));
  }
  async getTokenHash() {
    if (this.authThrows) throw new Error('db down');
    return this.tokenHash;
  }
}

async function start(t, opts = {}) {
  const db = opts.db ?? new FakeDb();
  const server = createServer({ db, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); server.closeAllConnections(); });
  return { base: `http://127.0.0.1:${server.address().port}`, db };
}

function post(base, body, token = TOKEN) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(`${base}/api/ingest`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function tmpConfig(t, hash) {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-02-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (hash !== undefined) writeFileSync(join(dir, 'token-hash.txt'), `${hash}\n`);
  return dir;
}

// ---------------------------------------------------------------------------
// Auth (AC1)
// ---------------------------------------------------------------------------
test('ingest without token → 401 empty detail, nothing inserted', async (t) => {
  const { base, db } = await start(t);
  const res = await post(base, mkSnapshot(), null);
  assert.equal(res.status, 401);
  assert.equal(await res.text(), '');
  assert.equal(db.rows.length, 0);
});

test('ingest with wrong token → 401 empty detail, nothing inserted', async (t) => {
  const { base, db } = await start(t);
  const res = await post(base, mkSnapshot(), 'wrong-token');
  assert.equal(res.status, 401);
  assert.equal(await res.text(), '');
  assert.equal(db.rows.length, 0);
});

test('ingest with non-Bearer authorization → 401', async (t) => {
  const { base, db } = await start(t);
  const res = await fetch(`${base}/api/ingest`, {
    method: 'POST',
    headers: { Authorization: `Basic ${TOKEN}` },
    body: JSON.stringify(mkSnapshot()),
  });
  assert.equal(res.status, 401);
  assert.equal(db.rows.length, 0);
});

test('valid token + valid snapshot → 200 {ok,receivedAt} and stored', async (t) => {
  const { base, db } = await start(t);
  const snap = mkSnapshot();
  const res = await post(base, snap);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(typeof json.receivedAt, 'string');
  assert.equal(db.rows.length, 1);
  assert.deepEqual(db.rows[0].data, snap);
});

test('no hash in DB and no config file → 401 fail-closed', async (t) => {
  const { base, db } = await start(t, { db: new FakeDb({ tokenHash: null }), configDir: tmpConfig(t) });
  const res = await post(base, mkSnapshot());
  assert.equal(res.status, 401);
  assert.equal(db.rows.length, 0);
});

// ---------------------------------------------------------------------------
// Validation (AC2): every 400 inserts/overwrites NOTHING
// ---------------------------------------------------------------------------
const badBodies = [
  ['malformed JSON', '{not json'],
  ['wrong schema string', mkSnapshot({ schema: 'hosted-cockpit-snapshot/2' })],
  ['missing required field', (() => { const s = mkSnapshot(); delete s.revenue; return s; })()],
  ['unknown extra top-level key', mkSnapshot({ smuggled: 'x' })],
  ['string over 500 chars', (() => { const s = mkSnapshot(); s.needsYou[0].title = 'x'.repeat(501); return s; })()],
  ['array over 100 items', (() => { const s = mkSnapshot(); s.needsYou = Array.from({ length: 101 }, () => ({ kind: 'k', title: 't', why: 'w', status: 'open' })); return s; })()],
  ['negative count', (() => { const s = mkSnapshot(); s.coverage.rated = -1; return s; })()],
  ['non-integer count', (() => { const s = mkSnapshot(); s.funnel.published = 1.5; return s; })()],
  ['negative form count', (() => { const s = mkSnapshot(); s.forms.count = -2; return s; })()],
  ['frozen with null since', (() => { const s = mkSnapshot(); s.freeze.since = null; return s; })()],
  ['bad digest date', mkSnapshot({ digestDateSGT: 'yesterday' })],
  ['unparseable dataAsOf', mkSnapshot({ dataAsOf: 'not-a-date' })],
];
for (const [name, body] of badBodies) {
  test(`invalid body (${name}) → 400, nothing inserted or overwritten`, async (t) => {
    const { base, db } = await start(t);
    const good = mkSnapshot();
    db.seed(good, new Date().toISOString());
    const before = db.rows.length;
    const res = await post(base, body);
    assert.equal(res.status, 400);
    assert.equal(db.rows.length, before);
    const latest = await db.latestSnapshot();
    assert.deepEqual(latest.data, good);
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes('Decide when to go live'));
  });
}

test('body over 256 KB → 400, nothing inserted', async (t) => {
  const { base, db } = await start(t);
  const oversize = JSON.stringify({ ...mkSnapshot(), pad: 'x'.repeat(256 * 1024) });
  const res = await post(base, oversize);
  assert.equal(res.status, 400);
  assert.equal(db.rows.length, 0);
});

test('forms.count null is honest-missing and accepted, labelled unavailable', async (t) => {
  const { base } = await start(t);
  const res = await post(base, mkSnapshot({ forms: { count: null } }));
  assert.equal(res.status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('<b>unavailable</b>'));
});

// ---------------------------------------------------------------------------
// Server-side guard (AC3, defense in depth)
// ---------------------------------------------------------------------------
const guardPlants = [
  ['email-like text', (s) => { s.needsYou[0].why = 'write to founder@example.com please'; }],
  ['/Users/ fragment', (s) => { s.loop[0].value = '/Users/example/secret'; }],
  ['runs/ fragment', (s) => { s.loop[0].label = 'see runs/p2-18 for detail'; }],
  ['pending/ fragment', (s) => { s.needsYou[0].why = 'open pending/queue'; }],
  ['scripts/ fragment', (s) => { s.needsYou[0].title = 'node scripts/founder.mjs unfreeze'; }],
  ['.json fragment', (s) => { s.traffic.status = 'freeze-state.json'; }],
  ['UUID-like id', (s) => { s.needsYou[0].title = 'cron c5105f5a-0a7d-4745-afd2-73738759c537'; }],
  ['Runs/ mixed-case fragment (B2)', (s) => { s.needsYou[0].why = 'See Runs/p2-18 for detail'; }],
  ['/users/ lowercase fragment (B2)', (s) => { s.loop[0].value = '/users/example/secret'; }],
  ['.JSON uppercase fragment (B2)', (s) => { s.traffic.status = 'aggregate.JSON'; }],
  ['SCRIPTS/ uppercase fragment (B2)', (s) => { s.needsYou[0].title = 'node SCRIPTS/founder.mjs status'; }],
  ['uppercase email (B2)', (s) => { s.needsYou[0].why = 'write to VISITOR@EXAMPLE.COM please'; }],
];
for (const [name, plant] of guardPlants) {
  test(`pushed body with ${name} → 400 via server guard, nothing inserted`, async (t) => {
    const { base, db } = await start(t);
    const snap = mkSnapshot();
    plant(snap);
    const res = await post(base, snap);
    assert.equal(res.status, 400);
    assert.equal(db.rows.length, 0);
  });
}

test('guard module: assertSafe accepts the fixture and refuses deep plants', () => {
  assertSafe(mkSnapshot());
  assertSafe({ a: [1, null, true, { b: 'plain text' }] });
  assert.throws(() => assertSafe({ deep: [{ x: 'a@b.co' }] }));
  assert.throws(() => assertSafe({ deep: [{ x: 'runs/x' }] }));
  assert.throws(() => assertSafe({ deep: [{ x: 'c5105f5a-0a7d-4745-afd2-73738759c537' }] }));
});

test('validate module: exact D3 shape accepted, planted violations throw', () => {
  validateSnapshot(mkSnapshot());
  assert.throws(() => validateSnapshot(mkSnapshot({ schema: 'x' })));
  assert.throws(() => validateSnapshot({}));
});

// ---------------------------------------------------------------------------
// Null contract (rev 2.1, fix round 1 B1/A1): traffic nulls ONLY when degraded
// ---------------------------------------------------------------------------
test('validate: degraded traffic (status stale/unavailable/null) with null counts+asOf accepted', () => {
  for (const status of ['stale', 'unavailable', null]) {
    validateSnapshot(mkSnapshot({ traffic: { views: null, visitors: null, sessions: null, asOf: null, status } }));
  }
});

test('validate: status "ok" still requires non-null traffic counts and asOf', () => {
  const ok = { views: 17, visitors: 9, sessions: 10, asOf: '2026-11-22T03:06:24Z', status: 'ok' };
  validateSnapshot(mkSnapshot({ traffic: ok }));
  for (const k of ['views', 'visitors', 'sessions', 'asOf']) {
    assert.throws(() => validateSnapshot(mkSnapshot({ traffic: { ...ok, [k]: null } })), /traffic/);
  }
});

test('validate: degraded traffic still rejects negative, non-integer, and wrong-type counts', () => {
  for (const bad of [-1, 1.5, '17', true, {}]) {
    assert.throws(() => validateSnapshot(mkSnapshot({ traffic: { views: bad, visitors: null, sessions: null, asOf: null, status: 'unavailable' } })), /traffic\.views/);
  }
  assert.throws(() => validateSnapshot(mkSnapshot({ traffic: { views: null, visitors: null, sessions: null, asOf: null, status: 42 } })), /traffic\.status/);
  assert.throws(() => validateSnapshot(mkSnapshot({ forms: { count: -1 } })), /forms\.count/);
  assert.throws(() => validateSnapshot(mkSnapshot({ coverage: { rated: null, total: 80, per100g: 71 } })), /coverage\.rated/);
  assert.throws(() => validateSnapshot(mkSnapshot({ freeze: { frozen: true, since: null } })), /freeze\.since/);
});

test('render: degraded traffic + null forms render labelled unavailable, never 0', async (t) => {
  const { base } = await start(t);
  const snap = mkSnapshot({
    traffic: { views: null, visitors: null, sessions: null, asOf: null, status: 'unavailable' },
    forms: { count: null },
  });
  assert.equal((await post(base, snap)).status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('status: unavailable'));
  assert.ok(html.includes('as of unavailable'));
  const unavailableCells = html.match(/<b>unavailable<\/b>/g) ?? [];
  assert.equal(unavailableCells.length, 4); // views, visitors, sessions, submissions
  assert.ok(!html.includes('<b>null</b>'));
});

// ---------------------------------------------------------------------------
// HTTP robustness (fix round 1 B3): explicit timeouts + oversize early-destroy
// ---------------------------------------------------------------------------
test('server sets explicit header/request timeouts (no 300s default hang)', () => {
  const server = createServer({ db: new FakeDb() });
  assert.equal(server.headersTimeout, 10_000);
  assert.equal(server.requestTimeout, 30_000);
});

test('oversize body: connection destroyed early mid-upload, nothing inserted', async (t) => {
  const { base, db } = await start(t);
  const port = Number(base.split(':').pop());
  const DECLARED = 4 * 1024 * 1024; // declares 4 MB, sends only 320 KB, never ends
  const outcome = await new Promise((resolvePromise, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/ingest',
      headers: { 'Content-Type': 'application/json', 'Content-Length': DECLARED, Authorization: `Bearer ${TOKEN}` },
    });
    let status = null;
    const guardTimer = setTimeout(() => { req.destroy(); reject(new Error('server did not destroy the oversize connection')); }, 8000);
    req.on('response', (res) => { status = res.statusCode; res.resume(); });
    req.on('error', () => {}); // ECONNRESET after early destroy is expected
    req.on('close', () => { clearTimeout(guardTimer); resolvePromise({ status }); });
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    for (let i = 0; i < 5; i += 1) req.write(chunk); // 320 KB > 256 KB cap, far below declared
  });
  assert.ok(outcome.status === null || outcome.status === 400);
  assert.equal(db.rows.length, 0);
});

// ---------------------------------------------------------------------------
// XSS escaping (AC4)
// ---------------------------------------------------------------------------
test('planted <script> and quotes in why → escaped entities, never executable markup', async (t) => {
  const { base } = await start(t);
  const snap = mkSnapshot();
  snap.needsYou[0].why = '<script>alert("pwn")</script> & \'quote\'';
  const res = await post(base, snap);
  assert.equal(res.status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('&lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&#39;quote&#39;'));
});

// ---------------------------------------------------------------------------
// Retention (AC5) — fake implements real ordering/delete
// ---------------------------------------------------------------------------
test('after 16 inserts only the latest 14 remain, newest renders', async (t) => {
  const { base, db } = await start(t);
  for (let i = 0; i < 16; i++) {
    const snap = mkSnapshot();
    snap.needsYou[0].title = `push number ${i}`;
    const res = await post(base, snap);
    assert.equal(res.status, 200);
  }
  assert.equal(db.rows.length, 14);
  const ids = db.rows.map((r) => r.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('push number 15'));
  assert.ok(!html.includes('push number 0'));
});

// ---------------------------------------------------------------------------
// Render panels (AC6)
// ---------------------------------------------------------------------------
test('GET / renders all panels, Honest Label tokens, no client JS', async (t) => {
  const { base } = await start(t);
  const snap = mkSnapshot();
  assert.equal((await post(base, snap)).status, 200);
  const html = await (await fetch(`${base}/`)).text();
  // NEEDS YOU
  assert.ok(html.includes('Needs you'));
  assert.ok(html.includes('unfreeze'));
  assert.ok(html.includes('Decide when to go live'));
  assert.ok(html.includes('Unfreezing resumes daily auto-publish'));
  assert.ok(html.includes('status: open'));
  assert.ok(html.includes('status: expired'));
  assert.ok(html.includes('expired'));
  assert.ok(html.includes('possibly stale'));
  assert.ok(html.includes('decisions happen in your terminal'));
  // coverage + funnel
  assert.ok(html.includes('Coverage'));
  for (const n of ['57', '80', '71']) assert.ok(html.includes(`<b>${n}</b>`));
  assert.ok(html.includes('Funnel'));
  for (const n of ['122', '120', '85', '35', '2']) assert.ok(html.includes(`<b>${n}</b>`));
  // 7-stage loop
  for (const name of ['Research', 'Find', 'Execute', 'Review', 'Test', 'Deploy', 'Grow']) assert.ok(html.includes(name));
  assert.ok(html.includes('frozen-expected'));
  assert.ok(html.includes('static-proof'));
  // traffic labels its OWN asOf AND status
  assert.ok(html.includes('Traffic'));
  assert.ok(html.includes('as of 2026-11-22T03:06:24Z'));
  assert.ok(html.includes('status: stale'));
  for (const n of ['17', '9', '10']) assert.ok(html.includes(`<b>${n}</b>`));
  // forms + alerts counts
  assert.ok(html.includes('Forms'));
  assert.ok(html.includes('Alerts'));
  // freeze badge
  assert.ok(html.includes('FROZEN since 2026-11-21T07:20:58.298Z'));
  // revenue VERBATIM
  assert.ok(html.includes('not-live'));
  // data-as-of header
  assert.ok(html.includes(`data as of ${snap.dataAsOf}`));
  // Honest Label tokens
  for (const token of ['#F6F0E4', '#1B1917', '#0F766E']) assert.ok(html.includes(token));
  assert.ok(html.includes('system-ui'));
  // no client JavaScript
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('onclick'));
});

test('revenue status renders VERBATIM from the snapshot, not hardcoded', async (t) => {
  const { base } = await start(t);
  const snap = mkSnapshot({ revenue: { status: 'live-beta' } });
  assert.equal((await post(base, snap)).status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('<p class="revenue">live-beta</p>'));
  assert.ok(!html.includes('not-live'));
});

test('unfrozen snapshot renders NOT FROZEN badge', async (t) => {
  const { base } = await start(t);
  const snap = mkSnapshot({ freeze: { frozen: false, since: null } });
  assert.equal((await post(base, snap)).status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('NOT FROZEN'));
});

// ---------------------------------------------------------------------------
// Staleness (AC7)
// ---------------------------------------------------------------------------
test('fresh push + dataAsOf 3 days old → staleness banner', async (t) => {
  const { base } = await start(t);
  const snap = mkSnapshot({ dataAsOf: new Date(Date.now() - 72 * HOUR).toISOString() });
  assert.equal((await post(base, snap)).status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('STALE DATA'));
});

test('receivedAt older than 26h → staleness banner even with fresh dataAsOf', async (t) => {
  const { base, db } = await start(t);
  db.seed(mkSnapshot(), new Date(Date.now() - 27 * HOUR).toISOString());
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('STALE DATA'));
});

test('fresh push + fresh data → no staleness banner', async (t) => {
  const { base } = await start(t);
  assert.equal((await post(base, mkSnapshot())).status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(!html.includes('STALE DATA'));
});

test('digestDateSGT ≠ today SGT → "digest has not rebuilt today" note', async (t) => {
  const { base } = await start(t);
  const yesterday = sgtToday(Date.now() - 24 * HOUR);
  const snap = mkSnapshot({ digestDateSGT: yesterday });
  assert.equal((await post(base, snap)).status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('digest has not rebuilt today'));
});

test('digestDateSGT = today SGT → no digest note', async (t) => {
  const { base } = await start(t);
  assert.equal((await post(base, mkSnapshot())).status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(!html.includes('digest has not rebuilt today'));
});

test('empty store → honest "no data pushed yet" page', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('no data pushed yet'));
  assert.ok(!html.includes('Coverage'));
  assert.ok(!html.includes('STALE DATA'));
});

// ---------------------------------------------------------------------------
// /api/snapshot + routing (AC8)
// ---------------------------------------------------------------------------
test('GET /api/snapshot returns the latest sanitized JSON', async (t) => {
  const { base } = await start(t);
  const snap = mkSnapshot();
  assert.equal((await post(base, snap)).status, 200);
  const res = await fetch(`${base}/api/snapshot`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), snap);
});

test('GET /api/snapshot on empty store → 404', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/api/snapshot`);
  assert.equal(res.status, 404);
});

test('no other routes exist', async (t) => {
  const { base } = await start(t);
  for (const path of ['/admin', '/favicon.ico', '/api/ingest', '/env']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404);
  }
  const res = await fetch(`${base}/`, { method: 'POST' });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Token-hash precedence (AC9, R2-3)
// ---------------------------------------------------------------------------
test('DB auth row wins over config fallback', async (t) => {
  const configDir = tmpConfig(t, OTHER_HASH);
  const { base, db } = await start(t, { configDir });
  assert.equal((await post(base, mkSnapshot(), TOKEN)).status, 200);
  const res = await post(base, mkSnapshot(), OTHER_TOKEN);
  assert.equal(res.status, 401);
  assert.equal(db.rows.length, 1);
});

test('config fallback authenticates when DB has no auth row', async (t) => {
  const configDir = tmpConfig(t, HASH);
  const { base } = await start(t, { db: new FakeDb({ tokenHash: null }), configDir });
  assert.equal((await post(base, mkSnapshot(), TOKEN)).status, 200);
  assert.equal((await post(base, mkSnapshot(), 'wrong')).status, 401);
});

test('config fallback used when DB auth lookup errors', async (t) => {
  const configDir = tmpConfig(t, HASH);
  const db = new FakeDb({ tokenHash: null });
  db.authThrows = true;
  const { base } = await start(t, { db, configDir });
  assert.equal((await post(base, mkSnapshot(), TOKEN)).status, 200);
});

test('token-hash.txt ships absent from the page directory', () => {
  assert.equal(existsSync(join(PAGE_DIR, 'token-hash.txt')), false);
});

// ---------------------------------------------------------------------------
// No response leaks hash / token / env values (AC8)
// ---------------------------------------------------------------------------
test('no response ever contains the token hash, token, or env values', async (t) => {
  const envBackup = {};
  const fakeEnv = {
    SUPABASE_URL: 'https://fake-env-url.example.invalid',
    SUPABASE_ANON_KEY: 'fake-anon-key-should-never-leak',
    SUPABASE_INSTANCE_ID: 'fake-instance-id-999',
  };
  for (const [k, v] of Object.entries(fakeEnv)) {
    envBackup[k] = process.env[k];
    process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const { base } = await start(t);
  const bodies = [];
  bodies.push(await (await post(base, mkSnapshot())).text());
  bodies.push(await (await post(base, mkSnapshot(), 'wrong')).text());
  bodies.push(await (await post(base, { schema: 'bad' })).text());
  bodies.push(await (await fetch(`${base}/`)).text());
  bodies.push(await (await fetch(`${base}/api/snapshot`)).text());
  bodies.push(await (await fetch(`${base}/nope`)).text());
  for (const body of bodies) {
    assert.ok(!body.includes(HASH));
    assert.ok(!body.includes(TOKEN));
    for (const v of Object.values(fakeEnv)) assert.ok(!body.includes(v));
  }
});

// ---------------------------------------------------------------------------
// PORT / HOST / direct-run (AC10) + db REST client against a LOCAL stub
// ---------------------------------------------------------------------------
test('default port is 8081', () => {
  assert.equal(DEFAULT_PORT, 8081);
});

test('direct run reads PORT and HOST; serves empty state via REST stub', async (t) => {
  const seenHeaders = [];
  const stub = http.createServer((req, res) => {
    seenHeaders.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  t.after(() => { stub.close(); stub.closeAllConnections(); });
  const stubBase = `http://127.0.0.1:${stub.address().port}`;

  const child = spawn(process.execPath, [join(PAGE_DIR, 'server.mjs')], {
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      SUPABASE_URL: stubBase,
      SUPABASE_ANON_KEY: 'stub-anon-key',
      SUPABASE_INSTANCE_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill(); });
  const port = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = /listening on 127\.0\.0\.1:(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolvePromise(Number(m[1])); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code})`)); });
  });
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('no data pushed yet'));
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/snapshot`)).status, 404);
  assert.ok(seenHeaders.length > 0);
  assert.equal(seenHeaders[0].apikey, 'stub-anon-key');
  assert.equal(seenHeaders[0].authorization, 'Bearer stub-anon-key');
});

// ---------------------------------------------------------------------------
// db.mjs dual-mode + REST semantics (injected fake fetch — zero network)
// ---------------------------------------------------------------------------
function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    impl: async (url, opts) => {
      calls.push({ url, opts });
      const next = responses.shift() ?? { status: 200, body: '[]' };
      return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => next.body };
    },
  };
}

test('db client retries with tenant profile headers on PGRST205 and stays in profile mode', async () => {
  const { calls, impl } = fakeFetch([
    { status: 404, body: JSON.stringify({ code: 'PGRST205', message: 'Could not find the table in the schema cache' }) },
    { status: 200, body: '[]' },
    { status: 200, body: '[]' },
  ]);
  const db = createDb({ url: 'https://x.example', anonKey: 'k', instanceId: 'abc123', fetchImpl: impl });
  assert.equal(await db.latestSnapshot(), null);
  assert.equal(await db.latestSnapshot(), null);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].opts.headers['Accept-Profile'], undefined);
  assert.equal(calls[1].opts.headers['Accept-Profile'], 'tenant_abc123_schema');
  assert.equal(calls[1].opts.headers['Content-Profile'], 'tenant_abc123_schema');
  assert.equal(calls[2].opts.headers['Accept-Profile'], 'tenant_abc123_schema');
  assert.equal(calls[0].opts.headers.apikey, 'k');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer k');
});

test('db client plain mode succeeds without profile headers', async () => {
  const { calls, impl } = fakeFetch([
    { status: 200, body: JSON.stringify([{ id: 1, received_at: '2026-11-23T00:00:00Z', data: { a: 1 } }]) },
  ]);
  const db = createDb({ url: 'https://x.example/', anonKey: 'k', instanceId: 'abc123', fetchImpl: impl });
  const row = await db.latestSnapshot();
  assert.deepEqual(row, { receivedAt: '2026-11-23T00:00:00Z', data: { a: 1 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers['Accept-Profile'], undefined);
  assert.ok(calls[0].url.startsWith('https://x.example/rest/v1/cockpit_snapshots?'));
  assert.ok(calls[0].url.includes('order=received_at.desc,id.desc'));
});

test('db client insert returns receivedAt; prune deletes only ids beyond keep', async () => {
  const { calls, impl } = fakeFetch([
    { status: 201, body: JSON.stringify([{ id: 5, received_at: '2026-11-23T01:00:00Z' }]) },
    { status: 200, body: JSON.stringify([{ id: 1 }, { id: 2 }]) },
    { status: 204, body: '' },
  ]);
  const db = createDb({ url: 'https://x.example', anonKey: 'k', fetchImpl: impl });
  const ins = await db.insertSnapshot({ schema: 'hosted-cockpit-snapshot/1' });
  assert.equal(ins.receivedAt, '2026-11-23T01:00:00Z');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Prefer, 'return=representation');
  await db.pruneSnapshots(14);
  assert.ok(calls[1].url.includes('offset=14'));
  assert.equal(calls[2].opts.method, 'DELETE');
  assert.ok(calls[2].url.includes('id=in.(1,2)'));
});

test('db client prune with nothing beyond keep issues no DELETE; empty auth → null', async () => {
  const { calls, impl } = fakeFetch([
    { status: 200, body: '[]' },
    { status: 200, body: '[]' },
  ]);
  const db = createDb({ url: 'https://x.example', anonKey: 'k', fetchImpl: impl });
  await db.pruneSnapshots(14);
  assert.equal(await db.getTokenHash(), null);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes('cockpit_auth'));
});

// ---------------------------------------------------------------------------
// migrations.sql (AC11): idempotent, unqualified, schema-only
// ---------------------------------------------------------------------------
test('migrations.sql is idempotent, unqualified, schema-only, no secrets', () => {
  const sql = readFileSync(join(PAGE_DIR, 'migrations.sql'), 'utf8');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS cockpit_snapshots'));
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS cockpit_auth'));
  assert.ok(!/\b(INSERT|UPDATE|DELETE|COPY|DROP|TRUNCATE)\b/i.test(sql));
  assert.ok(!sql.includes('tenant_'));
  assert.ok(!/[a-z_]+\.(cockpit_snapshots|cockpit_auth)/i.test(sql));
  assert.ok(!sql.includes(HASH));
});

test('page package.json is private, module, zero dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(PAGE_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});
// ---------------------------------------------------------------------------
// Rev 2.2: optional automation field — validator, ingest, render, escaping
// ---------------------------------------------------------------------------
const mkJob = (over = {}) => ({
  name: 'HealthHawk daily founder digest (07:30 SGT)',
  schedule: 'daily 07:30 SGT',
  lastStatus: 'ok',
  feeds: 'Rebuilds this cockpit data',
  ...over,
});

test('rev2.2 validate: absent automation stays valid (old snapshots render)', () => {
  const snap = mkSnapshot();
  assert.ok(!Object.hasOwn(snap, 'automation'));
  validateSnapshot(snap);
});

test('rev2.2 validate: well-formed automation (incl. empty array) accepted', () => {
  validateSnapshot(mkSnapshot({ automation: [] }));
  validateSnapshot(mkSnapshot({ automation: [mkJob(), mkJob({ lastStatus: 'error' }), mkJob({ lastStatus: 'never-run' })] }));
  validateSnapshot(mkSnapshot({ automation: Array.from({ length: 20 }, () => mkJob()) }));
});

const badAutomation = [
  ['array over 20 items', Array.from({ length: 21 }, () => mkJob())],
  ['not an array', { name: 'x' }],
  ['bad lastStatus', [mkJob({ lastStatus: 'no-status' })]],
  ['lastStatus not a string', [mkJob({ lastStatus: 1 })]],
  ['name over 500 chars', [mkJob({ name: 'x'.repeat(501) })]],
  ['schedule over 500 chars', [mkJob({ schedule: 'x'.repeat(501) })]],
  ['feeds over 500 chars', [mkJob({ feeds: 'x'.repeat(501) })]],
  ['empty name', [mkJob({ name: '' })]],
  ['extra item key (id smuggling)', [mkJob({ id: 'c5105f5a-0a7d-4745-afd2-73738759c537' })]],
  ['missing feeds key', [{ name: 'n', schedule: 's', lastStatus: 'ok' }]],
  ['non-object item', ['just a string']],
];
for (const [name, automation] of badAutomation) {
  test(`rev2.2 invalid automation (${name}) → 400, nothing inserted`, async (t) => {
    const { base, db } = await start(t);
    const res = await post(base, mkSnapshot({ automation }));
    assert.equal(res.status, 400);
    assert.equal(db.rows.length, 0);
  });
}

test('rev2.2 render: Automation panel right after NEEDS YOU with name/schedule/chip/feeds', async (t) => {
  const { base } = await start(t);
  const snap = mkSnapshot({
    automation: [
      mkJob(),
      mkJob({ name: 'HealthHawk weekly blog draft (Mon 09:00 SGT)', schedule: 'Mon 09:00 SGT', lastStatus: 'error', feeds: 'Queues your blog approval' }),
      mkJob({ name: 'HealthHawk Monday founder report (Mon 09:30 SGT)', schedule: 'Mon 09:30 SGT', lastStatus: 'never-run', feeds: 'Your Monday report' }),
    ],
  });
  assert.equal((await post(base, snap)).status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('Automation — the scheduled jobs'));
  const needsIdx = html.indexOf('Needs you');
  const autoIdx = html.indexOf('Automation — the scheduled jobs');
  const coverageIdx = html.indexOf('<h2>Coverage</h2>');
  assert.ok(needsIdx > -1 && autoIdx > needsIdx && coverageIdx > autoIdx);
  for (const job of snap.automation) {
    assert.ok(html.includes(job.name));
    assert.ok(html.includes(job.schedule));
    assert.ok(html.includes(job.feeds));
  }
  assert.ok(html.includes('chip-ok'));
  assert.ok(html.includes('chip-error'));
  assert.ok(html.includes('chip-never'));
  assert.ok(!html.includes('<script'));
});

test('rev2.2 render: planted <script> in a job name → escaped, never executable', async (t) => {
  const { base } = await start(t);
  const snap = mkSnapshot({
    automation: [mkJob({ name: '<script>alert("pwn")</script> & \'quote\'' })],
  });
  assert.equal((await post(base, snap)).status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('&lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt;'));
  assert.ok(html.includes('&#39;quote&#39;'));
  assert.ok(!html.includes('<script>'));
});

test('rev2.2 render: empty automation → honest "no job data in this snapshot"', async (t) => {
  const { base } = await start(t);
  assert.equal((await post(base, mkSnapshot({ automation: [] }))).status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('Automation — the scheduled jobs'));
  assert.ok(html.includes('no job data in this snapshot'));
});

test('rev2.2 render: absent automation (old snapshot) still renders with honest empty line', async (t) => {
  const { base } = await start(t);
  assert.equal((await post(base, mkSnapshot())).status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('no job data in this snapshot'));
});
