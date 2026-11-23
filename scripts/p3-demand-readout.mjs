#!/usr/bin/env node
// HealthHawk P3-10 — demand-ranked aisle readout (deterministic, read-only
// against data/). Answers "which aisle to open next?" by combining:
//   1. the request demand queue (runs/demand/queue.json, fed by
//      scripts/p3-demand-sync.mjs from the Hashmeta request form), and
//   2. the EXISTING zero-result search feed — the compare app logs zero-result
//      searches to localStorage["healthhawk_requests_v1"] and collected
//      downloads land in data/requests/requests-*.json (slice 10/13
//      convention, schema {query,timestamp,chip,preset,source}). This script
//      only READS that feed; the app logging behavior is untouched.
//
// Departments are ranked by combined demand volume (requests + zero-result
// searches); products by request count; zero-result terms by search count.
// Unknown products/terms stay honestly "unclassified". Empty sources render
// an honest "no demand yet" readout — demand is never invented.
//
// Usage:
//   node scripts/p3-demand-readout.mjs [--queue runs/demand/queue.json] \
//     [--requests-dir data/requests] [--catalogue data/catalogue.json] \
//     [--out runs/p3-10/demand-readout.json] [--root <dir>]
//
// Writes ONLY the readout .json + .md (machine-guarded to runs/ or pending/).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { DEPARTMENTS } from './departments.config.mjs';
import { inferDepartment, departmentForChip, UNCLASSIFIED } from './p3-demand-infer.mjs';
import { assertWriteScope, guardedWrite } from './p2-skill-scope.mjs';
import { DEFAULT_QUEUE } from './p3-demand-sync.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const READOUT_SCHEMA = 'healthhawk-demand-readout-v1';

// Read the collected zero-result logs (READ-ONLY). Files match the slice-10
// convention requests-*.json; each is an array of {query,timestamp,chip,
// preset,source}. Missing directory / no files → honest empty feed.
export function readZeroResultLogs(requestsDirAbs) {
  if (!existsSync(requestsDirAbs)) return { files: [], entries: [] };
  const files = readdirSync(requestsDirAbs).filter((f) => /^requests-.*\.json$/.test(f)).sort();
  const entries = [];
  for (const f of files) {
    const doc = JSON.parse(readFileSync(resolve(requestsDirAbs, f), 'utf8'));
    for (const e of Array.isArray(doc) ? doc : []) entries.push({ ...e, file: f });
  }
  return { files, entries };
}

// Department for one zero-result entry: the active chip is config evidence
// (chip id → owning department); the shared "all" chip / unknown chips fall
// back to query-text inference; no signal → unclassified.
export function zeroResultDepartment(entry, departments = DEPARTMENTS) {
  const viaChip = departmentForChip(entry?.chip, departments);
  if (viaChip) return { department: viaChip, departmentVia: 'chip' };
  const inf = inferDepartment(entry?.query ?? '', departments);
  return { department: inf.department, departmentVia: inf.via };
}

// Pure deterministic readout builder. `queueEntries` = demand queue entries;
// `zeroResultEntries` = collected zero-result log entries. `catalogue` is
// read-only coverage evidence (which aisles have data today).
export function buildReadout({ queueEntries = [], zeroResultEntries = [], departments = DEPARTMENTS, catalogue = null, now, sources = {} }) {
  const withData = new Set((catalogue?.products ?? []).map((p) => p?.department).filter(Boolean));

  // Department buckets: every configured aisle + the honest unclassified bucket.
  const buckets = new Map();
  for (const id of Object.keys(departments)) {
    buckets.set(id, { department: id, label: departments[id].label, requests: 0, zeroResultSearches: 0, hasData: withData.has(id) });
  }
  buckets.set(UNCLASSIFIED, { department: UNCLASSIFIED, label: 'Unclassified (honest unknown)', requests: 0, zeroResultSearches: 0, hasData: false });
  const bucketOf = (id) => buckets.get(id) ?? buckets.get(UNCLASSIFIED);

  for (const e of queueEntries) bucketOf(e?.department).requests += 1;
  const zrTerms = new Map();
  const sortedZr = [...zeroResultEntries].sort((a, b) =>
    String(a?.timestamp ?? '').localeCompare(String(b?.timestamp ?? ''))
    || String(a?.query ?? '').localeCompare(String(b?.query ?? '')));
  for (const e of sortedZr) {
    const { department } = zeroResultDepartment(e, departments);
    bucketOf(department).zeroResultSearches += 1;
    const q = String(e?.query ?? '').toLowerCase().trim();
    if (!q) continue;
    if (!zrTerms.has(q)) zrTerms.set(q, { query: q, count: 0, department });
    zrTerms.get(q).count += 1;
  }

  const deptRanking = [...buckets.values()]
    .map((b) => ({ ...b, total: b.requests + b.zeroResultSearches }))
    .sort((a, b) => (b.total - a.total) || (b.requests - a.requests) || a.label.localeCompare(b.label));
  deptRanking.forEach((d, i) => { d.rank = i + 1; });

  // Product ranking from request entries (same determinism as p2-ux-demand:
  // count desc, name asc, ean asc). Entries are pre-sorted by submissionId so
  // first-seen name/department are input-order independent.
  const byProduct = new Map();
  const sortedEntries = [...queueEntries].sort((a, b) => String(a.submissionId).localeCompare(String(b.submissionId)));
  for (const e of sortedEntries) {
    const name = e?.name || e?.product || '';
    if (!name) continue;
    const k = e?.ean ?? 'name:' + name.toLowerCase();
    if (!byProduct.has(k)) byProduct.set(k, { ean: e?.ean ?? null, name, count: 0, department: e?.department ?? UNCLASSIFIED });
    byProduct.get(k).count += 1;
  }
  const products = [...byProduct.values()].sort((a, b) =>
    (b.count - a.count) || String(a.name).localeCompare(String(b.name)) || String(a.ean ?? '').localeCompare(String(b.ean ?? '')));

  const zeroResultTerms = [...zrTerms.values()].sort((a, b) => (b.count - a.count) || a.query.localeCompare(b.query));

  const totals = {
    requests: queueEntries.length,
    zeroResultSearches: zeroResultEntries.length,
    combined: queueEntries.length + zeroResultEntries.length,
  };

  // Honest recommendation: the highest-demand aisle WITHOUT catalogue data is
  // the next-aisle candidate. Unclassified demand is surfaced for manual
  // review, never guessed into an aisle. Zero signals → no recommendation.
  let recommendation;
  if (totals.combined === 0) {
    recommendation = 'No demand signals yet (0 requests, 0 zero-result searches). No aisle recommendation can be made honestly — keep collecting.';
  } else {
    const candidate = deptRanking.find((d) => d.total > 0 && !d.hasData && d.department !== UNCLASSIFIED);
    const unclassified = buckets.get(UNCLASSIFIED);
    const unclassifiedTotal = unclassified.requests + unclassified.zeroResultSearches;
    if (candidate) {
      recommendation = `Open ${candidate.label} next: ${candidate.total} demand signal(s) (${candidate.requests} request(s) + ${candidate.zeroResultSearches} zero-result search(es)) and no catalogue coverage today.`
        + (unclassifiedTotal > 0 ? ` ${unclassifiedTotal} unclassified signal(s) need manual review.` : '');
    } else if (unclassifiedTotal > 0 && deptRanking[0].total === unclassifiedTotal) {
      recommendation = `Demand is led by unclassified products (${unclassifiedTotal} signal(s)) — review them manually before choosing an aisle; no configured aisle can be honestly recommended from them.`;
    } else {
      const top = deptRanking.find((d) => d.total > 0);
      recommendation = `All classifiable demand concentrates in aisles already covered (${top.label}). No new-aisle candidate yet.`
        + (unclassifiedTotal > 0 ? ` ${unclassifiedTotal} unclassified signal(s) need manual review.` : '');
    }
  }

  return {
    schema: READOUT_SCHEMA,
    generatedAt: now,
    sources: {
      queue: sources.queue ?? null,
      queueEntries: queueEntries.length,
      zeroResultFiles: sources.zeroResultFiles ?? [],
      zeroResultEntries: zeroResultEntries.length,
    },
    totals,
    departments: deptRanking,
    products,
    zeroResultTerms,
    recommendation,
    honestyNote: 'Demand is never invented. Unknown products/terms are logged as "unclassified"; empty sources render an honest no-demand readout. Zero-result feed is read-only (app logging untouched).',
  };
}

export function readoutMarkdown(doc) {
  const lines = ['# P3-10 — demand-ranked aisle readout', ''];
  lines.push(`Generated: ${doc.generatedAt} · queue: ${doc.sources.queue ?? '—'} · zero-result files: ${doc.sources.zeroResultFiles.length}`);
  lines.push(`Signals: ${doc.totals.requests} request(s) + ${doc.totals.zeroResultSearches} zero-result search(es) = ${doc.totals.combined} combined.`);
  lines.push('');
  lines.push(`**Which aisle to open next:** ${doc.recommendation}`);
  lines.push('');
  lines.push('## Departments ranked by demand volume');
  lines.push('');
  lines.push('| Rank | Department | Requests | Zero-result searches | Total | Covered today |');
  lines.push('|---|---|---|---|---|---|');
  for (const d of doc.departments) {
    lines.push(`| ${d.rank} | ${d.label} | ${d.requests} | ${d.zeroResultSearches} | ${d.total} | ${d.hasData ? 'yes' : 'no'} |`);
  }
  lines.push('');
  lines.push('## Products ranked by request volume');
  lines.push('');
  if (doc.products.length === 0) lines.push('_No rating requests yet._');
  else {
    lines.push('| Rank | Product | EAN | Requests | Department |');
    lines.push('|---|---|---|---|---|');
    doc.products.forEach((p, i) => lines.push(`| ${i + 1} | ${p.name} | ${p.ean ?? '—'} | ${p.count} | ${p.department} |`));
  }
  lines.push('');
  lines.push('## Zero-result search terms (existing feed)');
  lines.push('');
  if (doc.zeroResultTerms.length === 0) lines.push('_No collected zero-result searches yet._');
  else {
    lines.push('| Rank | Query | Searches | Department |');
    lines.push('|---|---|---|---|');
    doc.zeroResultTerms.forEach((t, i) => lines.push(`| ${i + 1} | ${t.query} | ${t.count} | ${t.department} |`));
  }
  lines.push('');
  lines.push(doc.honestyNote);
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const root = resolve(arg('--root') ?? ROOT);
  const queueRel = arg('--queue') ?? DEFAULT_QUEUE;
  const requestsDir = arg('--requests-dir') ?? 'data/requests';
  const catPath = arg('--catalogue') ?? 'data/catalogue.json';
  const outRel = arg('--out') ?? 'runs/p3-10/demand-readout.json';
  // Machine write-scope guard: readout output lives in runs/ or pending/ only.
  assertWriteScope('analyst', outRel);
  const queuePath = resolve(root, queueRel);
  const queueDoc = existsSync(queuePath) ? JSON.parse(readFileSync(queuePath, 'utf8')) : null;
  const { files, entries } = readZeroResultLogs(resolve(root, requestsDir));
  const catalogue = existsSync(resolve(root, catPath)) ? JSON.parse(readFileSync(resolve(root, catPath), 'utf8')) : null;
  const doc = buildReadout({
    queueEntries: queueDoc?.entries ?? [],
    zeroResultEntries: entries,
    catalogue,
    now: new Date().toISOString(),
    sources: { queue: queueRel, zeroResultFiles: files },
  });
  guardedWrite('analyst', outRel, JSON.stringify(doc, null, 2) + '\n', { root });
  guardedWrite('analyst', outRel.replace(/\.json$/, '.md'), readoutMarkdown(doc) + '\n', { root });
  console.log(JSON.stringify({ out: outRel, totals: doc.totals, topDepartments: doc.departments.slice(0, 3), recommendation: doc.recommendation }, null, 2));
}

if (isMain(import.meta.url)) main();