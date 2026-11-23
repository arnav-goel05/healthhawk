#!/usr/bin/env node
// P2-15 — demand-ranked coverage queue (deterministic, read-only).
// The "Request a rating" CTA on unrated result cards feeds the EXISTING native
// Request-a-product form (Hashmeta form id 2). This script aggregates form
// submissions (+ optional data/requests/ local zero-result logs) into a
// demand-ranked queue: products with the most requests get graded first.
// Never invents demand — empty sources render an honest "none yet" queue.
//
// Usage:
//   node scripts/p2-ux-demand.mjs --submissions runs/p2-15/form-submissions.json \
//     [--catalogue data/catalogue.json] [--out runs/p2-15/demand-queue.json]
//
// Submission shape (MCP list_form_submissions): each item carries answers as
// [{field,value}] (submissionData) or a {product,store,email,notes} object.
// The EAN is parsed from the notes/product text; otherwise the product name is
// matched against the catalogue (case-insensitive) to key the demand.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Normalize one submission's answers into a flat {field: value} map.
export function answersOf(submission) {
  const out = {};
  const arr = submission?.submissionData ?? submission?.answers ?? null;
  if (Array.isArray(arr)) {
    for (const a of arr) {
      const k = a?.field ?? a?.name;
      if (k) out[k] = String(a?.value ?? '');
    }
    return out;
  }
  const data = submission?.data ?? submission ?? {};
  for (const k of ['product', 'store', 'email', 'notes']) {
    if (data[k] != null) out[k] = String(data[k]);
  }
  return out;
}

const EAN_RX = /\b(\d{8,14})\b/;

// Resolve a submission to a catalogue EAN (preferred) or a normalized name key.
export function requestKeyOf(submission, catalogue) {
  const a = answersOf(submission);
  const text = `${a.product ?? ''} ${a.notes ?? ''}`;
  const m = text.match(EAN_RX);
  const products = catalogue?.products ?? [];
  if (m) {
    const byEan = products.find((p) => p.ean === m[1]);
    if (byEan) return { ean: byEan.ean, name: byEan.name, via: 'ean' };
    return { ean: m[1], name: a.product || m[1], via: 'ean-unmatched' };
  }
  const norm = String(a.product ?? '').toLowerCase().trim();
  if (!norm) return null;
  const byName = products.find((p) => String(p.name).toLowerCase().trim() === norm);
  if (byName) return { ean: byName.ean, name: byName.name, via: 'name' };
  return { ean: null, name: a.product, via: 'name-unmatched' };
}

// Build the demand-ranked queue. Deterministic: count desc, then name asc,
// then ean asc. Each entry carries its request count + the source submissions.
// `via` keeps the STRONGEST match seen (ean > name) and submissionIds are sorted,
// so the queue is identical regardless of submission input order.
const VIA_STRENGTH = { ean: 3, 'ean-unmatched': 2, name: 1, 'name-unmatched': 0 };
export function buildDemandQueue(submissions, catalogue) {
  const byKey = new Map();
  const skipped = [];
  for (const s of submissions ?? []) {
    const key = requestKeyOf(s, catalogue);
    if (!key) { skipped.push({ id: s?.id ?? null, reason: 'no product field' }); continue; }
    const k = key.ean ?? 'name:' + key.name.toLowerCase();
    if (!byKey.has(k)) byKey.set(k, { ean: key.ean, name: key.name, via: key.via, count: 0, submissionIds: [] });
    const entry = byKey.get(k);
    entry.count += 1;
    if ((VIA_STRENGTH[key.via] ?? 0) > (VIA_STRENGTH[entry.via] ?? 0)) entry.via = key.via;
    if (s?.id != null) entry.submissionIds.push(s.id);
  }
  const queue = [...byKey.values()].sort((a, b) =>
    (b.count - a.count)
    || String(a.name).localeCompare(String(b.name))
    || String(a.ean ?? '').localeCompare(String(b.ean ?? '')));
  for (const q of queue) q.submissionIds.sort((a, b) => String(a).localeCompare(String(b)));
  return { queue, skipped, total: (submissions ?? []).length };
}

export function demandMarkdown(doc) {
  const lines = ['# P2-15 — demand-ranked coverage queue', ''];
  lines.push(`Generated: ${doc.generatedAt} · source: ${doc.source}`);
  lines.push(`Submissions read: ${doc.total} · distinct requests: ${doc.queue.length} · skipped: ${doc.skipped.length}`);
  lines.push('');
  lines.push('Products with the most rating requests are graded first. Demand is never invented — an empty source renders an honest "none yet" queue.');
  lines.push('');
  if (doc.queue.length === 0) {
    lines.push('_No rating requests yet._');
  } else {
    lines.push('| Rank | Product | EAN | Requests | Matched via |');
    lines.push('|---|---|---|---|---|');
    doc.queue.forEach((q, i) => lines.push(`| ${i + 1} | ${q.name} | ${q.ean ?? '—'} | ${q.count} | ${q.via} |`));
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const subPath = arg('--submissions');
  if (!subPath) { console.error('usage: p2-ux-demand.mjs --submissions <json> [--catalogue <json>] [--out <json>]'); process.exit(1); }
  const subDoc = JSON.parse(readFileSync(resolve(ROOT, subPath), 'utf8'));
  const submissions = Array.isArray(subDoc) ? subDoc : (subDoc.submissions ?? subDoc.items ?? []);
  const catPath = arg('--catalogue') ?? 'data/catalogue.json';
  const catalogue = existsSync(resolve(ROOT, catPath)) ? JSON.parse(readFileSync(resolve(ROOT, catPath), 'utf8')) : { products: [] };
  const { queue, skipped, total } = buildDemandQueue(submissions, catalogue);
  const doc = { generatedAt: new Date().toISOString(), source: subPath, total, queue, skipped };
  const out = arg('--out') ?? 'runs/p2-15/demand-queue.json';
  mkdirSync(dirname(resolve(ROOT, out)), { recursive: true });
  writeFileSync(resolve(ROOT, out), JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(resolve(ROOT, out).replace(/\.json$/, '.md'), demandMarkdown(doc) + '\n');
  console.log(JSON.stringify({ out, total, distinct: queue.length, top: queue.slice(0, 5) }, null, 2));
}

if (isMain(import.meta.url)) main();