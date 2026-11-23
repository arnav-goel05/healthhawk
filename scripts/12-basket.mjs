#!/usr/bin/env node
// HealthHawk slice 12 — weekly healthiest-basket report (analyst role).
// Deterministic: per comparison range, pick the top 5 products by the
// stored Best-value score S among RATED products whose grade carries an
// approved grade-change record (approval gate — never publishes an
// unapproved grade). Basket cost = sum of each pick's cheapest pack price.
// Writes runs/reports/basket-<SGT date>.md; with --queue also writes ONE
// pending/ structural item (status pending, review null) for founder
// visibility. Never publishes, never touches catalogue/sheet/grades.
//
// Usage: node scripts/12-basket.mjs [--queue] [--date 2026-11-21] [--top 5]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPendingQueue, gradeApproved } from './approval-gate.mjs';
import { RANGE_LABELS, RANGE_ORDER } from './4-classify.mjs';
import { primaryOffer } from './12-sync.mjs';
import { isMain } from './is-main.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sgtDate = (iso) => new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 10);
const compact = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');

export function computeBaskets(cat, { queue = [], top = 5 } = {}) {
  const rated = cat.products.filter((p) => p.rated === true && p.score?.grade && typeof p.score?.S?.['best-value'] === 'number');
  const approved = rated.filter((p) => gradeApproved(queue, p.ean, p.score.grade));
  const baskets = [];
  for (const range of RANGE_ORDER) {
    if (range === 'out-of-scope') continue;
    const inRange = approved.filter((p) => p.range === range).sort((a, b) => b.score.S['best-value'] - a.score.S['best-value'] || String(a.ean).localeCompare(String(b.ean)));
    if (inRange.length === 0) continue;
    const picks = inRange.slice(0, top).map((p) => {
      const offer = primaryOffer(p);
      return { ean: p.ean, name: p.name, grade: p.score.grade, S: p.score.S['best-value'], V: p.score.V, packPrice: offer?.packPrice ?? null, packSize: offer?.packSize ?? null, store: offer?.store ?? null, pricePer100g: offer?.pricePer100g ?? null, sourceUrl: offer?.sourceUrl ?? null, priceCheckedAt: offer?.priceCheckedAt ?? null };
    });
    const total = picks.reduce((s, p) => s + (p.packPrice ?? 0), 0);
    baskets.push({ range, label: RANGE_LABELS[range] ?? range, eligible: inRange.length, picks, basketTotal: Math.round(total * 100) / 100 });
  }
  return { baskets, ratedCount: rated.length, approvedCount: approved.length, productCount: cat.products.length, excludedUnapproved: rated.length - approved.length };
}

export function basketMarkdown(res, { date, generatedAt, queued = false }) {
  const L = [];
  L.push(`# Healthiest-basket report — ${date}`);
  L.push('');
  L.push(`Generated: ${generatedAt} · Deterministic script output (scripts/12-basket.mjs) — no LLM discretion in the math.`);
  L.push('');
  L.push(`**Method:** per comparison range, top picks by the stored Best-value score S = 0.3·H + 0.7·V (H = health points, V = value vs the range's cheapest per-100g price). Only RATED products with an APPROVED grade-change record are eligible (approval gate). Basket cost = sum of each pick's cheapest pack price (lowest across stores). Prices carry their check timestamps; always verify in store. Note: unlike the app's Best-value preset — which excludes Hawk Grade D and E products entirely — this basket ranks every approved-rated product by S, so D/E grades can appear in the lower ranges; each pick's grade is shown so the difference is visible.`);
  L.push('');
  L.push(`**Coverage (honest):** ${res.approvedCount}/${res.productCount} products rated+approved (${res.ratedCount} rated, ${res.excludedUnapproved} rated-but-unapproved excluded). Unrated products (incl. Cold Storage-only, price-only data) are browsable but never ranked here. Within-range comparison only — not medical or dietary advice.`);
  for (const b of res.baskets) {
    L.push('');
    L.push(`## ${b.range} — ${b.label} (${b.eligible} eligible)`);
    L.push('');
    L.push(`| # | Product | Grade | S (best-value) | Pack | Pack price | Store | Price checked |`);
    L.push('|---|---|---|---|---|---|---|---|');
    b.picks.forEach((p, i) => L.push(`| ${i + 1} | [${p.name}](https://healthhawk.geo.hashmeta.tech/products/${p.ean}) | ${p.grade} | ${p.S.toFixed(2)} | ${p.packSize ?? '—'} | S$${(p.packPrice ?? 0).toFixed(2)} | ${p.store ?? '—'} | ${String(p.priceCheckedAt ?? '').slice(0, 10)} |`));
    L.push('');
    L.push(`**Basket total: S$${b.basketTotal.toFixed(2)}** (${b.picks.length} packs).`);
  }
  L.push('');
  L.push('---');
  L.push(`Hawk Grades compare products within the same category only. Not medical or dietary advice. Contains information from Open Food Facts (ODbL 1.0). ${queued ? 'Founder visibility item queued in pending/ (structural) — the report itself is never auto-published to the site.' : 'Report only (no --queue): no pending item was created; the report is never auto-published to the site.'}`);
  return L.join('\n') + '\n';
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const now = new Date().toISOString();
  const date = arg('--date') ?? sgtDate(now);
  const top = arg('--top') ? Number(arg('--top')) : 5;
  const cat = JSON.parse(readFileSync(resolve(ROOT, 'data', 'catalogue.json'), 'utf8'));
  const queue = readPendingQueue();
  const res = computeBaskets(cat, { queue, top });
  const md = basketMarkdown(res, { date, generatedAt: now, queued: args.includes('--queue') });
  mkdirSync(resolve(ROOT, 'runs', 'reports'), { recursive: true });
  const reportPath = resolve(ROOT, 'runs', 'reports', `basket-${date}.md`);
  writeFileSync(reportPath, md);
  let itemPath = null;
  if (args.includes('--queue')) {
    const id = `${compact(now)}-structural-healthiest-basket-${date}`;
    itemPath = resolve(ROOT, 'pending', `${id}.json`);
    if (!existsSync(itemPath)) {
      writeFileSync(itemPath, JSON.stringify({
        id, kind: 'structural', createdAt: now, createdBy: 'script:12-basket.mjs (weekly analyst cron)', confidence: 'high',
        summary: `Weekly healthiest-basket report ${date}: ${res.baskets.length} ranges, top-${top} best-value picks per range from ${res.approvedCount} approved-rated products. Founder visibility only — decide whether to feature a basket on the site/blog (11b owns pages). Report: runs/reports/basket-${date}.md`,
        evidence: { report: `runs/reports/basket-${date}.md`, method: 'S = 0.3*H + 0.7*V (best-value preset), approved grades only, cheapest pack price per pick', coverage: { rated: res.ratedCount, approved: res.approvedCount, products: res.productCount }, baskets: res.baskets.map((b) => ({ range: b.range, eligible: b.eligible, total: b.basketTotal, picks: b.picks.map((p) => ({ ean: p.ean, grade: p.grade, S: p.S, packPrice: p.packPrice })) })) },
        status: 'pending', review: null,
      }, null, 2) + '\n');
    }
  }
  console.log(JSON.stringify({ reportPath, itemPath, ranges: res.baskets.length, approved: res.approvedCount, totals: res.baskets.map((b) => ({ range: b.range, total: b.basketTotal })) }, null, 2));
}

if (isMain(import.meta.url)) main();