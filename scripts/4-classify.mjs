// HealthHawk slice 4 — taxonomy & classification module (classification role).
// Three-key model (PRD Implementation Decisions): EAN identity · department
// (retailer-aligned, browse-only) · range (like-with-like ranking, format /
// positioning / process ONLY — zero nutrient thresholds in range gates) ·
// scoring_category (computed lookup from range+format). Attributes are filters,
// never ranges. Launch classification is ONE hand-classified sheet
// (data/classification/sheet.json); detectors flag, never auto-reclassify.
//
// Gate order: format → kids-positioning → process/flavour. Edge rulings (PRD):
// frosted/coated w/o kids branding → R1 + coated + sugar flag · mascot at any
// sugar → R5 · Nestum follows PACK PREP instructions, not brand · bars → Snacks
// (out of cereal scope) · 3-in-1 drinks → Beverages (SG Nutri-Grade,
// reconstituted). The sheet is human curation: build/refresh paths READ it and
// never write it (writeSheet refuses auto-overwrite).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCORING_CATEGORY_GENERAL, SCORING_CATEGORY_BEVERAGE } from './score.mjs';
import { DEPARTMENT_ORDER, rangeOrderFor, rangeLabelsFor, chipsFor, DEPARTMENTS } from './departments.config.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SHEET_PATH = resolve(ROOT, 'data', 'classification', 'sheet.json');
export const CLASSIFIER_ID = 'agent:t7-classification';

// P3-02: the department/range/chip vocabulary is DERIVED from the single
// config module (scripts/departments.config.mjs) — never redefined here.
// Range codes. R1–R5 = cereal launch ranges (PRD). BEV = the Beverages
// comparison range (3-in-1 / cereal drinks + Nestum prep-rule drinks): SG
// Nutri-Grade A–D reconstituted per 100ml, ranked only against other drinks.
// out-of-scope = not a cereal (bars → Snacks; nuts → Snacks): visible with
// price + store, never ranked inside a cereal range.
export const RANGE_ORDER = rangeOrderFor(DEPARTMENT_ORDER);
export const RANGE_LABELS = rangeLabelsFor(DEPARTMENT_ORDER);
export const VALID_RANGES = new Set(RANGE_ORDER);
// scoring keys in the config map to the engine constants (score.mjs owns
// the engine ids; the config never copies them).
const SCORING_KEY_TO_ENGINE = {
  general: SCORING_CATEGORY_GENERAL,
  beverage: SCORING_CATEGORY_BEVERAGE,
};
export const SCORING_BY_RANGE = Object.fromEntries(
  DEPARTMENT_ORDER.flatMap((id) => DEPARTMENTS[id].rangeOrder.map((r) => {
    const key = DEPARTMENTS[id].ranges[r].scoring;
    return [r, key == null ? null : SCORING_KEY_TO_ENGINE[key]];
  })),
);

// Category chips (user story 3) — derived from the config (single source).
// Plain-language labels; each chip maps to one or more WHOLE ranges —
// ranking never crosses ranges. Beverages surface under "Instant &
// flavoured" as their own labelled section (honest grouping: they are
// instant cereal drinks, but ranked only within BEV on the Nutri-Grade
// basis, never against R3 porridge mixes). Documented in docs/reports/04.
export const CHIPS = chipsFor(DEPARTMENT_ORDER);

export const CONFIDENCE_LEVELS = new Set(['H', 'M', 'L']);

// ---------- pure gate-order classifier (unit-testable; no nutrient gates) ----------

// input: {
//   format: 'flakes'|'puffed'|'biscuit'|'oats'|'hot-cereal'|'instant-mix'|
//           'muesli'|'granola'|'bar'|'drink-mix'|'nuts'|'unknown',
//   kidsPositioned?: bool, mascot?: bool, coated?: bool, sweetened?: bool,
//   prep?: 'drink'|'porridge'|'cook'|'ready-to-eat'|null,
//   brand?: string, name?: string
// }
// Returns { range, scoring_category, attributes, gatePath, ruling } or
// { range: null, confidence: 'L', ruling } when evidence is insufficient
// (Nestum without pack prep instructions). NEVER uses nutrient values.
export function classifyByGates(input) {
  const gatePath = [];
  const attrs = {};
  const brand = String(input.brand ?? '');
  const name = String(input.name ?? '');
  const kids = input.kidsPositioned === true || input.mascot === true;

  // GATE 1 — FORMAT (department-level exclusions + drink format first).
  gatePath.push('format');
  if (input.format === 'bar') {
    return { range: 'out-of-scope', scoring_category: null, attributes: { proposedDepartment: 'Snacks' }, gatePath, ruling: 'Bars → Snacks (PRD): not a cereal comparison range.' };
  }
  if (input.format === 'nuts') {
    return { range: 'out-of-scope', scoring_category: null, attributes: { proposedDepartment: 'Snacks' }, gatePath, ruling: 'Baked nuts snack → Snacks: not a cereal comparison range.' };
  }
  // Nestum rule: the PACK PREP instructions decide, never the brand name.
  const isNestum = /nestum/i.test(brand) || /nestum/i.test(name);
  if (isNestum && !input.prep && input.format !== 'drink-mix') {
    return { range: null, confidence: 'L', gatePath, ruling: 'Nestum follows pack preparation instructions, not brand — prep instructions required before a range can be assigned.' };
  }
  if (input.format === 'drink-mix' || input.prep === 'drink' || /\b3\s*-?\s*in\s*-?\s*1\b/i.test(name) || /cereal (milk )?drink|wholegrain beverage/i.test(name)) {
    return { range: 'BEV', scoring_category: SCORING_CATEGORY_BEVERAGE, attributes: attrs, gatePath, ruling: '3-in-1 / cereal drink (or pack prep reconstitutes to a drink) → Beverages, SG Nutri-Grade per 100ml as consumed.' };
  }
  if (isNestum && input.prep === 'porridge') {
    gatePath.push('process/flavour');
    return { range: 'R3', scoring_category: SCORING_CATEGORY_GENERAL, attributes: attrs, gatePath, ruling: 'Nestum pack prep = porridge (spoonable, not drunk) → flavoured instant & porridge mixes.' };
  }

  // GATE 2 — KIDS POSITIONING (mascot at ANY sugar level → R5).
  gatePath.push('kids-positioning');
  if (kids) {
    if (input.mascot === true) attrs.mascot = true;
    attrs.kidsPositioned = true;
    return { range: 'R5', scoring_category: SCORING_CATEGORY_GENERAL, attributes: attrs, gatePath, ruling: 'Kids-positioned (mascot / kids branding) → R5 at any sugar level.' };
  }
  attrs.kidsPositioned = false;

  // GATE 3 — PROCESS / FLAVOUR.
  gatePath.push('process/flavour');
  if (input.format === 'muesli' || input.format === 'granola') {
    return { range: 'R4', scoring_category: SCORING_CATEGORY_GENERAL, attributes: attrs, gatePath, ruling: 'Muesli & granola merged range.' };
  }
  if (input.format === 'oats' || input.format === 'hot-cereal') {
    return { range: 'R2', scoring_category: SCORING_CATEGORY_GENERAL, attributes: attrs, gatePath, ruling: 'Plain oats & hot cereal (plain instant oats stay here — process alone is not a flavour gate).' };
  }
  if (input.format === 'instant-mix') {
    if (input.sweetened === true) {
      return { range: 'R3', scoring_category: SCORING_CATEGORY_GENERAL, attributes: attrs, gatePath, ruling: 'Sweetened/flavoured instant porridge mix → R3.' };
    }
    return { range: 'R2', scoring_category: SCORING_CATEGORY_GENERAL, attributes: attrs, gatePath, ruling: 'Unsweetened plain multigrain hot cereal → R2 (no added sugar/flavouring).' };
  }
  if (input.format === 'flakes' || input.format === 'puffed' || input.format === 'biscuit') {
    if (input.coated === true) attrs.coated = true;
    if (input.coated === true || input.sweetened === true) attrs.sugarFlag = true;
    return {
      range: 'R1', scoring_category: SCORING_CATEGORY_GENERAL, attributes: attrs, gatePath,
      ruling: input.coated === true
        ? 'Frosted/coated WITHOUT kids branding → R1 + coated + sugar flag (PRD edge ruling).'
        : 'Plain flakes & puffed (plain wholegrain biscuits belong to the same like-for-like plain range).',
    };
  }
  return { range: null, confidence: 'L', gatePath, ruling: 'Unknown format — insufficient evidence; route to founder.' };
}

// ---------- chip filtering + range-scoped ranking (pure seams) ----------

export function chipById(id) {
  return CHIPS.find((c) => c.id === id) ?? CHIPS[0];
}

export function filterByChip(products, chipId) {
  const ranges = new Set(chipById(chipId).ranges);
  return products.filter((p) => ranges.has(p.range));
}

const GRADE_ORDER = { A: 0, B: 1, C: 2, D: 3, E: 4 };
// Within ONE range: rated first by grade (A→E, ties by name), unrated LAST by
// name. Never call across ranges — ranking is always range-scoped.
export function rankWithinRange(products) {
  return [...products].sort((a, b) => {
    if (a.rated !== b.rated) return a.rated ? -1 : 1;
    if (a.rated && b.rated) {
      const ga = GRADE_ORDER[a.grade] ?? 99, gb = GRADE_ORDER[b.grade] ?? 99;
      if (ga !== gb) return ga - gb;
    }
    return String(a.name).localeCompare(String(b.name));
  });
}

// Group into ordered range sections; each section ranked independently.
export function groupByRange(products) {
  const out = [];
  for (const range of RANGE_ORDER) {
    const inRange = products.filter((p) => p.range === range);
    if (inRange.length > 0) out.push({ range, label: RANGE_LABELS[range], products: rankWithinRange(inRange) });
  }
  return out;
}

// ---------- sheet I/O (human curation — never auto-overwritten) ----------

export function loadSheet(path = SHEET_PATH) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

// The ONLY sanctioned sheet write path. Refuses to overwrite an existing,
// different sheet unless a human explicitly confirms (founder approval).
// Build/refresh paths never call this — they only loadSheet().
export function writeSheet(sheet, { path = SHEET_PATH, confirmedByHuman = false, approvalRecord = null } = {}) {
  const next = JSON.stringify(sheet, null, 2) + '\n';
  if (existsSync(path)) {
    const before = readFileSync(path, 'utf8');
    if (before === next) return { path, unchanged: true };
    if (!confirmedByHuman || !approvalRecord) {
      throw new Error('REFUSED: classification sheet is human curation — auto-overwrite is forbidden. Pass confirmedByHuman:true with the founder approval record to replace it.');
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return { path, unchanged: false };
}

// Append-only extension (slice 4 CS round): adds NEW rows for newly admitted
// SKUs without touching a single existing row. Structurally cannot modify
// confirmed curation: existing rows are carried over by reference and any EAN
// collision is refused. Meta counts are recomputed from the full row set.
export function extendSheet(newRows, { path = SHEET_PATH, metaPatch = {} } = {}) {
  const existing = loadSheet(path);
  if (!existing || !Array.isArray(existing.rows)) throw new Error('extendSheet: no existing sheet to extend');
  if (!Array.isArray(newRows) || newRows.length === 0) throw new Error('extendSheet: newRows must be a non-empty array');
  const existingEans = new Set(existing.rows.map((r) => r.ean));
  for (const r of newRows) {
    if (existingEans.has(r.ean)) throw new Error(`REFUSED: extension row ${r.ean} already exists — existing (possibly confirmed) rows are never modified`);
    if (!r.ean || !r.range) throw new Error('extendSheet: each new row needs ean + range');
  }
  const rows = [...existing.rows, ...newRows];
  const distribution = {};
  const confidenceCounts = { H: 0, M: 0, L: 0 };
  for (const r of rows) {
    distribution[r.range] = (distribution[r.range] ?? 0) + 1;
    confidenceCounts[r.confidence] = (confidenceCounts[r.confidence] ?? 0) + 1;
  }
  const meta = {
    ...existing.meta,
    ...metaPatch,
    rowCount: rows.length,
    humanConfirmedCount: rows.filter((r) => r.humanConfirmed === true).length,
    distribution,
    confidenceCounts,
  };
  const next = { ...existing, meta, rows };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  return { path, added: newRows.length, total: rows.length };
}

// ---------- sheet validation (handoff contract) ----------

const REQUIRED_ROW_FIELDS = ['ean', 'retailer', 'name', 'breadcrumb', 'range', 'scoring_category', 'attributes', 'evidence', 'confidence', 'classifierId', 'date', 'humanConfirmed'];

export function validateSheet(sheet, catalogue) {
  const errors = [];
  if (!sheet || typeof sheet !== 'object') return ['sheet: required object'];
  if (!Array.isArray(sheet.rows)) return ['sheet.rows: required array'];
  const seen = new Set();
  for (const row of sheet.rows) {
    const label = `sheet[${row?.ean ?? '?'}]`;
    for (const f of REQUIRED_ROW_FIELDS) {
      if (f === 'scoring_category' && row.range === 'out-of-scope') continue; // null is the correct lookup for out-of-scope
      if (row[f] === undefined || row[f] === null || row[f] === '') errors.push(`${label}.${f}: required`);
    }
    if (typeof row.ean !== 'string' || !/^\d{8,14}$/.test(row.ean)) errors.push(`${label}.ean: text barcode required`);
    if (seen.has(row.ean)) errors.push(`${label}: duplicate EAN`);
    seen.add(row.ean);
    if (!VALID_RANGES.has(row.range)) errors.push(`${label}.range: invalid "${row.range}"`);
    const expectedScoring = SCORING_BY_RANGE[row.range];
    if (row.scoring_category !== expectedScoring) errors.push(`${label}.scoring_category: "${row.scoring_category}" != lookup "${expectedScoring}" for ${row.range}`);
    if (typeof row.attributes !== 'object' || Array.isArray(row.attributes)) errors.push(`${label}.attributes: object required (filters, never ranges)`);
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) errors.push(`${label}.evidence: non-empty array required`);
    else for (const [i, ev] of row.evidence.entries()) {
      if (!ev.quote || !ev.sourceUrl) errors.push(`${label}.evidence[${i}]: quote + sourceUrl required`);
    }
    if (!CONFIDENCE_LEVELS.has(row.confidence)) errors.push(`${label}.confidence: H/M/L required`);
    if (row.classifierId !== CLASSIFIER_ID) errors.push(`${label}.classifierId: must be ${CLASSIFIER_ID}`);
    if (Number.isNaN(Date.parse(row.date))) errors.push(`${label}.date: ISO-8601 required`);
    if (typeof row.humanConfirmed !== 'boolean') errors.push(`${label}.humanConfirmed: boolean required`);
  }
  if (catalogue) {
    // Coverage is DYNAMIC: every catalogue SKU except the curated cornflakes
    // record must have a sheet row — whether still UNCLASSIFIED (pre-sync) or
    // already synced from the sheet (merge-03 onward).
    const needRows = catalogue.products.filter((p) => p.ean !== '8852756304053');
    for (const p of needRows) {
      if (!seen.has(p.ean)) errors.push(`coverage: catalogue SKU ${p.ean} (${p.name}) missing from sheet`);
    }
    for (const ean of seen) {
      if (!catalogue.products.some((p) => p.ean === ean)) errors.push(`sheet row ${ean}: not in catalogue`);
    }
    const curated = catalogue.products.find((p) => p.ean === '8852756304053');
    if (curated && seen.has(curated.ean)) errors.push('curation: curated cornflakes must NOT be re-classified in the sheet');
  }
  return errors;
}

// ---------- build-time join (READ-ONLY; used by build-app.mjs) ----------

// Returns Map ean → sheet row. The catalogue is never mutated; the sheet is
// never written. Curated records (cornflakes) keep their own classification.
export function joinSheet(catalogue, sheet) {
  const byEan = new Map();
  if (!sheet?.rows) return byEan;
  for (const row of sheet.rows) byEan.set(row.ean, row);
  return byEan;
}