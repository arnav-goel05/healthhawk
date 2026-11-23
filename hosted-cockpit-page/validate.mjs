// Strict per-field validation of the pinned snapshot contract
// `hosted-cockpit-snapshot/1` (PRD D3/D5). Throws on ANY violation.
// Exact key sets: unknown fields are refused (fail-closed, no smuggling).
// Strings <= 500 chars, arrays <= 100 items, counts non-negative integers.
// Null contract (PRD rev 2.1, fix round 1 B1/A1): traffic.{views,visitors,
// sessions,asOf} may be null ONLY when traffic.status is not "ok" (degraded
// or absent; status itself may be null); forms.count may be null. freeze,
// coverage and funnel counts remain mandatory. Nulls render as "unavailable".

export const SCHEMA = 'hosted-cockpit-snapshot/1';
const MAX_STRING = 500;
const MAX_ARRAY = 100;

function fail(field) {
  throw new Error(`invalid snapshot: ${field}`);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function exactKeys(v, keys, field) {
  if (!isObj(v)) fail(field);
  const got = Object.keys(v);
  if (got.length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) fail(field);
}

function str(v, field, { allowEmpty = false } = {}) {
  if (typeof v !== 'string' || v.length > MAX_STRING || (!allowEmpty && v.length === 0)) fail(field);
}

function count(v, field) {
  if (!Number.isInteger(v) || v < 0) fail(field);
}

function arr(v, field) {
  if (!Array.isArray(v) || v.length > MAX_ARRAY) fail(field);
}

export function validateSnapshot(s) {
  // Rev 2.2: `automation` is OPTIONAL (old snapshots without it stay valid).
  const requiredKeys = [
    'schema', 'dataAsOf', 'digestDateSGT', 'freeze', 'coverage', 'funnel',
    'needsYou', 'loop', 'traffic', 'forms', 'alerts', 'revenue',
  ];
  if (!isObj(s)) fail('top-level shape');
  const topKeys = Object.keys(s);
  if (requiredKeys.some((k) => !Object.hasOwn(s, k))
    || topKeys.some((k) => !requiredKeys.includes(k) && k !== 'automation')) fail('top-level shape');
  if (s.schema !== SCHEMA) fail('schema');
  str(s.dataAsOf, 'dataAsOf');
  if (!Number.isFinite(Date.parse(s.dataAsOf))) fail('dataAsOf');
  str(s.digestDateSGT, 'digestDateSGT');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.digestDateSGT)) fail('digestDateSGT');

  exactKeys(s.freeze, ['frozen', 'since'], 'freeze');
  if (typeof s.freeze.frozen !== 'boolean') fail('freeze.frozen');
  if (s.freeze.frozen) str(s.freeze.since, 'freeze.since');
  else if (s.freeze.since !== null) fail('freeze.since');

  exactKeys(s.coverage, ['rated', 'total', 'per100g'], 'coverage');
  count(s.coverage.rated, 'coverage.rated');
  count(s.coverage.total, 'coverage.total');
  count(s.coverage.per100g, 'coverage.per100g');

  exactKeys(s.funnel, ['proposed', 'guardsPassed', 'consensus', 'published', 'overruled', 'greyZone', 'outcomes'], 'funnel');
  for (const k of ['proposed', 'guardsPassed', 'consensus', 'published', 'overruled', 'greyZone']) count(s.funnel[k], `funnel.${k}`);
  exactKeys(s.funnel.outcomes, ['publish', 'unverified', 'withheld', 'rejected'], 'funnel.outcomes');
  for (const k of ['publish', 'unverified', 'withheld', 'rejected']) count(s.funnel.outcomes[k], `funnel.outcomes.${k}`);

  arr(s.needsYou, 'needsYou');
  for (const item of s.needsYou) {
    if (!isObj(item)) fail('needsYou item');
    const keys = Object.keys(item);
    const required = ['kind', 'title', 'why', 'status'];
    const optional = ['expiresWhen', 'stale'];
    if (required.some((k) => !Object.hasOwn(item, k)) || keys.some((k) => !required.includes(k) && !optional.includes(k))) fail('needsYou item shape');
    str(item.kind, 'needsYou.kind');
    str(item.title, 'needsYou.title');
    str(item.why, 'needsYou.why', { allowEmpty: true });
    str(item.status, 'needsYou.status');
    if (Object.hasOwn(item, 'expiresWhen') && item.expiresWhen !== null) str(item.expiresWhen, 'needsYou.expiresWhen');
    if (Object.hasOwn(item, 'stale') && typeof item.stale !== 'boolean') fail('needsYou.stale');
  }

  arr(s.loop, 'loop');
  for (const stage of s.loop) {
    exactKeys(stage, ['id', 'name', 'state', 'label', 'value'], 'loop stage');
    str(stage.id, 'loop.id');
    str(stage.name, 'loop.name');
    str(stage.state, 'loop.state');
    str(stage.label, 'loop.label', { allowEmpty: true });
    if (typeof stage.value === 'string') str(stage.value, 'loop.value', { allowEmpty: true });
    else count(stage.value, 'loop.value');
  }

  exactKeys(s.traffic, ['views', 'visitors', 'sessions', 'asOf', 'status'], 'traffic');
  if (s.traffic.status !== null) str(s.traffic.status, 'traffic.status');
  const degradedTraffic = s.traffic.status !== 'ok';
  for (const k of ['views', 'visitors', 'sessions']) {
    if (s.traffic[k] === null) {
      if (!degradedTraffic) fail(`traffic.${k}`);
    } else count(s.traffic[k], `traffic.${k}`);
  }
  if (s.traffic.asOf === null) {
    if (!degradedTraffic) fail('traffic.asOf');
  } else str(s.traffic.asOf, 'traffic.asOf');

  exactKeys(s.forms, ['count'], 'forms');
  if (s.forms.count !== null) count(s.forms.count, 'forms.count');

  exactKeys(s.alerts, ['high', 'medium', 'low', 'info'], 'alerts');
  for (const k of ['high', 'medium', 'low', 'info']) count(s.alerts[k], `alerts.${k}`);

  exactKeys(s.revenue, ['status'], 'revenue');
  str(s.revenue.status, 'revenue.status');

  // Rev 2.2: optional Automation panel — array <= 20 items, four strings
  // each <= 500 chars, lastStatus pinned to ok|error|never-run.
  if (Object.hasOwn(s, 'automation')) {
    if (!Array.isArray(s.automation) || s.automation.length > 20) fail('automation');
    for (const job of s.automation) {
      exactKeys(job, ['name', 'schedule', 'lastStatus', 'feeds'], 'automation item');
      str(job.name, 'automation.name');
      str(job.schedule, 'automation.schedule');
      str(job.feeds, 'automation.feeds');
      if (!['ok', 'error', 'never-run'].includes(job.lastStatus)) fail('automation.lastStatus');
    }
  }
}