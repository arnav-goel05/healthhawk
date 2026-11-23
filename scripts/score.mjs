#!/usr/bin/env node
// HealthHawk scoring engine — slice 1 stage B + slice 3a beverage branch.
// PURE functions, zero deps, no network in the math.
//  - General foods: Nutri-Score 2023 per 100g dry (audited tables:
//    scripts/nutriscore-tables.mjs, source docs/README.md §4).
//  - Beverages (slice 3a): SG Nutri-Grade A–D per 100ml AS CONSUMED,
//    reconstituted per pack instructions (scripts/nutrigrade-tables.mjs,
//    live-verified vs HPB/MOH/SFA 2026-11-20, evidence:
//    runs/raw/nutrigrade-thresholds-evidence.md). NOT the Nutri-Score
//    beverage branch (PRD Implementation Decisions).
//
// Display grade is own-brand "Hawk Grade" — NEVER official Nutri-Score marks
// (trademark blocker, README §4): attribution "derived using the Nutri-Score
// 2023 algorithm (Santé publique France)".
//
//   H = clamp(100 * (19 - s) / 24, 0, 100)          (monotone in s)
//   V = 100 * p_min / p                              (p_min FIXED per range
//                                                     against the FULL
//                                                     catalogue — filter-
//                                                     invariant; guard p<=0;
//                                                     IN-STOCK offers only —
//                                                     OOS never prices, 3b fix)
//   S(w) = w*H + (1-w)*V                             (presets 0.3/0.5/0.8)
//
// Missing inputs -> "Not yet rated", never a fabricated score.
//
// Approval gate (stage C): a computed score is STORED on the record, but
// `rated` only becomes true when the founder has approved the queued
// grade-change item (pending/*.json, status 'approved' + review record).
// Until then the public surface shows "Not yet rated" — an unapproved grade
// is never displayed. The pure functions below are unaffected; the gate
// lives in the CLI write path and in rankProducts (record.rated flag).
//
// CLI: node scripts/score.mjs            # score catalogue via validated write
//      node scripts/score.mjs --dry-run  # compute + print, no write

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalogue } from './validate-catalogue.mjs';
import { readPendingQueue, gradeApproved } from './approval-gate.mjs';
import { isMain } from './is-main.mjs';
export { readPendingQueue, gradeApproved };
import {
  ENERGY_KJ_THRESHOLDS, SUGARS_G_THRESHOLDS, SATURATED_FAT_G_THRESHOLDS,
  SODIUM_MG_THRESHOLDS, SALT_G_THRESHOLDS, FVL_PERCENT_THRESHOLDS, FVL_POINTS,
  FIBRE_G_THRESHOLDS, PROTEIN_G_THRESHOLDS, pointsFor, gradeForScore,
} from './nutriscore-tables.mjs';
import {
  nutriGradeBeverage, worseNutriGrade, NUTRIGRADE_ORDER, NUTRIGRADE_ATTRIBUTION,
} from './nutrigrade-tables.mjs';

export const SCRIPT_VERSION = '1.1.0';
export const GRADE_DISPLAY_NAME = 'Hawk Grade';
export const GRADE_ATTRIBUTION = 'derived using the Nutri-Score 2023 algorithm (Santé publique France)';

// scoring_category keys (computed lookup, PRD three-key model).
export const SCORING_CATEGORY_GENERAL = 'nutriscore-2023-general-foods';
export const SCORING_CATEGORY_BEVERAGE = 'sg-nutrigrade-beverages';

// Beverage grade -> H anchor. DESIGN DECISION (slice 3a), NOT an HPB rule:
// the PRD/README say beverages use "SG Nutri-Grade A–D … no E — separate
// mapping" but do not fix numeric H anchors. We map the four Nutri-Grade
// letters onto a monotone 0–100 health axis (A=100 … D=25) so beverages rank
// coherently alongside general foods under S(w). The Nutri-Grade LETTER itself
// is fully threshold-verified (nutrigrade-tables.mjs); only this ranking anchor
// is a HealthHawk choice, flagged for founder confirmation in slice 3b. No E.
export const BEVERAGE_GRADE_H = { A: 100, B: 75, C: 50, D: 25 };

export const PRESETS = [
  { id: 'best-value', label: 'Best value', w: 0.3, excludeGrades: ['D', 'E'] },
  { id: 'balanced', label: 'Balanced', w: 0.5, excludeGrades: ['E'] },
  { id: 'healthiest', label: 'Healthiest', w: 0.8, excludeGrades: ['E'] },
];

const round = (n, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------- pure scoring core ----------

// Nutri-Score 2023, general foods, per 100g. Required: energyKj, sugarsG,
// saturatedFatG, fibreG, proteinG, and sodiumMg OR saltG. fvlPercent defaults
// to 0 (no declared fruits/veg/legumes %). Any missing required input ->
// { rated: false } — never fabricate (handoff contract).
export function nutriScore2023General(inputs) {
  const { energyKj, sugarsG, saturatedFatG, fibreG, proteinG, fvlPercent = 0 } = inputs ?? {};
  const sodiumMg = isNum(inputs?.sodiumMg) ? inputs.sodiumMg : (isNum(inputs?.saltG) ? (inputs.saltG * 1000) / 2.5 : null);
  const missing = [];
  if (!isNum(energyKj)) missing.push('energyKj');
  if (!isNum(sugarsG)) missing.push('sugarsG');
  if (!isNum(saturatedFatG)) missing.push('saturatedFatG');
  if (!isNum(sodiumMg)) missing.push('sodiumMg/saltG');
  if (!isNum(fibreG)) missing.push('fibreG');
  if (!isNum(proteinG)) missing.push('proteinG');
  if (missing.length > 0) return { rated: false, reason: `missing per-100g inputs: ${missing.join(', ')}`, missing };

  const negative = {
    energy: { value: energyKj, unit: 'kJ', points: pointsFor(energyKj, ENERGY_KJ_THRESHOLDS) },
    sugars: { value: sugarsG, unit: 'g', points: pointsFor(sugarsG, SUGARS_G_THRESHOLDS) },
    saturatedFat: { value: saturatedFatG, unit: 'g', points: pointsFor(saturatedFatG, SATURATED_FAT_G_THRESHOLDS) },
    salt: { value: round(sodiumMg / 1000 * 2.5), unit: 'g', sodiumMg: round(sodiumMg), points: pointsFor(sodiumMg, SODIUM_MG_THRESHOLDS) },
  };
  const N = Object.values(negative).reduce((a, c) => a + c.points, 0);

  // 2023 rule: N >= 11 -> protein NOT counted (FVL>=5 exemption removed).
  const proteinCounted = N < 11;
  let fvlPoints = 0;
  FVL_PERCENT_THRESHOLDS.forEach((t, i) => { if (fvlPercent > t) fvlPoints = FVL_POINTS[i]; });
  const positive = {
    fvl: { value: fvlPercent, unit: '%', points: fvlPoints },
    fibre: { value: fibreG, unit: 'g', points: pointsFor(fibreG, FIBRE_G_THRESHOLDS) },
    protein: { value: proteinG, unit: 'g', points: pointsFor(proteinG, PROTEIN_G_THRESHOLDS), counted: proteinCounted },
  };
  const P = positive.fvl.points + positive.fibre.points + (proteinCounted ? positive.protein.points : 0);
  const s = N - P;
  return { rated: true, negative, positive, negativePoints: N, positivePoints: P, proteinCounted, points: s, grade: gradeForScore(s) };
}

// H = clamp(100*(19-s)/24, 0, 100). Monotone non-increasing in s.
export function healthH(s) {
  if (!isNum(s)) return null;
  return round(Math.min(100, Math.max(0, (100 * (19 - s)) / 24)));
}

// V = 100*p_min/p. Guard p<=0 (and p_min<=0) -> null, never Infinity.
export function valueV(p, pMin) {
  if (!isNum(p) || !isNum(pMin) || p <= 0 || pMin <= 0) return null;
  return round((100 * pMin) / p);
}

export function compositeS(H, V, w) {
  if (!isNum(H) || !isNum(V) || !isNum(w)) return null;
  return round(w * H + (1 - w) * V);
}

// Cheapest offer $/100g for a product — IN-STOCK offers only (slice 3b fix,
// review issue 4: an out-of-stock offer is a phantom price for ranking).
// Stock rule: an explicit inventoryStatus of "Out of Stock" (case-insensitive)
// excludes the offer. A MISSING status (legacy FairPrice offers predate the
// field) is treated as available — never silently drop real observed prices.
// Other declared statuses (e.g. "In Stock") remain priceable. No in-stock
// offer -> null -> V null -> S null: the product is unpriceable, browsable
// with its last-checked price + an honest "Out of stock" state, and sinks
// below scored rated rows in rankProducts (never ranked on a phantom price).
export function offerInStock(offer) {
  const s = offer?.inventoryStatus;
  return !(typeof s === 'string' && s.trim().toLowerCase() === 'out of stock');
}

export function productPricePer100g(product) {
  const prices = (product?.offers ?? []).filter(offerInStock).map((o) => o.pricePer100g).filter((v) => isNum(v) && v > 0);
  return prices.length > 0 ? Math.min(...prices) : null;
}

// p_min FIXED per range against the FULL catalogue — never a filtered subset
// (filter-invariance: filtering must not re-price the catalogue). Uses the
// cheapest IN-STOCK offer per product (offerInStock) — OOS offers never set
// the floor either.
export function rangeMinPrice(products, range) {
  const prices = (products ?? [])
    .filter((p) => p.range === range)
    .map(productPricePer100g)
    .filter((v) => isNum(v) && v > 0);
  return prices.length > 0 ? Math.min(...prices) : null;
}

// Build per-100g scoring inputs from a catalogue record (schema units).
export function inputsFromRecord(product) {
  const n = product?.nutrition?.per100g;
  if (!n) return null;
  const val = (k) => (n[k] && isNum(n[k].value) ? n[k].value : undefined);
  return {
    energyKj: val('energy_kj'),
    sugarsG: val('sugars'),
    saturatedFatG: val('saturated_fat'),
    sodiumMg: n.sodium?.unit === 'mg' ? val('sodium') : undefined,
    saltG: n.salt?.unit === 'g' ? val('salt') : undefined,
    fibreG: val('fibre'),
    proteinG: val('protein'),
    fvlPercent: isNum(product?.attributes?.fvlPercent) ? product.attributes.fvlPercent : 0,
  };
}

// ---------- beverage branch (slice 3a): SG Nutri-Grade, per 100ml as consumed ----------

// Reconstitute a powder/concentrate per pack instructions to per-100ml AS
// CONSUMED. SFA/HPB basis: "grams of sugar and saturated fat per 100 ml … as
// prepared according to instructions indicated by the manufacturer"
// (runs/raw/nutrigrade-thresholds-evidence.md, Source 3).
//
//   per100g  = { sugarsG, saturatedFatG, lactoseG?, galactoseG? }  (dry powder)
//   prep     = { powderG, waterMl?, finalVolumeMl? }               (pack instructions)
//
// Mass balance: nutrient_total = per100g_value * powderG / 100.
// Concentration as consumed = nutrient_total / finalVolumeMl * 100.
// finalVolumeMl: the pack-stated made-up volume when given; otherwise waterMl
// (powder volume contribution neglected — a DOCUMENTED, flagged assumption,
// never silent; volumeBasis records which was used). Missing OR NEGATIVE
// inputs -> { rated:false } with an honest reason — never a fabricated
// concentration, never clamp-to-0 (review 03a issue 1).
export function reconstitutePer100ml(per100g, prep) {
  const { sugarsG, saturatedFatG, lactoseG, galactoseG } = per100g ?? {};
  const { powderG, waterMl, finalVolumeMl } = prep ?? {};
  const missing = [];
  const invalid = [];
  if (!isNum(sugarsG)) missing.push('sugarsG');
  else if (sugarsG < 0) invalid.push('sugarsG');
  if (!isNum(saturatedFatG)) missing.push('saturatedFatG');
  else if (saturatedFatG < 0) invalid.push('saturatedFatG');
  if (lactoseG !== undefined && (!isNum(lactoseG) || lactoseG < 0)) invalid.push('lactoseG');
  if (galactoseG !== undefined && (!isNum(galactoseG) || galactoseG < 0)) invalid.push('galactoseG');
  if (!isNum(powderG) || powderG <= 0) missing.push('powderG');
  const volume = isNum(finalVolumeMl) && finalVolumeMl > 0 ? finalVolumeMl
    : (isNum(waterMl) && waterMl > 0 ? waterMl : null);
  if (volume === null) missing.push('finalVolumeMl/waterMl');
  if (missing.length > 0 || invalid.length > 0) {
    const parts = [
      ...missing.map((k) => `${k} (missing or non-positive)`),
      ...invalid.map((k) => `${k} (negative or non-numeric — impossible nutrient value)`),
    ];
    return { rated: false, reason: `invalid reconstitution inputs: ${parts.join(', ')} — refusing to compute a concentration`, missing, invalid };
  }
  // per-100g -> per-100ml as consumed: value * powderG / volume (multiply
  // first, divide last — keeps hand-computed reference cases exact in FP).
  // No pre-rounding: grade on the exact reconstituted values (boundary-safe,
  // mirrors the audited Nutri-Score no-pre-rounding rule).
  const per100ml = (v) => (v * powderG) / volume;
  const out = {
    rated: true,
    basis: 'per-100ml-as-consumed',
    powderG,
    finalVolumeMl: volume,
    volumeBasis: isNum(finalVolumeMl) && finalVolumeMl > 0 ? 'pack-stated-final-volume' : 'water-volume-assumption',
    sugarsG: per100ml(sugarsG),
    saturatedFatG: per100ml(saturatedFatG),
  };
  if (isNum(lactoseG)) out.lactoseG = per100ml(lactoseG);
  if (isNum(galactoseG)) out.galactoseG = per100ml(galactoseG);
  return out;
}

// Read dry-powder per-100g nutrition from a catalogue record (schema units).
export function beveragePowderInputs(product) {
  const n = product?.nutrition?.per100g;
  if (!n) return null;
  const val = (k) => (n[k] && isNum(n[k].value) ? n[k].value : undefined);
  return { sugarsG: val('sugars'), saturatedFatG: val('saturated_fat'), lactoseG: val('lactose'), galactoseG: val('galactose') };
}

// Full beverage score object, or null when not scoreable. Grade = SG Nutri-Grade
// A–D (worse-of sugar/sat-fat, sweetener floor A->B, declared lactose/galactose
// subtracted). H uses the documented BEVERAGE_GRADE_H anchor; V uses the same
// $/100g offer basis as general foods (filter-invariant p_min per range).
export function scoreBeverage(product, pMin) {
  const powder = beveragePowderInputs(product);
  const prep = product?.prepInstructions;
  if (!powder || !prep) return null;
  const recon = reconstitutePer100ml(powder, prep);
  if (!recon.rated) return null;
  const hasSweetener = typeof product?.attributes?.hasSweetener === 'boolean' ? product.attributes.hasSweetener : undefined;
  const ng = nutriGradeBeverage({
    sugarsG: recon.sugarsG, saturatedFatG: recon.saturatedFatG,
    lactoseG: recon.lactoseG, galactoseG: recon.galactoseG, hasSweetener,
  });
  if (!ng.rated) return null;
  const H = BEVERAGE_GRADE_H[ng.grade];
  const p = productPricePer100g(product);
  const V = valueV(p, pMin);
  const S = {};
  for (const preset of PRESETS) S[preset.id] = compositeS(H, V, preset.w);
  const per100g = product.nutrition.per100g;
  const tier = per100g.sugars?.provenanceTier ?? null;
  return {
    algorithm: SCORING_CATEGORY_BEVERAGE,
    scriptVersion: SCRIPT_VERSION,
    scoredAt: new Date().toISOString(),
    inputs: { ...powder, hasSweetener, basis: 'per-100g-dry-powder', provenanceTier: tier, sourceUrl: product.nutrition.off?.url ?? null, fetchedAt: product.nutrition.off?.fetchedAt ?? null },
    reconstitution: recon,
    per100ml: { sugarsG: recon.sugarsG, saturatedFatG: recon.saturatedFatG, lactoseG: recon.lactoseG ?? 0, galactoseG: recon.galactoseG ?? 0 },
    sugarsForGradingG: ng.sugarsForGradingG,
    sugarGrade: ng.sugarGrade,
    satFatGrade: ng.satFatGrade,
    sweetenerFloorApplied: ng.sweetenerFloorApplied,
    grade: ng.grade,
    gradeDisplayName: GRADE_DISPLAY_NAME,
    attribution: NUTRIGRADE_ATTRIBUTION,
    H,
    pPer100g: p,
    pMinRange: pMin,
    V,
    S,
  };
}

// Full score object for a record, or null when not scoreable.
export function scoreProduct(product, pMin) {
  if (product?.scoring_category === SCORING_CATEGORY_BEVERAGE) return scoreBeverage(product, pMin);
  if (product?.scoring_category !== SCORING_CATEGORY_GENERAL) return null;
  const inputs = inputsFromRecord(product);
  if (!inputs) return null;
  const ns = nutriScore2023General(inputs);
  if (!ns.rated) return null;
  const p = productPricePer100g(product);
  const H = healthH(ns.points);
  const V = valueV(p, pMin);
  const S = {};
  for (const preset of PRESETS) S[preset.id] = compositeS(H, V, preset.w);
  const per100g = product.nutrition.per100g;
  const tier = per100g.energy_kj?.provenanceTier ?? null;
  return {
    algorithm: 'nutriscore-2023-general-foods',
    scriptVersion: SCRIPT_VERSION,
    scoredAt: new Date().toISOString(),
    inputs: { ...inputs, basis: 'per-100g-dry', provenanceTier: tier, sourceUrl: product.nutrition.off?.url ?? null, fetchedAt: product.nutrition.off?.fetchedAt ?? null },
    negativePoints: ns.negativePoints,
    positivePoints: ns.positivePoints,
    proteinCounted: ns.proteinCounted,
    components: { negative: ns.negative, positive: ns.positive },
    points: ns.points,
    grade: ns.grade,
    gradeDisplayName: GRADE_DISPLAY_NAME,
    attribution: GRADE_ATTRIBUTION,
    H,
    pPer100g: p,
    pMinRange: pMin,
    V,
    S,
  };
}

// Honest "why not scoreable" reason, per scoring_category (never fabricated).
export function notScoreableReason(product) {
  if (product?.scoring_category === SCORING_CATEGORY_BEVERAGE) {
    const powder = beveragePowderInputs(product);
    if (!powder) return 'no per-100g powder basis';
    if (!product?.prepInstructions) return 'missing prepInstructions (pack preparation)';
    const recon = reconstitutePer100ml(powder, product.prepInstructions);
    if (!recon.rated) return recon.reason;
    const hasSweetener = typeof product?.attributes?.hasSweetener === 'boolean' ? product.attributes.hasSweetener : undefined;
    const ng = nutriGradeBeverage({ sugarsG: recon.sugarsG, saturatedFatG: recon.saturatedFatG, lactoseG: recon.lactoseG, galactoseG: recon.galactoseG, hasSweetener });
    return ng.rated ? 'not scoreable' : ng.reason;
  }
  const inputs = inputsFromRecord(product);
  return inputs ? nutriScore2023General(inputs).reason : 'no per-100g basis';
}

// Rank a (possibly filtered) result set. V always uses p_min from the FULL
// catalogue. Unrated products sort last. Preset health floors apply unless
// allowLowerRated (explicit user override). The record's `rated` flag is the
// approval gate: a product with a computed-but-unapproved score (rated:false)
// ranks as unrated — its grade is never surfaced before founder approval.
export function rankProducts(fullCatalogue, resultSet, presetId, { allowLowerRated = false } = {}) {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`unknown preset: ${presetId}`);
  const pMinByRange = new Map();
  for (const p of resultSet) {
    if (!pMinByRange.has(p.range)) pMinByRange.set(p.range, rangeMinPrice(fullCatalogue, p.range));
  }
  const rows = [];
  for (const product of resultSet) {
    if (product.rated === false) { rows.push({ product, score: null, S: null, rated: false }); continue; }
    const score = scoreProduct(product, pMinByRange.get(product.range));
    if (!score) { rows.push({ product, score: null, S: null, rated: false }); continue; }
    if (!allowLowerRated && preset.excludeGrades.includes(score.grade)) continue;
    rows.push({ product, score, S: score.S[preset.id], rated: true });
  }
  rows.sort((a, b) => {
    if (a.rated !== b.rated) return a.rated ? -1 : 1; // unrated always bottom
    if (a.rated && b.rated) {
      // Unpriceable rated rows (no in-stock offer -> S null) sink below every
      // scored rated row, by name among themselves — never ranked on a
      // phantom price, never above a priced option (slice 3b OOS fix).
      const aNull = a.S === null, bNull = b.S === null;
      if (aNull !== bNull) return aNull ? 1 : -1;
      if (aNull && bNull) return String(a.product.name).localeCompare(String(b.product.name));
      return b.S - a.S;
    }
    return 0;
  });
  return rows;
}

// ---------- CLI: validated catalogue write ----------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compact = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');

// Approval gate lives in scripts/approval-gate.mjs (shared with the validator).

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const catPath = resolve(ROOT, 'data', 'catalogue.json');
  const before = readFileSync(catPath, 'utf8');
  const cat = JSON.parse(before);
  const queue = readPendingQueue();

  const results = [];
  for (const product of cat.products) {
    const pMin = rangeMinPrice(cat.products, product.range); // FULL catalogue
    const score = scoreProduct(product, pMin);
    const prevGrade = product.score?.grade ?? null;
    const prevPoints = product.score?.points ?? null;
    // P2-05 (D3 step 1): grade-on-complete-nutrition. Ingredients are NOT a
    // scoring input — a complete per-100g basis grades even when the ingredient
    // list is unpublished (the app renders that as a separate honest gap).
    if (score) {
      product.score = score;
      // Approval gate: store the computed score, but keep rated:false until
      // the grade is approved (D9 auto-gate: two independent reviewer verdicts
      // at the merge stage; legacy founder approvals still satisfy the gate).
      // Public = "Not yet rated" until then.
      product.rated = gradeApproved(queue, product.ean, score.grade);
    } else {
      product.score = null;
      product.rated = false;
    }
    product.timestamp = new Date().toISOString();
    results.push({ ean: product.ean, rated: product.rated, grade: product.score?.grade ?? null, points: product.score?.points ?? null, prevPoints, pointsChange: (product.score && prevPoints !== null && product.score.points !== prevPoints) ? `${prevPoints} -> ${product.score.points}` : null, H: product.score?.H ?? null, V: product.score?.V ?? null, S: product.score?.S ?? null, prevGrade, approval: product.rated ? 'approved' : (product.score ? 'pending' : 'not-scoreable'), reason: product.score ? null : notScoreableReason(product) });
  }
  cat.updatedAt = new Date().toISOString();

  console.log(JSON.stringify(results, null, 2));
  if (dryRun) { console.log('dry-run: no write.'); return; }

  const preErrors = validateCatalogue(cat);
  if (preErrors.length > 0) {
    console.error('CANARY FAIL (pre-write):');
    for (const e of preErrors) console.error(`  - ${e}`);
    console.error('write aborted — catalogue unchanged.');
    process.exit(1);
  }
  const backup = resolve(ROOT, 'runs', `catalogue-backup-${compact(cat.updatedAt)}.json`);
  writeFileSync(backup, before);
  writeFileSync(catPath, JSON.stringify(cat, null, 2) + '\n');
  const postErrors = validateCatalogue(JSON.parse(readFileSync(catPath, 'utf8')));
  if (postErrors.length > 0) {
    copyFileSync(backup, catPath);
    console.error('CANARY FAIL (post-write) — rolled back:');
    for (const e of postErrors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`catalogue write OK (canary pre+post passed): ${catPath}`);

  const runTs = new Date().toISOString();
  const runPath = resolve(ROOT, 'runs', `run-${compact(runTs)}.json`);
  writeFileSync(runPath, JSON.stringify({ runAt: runTs, stage: 'scoring', scriptVersion: SCRIPT_VERSION, results, write: { catPath, backup }, blockers: results.filter((r) => !r.grade).map((r) => `EAN ${r.ean}: ${r.reason}`), pendingApprovals: results.filter((r) => r.approval === 'pending').map((r) => `EAN ${r.ean}: grade ${r.grade} computed, awaiting founder approval`) }, null, 2));
  console.log(`run snapshot: ${runPath}`);

  // Grade changes are reputational -> approval queue (never auto-published).
  // Dedupe: an existing PENDING item for the same EAN + target grade is kept
  // (no duplicate queue entries on re-runs). New-SKU context is referenced so
  // the founder reviews the grade and the SKU admission together.
  for (const r of results) {
    if (r.grade && r.grade !== r.prevGrade) {
      const existing = queue.find((item) => item.kind === 'grade-change' && item.ean === r.ean && item.status === 'pending' && item.proposedGrade === r.grade);
      if (existing) { console.log(`approval item already pending: pending/${existing.id}.json`); continue; }
      const newSkuItem = queue.find((item) => item.kind === 'new-sku' && item.ean === r.ean && item.status === 'pending');
      const pendingId = `${compact(runTs)}-grade-${r.ean}`;
      const pendingPath = resolve(ROOT, 'pending', `${pendingId}.json`);
      writeFileSync(pendingPath, JSON.stringify({
        id: pendingId, kind: 'grade-change', ean: r.ean, createdAt: runTs,
        createdBy: `script:score.mjs@${SCRIPT_VERSION}`, confidence: 'high',
        proposedGrade: r.grade,
        summary: `Hawk Grade ${r.prevGrade ?? '(unrated)'} -> ${r.grade} (s=${r.points}, H=${r.H}, V=${r.V}). Deterministic script output; publish requires the D9 auto-gate (two independent reviewer verdicts + audit record) or a legacy founder approval. Record stays rated:false ("Not yet rated" publicly) until approved.${newSkuItem ? ` New-SKU context: this EAN's admission is also pending (pending/${newSkuItem.id}.json) — review together.` : ''}`,
        evidence: { runSnapshot: runPath, newSkuItem: newSkuItem ? `pending/${newSkuItem.id}.json` : null },
        status: 'pending', review: null,
      }, null, 2));
      console.log(`queued for approval: ${pendingPath}`);
    }
  }
}

if (isMain(import.meta.url)) main();