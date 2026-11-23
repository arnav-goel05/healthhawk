#!/usr/bin/env node
// HealthHawk slice 5 — rate-limited plain-GET fetcher for Cold Storage PUBLIC
// pages only (sitemap_product.xml + /product/ pages). Rules (PRD §6):
// <=1 req/2.5s (enforced across invocations via runs/5-request-log.json);
// raw bytes saved to runs/raw/5- BEFORE parsing; HALT on 403/429
// (runs/5-blocker-*.json, no retry against block; offline work may continue);
// NEVER any API beyond public pages/sitemap.
//
// Usage: node scripts/5-fetch.mjs <url> [<url> ...]

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RAW_DIR = resolve(ROOT, 'runs', 'raw');
export const LOG_PATH = resolve(ROOT, 'runs', '5-request-log.json');
export const MIN_GAP_MS = 2500;
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const ALLOWED = /^https:\/\/(www\.)?coldstorage\.com\.sg\/(sitemap_product\.xml|product\/[a-z0-9-]+\/?)$/i;

const compact = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadLog() {
  if (!existsSync(LOG_PATH)) return [];
  try { return JSON.parse(readFileSync(LOG_PATH, 'utf8')); } catch { return []; }
}

function labelFor(url) {
  const u = new URL(url);
  if (u.pathname === '/sitemap_product.xml') return '5-cs-sitemap-product';
  const slug = u.pathname.replace(/^\/product\//, '').replace(/\/$/, '');
  return `5-cs-product-${slug}`.slice(0, 140);
}

function recordBlocker(url, fetchedAt, status, reason, runsDir = resolve(ROOT, 'runs')) {
  const p = resolve(runsDir, `5-blocker-${compact(fetchedAt)}.json`);
  writeFileSync(p, JSON.stringify({
    slice: '5', url, fetchedAt, httpStatus: status, reason,
    action: 'halted; no retry against block; freeze last-good + stale badge; alert founder; offline analysis may continue',
  }, null, 2));
  console.error(`BLOCKER recorded: ${p}`);
  return p;
}

// Raw-cache-first: if a cached copy of this URL exists, return it without a
// network request (re-runs are free and never re-hit the retailer).
export function findCache(url, dir = RAW_DIR) {
  const label = labelFor(url);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith(`${label}-`) && (f.endsWith('.html') || f.endsWith('.xml'))).sort();
  const f = files.pop();
  if (!f) return null;
  const path = resolve(dir, f);
  const metaPath = path.replace(/\.(html|xml)$/, '.meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : { url, fetchedAt: null };
  return { path, meta };
}

export async function fetchOne(url, log, { rawDir = RAW_DIR, logPath = LOG_PATH, force = false, runsDir = resolve(ROOT, 'runs') } = {}) {
  if (!ALLOWED.test(url)) throw new Error(`REFUSED (only public coldstorage.com.sg sitemap/product pages allowed): ${url}`);
  if (!force) {
    const cached = findCache(url, rawDir);
    if (cached) {
      console.log(`[cache] ${url} -> ${cached.path}`);
      return { ...cached.meta, rawPath: cached.path, fromCache: true };
    }
  }
  const last = log[log.length - 1];
  if (last) {
    const gap = Date.now() - Date.parse(last.fetchedAt);
    if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
  }
  const fetchedAt = new Date().toISOString();
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml' }, redirect: 'follow' });
  } catch (err) {
    recordBlocker(url, fetchedAt, null, `network error: ${err.message}`, runsDir);
    throw new Error(`HALT: network error fetching ${url}: ${err.message}`);
  }
  if (res.status === 403 || res.status === 429) {
    recordBlocker(url, fetchedAt, res.status, 'bot block — pipeline halted, no retry', runsDir);
    throw new Error(`HALT: HTTP ${res.status} from ${url}. No retry against block.`);
  }
  const body = await res.text();
  const bytes = Buffer.byteLength(body, 'utf8');
  mkdirSync(rawDir, { recursive: true });
  const ext = url.endsWith('.xml') ? 'xml' : 'html';
  const rawPath = resolve(rawDir, `${labelFor(url)}-${compact(fetchedAt)}.${ext}`);
  writeFileSync(rawPath, body); // raw cache BEFORE any parsing
  const entry = { url, fetchedAt, httpStatus: res.status, bytes, rawPath };
  writeFileSync(rawPath.replace(/\.(html|xml)$/, '.meta.json'), JSON.stringify(entry, null, 2));
  log.push(entry);
  writeFileSync(logPath, JSON.stringify(log, null, 2));
  console.log(`[${res.status}] ${url} -> ${rawPath} (${bytes} bytes)`);
  if (!res.ok) {
    recordBlocker(url, fetchedAt, res.status, 'unexpected HTTP status', runsDir);
    throw new Error(`HALT: HTTP ${res.status} from ${url}`);
  }
  return entry;
}

if (isMain(import.meta.url)) {
  const urls = process.argv.slice(2);
  if (urls.length === 0) { console.error('usage: node scripts/5-fetch.mjs <url> [...]'); process.exit(1); }
  for (const u of urls) {
    if (!ALLOWED.test(u)) { console.error(`REFUSED (only public coldstorage.com.sg sitemap/product pages allowed): ${u}`); process.exit(1); }
  }
  const log = loadLog();
  for (const url of urls) {
    try { await fetchOne(url, log); } catch (err) { console.error(err.message); process.exit(2); }
  }
  console.log(`done: ${urls.length} url(s); total network requests logged: ${log.length}`);
}