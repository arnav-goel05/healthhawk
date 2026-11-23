// HealthHawk slice 7b — claim-check full catalogue sweep (washing-detection role).
// Re-runs the 7a rule engine across the FULL catalogue (incl. OFF/OCR-enriched
// records and Cold Storage name claims), adds sweep rules (low fat / low sat fat /
// cholesterol free / trans fat free / additive-claim cross-checks vs
// data/additives/verdicts.json + occurrences.json / quantitative protein /
// kids-positioning vs sugar content), and EXTENDS data/claims/findings.json —
// the 7a findings are preserved unchanged (flag history, no silent removals).
//
// New thresholds verified against the SAME official HPB Aug-2024 guide cached
// in 7a (runs/raw/7a-hpb/), addendum: runs/raw/7b-thresholds-addendum.md.
// Kids-sugar uses the UK NHS red heuristic, EXPLICITLY labelled NOT SG law.
// Additive claims are factual presence checks (no SG numeric threshold exists
// for "natural"/"no preservatives"/"no artificial") — non-chemophobic wording.
//
// ROLE SEPARATION (PRD story 68): writes ONLY data/claims/, pending/ (NEW
// claim-flag proposals, deduped by EAN+rule), runs/7b-*. NO publish path:
// no app/, catalogue, classification or additives writes; no build-app/sync
// imports. Founder approvals are applied by the orchestrator, never here.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import {
  ROOT as A7_ROOT, RULES as A7_RULES, HPB_GUIDE_URL, NHS_LABELS_URL, AGENT_ID as A7_AGENT,
  SCOREABLE_TIERS, usableNutrient, energyKcalPer100g, nutritionSourceUrl,
  ingredientEvidence, ingredientTextUsable, cleanIngredientText, parseIngredientList,
  wholegrainShare, extractClaims as extractClaims7a, checkClaim as checkClaim7a,
  runClaimChecks as runClaimChecks7a, readPendingItems, assertWriteScope, disputedPanelEans,
  FREE_SUGAR_RE, SUGAR_ALCOHOL_RE, SWEETENER_RE,
} from './7a-claim-rules.mjs';
import {
  runHcsGate, META as HCS_META, VISUAL_PATH as HCS_VISUAL_PATH,
} from './p2-hcs-rules.mjs';

export const ROOT = A7_ROOT;
export { readPendingItems, assertWriteScope };
export const AGENT_ID = 'agent:t10-claims-sweep';
export const SCRIPT_VERSION = '1.0.0';
export const ADDENDUM_PATH = 'runs/raw/7b-thresholds-addendum.md';
export const UK_RED_SUGARS = 22.5; // UK NHS traffic-light heuristic — NOT SG law
export const TSP_GRAMS = 5; // HPB consumer convention (PRD story 36 / README §4)

// ---------------------------------------------------------------------------
// Sweep rule registry — cited thresholds (HPB guide pages from the 7a cache)
// ---------------------------------------------------------------------------

export const SWEEP_RULES = {
  'CLM-LOWFAT': {
    family: 'low-fat',
    threshold: 'fat ≤ 3 g per 100 g (or ≤ 1.5 g per 100 ml)',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p35 (printed p34), Appendix I: Fats and cholesterol',
    sourceQuote: 'Low Fat / Low in Fat / Light in Fat / Lite in Fat: ≤ 3 g fat per 100 g, or ≤ 1.5 g fat per 100 ml',
  },
  'CLM-LOWSATFAT': {
    family: 'low-satfat',
    threshold: 'saturated fat ≤ 1.5 g per 100 g AND ≤ 10% of kilocalories from saturated fat',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p35 (printed p34), Appendix I: Fats and cholesterol',
    sourceQuote: 'Low Saturated Fat / Low in Saturated Fat: ≤ 1.5 g saturated fats per 100 g, and ≤10% of kilocalories from saturated fats, or ≤ 0.75 g of saturated fats per 100 ml, and ≤ 10% of kilocalories from saturated fats',
  },
  'CLM-CHOLFREE': {
    family: 'cholesterol-free',
    threshold: 'foods derived solely from plant source: 0 mg cholesterol per 100 g (source-based branch)',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p37 (printed p36), Appendix I: Fats and cholesterol — Cholesterol',
    sourceQuote: 'Cholesterol Free / No Cholesterol / Free of Cholesterol: Food that are derived solely from plant source. 0 mg of cholesterol per 100 g food',
  },
  'CLM-TRANSFATFREE': {
    family: 'trans-fat-free',
    threshold: 'trans fatty acids < 0.5 g per 100 g',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p37 (printed p36), Appendix I: Fats and cholesterol',
    sourceQuote: 'Trans Fat Free / Free of Trans Fat: < 0.5 g of trans fatty acids per 100 g',
  },
  'CLM-NOARTIFICIAL': {
    family: 'no-artificial',
    threshold: 'factual presence check: no synthetic colour/flavour additives vs the declared list + additive KB (no SG numeric threshold exists for this claim)',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, §5.1 PDF p10 (printed p9) + data/additives/verdicts.json (EFSA-cited, slice 8)',
    sourceQuote: 'A nutrition claim suggests or implies that a food has a nutritive property. This property may be general or specific and it can be stated positively or negatively.',
    heuristic: 'factual composition check, not a numeric legal threshold',
  },
  'CLM-NOPRESERVATIVES': {
    family: 'no-preservatives',
    threshold: 'factual presence check: no preservative-function additive in the declared list / additive occurrences',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, §5.1 PDF p10 (printed p9) + data/additives/verdicts.json (EFSA-cited)',
    sourceQuote: 'A nutrition claim suggests or implies that a food has a nutritive property.',
    heuristic: 'factual composition check, not a numeric legal threshold',
  },
  'CLM-NOADDITIVES': {
    family: 'no-additives',
    threshold: 'factual presence check: no food additives in the declared list / additive occurrences',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, §5.1 PDF p10 (printed p9) + data/additives/occurrences.json (OFF taxonomy, ODbL)',
    sourceQuote: 'A nutrition claim suggests or implies that a food has a nutritive property.',
    heuristic: 'factual composition check, not a numeric legal threshold',
  },
  'CLM-NATURAL': {
    family: 'natural',
    threshold: 'factual composition check: "natural" has no SG statutory definition in the HPB guide — assessed as whole-food composition vs synthetic additives, non-chemophobic wording',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, §5.1 PDF p10 (printed p9) + data/additives/verdicts.json (EFSA-cited)',
    sourceQuote: 'A nutrition claim suggests or implies that a food has a nutritive property.',
    heuristic: 'factual composition check; "natural" is not a defined SG nutrient claim',
  },
  'CLM-NATURALFLAVOUR': {
    family: 'natural-flavour',
    threshold: 'factual presence check: natural flavour ingredients present, no artificial/nature-identical flavour tokens',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, §5.1 PDF p10 (printed p9)',
    sourceQuote: 'A nutrition claim suggests or implies that a food has a nutritive property.',
    heuristic: 'factual composition check, not a numeric legal threshold',
  },
  'CLM-QUANT-PROTEIN': {
    family: 'quant-protein',
    threshold: 'a stated "X g protein per 100 g" must match the panel within label-rounding tolerance (±5% or ±0.5 g, whichever larger — engine heuristic)',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, §5.1 PDF p10 (printed p9); rounding tolerance is an engine heuristic, not a legal threshold',
    sourceQuote: 'A nutrition claim suggests or implies that a food has a nutritive property.',
    heuristic: '±5% / ±0.5 g rounding tolerance is an engine heuristic',
  },
  'CLM-KIDS-SUGAR': {
    family: 'kids-sugar',
    threshold: `kids-positioned + health-halo marketing + total sugars > ${UK_RED_SUGARS} g/100 g = UK NHS traffic-light RED (UK heuristic — NOT SG law); positioning-vs-content proposal for founder review`,
    sourceUrl: NHS_LABELS_URL,
    pageRef: 'NHS food labels (UK traffic-light criteria, page last reviewed 30 June 2026) — UK HEURISTIC, NOT SG LAW; teaspoon context 5 g/tsp = HPB consumer convention (PRD story 36)',
    sourceQuote: 'Sugars — High: more than 22.5g of total sugars per 100g. Red means high.',
    heuristic: 'UK NHS red heuristic, explicitly NOT SG law; no SG legal threshold asserted',
  },
};

export const ALL_RULES = { ...A7_RULES, ...SWEEP_RULES };

// ---------------------------------------------------------------------------
// Additive evidence (read-only joins of slice-8 artifacts)
// ---------------------------------------------------------------------------

// Colour origin classes — cited from verdicts.json safetyVerdicts (EFSA).
// "undeclared" = synthetic vs natural route not stated on the label we hold.
export const COLOUR_ORIGIN = {
  'en:e100': 'natural', 'en:e120': 'natural', 'en:e160b': 'natural',
  'en:e141ii': 'natural-derived', 'en:e160aiii': 'nature-identical-fermentation',
  'en:e160a': 'undeclared', 'en:e150a': 'undeclared',
  'en:e102': 'synthetic', 'en:e110': 'synthetic', 'en:e129': 'synthetic',
  'en:e132': 'synthetic', 'en:e133': 'synthetic',
};
export const SYNTHETIC_ANTIOXIDANTS = new Set(['en:e320', 'en:e321']); // BHA / BHT
export const ANIMAL_TOKEN_RE = /\b(?:milk|whey|casein(?:ate)?|lactose|honey|egg(?:s| white| yolk)?|gelatin(?:e)?|meat|fish|shellfish|butter|cream|yoghurt|yogurt|cheese|animal)\b/i;
export const ARTIFICIAL_FLAVOUR_RE = /\b(?:artificial|nature[- ]identical)\s+flavou?r/i;
export const NATURAL_FLAVOUR_RE = /\bnatural\s+flavou?r/i;
export const PRESERVATIVE_TOKEN_RE = /\(preservative\)|\b(?:potassium\s?sorbate|sodium\s?benzoate|calcium\s?propionate|sorbic\s?acid|benzoic\s?acid|sulphur\s?dioxide|sodium\s?metabisulphite|natamycin|nisin)\b/i;

export function indexOccurrences(occurrencesDoc) {
  const byEan = new Map();
  for (const [additiveId, occ] of Object.entries(occurrencesDoc?.occurrences ?? {})) {
    for (const x of occ) {
      const k = String(x.ean);
      if (!byEan.has(k)) byEan.set(k, []);
      byEan.get(k).push({ additiveId, ...x });
    }
  }
  return byEan;
}

function verdictFor(verdictsDoc, additiveId) {
  return verdictsDoc?.verdicts?.[additiveId] ?? null;
}

function additiveEvidenceBlock(product, occ, verdictsDoc, detail) {
  const v = verdictFor(verdictsDoc, occ.additiveId);
  return {
    kind: 'additive',
    quotedIngredient: occ.excerpt,
    ingredientSource: `data/additives/occurrences.json (${occ.additiveId}, matched "${occ.matchedTerm}", position ${occ.position}/${occ.totalIngredients})`,
    sourceUrl: product?.ingredients?.sourceUrl ?? product?.offers?.[0]?.sourceUrl ?? null,
    additive: {
      id: occ.additiveId,
      name: v?.name ?? occ.matchedTerm,
      function: v?.function ?? [],
      safetyVerdict: v?.safetyVerdict ?? null,
      efsaSource: v?.source?.url ?? null,
    },
    detail,
  };
}

// ---------------------------------------------------------------------------
// 7b ingredient preprocessing (multilingual OCR/OFF label prefixes)
// ---------------------------------------------------------------------------

export function stripLabelPrefix(text) {
  if (typeof text !== 'string') return text;
  // e.g. "INGREDIENTS / ส่วนประกอบที่สำคัญ / THÀNH PHÂN Cereal Flour (74.4%) ..."
  return text.replace(/^INGREDIENTS?\s*\/[\s\S]*?\b(?=Cereal|Corn|Wheat|Oat|Rice|Sugar|Whole|Maize|Barley)/i, '');
}

export function sweepIngredientEvidence(product, sheetRow) {
  const ing = ingredientEvidence(product, sheetRow);
  if (!ing.usable) return ing;
  const text = stripLabelPrefix(ing.text);
  if (!ingredientTextUsable(text)) return { ...ing, usable: false, source: `${ing.source} — unusable after label-prefix strip` };
  // Allergen-only STATEMENTS ("Contains oats", "Contains oats • Product may
  // contain traces of wheat") are not an ingredient list; a bare "oats" IS a
  // complete single-ingredient list and stays usable.
  if (/^contains?\s+(?:oats?|gluten|wheat|milk|soy|nuts?|cereals?)(?:\s+(?:and|,)\s+(?:oats?|gluten|wheat|milk|soy|nuts?|cereals?))*\.?$/i.test(text)
      || (/^contains?\s/i.test(text) && /may contain|traces/i.test(text) && text.length < 90)) {
    return { ...ing, usable: false, source: `${ing.source} — allergen-only statement, not an ingredient list` };
  }
  return { ...ing, text };
}

// ---------------------------------------------------------------------------
// Sweep claim extraction (names + positioning evidence, verbatim)
// ---------------------------------------------------------------------------

const SWEEP_PATTERNS = [
  { family: 'low-fat', re: /\blow(?:\s+in)?\s+fat\b/gi },
  { family: 'low-satfat', re: /\blow\s+in\s+saturated\s+fat\b/gi },
  { family: 'cholesterol-free', re: /\b(?:naturally\s+)?cholesterol[\s-]?free\b|\bno\s+cholesterol\b/gi },
  { family: 'trans-fat-free', re: /\btrans[\s-]?fat[\s-]?free\b|\bfree\s+of\s+trans\s+fat\b/gi },
  { family: 'no-artificial', re: /\bno\s+artificial\s+colou?rs?(?:\s+or\s+(?:artificial\s+)?flavou?rs?)?\b|\bno\s+artificial\s+flavou?rs?\b|\bno\s+added\s+colou?ring\s+and\s+flavou?ring\b|\bmade\s+with\s+natural\s+colou?rs?\b/gi },
  { family: 'no-preservatives', re: /\bno\s+preservatives?(?:\s+added)?\b|\bno\s+added[^.;•]{0,60}\bpreservatives?\b/gi },
  { family: 'no-additives', re: /\bno\s+(?:chemical\s+)?additives\b|\bno\s+added[^.;•]{0,60}\badditives\b/gi },
  { family: 'natural', re: /\b100%\s+natural(?:\s+ingredients)?\b|\ball\s+natural\b|\bnatural\s+oats\b/gi },
  { family: 'natural-flavour', re: /\bnaturally\s+flavou?red(?:\s+with\s+other\s+natural\s+flavou?rs)?\b/gi },
  { family: 'quant-protein', re: /\b\d+(?:\.\d+)?\s*g\s+(?:of\s+)?protein\s+per\s+100\s*g\b/gi },
];

const SOURCE_PRIORITY = { 'pack-photo-ocr': 3, 'marketing-copy': 2, 'key-information': 2 };

function sentenceAround(text, index) {
  const start = Math.max(text.lastIndexOf('.', index) + 1, text.lastIndexOf('•', index) + 1, text.lastIndexOf(';', index) + 1, 0);
  let end = text.length;
  for (const sep of ['.', '•', ';']) {
    const i = text.indexOf(sep, index);
    if (i >= 0 && i < end) end = i;
  }
  return text.slice(start, end).trim();
}

export function extractSweepClaims(product, sheetRow) {
  const sources = [{ location: 'product name (retailer listing)', text: product.name, sourceUrl: product?.offers?.[0]?.sourceUrl ?? null, priority: 1 }];
  for (const e of sheetRow?.evidence ?? []) {
    if (['marketing-copy', 'pack-photo-ocr', 'key-information'].includes(e.type) && e.quote) {
      sources.push({ location: `classification sheet evidence [${e.type}]`, text: e.quote, sourceUrl: e.sourceUrl ?? null, priority: SOURCE_PRIORITY[e.type] ?? 2, ocrRecord: e.ocrRecord ?? null });
    }
  }
  const byFamily = new Map();
  for (const src of sources) {
    for (const { family, re } of SWEEP_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src.text)) !== null) {
        const claim = {
          family,
          quotedClaim: m[0].trim(),
          claimSource: { location: src.location, contextQuote: src.text, sourceUrl: src.sourceUrl, ocrRecord: src.ocrRecord ?? undefined },
          sentence: sentenceAround(src.text, m.index),
          priority: src.priority,
        };
        if (family === 'quant-protein') claim.statedProteinG = Number(m[0].match(/(\d+(?:\.\d+)?)/)[1]);
        if (family === 'no-artificial') {
          claim.checksColours = /colou?r/i.test(m[0]);
          claim.checksFlavours = /flavou?r/i.test(m[0]);
          claim.naturalColoursClaim = /made\s+with\s+natural/i.test(m[0]);
          claim.noAddedClaim = /no\s+added/i.test(m[0]);
        }
        const prev = byFamily.get(family);
        if (!prev || claim.priority > prev.priority) byFamily.set(family, claim);
      }
    }
  }
  return [...byFamily.values()];
}

// ---------------------------------------------------------------------------
// Sweep checks
// ---------------------------------------------------------------------------

function finding(claim, product, ruleId, verdict, confidence, evidence, notes = []) {
  const rule = ALL_RULES[ruleId];
  return {
    ean: product.ean,
    productName: product.name,
    productPageUrl: product?.offers?.[0]?.sourceUrl ?? null,
    ruleId,
    claimFamily: claim.family,
    quotedClaim: claim.quotedClaim,
    claimSource: claim.claimSource,
    evidence,
    threshold: { rule: rule.threshold, sourceUrl: rule.sourceUrl, sourceQuote: rule.sourceQuote, pageRef: rule.pageRef, heuristic: rule.heuristic ?? undefined },
    verdict,
    confidence,
    notes,
    layer: '7b',
  };
}

function nutrientBlock(product, key, n, detail) {
  return { kind: 'nutrient', nutrientKey: key, value: n.value, unit: n.unit, provenanceTier: n.provenanceTier, sourceUrl: nutritionSourceUrl(product, n.provenanceTier), detail };
}

function ingredientBlock(ing, quotedIngredient) {
  return { kind: 'ingredient', quotedIngredient, ingredientListQuote: ing.raw, ingredientSource: ing.source, sourceUrl: ing.sourceUrl };
}

function uncheckable(claim, product, reason) {
  return { ean: product.ean, productName: product.name, claimFamily: claim.family, ruleId: FAMILY_RULE[claim.family], quotedClaim: claim.quotedClaim, claimSource: claim.claimSource, reason, layer: '7b' };
}

const FAMILY_RULE = {
  'low-fat': 'CLM-LOWFAT', 'low-satfat': 'CLM-LOWSATFAT', 'cholesterol-free': 'CLM-CHOLFREE',
  'trans-fat-free': 'CLM-TRANSFATFREE', 'no-artificial': 'CLM-NOARTIFICIAL',
  'no-preservatives': 'CLM-NOPRESERVATIVES', 'no-additives': 'CLM-NOADDITIVES',
  natural: 'CLM-NATURAL', 'natural-flavour': 'CLM-NATURALFLAVOUR', 'quant-protein': 'CLM-QUANT-PROTEIN',
};

function confForTier(tier) { return tier === 'estimated-derived' ? 'medium' : 'high'; }

function checkLowFat(claim, product) {
  const fat = usableNutrient(product, 'fat');
  if (!fat) return uncheckable(claim, product, 'no usable per-100g fat value (missing or non-scoreable provenance tier)');
  const ok = fat.value <= 3;
  const notes = [];
  // 07b-review issue 4: disclose HCS context for consistency with the kids
  // rule. HCS is category-relative and does NOT waive the absolute threshold.
  if (product?.attributes?.healthierChoiceSymbol === true) {
    notes.push('HCS context (07b-review issue 4): the retailer Healthier Choice Symbol attribute is TRUE. HCS is a category-relative certification and does NOT waive the absolute HPB ≤3 g/100g low-fat threshold — the finding stands; the retailer copy may loosely echo the certification. Disclosed for consistency with the kids-rule HCS treatment.');
  }
  let basisContingent = false;
  let asConsumedIllustrative = null;
  if (product.scoring_category === 'sg-nutrigrade-beverages') {
    // Beverage powder: the claim is assessed on the declared per-100g basis
    // (the form sold; HPB §5.1 solid criterion). The guide's as-reconstituted
    // per-100ml column is OPTIONAL (PDF p5) — recorded for founder context.
    const prep = product.prepInstructions;
    if (prep && typeof prep.powderG === 'number') {
      const vol = prep.finalVolumeMl ?? prep.waterMl;
      if (typeof vol === 'number' && vol > 0) {
        const per100ml = Math.round(fat.value * prep.powderG / vol * 100) / 100;
        notes.push(`Beverage powder: as-reconstituted fat ≈ ${per100ml} g/100ml (${prep.powderG} g powder → ${vol} ml) vs the liquid criterion ≤1.5 g/100ml — ${per100ml <= 1.5 ? 'passes on an as-consumed reading' : 'fails on both bases'}. The declared per-100g powder basis is the form sold; founder adjudicates the basis reading.`);
        if (!ok && per100ml <= 1.5) basisContingent = true;
      } else {
        notes.push('Beverage powder: as-reconstituted basis not computable (prep volume gap) — assessed on the declared per-100g powder basis.');
      }
    } else {
      notes.push('Beverage powder: prepInstructions not published in our data (structural prep-gap item pending) — as-reconstituted basis not computable from pack instructions; assessed on the declared per-100g powder basis (the form sold). Founder may adjudicate an as-consumed reading.');
      // 07b-review issue 1: labelled ILLUSTRATIVE as-consumed estimate at the
      // declared serving in an assumed typical volume — never pack instructions.
      const servingG = product?.nutrition?.servingSizeG;
      if (!ok && typeof servingG === 'number' && servingG > 0) {
        const assumedMl = 200;
        const per100ml = Math.round(fat.value * servingG / assumedMl * 100) / 100;
        asConsumedIllustrative = { assumedVolumeMl: assumedMl, declaredServingG: servingG, fatPer100ml: per100ml, liquidCriterionGPer100ml: 1.5, label: 'ILLUSTRATIVE ASSUMPTION (typical 200 ml prep) — NOT pack instructions; provenance: estimated' };
        basisContingent = per100ml <= 1.5;
        notes.push(`BASIS-CONTINGENT (07b-review issue 1): at the declared ${servingG} g serving in an ASSUMED 200 ml (typical prep, NOT pack instructions), fat ≈ ${per100ml} g/100ml ${per100ml <= 1.5 ? '≤ 1.5 → would PASS on an as-consumed reading' : '> 1.5 → fails on both bases'}. This flag is on the declared DRY per-100g basis per the label (form sold); HPB p5 makes the as-reconstituted column optional. Founder adjudicates the basis reading — do not present as an unqualified catch.`);
      }
    }
    // Slice-6 OCR row-level dispute context (07b-review issue 1).
    const adj = product?.nutrition?.ocr?.adjudication;
    if (typeof adj === 'string' && adj) {
      notes.push(`OCR panel context (slice 6): "${adj}" — the withheld row is saturated fat, not total fat; the LOWFAT verdict uses the undisputed total-fat row and is robust to the dispute (07b-review issue 1).`);
    }
  }
  const f = finding(claim, product, 'CLM-LOWFAT', ok ? 'ok' : 'contradicted', confForTier(fat.provenanceTier), nutrientBlock(product, 'fat', fat, `fat ${fat.value} g/100g vs ≤ 3 g/100g HPB low-fat threshold${basisContingent ? ' (DRY basis per label — basis-contingent, see notes)' : ''}`), notes);
  if (basisContingent) {
    f.basisContingent = true;
    f.evidence.basisContingent = true;
    if (asConsumedIllustrative) f.evidence.asConsumedIllustrative = asConsumedIllustrative;
  }
  return f;
}

function checkLowSatFat(claim, product) {
  const sat = usableNutrient(product, 'saturated_fat');
  const kcal = energyKcalPer100g(product);
  if (!sat || !kcal) return uncheckable(claim, product, 'no usable saturated-fat and/or energy basis for the dual criterion');
  const energyPct = (sat.value * 9 / kcal.value) * 100;
  const ok = sat.value <= 1.5 && energyPct <= 10;
  return finding(claim, product, 'CLM-LOWSATFAT', ok ? 'ok' : 'contradicted', confForTier(sat.provenanceTier), nutrientBlock(product, 'saturated_fat', sat, `saturated fat ${sat.value} g/100g (≤1.5 required) AND ${energyPct.toFixed(1)}% of energy (≤10% required)`));
}

function checkCholesterolFree(claim, product, ing, parsed) {
  if (!ing.usable) return uncheckable(claim, product, `ingredient list not usable (${ing.source}) — plant-only source not verifiable from the declared list`);
  const animal = parsed.flat.find((t) => ANIMAL_TOKEN_RE.test(t.raw));
  if (animal) {
    return finding(claim, product, 'CLM-CHOLFREE', 'contradicted', 'high', ingredientBlock(ing, animal.raw), ['HPB cholesterol-free (plant-source branch) requires food derived solely from plant source; an animal-derived ingredient is declared.']);
  }
  return finding(claim, product, 'CLM-CHOLFREE', 'ok', 'medium', ingredientBlock(ing, ing.text), ['Declared ingredients are solely plant-derived — HPB plant-source branch (0 mg cholesterol implicit). No cholesterol panel exists in the catalogue; the source-based criterion is used.']);
}

function checkTransFatFree(claim, product) {
  const trans = usableNutrient(product, 'trans_fat');
  if (!trans) return uncheckable(claim, product, 'no trans-fat value published in the catalogue (no per-100g trans_fat field) — <0.5 g/100g criterion not verifiable');
  const ok = trans.value < 0.5;
  return finding(claim, product, 'CLM-TRANSFATFREE', ok ? 'ok' : 'contradicted', confForTier(trans.provenanceTier), nutrientBlock(product, 'trans_fat', trans, `trans fat ${trans.value} g/100g vs < 0.5 g/100g`));
}

function checkNoArtificial(claim, product, ing, parsed, occ, verdictsDoc) {
  const ruleId = 'CLM-NOARTIFICIAL';
  const colourOcc = occ.filter((o) => (verdictFor(verdictsDoc, o.additiveId)?.function ?? []).includes('colour'));
  const artificialFlavour = parsed.flat.find((t) => ARTIFICIAL_FLAVOUR_RE.test(t.raw));
  const naturalFlavour = parsed.flat.find((t) => NATURAL_FLAVOUR_RE.test(t.raw));
  const notes = [];
  // "No added colouring and flavouring" — ANY added colour/flavour contradicts.
  if (claim.noAddedClaim) {
    if (!ing.usable && !colourOcc.length) return uncheckable(claim, product, `ingredient list not usable (${ing.source}) — added colouring/flavouring not verifiable`);
    const flavourToken = parsed.flat.find((t) => /flavou?r/i.test(t.raw));
    if (colourOcc.length) return finding(claim, product, ruleId, 'contradicted', 'high', additiveEvidenceBlock(product, colourOcc[0], verdictsDoc, 'A colour additive is declared/occurs while the pack claims no added colouring.'));
    if (flavourToken) return finding(claim, product, ruleId, 'contradicted', 'high', ingredientBlock(ing, flavourToken.raw), ['A flavouring ingredient is declared while the pack claims no added flavouring.']);
    return finding(claim, product, ruleId, 'ok', 'medium', ingredientBlock(ing, ing.text), ['No colour or flavour ingredient in the declared list.']);
  }
  // Flavours leg
  if (claim.checksFlavours) {
    if (artificialFlavour) {
      return finding(claim, product, ruleId, 'contradicted', 'high', ingredientBlock(ing, artificialFlavour.raw), ['An artificial/nature-identical flavour is declared (nature-identical vanillin is synthetic-origin).']);
    }
    if (!ing.usable) return uncheckable(claim, product, `ingredient list not usable (${ing.source}) — artificial flavours not verifiable`);
    notes.push(naturalFlavour ? `Natural flavour declared ("${naturalFlavour.raw}"); no artificial/nature-identical flavour token.` : 'No flavour ingredient declared; no artificial/nature-identical flavour token.');
  }
  // Colours leg
  if (claim.checksColours) {
    const synthetic = colourOcc.find((o) => COLOUR_ORIGIN[o.additiveId] === 'synthetic');
    if (synthetic) {
      return finding(claim, product, ruleId, 'contradicted', 'high', additiveEvidenceBlock(product, synthetic, verdictsDoc, 'A synthetic colour occurs in the product while the pack claims no artificial colours / made with natural colours.'), notes);
    }
    const undeclared = colourOcc.find((o) => (COLOUR_ORIGIN[o.additiveId] ?? 'undeclared') === 'undeclared');
    if (undeclared) {
      const v = verdictFor(verdictsDoc, undeclared.additiveId);
      return uncheckable(claim, product, `added colour "${undeclared.excerpt}" (${v?.name ?? undeclared.additiveId}) has UNDECLARED origin (synthetic vs natural route not stated on the label we hold) — "${claim.quotedClaim}" is not verifiable either way; label-origin verification needed before any accusation (closest candidate, NOT queued)`);
    }
    if (!colourOcc.length) {
      if (!ing.usable) return uncheckable(claim, product, `ingredient list not usable (${ing.source}) — colours not verifiable`);
      const colourToken = parsed.flat.find((t) => /\bcolou?r(?:ing)?\b/i.test(t.raw) && !/no\s+added/i.test(t.raw));
      if (colourToken) return uncheckable(claim, product, `colour ingredient "${colourToken.raw}" not matched to the additive KB — origin not classifiable from our data`);
      notes.push('No colour additive in the declared list or additive occurrences.');
    } else {
      const origins = colourOcc.map((o) => `${verdictFor(verdictsDoc, o.additiveId)?.name ?? o.additiveId}: ${COLOUR_ORIGIN[o.additiveId]}`);
      notes.push(`Colours present are natural / natural-derived / fermentation-derived nature-identical (${origins.join('; ')}) — not synthetic dyes. Non-chemophobic framing: these are permitted colours with EFSA safety verdicts, not a toxicity concern.`);
      if (colourOcc.some((o) => COLOUR_ORIGIN[o.additiveId] === 'nature-identical-fermentation')) {
        notes.push('E160a(iii) beta-carotene is nature-identical, produced by fermentation (verdicts.json) — treated as not-artificial for this claim; founder may apply a stricter reading.');
      }
      if (colourOcc.some((o) => o.additiveId === 'en:e120')) notes.push('Cochineal (E120) is insect-derived — relevant to vegan/vegetarian labelling, not to the natural-colour claim.');
    }
  }
  const ev = colourOcc.length ? additiveEvidenceBlock(product, colourOcc[0], verdictsDoc, 'Colour evidence cross-checked against verdicts.json origin classes.') : ing.usable ? ingredientBlock(ing, naturalFlavour?.raw ?? ing.text) : { kind: 'claim-text', detail: claim.sentence, sourceUrl: claim.claimSource.sourceUrl };
  return finding(claim, product, ruleId, 'ok', colourOcc.length || ing.usable ? 'high' : 'medium', ev, notes);
}

function checkNoPreservatives(claim, product, ing, parsed, occ, verdictsDoc) {
  const ruleId = 'CLM-NOPRESERVATIVES';
  const preservativeOcc = occ.find((o) => (verdictFor(verdictsDoc, o.additiveId)?.function ?? []).includes('preservative'));
  if (preservativeOcc) {
    return finding(claim, product, ruleId, 'contradicted', 'high', additiveEvidenceBlock(product, preservativeOcc, verdictsDoc, 'An additive with preservative function occurs while the pack claims no preservatives.'), ['Factual presence check — the additive\'s EFSA safety verdict is carried in the evidence; this is a claim-accuracy finding, not a toxicity accusation.']);
  }
  const token = parsed.flat.find((t) => PRESERVATIVE_TOKEN_RE.test(t.raw));
  if (token) return finding(claim, product, ruleId, 'contradicted', 'high', ingredientBlock(ing, token.raw), ['A preservative is declared in the ingredient list.']);
  if (!ing.usable) return uncheckable(claim, product, `ingredient list not usable (${ing.source}) — absence of preservatives not verifiable (occurrence index alone is not evidence of absence on an unusable list)`);
  return finding(claim, product, ruleId, 'ok', 'high', ingredientBlock(ing, ing.text), ['No preservative-function additive in the declared list or additive occurrences.']);
}

function checkNoAdditives(claim, product, ing, parsed, occ, verdictsDoc) {
  const ruleId = 'CLM-NOADDITIVES';
  if (occ.length) {
    return finding(claim, product, ruleId, 'contradicted', 'high', additiveEvidenceBlock(product, occ[0], verdictsDoc, `${occ.length} additive occurrence(s) indexed while the pack claims no additives.`), occ.slice(1, 4).map((o) => `Additional additive: "${o.excerpt}" (${o.additiveId})`));
  }
  if (!ing.usable) return uncheckable(claim, product, `ingredient list not usable (${ing.source}) — absence of additives not verifiable`);
  return finding(claim, product, ruleId, 'ok', 'high', ingredientBlock(ing, ing.text), ['No additives in the declared list or additive occurrences.']);
}

function checkNatural(claim, product, ing, parsed, occ, verdictsDoc) {
  const ruleId = 'CLM-NATURAL';
  const synthetic = occ.find((o) => COLOUR_ORIGIN[o.additiveId] === 'synthetic' || SYNTHETIC_ANTIOXIDANTS.has(o.additiveId));
  const artificialFlavour = parsed.flat.find((t) => ARTIFICIAL_FLAVOUR_RE.test(t.raw));
  if (synthetic) {
    return finding(claim, product, ruleId, 'misleading', 'medium', additiveEvidenceBlock(product, synthetic, verdictsDoc, 'A synthetic additive occurs under a "natural" claim.'), ['"Natural" has no SG statutory definition in the HPB guide — factual composition proposal for founder review, not a legal-threshold accusation. The additive is permitted and EFSA-evaluated; the finding is about claim accuracy, not safety.']);
  }
  if (artificialFlavour) {
    return finding(claim, product, ruleId, 'misleading', 'medium', ingredientBlock(ing, artificialFlavour.raw), ['An artificial/nature-identical flavour is declared under a "natural" claim; "natural" has no SG statutory definition — founder review proposed.']);
  }
  if (!ing.usable) return uncheckable(claim, product, `ingredient list not usable (${ing.source}) — natural composition not verifiable`);
  return finding(claim, product, ruleId, 'ok', 'medium', ingredientBlock(ing, ing.text), ['Whole-food declared composition; no synthetic additives in the list or occurrences. "Natural" has no SG statutory definition — assessed as a factual composition check.']);
}

function checkNaturalFlavour(claim, product, ing, parsed) {
  const ruleId = 'CLM-NATURALFLAVOUR';
  if (!ing.usable) return uncheckable(claim, product, `ingredient list not usable (${ing.source})`);
  const artificial = parsed.flat.find((t) => ARTIFICIAL_FLAVOUR_RE.test(t.raw));
  if (artificial) return finding(claim, product, ruleId, 'contradicted', 'high', ingredientBlock(ing, artificial.raw), ['An artificial/nature-identical flavour is declared under a "naturally flavoured" claim.']);
  const natural = parsed.flat.find((t) => NATURAL_FLAVOUR_RE.test(t.raw));
  if (natural) return finding(claim, product, ruleId, 'ok', 'high', ingredientBlock(ing, natural.raw), ['Natural flavour ingredient declared; no artificial/nature-identical flavour token.']);
  return uncheckable(claim, product, 'no flavour ingredient declared in the list we hold — "naturally flavoured" not verifiable');
}

function checkQuantProtein(claim, product) {
  const protein = usableNutrient(product, 'protein');
  if (!protein) return uncheckable(claim, product, 'no usable per-100g protein value');
  const tol = Math.max(0.5, claim.statedProteinG * 0.05);
  const diff = Math.abs(protein.value - claim.statedProteinG);
  const ok = diff <= tol;
  return finding(claim, product, 'CLM-QUANT-PROTEIN', ok ? 'ok' : 'contradicted', confForTier(protein.provenanceTier), nutrientBlock(product, 'protein', protein, `stated ${claim.statedProteinG} g/100g vs panel ${protein.value} g/100g (diff ${diff.toFixed(2)} g, tolerance ±${tol.toFixed(2)} g — engine rounding heuristic)`));
}

export function checkSweepClaim(claim, product, ctx) {
  const { ing, parsed, occ, verdictsDoc } = ctx;
  switch (claim.family) {
    case 'low-fat': return checkLowFat(claim, product);
    case 'low-satfat': return checkLowSatFat(claim, product);
    case 'cholesterol-free': return checkCholesterolFree(claim, product, ing, parsed);
    case 'trans-fat-free': return checkTransFatFree(claim, product);
    case 'no-artificial': return checkNoArtificial(claim, product, ing, parsed, occ, verdictsDoc);
    case 'no-preservatives': return checkNoPreservatives(claim, product, ing, parsed, occ, verdictsDoc);
    case 'no-additives': return checkNoAdditives(claim, product, ing, parsed, occ, verdictsDoc);
    case 'natural': return checkNatural(claim, product, ing, parsed, occ, verdictsDoc);
    case 'natural-flavour': return checkNaturalFlavour(claim, product, ing, parsed);
    case 'quant-protein': return checkQuantProtein(claim, product);
    default: return uncheckable(claim, product, `no sweep rule for family ${claim.family}`);
  }
}

// ---------------------------------------------------------------------------
// Kids-positioning vs sugar content (UK heuristic, labelled; proposals only)
// ---------------------------------------------------------------------------

const HEALTH_HALO_RE = /whole[\s-]?grain|wholegrain|fib(?:re|er)|vitamin|healthier\s+choice|stay\s+active|energy\s+to\s+be\s+active|energy\s+for\s+school|nutrismart|fuller\s+for\s+longer|alertness|keep\s+your\s+children|children\s+fuller/i;
const CHILD_BENEFIT_RE = /fuller\s+for\s+longer|alertness|stay\s+active|energy\s+to\s+be\s+active|energy\s+for\s+school|nutrismart|healthier\s+choice|keep\s+your\s+children|children/i;
// Annotation-only OCR quotes (mascot descriptions, format, prep, keyword lists)
// are positioning context, never a quotable health claim.
const NON_CLAIM_QUOTE_RE = /^\[(mascot|format|ingredients|prep|kidsPositioning|versatility|packName|back)\]/i;

export function kidsSugarCheck(product, sheetRow) {
  if (product?.attributes?.kidsPositioned !== true) return null;
  const sugars = usableNutrient(product, 'sugars');
  const positioning = (sheetRow?.evidence ?? []).filter((e) => ['marketing-copy', 'pack-photo-ocr', 'key-information'].includes(e.type) && e.quote && !NON_CLAIM_QUOTE_RE.test(e.quote));
  if (!sugars) {
    return { kind: 'uncheckable', ean: product.ean, productName: product.name, ruleId: 'CLM-KIDS-SUGAR', reason: 'kids-positioned but no usable per-100g sugars value — sugar content not verifiable (honest gap)', layer: '7b' };
  }
  if (sugars.value <= UK_RED_SUGARS) return null; // below UK red — nothing to propose
  // Prefer an explicit child-benefit / health-halo phrase over a generic
  // wholegrain/fibre mention; pack OCR outranks marketing copy at equal strength.
  const candidates = [];
  const BENEFIT_PHRASE_RE = /keep\s+your\s+children[^.;•]*|fuller\s+for\s+longer[^.;•]*|alertness[^.;•]*|stay\s+active[^.;•]*|energy\s+to\s+be\s+active[^.;•]*|energy\s+for\s+school[^.;•]*|healthier\s+choice[^.;•]*/i;
  for (const e of positioning) {
    const m = e.quote.match(BENEFIT_PHRASE_RE) ?? e.quote.match(HEALTH_HALO_RE);
    if (!m) continue;
    const strength = /fuller\s+for\s+longer|alertness|keep\s+your\s+children|children\s+fuller/i.test(e.quote) ? 3 : CHILD_BENEFIT_RE.test(e.quote) ? 2 : 1;
    const priority = SOURCE_PRIORITY[e.type] ?? 2;
    candidates.push({ e, m, strength, priority });
  }
  candidates.sort((a, b) => b.strength - a.strength || b.priority - a.priority);
  const haloSource = candidates[0]?.e;
  const haloMatch = candidates[0]?.m;
  const tspPerServing = typeof product?.nutrition?.servingSizeG === 'number' && product.nutrition.servingSizeG > 0
    ? Math.round((sugars.value * product.nutrition.servingSizeG / 100) / TSP_GRAMS * 10) / 10
    : null;
  const hcs = product?.attributes?.healthierChoiceSymbol === true || positioning.some((e) => /HEALTHIER\s+CHOICE/i.test(e.quote));
  const base = {
    ean: product.ean, productName: product.name, ruleId: 'CLM-KIDS-SUGAR',
    sugars: { value: sugars.value, unit: sugars.unit, provenanceTier: sugars.provenanceTier, sourceUrl: nutritionSourceUrl(product, sugars.provenanceTier) },
    ukRedThreshold: UK_RED_SUGARS,
    teaspoonsPerDeclaredServing: tspPerServing,
    declaredServingG: product?.nutrition?.servingSizeG ?? null,
    hcsCertifiedContext: hcs,
    layer: '7b',
  };
  if (!haloSource) {
    return { kind: 'informational', ...base, note: `Kids-positioned (mascot/child branding) with ${sugars.value} g sugars/100g — above the UK NHS red threshold (>22.5 g/100g, UK heuristic NOT SG law)${tspPerServing !== null ? `, ≈${tspPerServing} tsp per declared ${product.nutrition.servingSizeG} g serving (5 g/tsp HPB convention)` : ''}. NO health-halo claim to contradict — informational only, never queued.` };
  }
  const quotedClaim = sentenceAround(haloSource.quote, haloMatch.index).replace(/^\[[^\]]*\]\s*/, '');
  const claim = {
    family: 'kids-sugar',
    quotedClaim,
    claimSource: { location: haloSource.location ?? `classification sheet evidence [${haloSource.type}]`, contextQuote: haloSource.quote, sourceUrl: haloSource.sourceUrl ?? null, ocrRecord: haloSource.ocrRecord ?? undefined },
  };
  const notes = [
    `UK NHS traffic-light heuristic (>22.5 g total sugars/100g = RED) — explicitly NOT SG law; no SG legal threshold is asserted. Positioning-vs-content proposal for founder review.`,
    tspPerServing !== null ? `≈${tspPerServing} teaspoons of sugar per declared ${product.nutrition.servingSizeG} g serving (5 g/tsp, HPB consumer convention per PRD story 36).` : 'No declared serving size — per-100g basis only.',
    `Health-halo/child-benefit marketing quoted verbatim; kids positioning corroborated by the classification sheet (mascot/child imagery/kids wording).`,
  ];
  if (hcs) notes.push('HCS CAVEAT: this product carries the Healthier Choice Symbol (HPB category-relative certification, "lower in sugar" vs category). The founder may reject this proposal on that basis — consistent with the slice-4 precedent that HCS certification is not an unverified claim. Confidence dropped to LOW.');
  return {
    kind: 'finding',
    finding: finding(claim, product, 'CLM-KIDS-SUGAR', 'misleading', hcs ? 'low' : 'medium', {
      kind: 'nutrient', nutrientKey: 'sugars', value: sugars.value, unit: sugars.unit, provenanceTier: sugars.provenanceTier,
      sourceUrl: nutritionSourceUrl(product, sugars.provenanceTier),
      detail: `kids-positioned cereal with ${sugars.value} g sugars/100g > ${UK_RED_SUGARS} g/100g UK NHS red (UK heuristic, NOT SG law) under health-halo marketing "${quotedClaim}"`,
      teaspoonsPerDeclaredServing: tspPerServing, declaredServingG: product?.nutrition?.servingSizeG ?? null,
    }, notes),
  };
}

// ---------------------------------------------------------------------------
// Recheck passes (7a-review issues 3 + 6) — history preserved
// ---------------------------------------------------------------------------

export const WIDENED_FREE_SUGAR_RE = new RegExp(`${FREE_SUGAR_RE.source}|\\binvert\\s?syrup\\b|\\bfruit\\s?syrup\\b|\\bflavou?red\\s?syrup\\b|\\bsyrup\\b`, 'i');

export function widenedFreeSugarScan(parsed) {
  return parsed.flat.filter((t) => WIDENED_FREE_SUGAR_RE.test(t.raw) && !SUGAR_ALCOHOL_RE.test(t.raw) && !SWEETENER_RE.test(t.raw));
}

// Contested serving declarations (07a-review issue 3): when the retailer panel
// and OFF declare different servings, the protein daily-quantity proxy is
// contested → recheck to uncheckable. The 7a finding is NEVER rewritten.
export function proteinServingRechecks(findings7a, catalogue) {
  const out = [];
  const byEan = new Map(catalogue.products.map((p) => [String(p.ean), p]));
  for (const f of findings7a) {
    if (!['CLM-PROTEINHIGH', 'CLM-PROTEINSOURCE'].includes(f.ruleId) || f.verdict !== 'ok') continue;
    const p = byEan.get(String(f.ean));
    const offServing = p?.nutrition?.off?.servingQuantityG;
    const panelServing = p?.nutrition?.servingSizeG;
    if (typeof offServing !== 'number' || typeof panelServing !== 'number' || offServing <= 0 || panelServing <= 0) continue;
    if (Math.abs(offServing - panelServing) / panelServing <= 0.1) continue;
    const protein = usableNutrient(p, 'protein');
    if (!protein) continue;
    const perDayOff = Math.round(protein.value * offServing) / 100;
    out.push({
      ean: f.ean, productName: f.productName, ruleId: f.ruleId, layer: '7b',
      originalVerdict7a: f.verdict, recheckVerdict: perDayOff >= 10 ? 'ok' : 'uncheckable',
      reason: `contested serving declarations: retailer panel ${panelServing} g ("${p.nutrition.servingDescription ?? ''}") vs OFF "${p.nutrition.off.servingSize}" (${offServing} g). At the OFF serving the daily-quantity proxy provides ${perDayOff} g protein (${perDayOff >= 10 ? '≥' : '<'} 10 g). The 7a ok finding is preserved unchanged; the protein-claim basis is ${perDayOff >= 10 ? 'reconfirmed' : 'downgraded to UNCHECKABLE pending label verification of the pack daily-recommendation statement'} (07a-review issue 3).`,
      panelServingG: panelServing, offServingG: offServing, proteinPer100g: protein.value, proteinPerOffServingG: perDayOff,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full sweep
// ---------------------------------------------------------------------------

function claimKey(f) { return `${f.ean}|${f.ruleId}|${f.quotedClaim}`; }

export function runSweep({ catalogue, sheet, pendingItems, findings7aDoc, occurrencesDoc, verdictsDoc }) {
  const sheetByEan = new Map((sheet?.rows ?? []).map((r) => [String(r.ean), r]));
  const occByEan = indexOccurrences(occurrencesDoc);
  const disputed = disputedPanelEans(pendingItems);
  const findings7a = findings7aDoc?.findings ?? [];
  const uncheckable7a = findings7aDoc?.uncheckable ?? [];
  const key7a = new Map(findings7a.map((f) => [claimKey(f), f]));
  const uncheckableKey7a = new Set(uncheckable7a.map((u) => `${u.ean}|${u.claimFamily}|${u.quotedClaim}`));

  const reconfirmed7a = [];
  const changed7a = [];
  const new7aLayer = [];
  const sweepFindings = [];
  const sweepUncheckable = [];
  const informational = [];
  const widenedRechecks = [];
  let claims7a = 0, claims7b = 0;
  const coverage = { productsProcessed: 0, withIngredientText: 0, withUsableIngredientText: 0, withPer100g: 0, withOffLayer: 0, withOcrLayer: 0, ingredientTiers: {}, kidsPositioned: 0, coldStorageOnly: 0 };

  for (const product of catalogue.products) {
    coverage.productsProcessed++;
    const sheetRow = sheetByEan.get(String(product.ean));
    if (product.ingredients?.text) {
      coverage.withIngredientText++;
      coverage.ingredientTiers[product.ingredients.provenanceTier] = (coverage.ingredientTiers[product.ingredients.provenanceTier] ?? 0) + 1;
    }
    if (product.nutrition?.per100g) coverage.withPer100g++;
    if (product.nutrition?.off) coverage.withOffLayer++;
    if (product.nutrition?.ocr) coverage.withOcrLayer++;
    if (product.attributes?.kidsPositioned === true) coverage.kidsPositioned++;
    if ((product.offers ?? []).every((o) => /cold\s?storage/i.test(o.store))) coverage.coldStorageOnly++;

    const ing = sweepIngredientEvidence(product, sheetRow);
    if (ing.usable) coverage.withUsableIngredientText++;
    const parsed = ing.usable ? parseIngredientList(ing.text) : { top: [], flat: [], first: null };
    const occ = occByEan.get(String(product.ean)) ?? [];
    const isDisputed = disputed.has(String(product.ean));
    const ctx = { ing, parsed, occ, verdictsDoc, catalogue, disputed: isDisputed };

    // --- 7a layer re-run (with 7b preprocessing) ---
    const { claims } = extractClaims7a(product, sheetRow);
    claims7a += claims.length;
    for (const claim of claims) {
      const result = checkClaim7a(claim, product, { ing, parsed, catalogue, disputed: isDisputed });
      if (result.verdict) {
        const prior = key7a.get(claimKey(result));
        if (!prior) {
          new7aLayer.push({ ...result, layer: '7b-rerun', notes: [...(result.notes ?? []), 'New vs the checked-in 7a findings snapshot (catalogue enriched 80→184 and/or OFF/OCR fills since the 7a run).'] });
        } else if (prior.verdict !== result.verdict) {
          changed7a.push({ ...result, layer: '7b-rerun', priorVerdict7a: prior.verdict, notes: [...(result.notes ?? []), `Verdict changed from 7a "${prior.verdict}" after data enrichment — 7a finding preserved unchanged in findings.json (history).`] });
        } else {
          reconfirmed7a.push(claimKey(result));
        }
      } else {
        const k = `${result.ean}|${result.claimFamily}|${result.quotedClaim}`;
        if (!uncheckableKey7a.has(k)) sweepUncheckable.push({ ...result, layer: '7b-rerun' });
      }
    }

    // --- widened free-sugar recheck (7a-review issue 6) ---
    for (const claim of claims.filter((c) => ['no-added-sugar', 'unsweetened'].includes(c.family))) {
      if (!ing.usable) continue;
      const offenders = widenedFreeSugarScan(parsed);
      const prior = key7a.get(`${product.ean}|${claim.family === 'no-added-sugar' ? 'CLM-NOADDEDSUGAR' : 'CLM-UNSWEETENED'}|${claim.quotedClaim}`);
      if (offenders.length && (!prior || prior.verdict === 'ok')) {
        sweepFindings.push(finding(claim, product, claim.family === 'no-added-sugar' ? 'CLM-NOADDEDSUGAR' : 'CLM-UNSWEETENED', 'contradicted', 'high', ingredientBlock(ing, offenders[0].raw), ['Widened syrup scan (7b, 07a-review issue 6): generic invert/fruit/flavoured syrup phrasings now covered.']));
      } else {
        widenedRechecks.push({ ean: product.ean, claimFamily: claim.family, quotedClaim: claim.quotedClaim, result: 'reconfirmed-clean' });
      }
    }

    // --- 7b sweep rules ---
    const sweepClaims = extractSweepClaims(product, sheetRow);
    claims7b += sweepClaims.length;
    for (const claim of sweepClaims) {
      const result = checkSweepClaim(claim, product, ctx);
      if (result.verdict) sweepFindings.push(result);
      else sweepUncheckable.push(result);
    }

    // --- kids-positioning vs sugar ---
    const kids = kidsSugarCheck(product, sheetRow);
    if (kids?.kind === 'finding') sweepFindings.push(kids.finding);
    else if (kids?.kind === 'uncheckable') sweepUncheckable.push(kids);
    else if (kids?.kind === 'informational') informational.push(kids);
  }

  // 07b-review issue 2: a KIDS-SUGAR proposal must not quote a halo claim that
  // another rule verified TRUE on the same SKU (ok + misleading on the same
  // claim text). Downgrade such proposals to informational — explicit, audited,
  // never a silent removal; the founder sees the downgrade trail.
  const okClaimKeys = new Set();
  for (const f of [...findings7a, ...new7aLayer, ...changed7a, ...sweepFindings]) {
    if (f.verdict === 'ok') okClaimKeys.add(`${f.ean}|${f.quotedClaim}`);
  }
  const downgradedKidsProposals = [];
  for (let i = sweepFindings.length - 1; i >= 0; i--) {
    const f = sweepFindings[i];
    if (f.ruleId !== 'CLM-KIDS-SUGAR' || !okClaimKeys.has(`${f.ean}|${f.quotedClaim}`)) continue;
    sweepFindings.splice(i, 1);
    const okRule = [...findings7a, ...new7aLayer, ...changed7a].find((x) => x.ean === f.ean && x.quotedClaim === f.quotedClaim && x.verdict === 'ok')?.ruleId ?? 'another rule';
    downgradedKidsProposals.push({
      ean: f.ean, productName: f.productName, ruleId: f.ruleId, quotedClaim: f.quotedClaim,
      originalVerdict: f.verdict, originalConfidence: f.confidence, downgradedTo: 'informational',
      verifiedTrueByRule: okRule,
      reason: `07b-review issue 2: the quoted halo claim "${f.quotedClaim}" is verified TRUE on this SKU by ${okRule} (ok finding). A positioning-vs-content proposal quoting a true claim would render ok + misleading on the same claim text; downgraded to informational (sugars ${f.evidence.value} g/100g still exceeds the UK NHS red heuristic, labelled NOT SG law). Any already-queued proposal is annotated with a reject recommendation — status never changed by this role.`,
      priorFinding: f,
    });
    informational.push({
      kind: 'informational', ean: f.ean, productName: f.productName, ruleId: f.ruleId,
      sugars: { value: f.evidence.value, unit: f.evidence.unit, provenanceTier: f.evidence.provenanceTier, sourceUrl: f.evidence.sourceUrl },
      ukRedThreshold: UK_RED_SUGARS, teaspoonsPerDeclaredServing: f.evidence.teaspoonsPerDeclaredServing ?? null, declaredServingG: f.evidence.declaredServingG ?? null,
      downgradedFrom: f.verdict, verifiedTrueByRule: okRule, layer: '7b',
      note: `DOWNGRADED (07b-review issue 2): kids-positioned with ${f.evidence.value} g sugars/100g (UK NHS red >22.5 — UK heuristic, NOT SG law), but the quoted halo claim "${f.quotedClaim}" is verified TRUE by ${okRule}. No misleading claim to accuse — informational only, never queued.`,
    });
  }

  const rechecks = proteinServingRechecks(findings7a, catalogue);
  // --- P2-12 HCS vocabulary + logo-misuse layer (review-grade only) ---
  // Criteria verified at the official HPB portal (HCS Apr-2026). Verdicts are
  // ok|review|unverified ONLY — never accusations, never queued. Visual
  // confirmation + official-list cross-check are loaded if present (honest gaps
  // otherwise). See runs/p2-12/criteria-currency.md + wiring-patch.md.
  const visualConfirmations = existsSync(resolve(ROOT, HCS_VISUAL_PATH))
    ? Object.fromEntries((JSON.parse(readFileSync(resolve(ROOT, HCS_VISUAL_PATH), 'utf8')).confirmations ?? []).map((c) => [String(c.ean), c]))
    : {};
  const officialListPath = resolve(ROOT, 'runs/p2-12/raw/hcs-product-list-20260831.txt');
  const officialListText = existsSync(officialListPath) ? readFileSync(officialListPath, 'utf8') : null;
  const hcs = runHcsGate({ catalogue, sheet, pendingItems, findingsDoc: findings7aDoc, visualConfirmations, officialListText });
  const ukHeuristics = runClaimChecks7a({ catalogue, sheet, pendingItems }).ukHeuristics;

  const allNew = [...new7aLayer, ...changed7a, ...sweepFindings];
  const counts = {
    productsProcessed: coverage.productsProcessed,
    claims7aExtracted: claims7a,
    claims7bExtracted: claims7b,
    reconfirmed7a: reconfirmed7a.length,
    changed7a: changed7a.length,
    new7aLayer: new7aLayer.length,
    sweepFindings: sweepFindings.length,
    newFlagged: allNew.filter((f) => f.verdict !== 'ok').length,
    newContradicted: allNew.filter((f) => f.verdict === 'contradicted').length,
    newMisleading: allNew.filter((f) => f.verdict === 'misleading').length,
    newOk: allNew.filter((f) => f.verdict === 'ok').length,
    sweepUncheckable: sweepUncheckable.length,
    informational: informational.length,
    widenedRechecks: widenedRechecks.length,
    proteinServingRechecks: rechecks.length,
    downgradedKidsProposals: downgradedKidsProposals.length,
    ukHeuristicNotes: ukHeuristics.length,
  };
  return { reconfirmed7a, changed7a, new7aLayer, sweepFindings, sweepUncheckable, informational, downgradedKidsProposals, widenedRechecks, rechecks, ukHeuristics, coverage, counts, hcs };
}

// ---------------------------------------------------------------------------
// Queue proposals — dedupe by EAN+rule vs existing items; ok never queued
// ---------------------------------------------------------------------------

export function existingClaimFlagKeys(pendingItems) {
  const keys = new Set();
  for (const i of pendingItems) {
    if (i?.kind !== 'claim-flag') continue;
    const ruleId = i.evidence?.ruleId;
    if (ruleId) keys.add(`${i.ean}|${ruleId}`);
    else keys.add(`${i.ean}|*`); // legacy items without ruleId → EAN-level dedupe
  }
  return keys;
}

const VERDICT_RANK = { contradicted: 2, misleading: 1, ok: 0 };

export function buildSweepQueueItems(results, existingKeys, nowIso) {
  const ts = nowIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
  const flagged = [...results.new7aLayer, ...results.changed7a, ...results.sweepFindings].filter((f) => f.verdict === 'contradicted' || f.verdict === 'misleading');
  const byEan = new Map();
  for (const f of flagged) {
    const k = `${f.ean}|${f.ruleId}`;
    if (existingKeys.has(k) || existingKeys.has(`${f.ean}|*`)) continue;
    if (!byEan.has(f.ean)) byEan.set(f.ean, []);
    byEan.get(f.ean).push(f);
  }
  const items = [];
  const deduped = [];
  for (const [ean, fs] of byEan) {
    fs.sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict]);
    const worst = fs[0];
    const evShort = worst.evidence.kind === 'ingredient' || worst.evidence.kind === 'additive'
      ? `ingredient "${worst.evidence.quotedIngredient}"`
      : worst.evidence.kind === 'nutrient'
        ? `${worst.evidence.nutrientKey} ${worst.evidence.value}${worst.evidence.unit}/100g (${worst.evidence.provenanceTier})`
        : 'the claim text itself';
    items.push({
      id: `${ts}-claim-flag-${ean}`,
      kind: 'claim-flag',
      ean: String(ean),
      createdAt: nowIso,
      createdBy: AGENT_ID,
      confidence: worst.confidence,
      summary: `${worst.productName}: "${worst.quotedClaim}" ${worst.verdict} vs ${evShort}. Rule ${worst.ruleId}${worst.threshold.heuristic ? ` (${worst.threshold.heuristic})` : ''}. Proposal only — washing-detection has no publish path.`,
      evidence: {
        quotedClaim: worst.quotedClaim,
        claimSource: `${worst.claimSource.location}: "${worst.claimSource.contextQuote}"`,
        quotedIngredient: worst.evidence.kind === 'ingredient' || worst.evidence.kind === 'additive' ? worst.evidence.quotedIngredient : undefined,
        nutrientEvidence: worst.evidence.kind === 'nutrient' ? { nutrient: worst.evidence.nutrientKey, value: worst.evidence.value, unit: worst.evidence.unit, provenanceTier: worst.evidence.provenanceTier, detail: worst.evidence.detail, teaspoonsPerDeclaredServing: worst.evidence.teaspoonsPerDeclaredServing ?? undefined } : undefined,
        additiveEvidence: worst.evidence.kind === 'additive' ? worst.evidence.additive : undefined,
        ingredientSource: worst.evidence.ingredientSource,
        sourceUrl: worst.claimSource.sourceUrl ?? worst.evidence.sourceUrl,
        productPageUrl: worst.productPageUrl,
        ruleId: worst.ruleId,
        thresholdSource: { url: worst.threshold.sourceUrl, quote: worst.threshold.sourceQuote, pageRef: worst.threshold.pageRef, heuristic: worst.threshold.heuristic ?? undefined, evidenceCache: ADDENDUM_PATH },
        verdict: worst.verdict,
        findings: fs,
        proposedAction: 'Founder review: approve/reject publication of the claim flag(s). NO auto-reclassification — range unchanged; no public flag until approved (PRD stories 26/68). Approval is applied by the orchestrator, never by the washing-detection role.',
      },
      status: 'pending',
      review: null,
    });
  }
  for (const f of flagged) {
    const k = `${f.ean}|${f.ruleId}`;
    if (existingKeys.has(k) || existingKeys.has(`${f.ean}|*`)) deduped.push(k);
  }
  return { items, dedupedKeys: [...new Set(deduped)] };
}

// ---------------------------------------------------------------------------
// Extend findings.json — 7a arrays preserved EXACTLY; sweep7b section added
// ---------------------------------------------------------------------------

export function extendFindingsDoc(findings7aDoc, results, queue, nowIso) {
  return {
    ...findings7aDoc,
    schemaVersion: 2,
    hcsP2_12: {
      generatedAt: nowIso,
      generatedBy: 'agent:p2-12-hcs',
      criteriaVersion: HCS_META.criteriaVersion,
      criteriaVerified: HCS_META.criteriaVerified,
      criteriaCurrencyRecord: 'runs/p2-12/criteria-currency.md',
      logoCheckStatus: HCS_META.logoCheckStatus,
      counts: results.hcs.counts,
      findings: results.hcs.findings,
      logoFindings: results.hcs.logoFindings,
      coverage: results.hcs.coverage,
      ledger: results.hcs.ledger,
      netNewReviewProducts: results.hcs.ledger.filter((l) => l.netNewReviewProduct).map((l) => l.ean),
      note: 'REVIEW-GRADE ONLY. HCS verdicts ok|review|unverified — never accusations, never queued, never published without the full D9 gate + two independent reviewer verdicts. Staged gate inputs: runs/p2-12/inputs/ (copy to pending/p2-audit/inputs/ at merge).',
    },
    sweep7b: {
      generatedAt: nowIso,
      generatedBy: AGENT_ID,
      scriptVersion: SCRIPT_VERSION,
      thresholdEvidence: ADDENDUM_PATH,
      counts: results.counts,
      coverage: results.coverage,
      reconfirmed7aKeys: results.reconfirmed7a,
      changed7a: results.changed7a,
      new7aLayer: results.new7aLayer,
      findings: results.sweepFindings,
      uncheckable: results.sweepUncheckable,
      informational: results.informational,
      downgradedKidsProposals: results.downgradedKidsProposals,
      widenedFreeSugarRechecks: results.widenedRechecks,
      proteinServingRechecks: results.rechecks,
      ukHeuristics: results.ukHeuristics,
      queue: { created: queue.items.map((i) => i.id), dedupedKeys: queue.dedupedKeys },
      // W3 merge-03: the 07b fix-round annotation is a historical audit section
      // (7b-fix-round.mjs) — a sweep re-run must PRESERVE it, never drop it.
      ...(findings7aDoc?.sweep7b?.fixRound ? { fixRound: findings7aDoc.sweep7b.fixRound } : {}),
    },
  };
}

function guardedWrite(root, path, content) {
  assertWriteScope(root, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function writeSweepResults(doc, queue, { root = ROOT, nowIso }) {
  const written = [];
  const findingsPath = resolve(root, 'data', 'claims', 'findings.json');
  guardedWrite(root, findingsPath, JSON.stringify(doc, null, 2) + '\n');
  written.push(relative(root, findingsPath));
  for (const item of queue.items) {
    const p = resolve(root, 'pending', `${item.id}.json`);
    if (existsSync(p)) continue; // never overwrite an existing queue item
    guardedWrite(root, p, JSON.stringify(item, null, 2) + '\n');
    written.push(relative(root, p));
  }
  const runPath = resolve(root, 'runs', `7b-sweep-run-${nowIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-')}.json`);
  guardedWrite(root, runPath, JSON.stringify({ ranAt: nowIso, agent: AGENT_ID, scriptVersion: SCRIPT_VERSION, counts: doc.sweep7b.counts, coverage: doc.sweep7b.coverage, written, queueCreated: doc.sweep7b.queue.created, dedupedKeys: queue.dedupedKeys }, null, 2) + '\n');
  written.push(relative(root, runPath));
  return written;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main(root = ROOT) {
  const nowIso = new Date().toISOString();
  const catalogue = JSON.parse(readFileSync(resolve(root, 'data', 'catalogue.json'), 'utf8'));
  const sheet = JSON.parse(readFileSync(resolve(root, 'data', 'classification', 'sheet.json'), 'utf8'));
  const pendingItems = readPendingItems(resolve(root, 'pending'));
  const findings7aDoc = JSON.parse(readFileSync(resolve(root, 'data', 'claims', 'findings.json'), 'utf8'));
  const occurrencesDoc = JSON.parse(readFileSync(resolve(root, 'data', 'additives', 'occurrences.json'), 'utf8'));
  const verdictsDoc = JSON.parse(readFileSync(resolve(root, 'data', 'additives', 'verdicts.json'), 'utf8'));
  const results = runSweep({ catalogue, sheet, pendingItems, findings7aDoc, occurrencesDoc, verdictsDoc });
  const queue = buildSweepQueueItems(results, existingClaimFlagKeys(pendingItems), nowIso);
  const dryRun = process.argv.includes('--dry-run');
  let written = [];
  if (!dryRun) {
    const doc = extendFindingsDoc(findings7aDoc, results, queue, nowIso);
    written = writeSweepResults(doc, queue, { root, nowIso });
  }
  console.log(JSON.stringify({ dryRun, counts: results.counts, coverage: results.coverage, queueCreated: queue.items.map((i) => `${i.ean} ${i.evidence.ruleId} ${i.evidence.verdict} (${i.confidence}): ${i.evidence.quotedClaim}`), dedupedKeys: queue.dedupedKeys, written }, null, 2));
  return { results, queue, written };
}

if (isMain(import.meta.url)) main();