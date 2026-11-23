// HealthHawk slice 2b — shared OFFLINE helpers (zero network in this module).
// Role split per handoff §"Role write scopes": 2b-fetch.mjs = research/sourcing
// (runs/ only), 2b-ingest.mjs = product-matching (catalogue inserts, EAN dedupe),
// 2b-extract.mjs = label-extraction (ingredients/nutrition with provenance).
// Nothing here rates, scores or publishes. Curation is never overwritten.

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalogue } from './validate-catalogue.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RAW_2A = resolve(ROOT, 'runs', 'raw', '2a');
export const RAW_2B = resolve(ROOT, 'runs', 'raw', '2b');
export const CEREAL_CATEGORIES = ['adult-cereals', 'kids-cereals', 'instant-cereals', 'granola--muesli---oats'];
// Founder decision (02a-coverage §6, Option B): prioritise kids + oats/granola
// + instant ranges for product-page extraction.
export const PRIORITY_CATEGORIES = ['kids-cereals', 'instant-cereals', 'granola--muesli---oats'];
export const INGEST_CLASSIFIER = 'agent:2b-ingest';
export const UNCLASSIFIED = 'UNCLASSIFIED';

// Curation protection is by RECORD IDENTITY, not classifier identity (merge-03):
// after the classification sync, classifierId carries the sheet classifier
// (agent:t7-classification), so "classifierId === INGEST_CLASSIFIER" is no
// longer a safe proxy for "machine-ingested, refreshable". The curated
// cornflakes record (founder-approved admission + basis + grade D) is the one
// human-curated record and is NEVER touched by any refresh path.
export const CURATED_EANS = new Set(['8852756304053']);
export const isCuratedRecord = (p) => CURATED_EANS.has(p?.ean);

export const compact = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
export const round = (n, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;

export function getNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export const stripTags = (s) => String(s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// ---------- pack size (retailer-stated values only; never invented) ----------

// Returns { grams, ml, text } or null. Multipack "N x Mg", sachet "Ns Mg",
// single "Mg"/"Mkg". Ambiguous forms ("6s x 20 or 25g", "18 per pack") -> null.
export function parsePackGrams(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim().replace(/-/g, ' ');
  if (/\bor\b/i.test(s)) return null; // ambiguous alternative sizes
  if (/\/\s*[\d.]/.test(s)) return null; // "6 x 20g / 25g" — ambiguous alternatives
  let m = s.match(/(\d+)\s*(?:s\s*)?[x×]\s*([\d.]+)\s*(kg|g|ml)\b/i);
  if (m) {
    const each = parseFloat(m[2]) * (/kg/i.test(m[3]) ? 1000 : 1);
    return { grams: round(parseInt(m[1], 10) * each, 3), ml: /ml/i.test(m[3]), text: text.trim() };
  }
  m = s.match(/^([\d.]+)\s*(kg|g|ml)\b/i);
  if (m) return { grams: round(parseFloat(m[1]) * (/kg/i.test(m[2]) ? 1000 : 1), 3), ml: /ml/i.test(m[2]), text: text.trim() };
  return null;
}

// SAP Product Name carries the total pack mass, e.g. "SUPER NUTREMILL ORIGINAL
// CEREAL 504G" — retailer-stated fallback when DisplayUnit is unparseable.
export function parseSapNameGrams(text) {
  if (typeof text !== 'string') return null;
  const matches = [...text.matchAll(/([\d.]+)\s*(KG|G)\b/gi)];
  if (matches.length === 0) return null;
  const m = matches[matches.length - 1];
  return { grams: round(parseFloat(m[1]) * (/KG/i.test(m[2]) ? 1000 : 1), 3), ml: false, text: m[0] };
}

// Resolution order (all retailer-stated; discrepancies flagged, never averaged):
// 1. DisplayUnit multipack  2. name/slug multipack  3. DisplayUnit single
// 4. Unit Of Weight  5. SAP Product Name. A single-sachet DisplayUnit ("28G")
// never beats an explicitly stated multipack ("15 x 28g").
export function resolvePackSize(md, sku) {
  const du = typeof md?.DisplayUnit === 'string' ? md.DisplayUnit : null;
  const uow = typeof md?.['Unit Of Weight'] === 'string' ? md['Unit Of Weight'] : null;
  const sap = typeof md?.['SAP Product Name'] === 'string' ? md['SAP Product Name'] : null;
  const duParsed = parsePackGrams(du);
  const nameParsed = parsePackGrams(sku?.name) ?? parsePackGrams(sku?.slug);
  const nameSlugText = `${sku?.name ?? ''} ${sku?.slug ?? ''}`.replace(/-/g, ' ');
  const notes = [];
  let picked = null, source = null;
  // "N per pack" + SAP sachet mass: pack mass = count x stated sachet mass
  // (arithmetic on two retailer-stated values; flagged, never silent).
  const countMatch = (du ?? '').match(/^(\d+)\s*(?:per\s*pack|sachets?|s)\b/i);
  const sapParsed = parseSapNameGrams(sap);
  const sapAsSachet = countMatch && sapParsed && sapParsed.grams < 100;
  if (duParsed && /(\d+)\s*(?:s\s*)?[x×]/i.test(du ?? '')) { picked = duParsed; source = 'DisplayUnit'; }
  else if (nameParsed && /(\d+)\s*(?:s\s*)?[x×]/i.test(nameSlugText)) { picked = nameParsed; source = 'name/slug multipack'; }
  else if (duParsed) { picked = duParsed; source = 'DisplayUnit'; }
  else if (parsePackGrams(uow)) { picked = parsePackGrams(uow); source = 'Unit Of Weight'; }
  else if (sapAsSachet) {
    const n = parseInt(countMatch[1], 10);
    picked = { grams: round(n * sapParsed.grams, 3), ml: false, text: `${du} (${sap})` };
    source = 'DisplayUnit count x SAP sachet mass';
    notes.push(`pack mass derived: ${n} x ${sapParsed.grams}g (SAP "${sap}" read as per-sachet; a ${sapParsed.grams}g total for ${n} sachets is implausible) — flagged for review`);
  }
  else if (sapParsed) { picked = sapParsed; source = 'SAP Product Name'; }
  if (!picked) return { packSize: du ?? uow ?? null, packSizeGrams: null, source: null, notes: ['no retailer-stated pack mass found — offer not writable'] };
  if (du && !duParsed && source !== 'DisplayUnit') {
    notes.push(`DisplayUnit "${du}" is not parseable as a pack mass (ambiguous/count-only) — ${source} used`);
  }
  if (duParsed && source !== 'DisplayUnit' && duParsed.grams !== picked.grams) {
    notes.push(`DisplayUnit "${du}" (${duParsed.grams}g) differs from ${source} "${picked.text}" (${picked.grams}g) — multipack wins; flagged for review`);
  }
  if (nameParsed && source === 'DisplayUnit' && nameParsed.grams !== picked.grams) {
    notes.push(`name/slug implies ${nameParsed.grams}g${nameParsed.ml ? ' (ml stated; treated 1:1)' : ''} but retailer DisplayUnit states "${du}" (${picked.grams}g) — retailer unit used; flagged for review`);
  }
  // Embedded single size in name/slug (e.g. Triple Fun "…130g…" vs DisplayUnit
  // "6 x 50g" = 300g). Only when no multipack is stated and no hyphen-split
  // decimal ("1-35kg" -> "1 35kg") could misread the token.
  const multipackInName = /(\d+)\s*(?:s\s*)?[x×]/i.test(nameSlugText);
  if (!nameParsed && !multipackInName && !/\d\s+\d/.test(nameSlugText) && source === 'DisplayUnit') {
    const em = nameSlugText.match(/([\d.]+)\s*(kg|g|ml)\b/i);
    if (em) {
      const embedded = round(parseFloat(em[1]) * (/kg/i.test(em[2]) ? 1000 : 1), 3);
      if (embedded !== picked.grams) notes.push(`name/slug states ${embedded}g but retailer DisplayUnit states "${du}" (${picked.grams}g) — retailer unit used; flagged for review`);
    }
  }
  // Unit Of Weight discrepancy (e.g. Koko Krunch packet DisplayUnit/SAP 70g vs
  // UoW 80G) — never silently ignored, never averaged.
  const uowParsed = parsePackGrams(uow);
  if (uowParsed && uowParsed.grams !== picked.grams) {
    notes.push(`Unit Of Weight "${uow}" (${uowParsed.grams}g) differs from ${source} (${picked.grams}g) — retailer ${source} used; flagged for review`);
  }
  if (sapParsed && sapParsed.grams === picked.grams && source !== 'SAP Product Name' && source !== 'DisplayUnit count x SAP sachet mass') {
    notes.push(`SAP Product Name corroborates ${picked.grams}g ("${sap}")`);
  }
  if (picked.ml) notes.push('pack stated in ml — grams treated 1:1 (water-based); flagged for slice 4 beverage classification');
  return { packSize: du ?? picked.text, packSizeGrams: picked.grams, source, notes };
}

// ---------- nutrition extraction (scoped to entity.metaData only) ----------

export function parseNutritionTable(htmlTable) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(htmlTable)) !== null) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) cells.push(stripTags(c[1]));
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

// Anchored core-nutrient patterns. "Trans Fat", "Calories from Fat",
// "Soluble/Insoluble Fibre", "Polyunsaturated Fatty Acid" can never match.
const NUTRIENT_MAP = [
  [/^protein\b/i, 'protein'],
  [/^(total\s+)?carbohydrates?\b/i, 'carbohydrate'],
  [/^(total\s+)?sugars?\b/i, 'sugars'],
  [/^of\s+which\s+sugars\b/i, 'sugars'],
  [/^(total\s+)?saturated\s+fat\b/i, 'saturated_fat'],
  [/^of\s+which\s+saturates\b/i, 'saturated_fat'],
  [/^(total\s+)?fat\b/i, 'fat'],
  [/^(total\s+)?(dietary\s+)?fib(re|er)\b/i, 'fibre'],
  [/^sodium\b/i, 'sodium'],
  [/^salt\b/i, 'salt'],
];

export function parseQuantity(text) {
  const m = String(text).match(/([\d.]+)\s*(kJ|kcal|cal|mg|g)\b/i);
  if (!m) return null;
  const u = m[2].toLowerCase();
  const unit = u === 'kj' ? 'kJ' : (u === 'kcal' || u === 'cal') ? 'kcal' : u;
  return { value: parseFloat(m[1]), unit, wroteCal: u === 'cal' };
}

const SERVING_RE = /per\s+serving\s*\(?\s*([\d.]+)\s*(g|gram|ml)\s*\)?/i;

// Returns { nutrition, rows, gap, notes }. Rules:
// - FairPrice panels are per-serving. per100g derived ONLY from a STATED
//   serving (tier estimated-derived). No serving -> per100g null (honest gap).
// - A stated 100g serving (Rolled Oats, Weet-Bix, ...) IS per-100g directly:
//   tier 'exact', never re-derived, never 'estimated' (02a-review minor 4).
// - A panel headed "Per 100g" is directly-stated per-100g (tier exact).
// - energy_kj arithmetically derived from stated kcal (x4.184) when kJ absent
//   -> tier estimated-derived, formula recorded. Nothing else is gap-filled.
export function extractNutrition(md) {
  const notes = [];
  const tableHtml = md?.['Nutritional Data'];
  if (typeof tableHtml !== 'string' || !/<t[rd]/i.test(tableHtml)) {
    return { nutrition: null, rows: [], gap: 'no Nutritional Data HTML table in product metaData', notes };
  }
  const rows = parseNutritionTable(tableHtml);
  const header = rows[0]?.join(' ') ?? '';
  const per100gHeader = /per\s*100\s*(g|gram|ml)/i.test(header);
  const perServing = {};
  let servingSizeG = null, servingDescription = null;

  const hm = header.match(SERVING_RE);
  if (hm) { servingSizeG = parseFloat(hm[1]); servingDescription = header.trim(); }
  for (const cells of rows) {
    const name = (cells[0] ?? '').trim();
    if (/^per\s+serving$/i.test(name) || /^serving(\s+size)?$/i.test(name)) {
      const qtyText = cells.slice(1).find((c) => /[\d.]+\s*(g|gram|ml)\b/i.test(c));
      const sm = qtyText?.match(/([\d.]+)\s*(g|gram|ml)\b/i);
      if (sm) { servingSizeG = parseFloat(sm[1]); servingDescription = `${name}: ${qtyText}`; }
    }
  }
  if (!servingSizeG) {
    const sm = stripTags(tableHtml).match(/serving\s*size\s*[:\-]?\s*([\d.]+)\s*(g|gram|ml)\b/i);
    if (sm) { servingSizeG = parseFloat(sm[1]); servingDescription = `Serving size: ${sm[1]}${sm[2]}`; }
  }
  for (const key of ['Serving Size', 'Serving']) {
    if (!servingSizeG && typeof md[key] === 'string') {
      const sm = md[key].match(/([\d.]+)\s*(g|gram|ml)\b/i);
      if (sm) { servingSizeG = parseFloat(sm[1]); servingDescription = `${key}: ${md[key]}`; }
    }
  }

  for (const cells of rows) {
    const name = (cells[0] ?? '').trim();
    if (!name || /^attributes$/i.test(name) || /^per\s+serving/i.test(name) || /^serving(\s+size)?$/i.test(name)) continue;
    const qtyText = cells.slice(1).find((c) => /[\d.]/.test(c));
    if (!qtyText) continue;
    if (/^energy$|^calories$/i.test(name)) {
      for (const cell of cells.slice(1)) {
        for (const qm of String(cell).matchAll(/([\d.]+)\s*(kJ|kcal|cal)\b/gi)) {
          const u = qm[2].toLowerCase();
          if (u === 'kj') perServing.energy_kj = { value: parseFloat(qm[1]), unit: 'kJ', provenanceTier: 'label-declared' };
          else {
            perServing.energy_kcal = { value: parseFloat(qm[1]), unit: 'kcal', provenanceTier: 'label-declared' };
            if (u === 'cal') notes.push(`retailer writes "${qm[0]}" — interpreted as kcal (food Calories)`);
          }
        }
        if (!perServing.energy_kj && !perServing.energy_kcal && /^[\d.]+$/.test(cell.trim())) {
          perServing.energy_kcal = { value: parseFloat(cell.trim()), unit: 'kcal', provenanceTier: 'label-declared' };
          notes.push(`"${name} ${cell.trim()}" has no unit — interpreted as kcal (US Calories convention)`);
        }
      }
      continue;
    }
    for (const [re, key] of NUTRIENT_MAP) {
      if (re.test(name)) {
        const q = parseQuantity(qtyText);
        if (q && !(key in perServing)) {
          perServing[key] = { value: q.value, unit: q.unit, provenanceTier: 'label-declared' };
          if (q.wroteCal) notes.push(`${name}: retailer writes "cal" — interpreted as kcal`);
        }
        break;
      }
    }
  }

  if (Object.keys(perServing).length === 0) return { nutrition: null, rows, gap: 'nutrition table present but no core nutrients parsed', notes };

  const direct100 = per100gHeader || servingSizeG === 100;
  let per100g = null;
  let basis = 'per-serving';
  let gap = null;
  if (direct100) {
    basis = per100gHeader ? 'per-100g (panel headed per 100g)' : 'per-100g (stated 100g serving)';
    per100g = {};
    for (const [k, e] of Object.entries(perServing)) per100g[k] = { value: e.value, unit: e.unit, provenanceTier: 'exact' };
    if (servingSizeG === 100) notes.push('stated 100g serving — panel values ARE per-100g directly (tier exact; never re-derived, never estimated)');
  } else if (servingSizeG && servingSizeG > 0) {
    per100g = {};
    for (const [k, e] of Object.entries(perServing)) {
      per100g[k] = { value: round((e.value * 100) / servingSizeG), unit: e.unit, provenanceTier: 'estimated-derived' };
    }
  } else {
    gap = 'serving size not stated on page — per-100g not derivable from this source; enrichment (OFF/OCR) needed';
  }
  if (per100g && per100g.energy_kcal && !per100g.energy_kj) {
    per100g.energy_kj = { value: Math.round(per100g.energy_kcal.value * 4.184), unit: 'kJ', provenanceTier: 'estimated-derived' };
    notes.push('energy_kj derived from stated kcal (kcal x 4.184, rounded to whole kJ) — tier estimated-derived');
  }
  if (perServing.sodium && perServing.sodium.unit !== 'mg') notes.push(`sodium stated in ${perServing.sodium.unit} (retailer unit anomaly) — kept verbatim, flagged for slice 6 sanity check`);

  return {
    nutrition: {
      basis,
      servingSizeG: servingSizeG ?? null,
      ...(servingSizeG ? { servingSizeProvenanceTier: 'label-declared' } : {}),
      servingDescription,
      perServing,
      per100g,
      ...(gap ? { gap } : {}),
    },
    rows,
    gap,
    notes,
  };
}

// Full label extraction from one entity.metaData. Halal = retailer Dietary
// Attribute ONLY, never inferred from ingredients.
export function extractFromMetaData(md, { sourceUrl, fetchedAt }) {
  const ingredientsText = typeof md?.Ingredients === 'string' && md.Ingredients.trim() ? md.Ingredients.trim() : null;
  const { nutrition, rows, gap, notes } = extractNutrition(md ?? {});
  const dietary = Array.isArray(md?.['Dietary Attributes']) ? md['Dietary Attributes'] : [];
  const halalStatus = dietary.some((d) => /^halal$/i.test(String(d).trim())) ? 'certified' : 'unknown';
  return {
    ingredients: ingredientsText ? { text: ingredientsText, provenanceTier: 'label-declared', sourceUrl, fetchedAt } : null,
    nutrition,
    halal: {
      status: halalStatus,
      basis: halalStatus === 'certified' ? 'FairPrice Dietary Attributes lists Halal' : 'no Halal certification attribute on FairPrice page — never inferred from ingredients',
      sourceUrl,
    },
    dietaryAttributes: dietary,
    rows,
    gap,
    notes,
  };
}

// ---------- cache + listing lookup (offline) ----------

export function findProductCache(slug) {
  const dirs = [
    { dir: RAW_2B, origin: 'product-page-2b' },
    { dir: RAW_2A, origin: 'product-page-2a' },
  ];
  for (const { dir, origin } of dirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.startsWith(`fairprice-product-${slug}-`) && f.endsWith('.html')).sort();
    const f = files.pop();
    if (!f) continue;
    const path = resolve(dir, f);
    const metaPath = path.replace(/\.html$/, '.meta.json');
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : { url: `https://www.fairprice.com.sg/product/${slug}`, fetchedAt: null };
    return { path, meta, origin };
  }
  if (slug === 'kelloggs-cereal-cornflakes-275g-494617') {
    const stageA = resolve(ROOT, 'runs', 'raw', 'fairprice-kelloggs-cornflakes-275g-20261120-111225Z.html');
    if (existsSync(stageA)) {
      const metaPath = stageA.replace(/\.html$/, '.meta.json');
      return { path: stageA, meta: JSON.parse(readFileSync(metaPath, 'utf8')), origin: 'product-page-stageA' };
    }
  }
  return null;
}

// The 2a category caches carry the SAME entity.metaData server-rendered in the
// ProductCollection payload — a legitimate offline extraction source for SKUs
// without a product-page cache (source cited as the category page observed).
export function listingIndex() {
  const byEan = new Map();
  const categories = [];
  for (const slug of CEREAL_CATEGORIES) {
    const files = readdirSync(RAW_2A).filter((f) => f.startsWith(`fairprice-category-${slug}-`) && f.endsWith('.html') && !/-page-\d+-/.test(f)).sort();
    const f = files.pop();
    if (!f) continue;
    const path = resolve(RAW_2A, f);
    const meta = JSON.parse(readFileSync(path.replace(/\.html$/, '.meta.json'), 'utf8'));
    const d = getNextData(readFileSync(path, 'utf8'));
    const page = d?.props?.pageProps?.data?.data?.page;
    const col = (page?.layouts ?? []).find((l) => l.name === 'ProductCollection')?.value?.collection;
    if (!col) continue;
    const department = page?.entity?.primaryCategory?.parentCategory?.name ?? page?.entity?.primaryCategory?.name ?? 'Breakfast';
    categories.push({ slug, url: meta.url, fetchedAt: meta.fetchedAt, department });
    for (const pr of col.product ?? []) {
      const ean = (pr.barcodes ?? []).map(String).find((b) => /^\d{8,14}$/.test(b));
      if (!ean || byEan.has(ean)) continue;
      byEan.set(ean, { ean, slug: pr.slug, md: pr.metaData ?? {}, price: pr.final_price ?? null, categoryUrl: meta.url, categoryFetchedAt: meta.fetchedAt, department, rawPath: path });
    }
  }
  return { byEan, categories };
}

// ---------- canary-gated catalogue write (same pattern as fetch-product) ----------

export function canaryWriteCatalogue(nextCat, { label }) {
  const catPath = resolve(ROOT, 'data', 'catalogue.json');
  const before = readFileSync(catPath, 'utf8');
  const preErrors = validateCatalogue(nextCat);
  if (preErrors.length > 0) {
    console.error(`CANARY FAIL (pre-write, ${label}):`);
    for (const e of preErrors) console.error(`  - ${e}`);
    throw new Error('write aborted — catalogue unchanged.');
  }
  const backup = resolve(ROOT, 'runs', `catalogue-backup-${compact(nextCat.updatedAt)}.json`);
  writeFileSync(backup, before);
  writeFileSync(catPath, JSON.stringify(nextCat, null, 2) + '\n');
  const postErrors = validateCatalogue(JSON.parse(readFileSync(catPath, 'utf8')));
  if (postErrors.length > 0) {
    copyFileSync(backup, catPath);
    console.error(`CANARY FAIL (post-write, ${label}) — rolled back:`);
    for (const e of postErrors) console.error(`  - ${e}`);
    throw new Error('write rolled back.');
  }
  console.log(`catalogue write OK (canary pre+post passed, ${label}): ${nextCat.products.length} product(s)`);
  return { catPath, backup };
}

export function writeSnapshot(name, payload) {
  const p = resolve(ROOT, 'runs', name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(payload, null, 2) + '\n');
  console.log(`snapshot: ${p}`);
  return p;
}