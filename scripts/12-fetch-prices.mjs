#!/usr/bin/env node
// HealthHawk slice 12 — daily price-refresh sampler (research/sourcing role).
// Fetches a SMALL live sample: <=10 FairPrice product pages (catalogue
// sourceUrls) + <=3 Cold Storage product pages. FOS-09: the sample rotates
// by SGT date (curated pinned daily; the rest covered within a bounded
// cycle — see selectSample/rotationCycle). Rules (PRD §6, ToS):
//   - <=1 req/2.5s per store, enforced across invocations via
//     runs/12-request-log.json (FairPrice) + runs/12-cs-request-log.json (CS);
//   - public /product/ pages ONLY (allowlist refuses anything else);
//   - raw-cache-first: a page already fetched TODAY (SGT) is reused offline;
//     raw bytes cached in runs/raw/12-* BEFORE any parsing;
//   - HALT on 403/429/network error: runs/stale-state.json {stale:true,...}
//     + runs/12-alert-*.json, NO retry, NO further requests, freeze last-good
//     (12-sync refuses to plan writes while stale);
//   - successful live run clears stale-state (file removed; absent = fresh);
//     stale-state/alert writes are ATOMIC (tmp+rename); corrupt request logs
//     fail CLOSED (no network without a trustworthy pacing log);
//   - READ-ONLY against the catalogue: observed prices are diffed against
//     catalogue offers and reported (runs/12-price-sample-*.json); catalogue
//     refresh writes stay with the validated fetch/refresh scripts.
//
// Usage: node scripts/12-fetch-prices.mjs [--fp-limit 10] [--cs-limit 3] [--offline]
// Exit codes: 0 ok · 2 halted (block) · 1 usage/parse failure.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNextData } from './2b-lib.mjs';
import { extractOffer } from './5-extract.mjs';
import { isMain } from './is-main.mjs';
// Slice 15 DATA FREEZE guard (additions only): while frozen, the refresh cron
// may RUN but this script performs NO fetch and NO writes (exit 0 + note).
import { readFreeze, freezeRefusal } from './12-sync.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MIN_GAP_MS = 2500;
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const FP_ALLOW = /^https:\/\/www\.fairprice\.com\.sg\/product\/[a-z0-9-]+\/?$/i;
export const CS_ALLOW = /^https:\/\/(www\.)?coldstorage\.com\.sg\/product\/[a-z0-9-]+\/?$/i;
export const STORES = {
  FairPrice: { allow: FP_ALLOW, log: '12-request-log.json', rawPrefix: '12-fairprice-' },
  ColdStorage: { allow: CS_ALLOW, log: '12-cs-request-log.json', rawPrefix: '12-cs-' },
};
const compact = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sgtDate = (iso) => new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 10);
const slugOf = (url) => new URL(url).pathname.replace(/^\/product\//, '').replace(/\/$/, '');

// FOS-09 date-seeded rotation (sampler-only): the curated flagship stays
// pinned first (daily check — existing contract); the REMAINING daily budget
// rotates through the rest of the eligible universe in consecutive
// day-indexed chunks, so every target is re-checked within a bounded cycle
// of ceil(rest / rotationBudget) days. Same date + catalogue → same sample.
// Rotation only changes WHICH SKUs are sampled — rate limits, daily budget,
// halt-on-block and the freeze guard are untouched, and freshness stamps
// still come only from real fetch evidence (the existing offer-stamp
// mechanism downstream — this script never writes freshness fields).
const CURATED_EAN = '8852756304053';
const dayIndexOf = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);

// Canonical eligible universe for a store: curated first, then rated
// (EAN asc), then the rest; one target per unique allowlisted sourceUrl.
export function rotationUniverse(cat, store) {
  const rank = (p) => (p.ean === CURATED_EAN ? 0 : p.score?.grade ? 1 : 2);
  const sorted = [...cat.products].sort((a, b) => rank(a) - rank(b) || String(a.ean).localeCompare(String(b.ean)));
  const out = [];
  const seen = new Set();
  for (const p of sorted) {
    const o = (p.offers ?? []).find((x) => x.store === store && x.sourceUrl && STORES[store].allow.test(x.sourceUrl));
    if (!o || seen.has(o.sourceUrl)) continue;
    seen.add(o.sourceUrl);
    out.push({ ean: String(p.ean), name: p.name, url: o.sourceUrl, slug: slugOf(o.sourceUrl), offer: o });
  }
  return out;
}

// Cycle math per store: cycleDays = ceil(rest / rotationBudget); null means
// the non-curated tail is unreachable at this budget (honest, never silent).
export function rotationCycle(cat, { fpLimit = 10, csLimit = 3 } = {}) {
  const info = (store, limit) => {
    const universe = rotationUniverse(cat, store);
    const pinned = universe.filter((t) => t.ean === CURATED_EAN).length;
    const rest = universe.length - pinned;
    const budget = Math.max(0, limit - pinned);
    return { targets: universe.length, pinned, rotationBudget: budget, cycleDays: rest === 0 ? 0 : budget > 0 ? Math.ceil(rest / budget) : null };
  };
  return { FairPrice: info('FairPrice', fpLimit), ColdStorage: info('ColdStorage', csLimit) };
}

// Deterministic per-date sample: pinned curated + the day's rotation chunk.
export function selectSample(cat, { fpLimit = 10, csLimit = 3, date = sgtDate(new Date().toISOString()) } = {}) {
  const pick = (store, limit) => {
    if (limit <= 0) return [];
    const universe = rotationUniverse(cat, store);
    const pinned = universe.filter((t) => t.ean === CURATED_EAN);
    const rest = universe.filter((t) => t.ean !== CURATED_EAN);
    const budget = limit - pinned.length;
    if (budget <= 0 || rest.length === 0) return universe.slice(0, limit);
    const cycleDays = Math.ceil(rest.length / budget);
    const slot = ((dayIndexOf(date) % cycleDays) + cycleDays) % cycleDays;
    return [...pinned, ...rest.slice(slot * budget, slot * budget + budget)];
  };
  return { FairPrice: pick('FairPrice', fpLimit), ColdStorage: pick('ColdStorage', csLimit) };
}

// Pure FairPrice price parse — barcode-matched ProductDetail layout ONLY
// (related-product carousels carry their own prices and must never leak).
export function parseFpPrice(html) {
  const d = getNextData(html);
  const page = d?.props?.pageProps?.product?.data?.page;
  const entity = page?.entity;
  if (!entity) return { ok: false, gap: 'no __NEXT_DATA__ product entity (site redesign?)' };
  const ean = Array.isArray(entity.barcodes) ? entity.barcodes.map(String).find((b) => /^\d{8,14}$/.test(b)) : null;
  if (!ean) return { ok: false, gap: 'no barcode on entity' };
  const detail = (page.layouts ?? []).find((l) => l.name === 'ProductDetail' && l.value?.barcodes?.map(String).includes(ean))?.value;
  const mrp = detail?.storeSpecificData?.[0]?.mrp;
  const packPrice = parseFloat(mrp);
  if (!Number.isFinite(packPrice) || packPrice <= 0) return { ok: false, ean, gap: 'no price on barcode-matched ProductDetail storeSpecificData' };
  return { ok: true, ean, packPrice, pricePath: 'layouts[ProductDetail].value.storeSpecificData[0].mrp' };
}

function findTodayCache(rawDir, store, slug, nowIso) {
  if (!existsSync(rawDir)) return null;
  const prefix = `${STORES[store].rawPrefix}${slug}-`;
  const files = readdirSync(rawDir).filter((f) => f.startsWith(prefix) && f.endsWith('.html')).sort();
  for (const f of files.reverse()) {
    const metaPath = resolve(rawDir, f.replace(/\.html$/, '.meta.json'));
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (meta.fetchedAt && sgtDate(meta.fetchedAt) === sgtDate(nowIso)) return { path: resolve(rawDir, f), meta };
  }
  return null;
}

function loadLog(path) {
  if (!existsSync(path)) return [];
  // Fail-CLOSED on corruption (review #8c): without a trustworthy log the
  // cross-invocation pacing guarantee is void — refuse to fetch rather than
  // silently reset the rate limit.
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`HALT: request log corrupt (${path}) — pacing cannot be guaranteed; no network. Repair/archive the log manually.`); }
  if (!Array.isArray(parsed)) throw new Error(`HALT: request log malformed (${path}) — expected an array; no network.`);
  return parsed;
}

// Atomic JSON write (tmp + rename) — a crash mid-write can never leave a
// truncated stale-state/alert behind (T9 flag; review round).
export function atomicWriteJson(path, obj) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path);
}

// Bounded log growth (review #8c): keep the most recent 200 entries in the
// active log; archive the rest verbatim before truncating (audit trail kept).
function persistLog(logPath, log) {
  if (log.length > 1000) {
    const archive = logPath.replace(/\.json$/, `-archive-${compact(new Date().toISOString())}.json`);
    atomicWriteJson(archive, log.slice(0, log.length - 200));
    log.splice(0, log.length - 200);
  }
  atomicWriteJson(logPath, log);
}

// Halt artifacts: stale-state (freeze + stale badge source for the app) and
// the founder alert. lastGoodAt = previous known-good time (never invented).
export function recordHalt(runsDir, { store, url, status, reason, at, lastGoodAt }) {
  mkdirSync(runsDir, { recursive: true });
  // `stale` is the slice-12 sync freeze flag; `freeze` + blockedAt + reason +
  // staleEans:null is the T9 build-app contract (normalizeStaleState) that
  // renders the whole-catalogue stale banner + per-row badges.
  const stale = { stale: true, freeze: true, blockedAt: at, store, url, httpStatus: status, reason, lastGoodAt: lastGoodAt ?? null, staleEans: null, action: 'freeze last-good; stale badge; alert founder; NO retry against block; sync frozen until a successful refresh clears this file' };
  atomicWriteJson(resolve(runsDir, 'stale-state.json'), stale);
  const alertPath = resolve(runsDir, `12-alert-${compact(at)}.json`);
  atomicWriteJson(alertPath, { alert: 'refresh-blocked', ...stale, alertAt: at });
  return { stale, alertPath };
}

// Clear-state on a successful live run: the file is REMOVED — per the T9
// build-app contract an absent runs/stale-state.json means fresh (no banner,
// no badges). The file exists only while a block freeze is active.
export function clearStale(runsDir, at) {
  const p = resolve(runsDir, 'stale-state.json');
  let prev = {};
  if (existsSync(p)) { try { prev = JSON.parse(readFileSync(p, 'utf8')); } catch { prev = { corrupt: true }; } }
  if (existsSync(p)) unlinkSync(p);
  return { stale: false, freeze: false, clearedAt: at, lastGoodAt: at, cleared: 'stale-state.json removed (absent = fresh)', previousBlock: prev.stale === true ? { blockedAt: prev.blockedAt, store: prev.store } : null };
}

const defaultFetchImpl = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
  return { status: res.status, body: await res.text() };
};

// Fetch the sample. fetchImpl is injectable (tests use a synthetic 403/429).
// Returns the sample summary; writes raw caches, logs, sample snapshot,
// stale-state/alert artifacts. NEVER writes the catalogue or the sheet.
export async function fetchSample({ root = ROOT, cat, fpLimit = 10, csLimit = 3, offline = false, fetchImpl = defaultFetchImpl, now = new Date().toISOString(), sleepImpl = sleep } = {}) {
  const runsDir = resolve(root, 'runs');
  const rawDir = resolve(runsDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const startedAt = now;
  const sample = { startedAt, completedAt: null, agent: 'script:12-fetch-prices.mjs', offline, halted: null, observations: [], deltas: [], gaps: [], requests: { FairPrice: 0, ColdStorage: 0 }, cacheReused: 0 };
  const targets = selectSample(cat, { fpLimit, csLimit, date: sgtDate(now) });
  sample.rotation = { date: sgtDate(now), ...rotationCycle(cat, { fpLimit, csLimit }) };
  let prevStale = {};
  const stalePath = resolve(runsDir, 'stale-state.json');
  if (existsSync(stalePath)) { try { prevStale = JSON.parse(readFileSync(stalePath, 'utf8')); } catch { prevStale = {}; } }
  const lastGoodAt = prevStale.lastGoodAt ?? cat.updatedAt ?? null;
  let liveFetches = 0;
  for (const store of ['FairPrice', 'ColdStorage']) {
    if (sample.halted) break;
    const logPath = resolve(runsDir, STORES[store].log);
    const log = loadLog(logPath);
    for (const t of targets[store]) {
      if (sample.halted) break;
      if (!STORES[store].allow.test(t.url)) { sample.gaps.push({ ean: t.ean, store, url: t.url, gap: 'REFUSED by allowlist (public /product/ pages only)' }); continue; }
      let html, fetchedAt, rawPath, fromCache = false;
      const cached = findTodayCache(rawDir, store, t.slug, new Date().toISOString());
      if (cached) {
        html = readFileSync(cached.path, 'utf8'); fetchedAt = cached.meta.fetchedAt; rawPath = cached.path; fromCache = true;
        sample.cacheReused++;
      } else if (offline) {
        sample.gaps.push({ ean: t.ean, store, url: t.url, gap: 'offline mode: no cache for today — skipped (no network)' });
        continue;
      } else {
        const last = log[log.length - 1];
        if (last) {
          const gap = Date.now() - Date.parse(last.fetchedAt);
          if (gap < MIN_GAP_MS) await sleepImpl(MIN_GAP_MS - gap + 5);
        }
        fetchedAt = new Date().toISOString();
        let res;
        try {
          res = await fetchImpl(t.url);
        } catch (err) {
          const { alertPath } = recordHalt(runsDir, { store, url: t.url, status: null, reason: `network error: ${err.message}`, at: fetchedAt, lastGoodAt });
          sample.halted = { store, url: t.url, httpStatus: null, reason: err.message, at: fetchedAt, alertPath };
          break;
        }
        sample.requests[store]++;
        liveFetches++;
        if (res.status === 403 || res.status === 429 || res.status < 200 || res.status >= 300) {
          const { alertPath } = recordHalt(runsDir, { store, url: t.url, status: res.status, reason: res.status === 403 || res.status === 429 ? 'bot block — pipeline halted, no retry' : 'unexpected HTTP status', at: fetchedAt, lastGoodAt });
          sample.halted = { store, url: t.url, httpStatus: res.status, reason: 'halt-on-block', at: fetchedAt, alertPath };
          break;
        }
        html = res.body;
        rawPath = resolve(rawDir, `${STORES[store].rawPrefix}${t.slug}-${compact(fetchedAt)}.html`);
        writeFileSync(rawPath, html); // raw cache BEFORE any parsing
        const entry = { url: t.url, fetchedAt, httpStatus: res.status, bytes: Buffer.byteLength(html, 'utf8'), rawPath, store };
        writeFileSync(rawPath.replace(/\.html$/, '.meta.json'), JSON.stringify(entry, null, 2));
        log.push(entry);
        persistLog(logPath, log);
      }
      // parse (offline-safe)
      let obs;
      if (store === 'FairPrice') {
        const parsed = parseFpPrice(html);
        obs = { ean: t.ean, expectedEan: t.ean, store, url: t.url, fetchedAt, rawPath, fromCache, ok: parsed.ok && parsed.ean === t.ean, packPrice: parsed.ok ? parsed.packPrice : null, gap: parsed.ok ? (parsed.ean === t.ean ? null : `barcode mismatch: page ${parsed.ean} != catalogue ${t.ean}`) : parsed.gap };
      } else {
        const parsed = extractOffer(html, { url: t.url, fetchedAt, slug: t.slug });
        obs = { ean: t.ean, store, url: t.url, fetchedAt, rawPath, fromCache, ok: parsed.ok === true, packPrice: parsed.ok ? parsed.offer.packPrice : null, promoPrice: parsed.ok ? parsed.offer.promoPrice : null, inventoryStatus: parsed.inventoryStatus ?? null, gap: parsed.ok ? null : parsed.gap };
      }
      sample.observations.push(obs);
      if (!obs.ok) { sample.gaps.push({ ean: t.ean, store, url: t.url, gap: obs.gap }); continue; }
      const catOffer = t.offer;
      if (typeof catOffer.packPrice === 'number' && obs.packPrice !== catOffer.packPrice) {
        sample.deltas.push({ ean: t.ean, name: t.name, store, cataloguePrice: catOffer.packPrice, observedPrice: obs.packPrice, delta: Math.round((obs.packPrice - catOffer.packPrice) * 100) / 100, observedAt: fetchedAt, sourceUrl: t.url, rawPath });
      }
    }
  }
  sample.completedAt = new Date().toISOString();
  if (!sample.halted && !offline && liveFetches > 0) sample.staleCleared = clearStale(runsDir, sample.completedAt);
  const samplePath = resolve(runsDir, `12-price-sample-${compact(startedAt)}.json`);
  writeFileSync(samplePath, JSON.stringify(sample, null, 2) + '\n');
  sample.samplePath = samplePath;
  return sample;
}

async function main() {
  const args = process.argv.slice(2);
  // Slice 15 freeze guard — BEFORE any network or write:
  const freeze = readFreeze();
  if (freeze.frozen) {
    const note = freezeRefusal('fetch-prices', freeze);
    console.log(`FROZEN — no fetch, no writes. ${note.message}`);
    process.exit(2); // the daily cron's halt path: review report + finish, no writes
  }
  const arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
  const cat = JSON.parse(readFileSync(resolve(ROOT, 'data', 'catalogue.json'), 'utf8'));
  const sample = await fetchSample({ cat, fpLimit: arg('--fp-limit', 10), csLimit: arg('--cs-limit', 3), offline: args.includes('--offline') });
  console.log(JSON.stringify({ samplePath: sample.samplePath, halted: sample.halted, requests: sample.requests, cacheReused: sample.cacheReused, observations: sample.observations.length, ok: sample.observations.filter((o) => o.ok).length, deltas: sample.deltas, gaps: sample.gaps }, null, 2));
  if (sample.halted) { console.error('HALTED — stale-state + alert written; freeze last-good; no retry.'); process.exit(2); }
}

if (isMain(import.meta.url)) await main();