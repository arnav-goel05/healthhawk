#!/usr/bin/env node
// HealthHawk catalogue validator — zero-dependency.
// EAN-uniqueness canary + handoff-contract validation (docs/contracts/handoff.md).
// Usage: node scripts/validate-catalogue.mjs [path/to/catalogue.json]
// Exits 0 on pass, 1 on violation (errors printed), 2 on unreadable input.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPendingQueue, gradeApproved } from './approval-gate.mjs';
import { isMain } from './is-main.mjs';

const TIERS = new Set(['exact', 'label-declared', 'off-label', 'ocr-label', 'estimated-derived', 'estimated', 'regulatory-limit', 'derived']);
// Tiers whose per-100g values are stated DIRECTLY per 100g by the source
// (no serving-size derivation involved). 'off-label' = Open Food Facts
// transcription of the product label (crowdsourced, ODbL, attributed).
// 'ocr-label' = our own OCR transcription of a label photo (stage C+);
// the photo URL + verbatim transcription must be recorded in nutrition.ocr.
// 'derived' (P2-05, D3 step 1) = EXACT unit conversion of a directly-stated
// per-100g value (kcal → kJ, factor 4.184) — no serving-size derivation, so
// no servingSizeG is required; the derivation provenance object is mandatory.
const DIRECT_PER100G_TIERS = new Set(['exact', 'off-label', 'ocr-label', 'derived']);
const CONFIDENCE = new Set(['high', 'medium', 'low']);
const HALAL = new Set(['certified', 'not-certified', 'unknown']);
const NUTRIENT_KEYS = new Set(['energy_kj', 'energy_kcal', 'protein', 'carbohydrate', 'sugars', 'fat', 'saturated_fat', 'fibre', 'sodium', 'salt']);
const UNITS = new Set(['g', 'mg', 'kJ', 'kcal']);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
// ISO-8601 shape check (handoff contract) — Date.parse alone accepts prose
// like "Nov 20 2026", which is NOT ISO-8601.
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isIsoTimestamp = (v) => isNonEmptyString(v) && ISO_SHAPE.test(v) && !Number.isNaN(Date.parse(v));
const isPositiveNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

function checkNutrientMap(map, where, errors) {
  if (map === null || map === undefined) return;
  if (typeof map !== 'object' || Array.isArray(map)) {
    errors.push(`${where}: must be an object or null`);
    return;
  }
  for (const [key, entry] of Object.entries(map)) {
    const at = `${where}.${key}`;
    if (!NUTRIENT_KEYS.has(key)) errors.push(`${at}: unknown nutrient key (allowed: ${[...NUTRIENT_KEYS].join(', ')})`);
    if (entry === null) continue; // honest gap
    if (typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${at}: numeric nutrition field must be an object {value, unit, provenanceTier} — bare values are contract violations`);
      continue;
    }
    if (typeof entry.value !== 'number' || !Number.isFinite(entry.value) || entry.value < 0) {
      errors.push(`${at}.value: must be a finite number >= 0`);
    }
    if (!UNITS.has(entry.unit)) errors.push(`${at}.unit: must be one of ${[...UNITS].join(', ')}`);
    if (!TIERS.has(entry.provenanceTier)) errors.push(`${at}.provenanceTier: missing or invalid (required on EVERY numeric nutrition field; allowed: ${[...TIERS].join(', ')})`);
    // P2-05 (D3 step 1): tier 'derived' is the EXACT kcal→kJ unit conversion
    // (×4.184) of a kept per-100g kcal value. Provenance is mandatory and the
    // arithmetic is re-checked here — a 'derived' value without its derivation
    // object, or one that does not equal sourceValue × 4.184 (4dp), is a
    // contract violation. Only energy_kj may carry this tier.
    if (entry.provenanceTier === 'derived') {
      if (key !== 'energy_kj' || entry.unit !== 'kJ') {
        errors.push(`${at}: tier 'derived' is sanctioned only for energy_kj in kJ (exact kcal→kJ conversion)`);
      }
      const d = entry.derivation;
      if (!d || typeof d !== 'object' || d.factor !== 4.184 || d.sourceKey !== 'energy_kcal'
        || typeof d.sourceValue !== 'number' || !Number.isFinite(d.sourceValue) || d.sourceValue <= 0
        || typeof d.sourceTier !== 'string' || d.sourceTier.trim().length === 0) {
        errors.push(`${at}.derivation: tier 'derived' requires {factor: 4.184, sourceKey: 'energy_kcal', sourceValue > 0, sourceTier} — exact kcal→kJ provenance (P2-05)`);
      } else if (typeof entry.value === 'number' && Number.isFinite(entry.value)
        && Math.abs(entry.value - d.sourceValue * 4.184) > 0.000050001) {
        errors.push(`${at}.value: derived kJ ${entry.value} != sourceValue ${d.sourceValue} × 4.184 (4dp rounding tolerance)`);
      }
    }
  }
}

// A per-100g basis is USABLE for scoring only when every required input is
// present as a {value, unit, provenanceTier} object (mirrors the scoring
// engine's required inputs; sodium OR salt suffices for the salt component).
const BASIS_REQUIRED = ['energy_kj', 'sugars', 'saturated_fat', 'fibre', 'protein'];
function unusableBasisReasons(per100g) {
  if (per100g === null || per100g === undefined || typeof per100g !== 'object' || Object.keys(per100g).length === 0) {
    return ['no per-100g data'];
  }
  const ok = (k) => {
    const e = per100g[k];
    return e !== null && typeof e === 'object' && typeof e.value === 'number' && Number.isFinite(e.value);
  };
  const missing = BASIS_REQUIRED.filter((k) => !ok(k));
  if (!ok('sodium') && !ok('salt')) missing.push('sodium/salt');
  return missing;
}

// W4 merge-04 FIX (real contract gap found by the sweep-apply clone canary):
// the rated:true basis check above is the GENERAL-FOODS contract (complete
// per-100g panel). Beverages grade AS PREPARED per 100ml under the SG
// Nutri-Grade contract (scripts/score.mjs scoreBeverage: sugars + saturated
// fat dry-powder basis + pack prepInstructions) — requiring energy_kj/fibre/
// protein for a rated beverage contradicts the engine and blocked every
// gate-approved beverage flip. The check is now ROUTING-AWARE, mirroring
// scoreProduct exactly — never weaker: a rated beverage still needs a
// complete, non-negative powder basis + valid pack prep + the as-prepared
// algorithm (a dry general-foods grade on a beverage is a violation) + the
// same approval gate. General foods keep the unchanged complete-basis rule.
function unusableBeverageBasisReasons(p) {
  const reasons = [];
  const n = p.nutrition?.per100g;
  const ok = (k) => n && n[k] !== null && typeof n[k] === 'object' && typeof n[k].value === 'number' && Number.isFinite(n[k].value) && n[k].value >= 0;
  if (!ok('sugars')) reasons.push('sugars (dry powder basis, non-negative)');
  if (!ok('saturated_fat')) reasons.push('saturated_fat (dry powder basis, non-negative)');
  const prep = p.prepInstructions;
  const vol = typeof prep?.finalVolumeMl === 'number' && prep.finalVolumeMl > 0 ? prep.finalVolumeMl : prep?.waterMl;
  if (!(typeof prep?.powderG === 'number' && prep.powderG > 0) || !(typeof vol === 'number' && vol > 0)) {
    reasons.push('prepInstructions (powderG + water/final volume — never a fabricated reconstitution)');
  }
  return reasons;
}

// queue: the founder approval queue (pending/). Defaults to the REAL queue on
// disk so every shipped write path and the CLI enforce the gate machine-wide;
// tests may inject a synthetic queue.
export function validateCatalogue(data, { queue = readPendingQueue() } = {}) {
  const errors = [];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return ['catalogue: top level must be an object'];
  }
  if (data.schemaVersion !== 1) errors.push('catalogue.schemaVersion: must be 1');
  if (!Array.isArray(data.products)) {
    errors.push('catalogue.products: must be an array');
    return errors;
  }

  const seenEans = new Map();
  data.products.forEach((p, i) => {
    const at = `products[${i}]`;
    if (typeof p !== 'object' || p === null) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const label = isNonEmptyString(p.ean) ? `${at} (EAN ${p.ean})` : at;

    // EAN-uniqueness canary
    if (!isNonEmptyString(p.ean) || !/^\d{8,14}$/.test(p.ean)) {
      errors.push(`${label}.ean: required, must be TEXT of 8–14 digits`);
    } else if (seenEans.has(p.ean)) {
      errors.push(`${label}.ean: DUPLICATE EAN ${p.ean} (also at products[${seenEans.get(p.ean)}]) — uniqueness canary failed`);
    } else {
      seenEans.set(p.ean, i);
    }

    for (const f of ['name', 'brand', 'department', 'range']) {
      if (!isNonEmptyString(p[f])) errors.push(`${label}.${f}: required non-empty string`);
    }
    // scoring_category: computed lookup from range (PRD three-key model).
    // out-of-scope records are NEVER scored — null is the sanctioned lookup
    // (scripts/4-classify.mjs SCORING_BY_RANGE['out-of-scope'] = null), synced
    // from the classification sheet at merge-03. Every other range requires
    // the engine key string.
    if (p.range === 'out-of-scope') {
      if (p.scoring_category !== null) errors.push(`${label}.scoring_category: out-of-scope records must carry null (never scored) — got "${p.scoring_category}"`);
    } else if (!isNonEmptyString(p.scoring_category)) {
      errors.push(`${label}.scoring_category: required non-empty string`);
    }
    if (typeof p.attributes !== 'object' || p.attributes === null || Array.isArray(p.attributes)) {
      errors.push(`${label}.attributes: required object (filters, never ranges)`);
    }

    // Handoff contract required fields
    if (!isNonEmptyString(p.classifierId)) errors.push(`${label}.classifierId: required non-empty string (handoff contract)`);
    if (!isIsoTimestamp(p.timestamp)) errors.push(`${label}.timestamp: required ISO-8601 timestamp (handoff contract)`);
    if (!CONFIDENCE.has(p.confidence)) errors.push(`${label}.confidence: required, one of high/medium/low (handoff contract)`);

    // Offers
    if (!Array.isArray(p.offers) || p.offers.length === 0) {
      errors.push(`${label}.offers: required array with >= 1 offer`);
    } else {
      p.offers.forEach((o, j) => {
        const oat = `${label}.offers[${j}]`;
        if (typeof o !== 'object' || o === null) { errors.push(`${oat}: must be an object`); return; }
        if (!isNonEmptyString(o.store)) errors.push(`${oat}.store: required`);
        if (!isPositiveNumber(o.packPrice)) errors.push(`${oat}.packPrice: required number > 0`);
        if (!isNonEmptyString(o.packSize)) errors.push(`${oat}.packSize: required`);
        if (!isPositiveNumber(o.packSizeGrams)) errors.push(`${oat}.packSizeGrams: required number > 0`);
        if (!isPositiveNumber(o.pricePer100g)) errors.push(`${oat}.pricePer100g: required number > 0`);
        if (!isIsoTimestamp(o.priceCheckedAt)) errors.push(`${oat}.priceCheckedAt: required ISO-8601 timestamp`);
        if (!isNonEmptyString(o.sourceUrl) || !/^https:\/\//.test(o.sourceUrl)) errors.push(`${oat}.sourceUrl: required https URL`);
        if (isPositiveNumber(o.packPrice) && isPositiveNumber(o.packSizeGrams) && isPositiveNumber(o.pricePer100g)) {
          const expected = (o.packPrice / o.packSizeGrams) * 100;
          if (Math.abs(expected - o.pricePer100g) > 0.001) {
            errors.push(`${oat}.pricePer100g: ${o.pricePer100g} inconsistent with packPrice/packSizeGrams (expected ~${expected.toFixed(4)})`);
          }
        }
      });
    }

    // Ingredients (null = honest gap)
    if (p.ingredients !== null && p.ingredients !== undefined) {
      const g = p.ingredients;
      if (typeof g !== 'object' || Array.isArray(g)) {
        errors.push(`${label}.ingredients: must be object or null`);
      } else {
        if (!isNonEmptyString(g.text)) errors.push(`${label}.ingredients.text: required non-empty string`);
        if (!TIERS.has(g.provenanceTier)) errors.push(`${label}.ingredients.provenanceTier: required valid tier (handoff contract)`);
        if (!isNonEmptyString(g.sourceUrl)) errors.push(`${label}.ingredients.sourceUrl: required`);
        if (!isIsoTimestamp(g.fetchedAt)) errors.push(`${label}.ingredients.fetchedAt: required ISO-8601 timestamp`);
      }
    } else if (p.ingredients === undefined) {
      errors.push(`${label}.ingredients: required (object or null)`);
    }

    // Nutrition (null = honest gap)
    if (p.nutrition !== null && p.nutrition !== undefined) {
      const n = p.nutrition;
      if (typeof n !== 'object' || Array.isArray(n)) {
        errors.push(`${label}.nutrition: must be object or null`);
      } else {
        if (n.servingSizeG !== null && n.servingSizeG !== undefined) {
          if (!isPositiveNumber(n.servingSizeG)) errors.push(`${label}.nutrition.servingSizeG: must be number > 0 or null`);
          if (!TIERS.has(n.servingSizeProvenanceTier)) errors.push(`${label}.nutrition.servingSizeProvenanceTier: required when servingSizeG present`);
        }
        checkNutrientMap(n.perServing, `${label}.nutrition.perServing`, errors);
        checkNutrientMap(n.per100g, `${label}.nutrition.per100g`, errors);
        // ocr-label tier requires the OCR provenance layer (photo URL +
        // timestamp + verbatim transcription path) — never an unanchored OCR value.
        const usesOcr = [n.perServing, n.per100g].some((map) => map && typeof map === 'object' && Object.values(map).some((e) => e !== null && typeof e === 'object' && e.provenanceTier === 'ocr-label'));
        if (usesOcr) {
          const o = n.ocr;
          if (typeof o !== 'object' || o === null || !isNonEmptyString(o.imageUrl) || !/^https:\/\//.test(o.imageUrl) || !isIsoTimestamp(o.transcribedAt) || !isNonEmptyString(o.verbatimTranscription) || !isNonEmptyString(o.structuredEvidence)) {
            errors.push(`${label}.nutrition.ocr: required when any nutrition field uses tier ocr-label — {imageUrl (https), transcribedAt (ISO-8601), verbatimTranscription (path), structuredEvidence (path)}`);
          }
        }
        if (n.per100g && Object.keys(n.per100g).length > 0 && !isPositiveNumber(n.servingSizeG)) {
          // Directly-stated per-100g (exact / off-label) needs no serving basis.
          // Derived per-100g (estimated-derived / estimated) MUST have a stated
          // serving size — never silently assume one.
          const derived = Object.entries(n.per100g).filter(([, e]) => e !== null && typeof e === 'object' && !DIRECT_PER100G_TIERS.has(e.provenanceTier));
          if (derived.length > 0) {
            errors.push(`${label}.nutrition: per100g has derived entries (${derived.map(([k]) => k).join(', ')}) but no stated servingSizeG — derived values need a label-declared serving basis (never silently assume); directly-stated per-100g must use tier exact/off-label`);
          }
        }
      }
    } else if (p.nutrition === undefined) {
      errors.push(`${label}.nutrition: required (object or null)`);
    }

    // Halal — certification only
    if (typeof p.halal !== 'object' || p.halal === null || !HALAL.has(p.halal.status)) {
      errors.push(`${label}.halal.status: required, one of certified/not-certified/unknown (never inferred)`);
    }

    // Rated honesty + machine-enforced approval gate (handoff §4/§6).
    // P2-05 (D3 step 1) rating contract: a grade requires COMPLETE per-100g
    // nutrition only. Missing ingredients are a separate honest gap
    // ("ingredients not published") and never block the grade.
    if (typeof p.rated !== 'boolean') {
      errors.push(`${label}.rated: required boolean`);
    } else if (p.rated === true) {
      if (p.nutrition == null) {
        errors.push(`${label}.rated: true but nutrition incomplete — must be false ("Not yet rated")`);
      } else {
        // W4 merge-04: routing-aware basis contract (mirrors scoreProduct).
        const isBeverage = p.scoring_category === 'sg-nutrigrade-beverages';
        const missing = isBeverage ? unusableBeverageBasisReasons(p) : unusableBasisReasons(p.nutrition.per100g);
        if (missing.length > 0) {
          errors.push(`${label}.rated: true but ${isBeverage ? 'beverage as-prepared basis' : 'per-100g basis'} unusable (missing: ${missing.join(', ')}) — must be false ("Not yet rated")`);
        }
        if (typeof p.score !== 'object' || p.score === null || !isNonEmptyString(p.score.grade)) {
          errors.push(`${label}.rated: true requires a computed score with a grade (scripts/score.mjs owns the flag) — never rate without one`);
        } else if (!gradeApproved(queue, p.ean, p.score.grade)) {
          errors.push(`${label}.rated: true without an approved grade-change record in pending/ for grade ${p.score.grade} (status approved + review record + matching proposedGrade) — approval gate violated; keep rated:false until founder approval`);
        } else if (isBeverage && (p.score.algorithm !== 'sg-nutrigrade-beverages' || p.score.reconstitution?.basis !== 'per-100ml-as-consumed')) {
          errors.push(`${label}.rated: beverage graded on the wrong basis (${p.score.algorithm ?? '?'} / ${p.score.reconstitution?.basis ?? '?'}) — SG Nutri-Grade per 100ml AS PREPARED only, never the dry general-foods path`);
        }
      }
    }
  });

  return errors;
}

if (isMain(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const target = process.argv[2] ?? resolve(here, '..', 'data', 'catalogue.json');
  let data;
  try {
    data = JSON.parse(readFileSync(target, 'utf8'));
  } catch (err) {
    console.error(`FAIL: cannot read/parse ${target}: ${err.message}`);
    process.exit(2);
  }
  const errors = validateCatalogue(data);
  if (errors.length > 0) {
    console.error(`FAIL: ${errors.length} contract violation(s) in ${target}`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`PASS: ${target} — ${data.products.length} product(s), EAN uniqueness canary OK, handoff contract OK`);
}