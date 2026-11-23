#!/usr/bin/env node
// HealthHawk slice 5 — Cold Storage RSC offer extractor (checked-in parser).
// Source: public product pages, raw-cached in runs/raw/5-cs-product-*.html.
// The product payload lives in the self.__next_f RSC flight stream under
// "$L1f" -> {"product": {...}} (verified 2026-11-21 on the Alpen page):
//   productId/name/slug/sku/size/price/promoPrice/isHalal/inventoryStatus/
//   country/storage/metaKeywords — and NO barcode/ingredients/nutrition
//   (re-verified: zero barcode|ean|gtin|upc keys in the whole flight text).
// relatedProducts carousels are NEVER extracted (scope discipline, as 2b).
// __NEXT_DATA__ is handled as a fallback if a future page shape carries it.
//
// Offline by default (raw-cache-first). --fetch pulls missing pages through
// scripts/5-fetch.mjs (<=1 req/2.5s, halt on 403/429, offline work continues).
//
// Usage: node scripts/5-extract.mjs [--fetch]

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, RAW_DIR, fetchOne, LOG_PATH } from './5-fetch.mjs';
import { writeSnapshot, round } from './2b-lib.mjs';
import { isMain } from './is-main.mjs';

export const STORE = 'ColdStorage';
export const OZ_TO_G = 28.3495;

// ---------- RSC flight parsing ----------

// Concatenate the unescaped __next_f push([1,"..."]) string chunks.
export function flightText(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { chunks.push(JSON.parse(m[1])); } catch { /* malformed chunk — skip */ }
  }
  return chunks.join('');
}

// Balanced-brace object extraction for `"key":{...}` inside flight text
// (string/escape aware — never fooled by braces inside strings).
export function extractFlightObject(text, key) {
  const needle = `"${key}":{`;
  let idx = text.indexOf(needle);
  while (idx >= 0) {
    const start = text.indexOf('{', idx);
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const raw = text.slice(start, i + 1);
          try { return JSON.parse(raw); } catch { break /* try next occurrence */ }
        }
      }
    }
    idx = text.indexOf(needle, idx + needle.length);
  }
  return null;
}

export function getNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// Main product ONLY: prefer the payload whose slug matches the page slug;
// fall back to the first product-shaped object with name+price+slug.
export function parseProductPayload(html, pageSlug = null) {
  const nd = getNextData(html);
  if (nd) {
    const p = nd?.props?.pageProps?.product ?? nd?.props?.pageProps?.data?.product;
    if (p && p.name && p.price != null) return { product: p, format: '__NEXT_DATA__' };
  }
  const fl = flightText(html);
  if (!fl) return { product: null, format: null, gap: 'no __next_f flight chunks found' };
  const candidates = [];
  const needle = '"product":{';
  let idx = fl.indexOf(needle);
  while (idx >= 0) {
    const obj = extractFlightObject(fl.slice(idx), 'product');
    if (obj && obj.name && obj.price != null && obj.slug) candidates.push(obj);
    idx = fl.indexOf(needle, idx + needle.length);
  }
  if (candidates.length === 0) return { product: null, format: 'rsc-flight', gap: 'no product object in flight text' };
  const bySlug = pageSlug ? candidates.find((c) => c.slug === pageSlug) : null;
  return { product: bySlug ?? candidates[0], format: 'rsc-flight', matchedBySlug: Boolean(bySlug) };
}

// ---------- pack size (retailer-stated only; oz converted, never invented) ----------

// Returns { grams, text, source, notes, ambiguous }. Multipack "N x Mg" /
// "Ns x Mg", single "Mg"/"Mkg"/"Moz". oz -> g at 28.3495 (labelled conversion).
// A single pack > 2000g is implausible for cereal (slug "115oz" = likely
// 11.5oz with the dot dropped) -> ambiguous, NEVER silently accepted.
export function parseCsPack(text, source) {
  if (typeof text !== 'string' || !text.trim()) return { grams: null, text: text ?? null, source, notes: [], ambiguous: 'no pack size stated' };
  const s = text.trim().replace(/-/g, ' ').replace(/\s+/g, ' ');
  const notes = [];
  // Retailer-stated gram equivalent wins over oz conversion:
  // "10.5oz (297g)" -> 297g exactly as the retailer states it. Only for oz
  // packs — a parenthetical on a gram pack ("1kg (2 x 500g)") is not a total.
  const paren = /oz/i.test(s) ? s.match(/\(\s*([\d.]+)\s*(kg|g)\s*\)/i) : null;
  if (paren) {
    const grams = round(parseFloat(paren[1]) * (/kg/i.test(paren[2]) ? 1000 : 1), 1);
    notes.push(`pack stated in oz with retailer gram equivalent "${paren[0]}" — stated grams used, no conversion`);
    return { grams, text: text.trim(), source, notes, ambiguous: null };
  }
  const toG = (n, unit) => {
    if (/kg/i.test(unit)) return n * 1000;
    if (/oz/i.test(unit)) { notes.push(`pack stated in oz — converted at 1 oz = ${OZ_TO_G} g (labelled conversion)`); return round(n * OZ_TO_G, 1); }
    return n; // g (ml never reaches cereal scope)
  };
  let m = s.match(/^(\d+)\s*s?\s*[x×]\s*([\d.]+)\s*(kg|g|oz)\b/i);
  if (m) {
    const grams = round(parseInt(m[1], 10) * toG(parseFloat(m[2]), m[3]), 1);
    return { grams, text: text.trim(), source, notes, ambiguous: null };
  }
  // "6s 170g" — retailer-stated count + per-unit mass (no 'x' separator).
  m = s.match(/^(\d+)\s*s\s+([\d.]+)\s*(kg|g|oz)\b/i);
  if (m) {
    const grams = round(parseInt(m[1], 10) * toG(parseFloat(m[2]), m[3]), 1);
    notes.push(`pack stated as "${text.trim()}" — read as ${m[1]} x ${m[2]}${m[3]} (retailer count + per-unit mass)`);
    return { grams, text: text.trim(), source, notes, ambiguous: null };
  }
  m = s.match(/^([\d.]+)\s*(kg|g|oz)\b/i);
  if (m) {
    const grams = round(toG(parseFloat(m[1]), m[2]), 1);
    if (grams > 2000) return { grams: null, text: text.trim(), source, notes, ambiguous: `single pack ${text.trim()} = ${grams}g is implausible (>2kg) — likely a dropped decimal point; needs human confirmation` };
    return { grams, text: text.trim(), source, notes, ambiguous: null };
  }
  // Embedded fallback for verbatim NAMES ("Quaker Instant Oatmeal 800g + 100g"
  // -> first stated mass 800g; the "+ 100g" bonus is not the base pack).
  m = s.match(/(\d+)\s*s?\s*[x×]\s*([\d.]+)\s*(kg|g|oz)\b/i);
  if (m) {
    const grams = round(parseInt(m[1], 10) * toG(parseFloat(m[2]), m[3]), 1);
    notes.push(`pack read from embedded multipack "${m[0]}" in ${source}`);
    return { grams, text: m[0], source, notes, ambiguous: null };
  }
  m = s.match(/(\d+)\s*s\s+([\d.]+)\s*(kg|g|oz)\b/i);
  if (m) {
    const grams = round(parseInt(m[1], 10) * toG(parseFloat(m[2]), m[3]), 1);
    notes.push(`pack read from embedded count form "${m[0]}" in ${source} — ${m[1]} x ${m[2]}${m[3]}`);
    return { grams, text: m[0], source, notes, ambiguous: null };
  }
  m = s.match(/([\d.]+)\s*(kg|g|oz)\b/i);
  if (m) {
    const grams = round(toG(parseFloat(m[1]), m[2]), 1);
    if (grams > 2000) return { grams: null, text: text.trim(), source, notes, ambiguous: `single pack ${m[0]} = ${grams}g is implausible (>2kg) — likely a dropped decimal point; needs human confirmation` };
    notes.push(`pack read from embedded "${m[0]}" in ${source}`);
    return { grams, text: m[0], source, notes, ambiguous: null };
  }
  return { grams: null, text: text.trim(), source, notes, ambiguous: `pack size "${text.trim()}" not parseable as a mass` };
}

// Resolution: retailer `size` field first, then the verbatim product name,
// then the slug. Discrepancies are flagged, never averaged.
export function resolveCsPack(product, slug) {
  const tries = [
    parseCsPack(product?.size, 'size field'),
    parseCsPack(product?.name, 'product name'),
    parseCsPack(slug?.replace(/-/g, ' '), 'slug'),
  ];
  const notes = [];
  let picked = null;
  for (const t of tries) {
    notes.push(...t.notes);
    if (t.grams != null && !picked) picked = t;
    else if (t.grams != null && picked && t.grams !== picked.grams) {
      notes.push(`${t.source} states ${t.grams}g but ${picked.source} states ${picked.grams}g — ${picked.source} used; flagged for review`);
    }
  }
  if (!picked) {
    const amb = tries.find((t) => t.ambiguous)?.ambiguous ?? 'no retailer-stated pack mass found';
    return { packSize: product?.size ?? null, packSizeGrams: null, source: null, notes, ambiguous: amb };
  }
  return { packSize: product?.size ?? picked.text, packSizeGrams: picked.grams, source: picked.source, notes, ambiguous: null };
}

// ---------- offer extraction ----------

export function extractOffer(html, { url, fetchedAt, slug }) {
  const { product, format, gap, matchedBySlug } = parseProductPayload(html, slug);
  if (!product) return { ok: false, url, slug, fetchedAt, format, gap: gap ?? 'no product payload' };
  const pack = resolveCsPack(product, slug ?? product.slug);
  const price = typeof product.price === 'number' ? product.price : null;
  const promoPrice = typeof product.promoPrice === 'number' ? product.promoPrice : null;
  const effective = promoPrice != null && promoPrice > 0 && price != null && promoPrice < price ? promoPrice : price;
  const out = {
    ok: true, url, slug: slug ?? product.slug, fetchedAt, format, matchedBySlug: matchedBySlug ?? null,
    productId: product.productId ?? null, sku: product.sku ?? null,
    name: product.name, size: product.size ?? null,
    price, promoPrice, effectivePrice: effective,
    onPromo: promoPrice != null && price != null && promoPrice > 0 && promoPrice < price,
    isHalal: product.isHalal === true ? true : product.isHalal === false ? false : null,
    inventoryStatus: product.inventoryStatus ?? null,
    country: product.country ?? null, storage: product.storage ?? null,
    metaKeywords: product.metaKeywords ?? null,
    pack,
    barcodeFieldsPresent: false, // re-verified per page below
    notes: [...pack.notes],
  };
  const fl = flightText(html);
  out.barcodeFieldsPresent = /"(barcode|ean|gtin|upc)[^"]*"\s*:/i.test(fl);
  if (out.barcodeFieldsPresent) out.notes.push('UNEXPECTED barcode-like key in flight — inspect before any barcode claim');
  if (price == null || price <= 0) { out.ok = false; out.gap = 'no usable price in payload'; }
  else if (pack.packSizeGrams == null) { out.ok = false; out.gap = `pack mass not writable: ${pack.ambiguous}`; }
  if (out.inventoryStatus && !/in stock/i.test(out.inventoryStatus)) out.notes.push(`inventoryStatus "${out.inventoryStatus}" — offer recorded with stock state (price still valid as observed)`);
  if (out.ok) {
    out.offer = {
      store: STORE,
      packPrice: effective,
      ...(out.onPromo ? { promoPrice, listPrice: price } : { promoPrice: null, listPrice: price }),
      packSize: pack.packSize,
      packSizeGrams: pack.packSizeGrams,
      pricePer100g: round((effective / pack.packSizeGrams) * 100, 4),
      priceCheckedAt: fetchedAt,
      sourceUrl: url,
      csSku: out.sku, csProductId: out.productId,
      inventoryStatus: out.inventoryStatus,
    };
  }
  return out;
}

// ---------- cache lookup + CLI ----------

export function findPageCache(slug) {
  if (!existsSync(RAW_DIR)) return null;
  const f = readdirSync(RAW_DIR).filter((x) => x.startsWith(`5-cs-product-${slug}-`) && x.endsWith('.html')).sort().pop();
  if (!f) return null;
  const path = resolve(RAW_DIR, f);
  const metaPath = path.replace(/\.html$/, '.meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : { url: `https://coldstorage.com.sg/product/${slug}`, fetchedAt: null };
  return { path, meta };
}

export function extractAll(enumeration) {
  const results = [];
  for (const hit of enumeration.hits) {
    const cache = findPageCache(hit.slug);
    if (!cache) { results.push({ ok: false, url: hit.url, slug: hit.slug, gap: 'no raw cache — fetch required' }); continue; }
    const html = readFileSync(cache.path, 'utf8');
    const r = extractOffer(html, { url: hit.url, fetchedAt: cache.meta.fetchedAt, slug: hit.slug });
    r.rawPath = cache.path;
    r.sitemapLastmod = hit.lastmod ?? null;
    r.keywords = hit.keywords;
    results.push(r);
  }
  return results;
}

if (isMain(import.meta.url)) {
  const doFetch = process.argv.includes('--fetch');
  const enumeration = JSON.parse(readFileSync(resolve(ROOT, 'runs', '5-enumeration.json'), 'utf8'));
  if (doFetch) {
    const log = existsSync(LOG_PATH) ? JSON.parse(readFileSync(LOG_PATH, 'utf8')) : [];
    let halted = false;
    for (const hit of enumeration.hits) {
      if (findPageCache(hit.slug)) continue;
      try { await fetchOne(hit.url, log); } catch (err) {
        console.error(err.message);
        halted = true; // blocker file already written by fetchOne
        break; // halt network; offline extraction of cached pages continues
      }
    }
    if (halted) console.error('NETWORK HALTED — extracting cached pages only (partial-refresh honesty).');
  }
  const results = extractAll(enumeration);
  const ok = results.filter((r) => r.ok);
  const snap = {
    slice: '5', extractedAt: new Date().toISOString(),
    enumerationSource: enumeration.source, sitemapFetchedAt: enumeration.sitemapFetchedAt,
    hits: enumeration.hits.length, extracted: ok.length,
    gaps: results.filter((r) => !r.ok).map((r) => ({ slug: r.slug, gap: r.gap })),
    barcodeFieldsSeen: results.filter((r) => r.barcodeFieldsPresent).map((r) => r.slug),
    results,
  };
  writeSnapshot(`5-extract-${snap.extractedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-')}.json`, snap);
  console.log(`extracted ${ok.length}/${results.length} offers; gaps: ${snap.gaps.length}; barcode fields seen: ${snap.barcodeFieldsSeen.length}`);
  for (const g of snap.gaps) console.log(`  GAP ${g.slug}: ${g.gap}`);
}