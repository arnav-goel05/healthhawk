// HealthHawk slice 7a — claim-check rule engine (washing-detection role).
// Deterministic, checked-in code — no LLM discretion in the checks. Claims are
// extracted verbatim from product names + brand-positioning evidence (the
// hand-classified sheet's marketing-copy / pack-photo-OCR quotes), then checked
// against per-100g nutrition (provenance-aware) and ingredient evidence.
//
// Thresholds: HPB "A Guide to Nutrition Labelling for Food Products (Singapore)",
// Revised August 2024 — live-verified 2026-11-20T19:36Z, evidence cached at
// runs/raw/7a-hpb-thresholds-20261120.md (URLs + verbatim quotes + page refs).
// UK red/amber notes are NHS/FSA traffic-light HEURISTICS, not SG law, and are
// informational only (never queued).
//
// ROLE SEPARATION (PRD story 68): this role writes ONLY to data/claims/,
// pending/ (NEW claim-flag proposals) and runs/7a-*. There is NO publish path:
// no app/ writes, no catalogue writes, no classification writes, no imports of
// build-app/publish scripts. Every write goes through assertWriteScope().
// Verdicts are factual: contradicted | misleading | ok | review. ok verdicts,
// review verdicts and uncheckable claims are NEVER queued. review (P2-02) is
// the grey-zone / guide-tension routing (T1 dual basis, T21 maltodextrin/fruit
// puree): not an accusation, not a validation — founder adjudication material,
// never published. Founder approval is applied by the orchestrator, never by
// this script.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
// P2-10 wiring (merge-03): structured-parser consumption seam. No import cycle
// (adapter → p2-parser-lib only); without a matcher the parser does NO file IO.
import { parseIngredientListStructured } from './p2-parser-adapter.mjs';
import { sha256 as parserTextSha256 } from './p2-parser-lib.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const AGENT_ID = 'agent:t10-claims';
export const SCRIPT_VERSION = '1.0.0';

export const HPB_GUIDE_URL = 'https://isomer-user-content.by.gov.sg/484/52300722-8fa4-41aa-a3b3-4bed2258b59c/a-guide-to-nutrition-labelling-for-food-products-(aug24)-(3).pdf';
export const NHS_LABELS_URL = 'https://www.nhs.uk/live-well/eat-well/food-guidelines-and-food-labels/how-to-read-food-labels/';
export const THRESHOLD_EVIDENCE_PATH = 'runs/raw/7a-hpb-thresholds-20261120.md';

// ---------------------------------------------------------------------------
// Rule registry — every rule cites the verified threshold source.
// ---------------------------------------------------------------------------

// P2-11 Reg-40A wording promotion — APPLIED through the D9 auto-gate at W3
// merge-03 (decisions p2-11-reg40a-4800361310031 / -4800361367110 /
// -4800361028165, dual independent reviewer consensus; audit records in
// pending/p2-audit/, outcomes in runs/p2-merge-03/gate-outcomes.json).
// Mirrored VERBATIM from scripts/p2-claim-reg40a.mjs (the staged-upgrade
// source); byte-equivalence is enforced by the golden build (the live engine
// must reproduce upgradeReg40aFinding's approved bytes exactly). Verdicts,
// quoted claims, claim sources, evidence and confidence are UNCHANGED — only
// the reg-40A note wording + threshold.rule precision change (T23 re-pin
// cites the same decisionIds).
export const REG40A_UPGRADED_NOTE = 'Reg 40A immediate-% qualifier defect (Food Regulations reg 40A; HPB Aug-2024 guide PDF p32): the term "wholegrain" (or words conveying that meaning) is not qualified immediately by words indicating the percentage of wholegrain ingredients used in the label text we hold. This is a regulatory labelling requirement — the misleading/contradicted verdict record cites it precisely (P2-11 wording upgrade). There is no SG minimum-% threshold for the word itself; the defect is the missing immediate qualifier and/or the misleading impression. Pack panels in our data are partial — the founder may adjudicate the label text.';
export const WG_SHARE_THRESHOLD_UPGRADE = 'an unqualified wholegrain claim is misleading when the first ingredient is refined, or the declared wholegrain share is < 50% without wholegrain leading the list (engine heuristic, labelled). SEPARATELY, Food Regulations reg 40A requires the term "wholegrain" to be qualified IMMEDIATELY by words indicating the percentage of wholegrain ingredients used — a regulatory labelling requirement cited precisely in this verdict record (no SG minimum-% threshold exists for the word itself)';
export const WG_MAIN_THRESHOLD_UPGRADE = 'a "whole grain main ingredient" / "#1 ingredient" claim requires the FIRST ingredient (SG descending-weight order) to be wholegrain. SEPARATELY, Food Regulations reg 40A requires the term "wholegrain" to be qualified IMMEDIATELY by words indicating the percentage of wholegrain ingredients used — a regulatory labelling requirement cited precisely in this verdict record';
export const REG40A_WORDING_UPGRADE_META = Object.freeze({ issue: 'docs/issues-p2/11-claim-rule-expansion.md', kind: 'reg-40a-immediate-percent-qualifier', stagedBy: 'agent:p2-11-claims', appliedVia: 'D9 auto-gate at merge (never silently)' });

export const RULES = {
  'CLM-SUGARFREE': {
    family: 'sugar-free',
    threshold: 'sugars ≤ 0.5 g per 100 g',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p30 (printed p29), Appendix I: Carbohydrate — Sugar',
    sourceQuote: 'Sugar Free / Free of Sugar: ≤ 0.5 g sugars per 100 g or 100 ml',
  },
  'CLM-NOADDEDSUGAR': {
    family: 'no-added-sugar',
    threshold: 'no free sugars or ingredients with free sugars added during processing (incl. honey, malt, malt extract, juice concentrate); sugar alcohols and sweetening substances EXCEPTED (permitted)',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p30 (printed p29) + free-sugars definition PDF p29 (printed p28)',
    sourceQuote: 'No Added Sugar / Without Added Sugar: No free sugars or ingredients with free sugars (whether naturally occurring or added), including honey, malt and malt extract, with the exception of sugar alcohols and sweetening substances, are added during processing.',
  },
  'CLM-UNSWEETENED': {
    family: 'unsweetened',
    threshold: 'stricter than no-added-sugar: ALSO bans sweetening substances and sugar alcohols',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p30 (printed p29)',
    sourceQuote: 'Unsweetened: No added free sugars or ingredients with free sugars, (whether naturally-occurring or added) including honey, malt, malt extract, sweetening substances or sugars alcohols, are added during processing.',
  },
  'CLM-LOWSUGAR': {
    family: 'low-sugar',
    threshold: 'sugars ≤ 5 g per 100 g (or ≤ 2 g per serving)',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p30 (printed p29)',
    sourceQuote: 'Low Sugar / Low in Sugar: ≤ 5 g sugars per 100 g, or ≤ 2.5 g sugars per 100 ml, or ≤ 2 g sugars per serving',
  },
  'CLM-LESSSUGAR': {
    family: 'comparative-sugar',
    threshold: '≥ 25% less sugar than an identifiable reference food + a reference-comparison statement',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p31 (printed p30) + §5.1 PDF p10 (printed p9) + glossary PDF p71 (printed p70)',
    sourceQuote: 'Less Sugar / Lower Sugar / Reduced Sugar: ≥ 25% less sugar than the reference food. §5.1: When comparing with a reference food, a statement must be included to compare the nutrient content of the subject food to the reference food.',
  },
  'CLM-FIBRESOURCE': {
    family: 'source-fibre',
    threshold: 'fibre ≥ 3 g per 100 g (or ≥ 1.5 g per 100 kcal)',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p33 (printed p32), Appendix I: Fiber and wholegrain',
    sourceQuote: 'Source of Dietary Fibre / Contains Dietary Fibre: ≥ 1.5 g per 100 kcal, or ≥ 3 g per 100 g, or ≥ 3 g per 100 ml',
  },
  'CLM-FIBREHIGH': {
    family: 'high-fibre',
    threshold: 'fibre ≥ 6 g per 100 g (or ≥ 3 g per 100 kcal, or ≥ 4 g per serving)',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p33 (printed p32)',
    sourceQuote: 'High in Dietary Fibre / Fibre-Rich: ≥ 4 g per serving, or ≥ 3 g per 100 kcal, or ≥ 6 g per 100 g, or ≥ 6 g per 100 ml',
  },
  'CLM-PROTEINSOURCE': {
    family: 'source-protein',
    threshold: 'protein ≥ 12% of energy AND ≥ 10 g in the recommended daily quantity',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p27 (printed p26), Appendix I: Protein',
    sourceQuote: 'Source of Protein / Contains Protein: The recommended quantity of food to be consumed per day must provide ≥ 10g protein; the protein content of the food must contribute to at least 12% of calorie yield',
  },
  'CLM-PROTEINHIGH': {
    family: 'high-protein',
    threshold: 'protein ≥ 20% of energy AND ≥ 10 g in the recommended daily quantity',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p27 (printed p26), Appendix I: Protein',
    sourceQuote: 'Good Source of Protein / High in Protein / Rich in Protein / Excellent Source of Protein: The recommended quantity of food to be consumed per day must provide ≥ 10g protein; the protein content of the food must contribute to at least 20% of calorie yield',
  },
  'CLM-WG-MAIN': {
    family: 'wholegrain-main',
    threshold: WG_MAIN_THRESHOLD_UPGRADE,
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p32 (printed p31), wholegrain definition + Food Regulations reg 40A',
    sourceQuote: 'Wholegrain means the intact grain or the dehulled, ground, milled, cracked, or flaked grain where the constituents (endosperm, germ and bran) are present in such proportions that represent the typical ration of those constituents occurring in the whole cereal, and includes wholemeal.',
  },
  'CLM-WG-SHARE': {
    family: 'wholegrain-unqualified',
    threshold: WG_SHARE_THRESHOLD_UPGRADE,
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p32 (printed p31), reg 40A notes',
    sourceQuote: 'Food products are not allowed to be labelled as "wholegrain" unless they fall within or are made from ingredients that fall within the definition of "wholegrain", and the term "wholegrain" is qualified immediately by words indicating the percentage of wholegrain ingredients used.',
  },
  'CLM-WG-PERCENT': {
    family: 'wholegrain-percent',
    threshold: 'a percentage-qualified wholegrain claim must match the declared wholegrain ingredient share (±2 pp rounding tolerance)',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p32 (printed p31), reg 40A notes',
    sourceQuote: 'the word "wholegrain" (or other words conveying that meaning) is qualified immediately by words indicating the percentage of wholegrain ingredients used.',
  },
  'CLM-WG-PRESENCE': {
    family: 'wholegrain-presence',
    threshold: '"made with whole grain" requires at least one wholegrain ingredient',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p32 (printed p31), wholegrain definition',
    sourceQuote: 'Food products are not allowed to be labelled as "wholegrain" unless they fall within or are made from ingredients that fall within the definition of "wholegrain"',
  },
  'CLM-WG-COMPARATIVE': {
    family: 'comparative-wholegrain',
    threshold: '"higher in wholegrains" requires ≥ 10% wholegrains AND a wholegrain-percent comparison statement vs the reference food',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, PDF p33 (printed p32) + §5.1 PDF p10 (printed p9)',
    sourceQuote: 'Higher in Wholegrains: ≥ 10% wholegrains. §5.1: For wholegrains, when comparing with a reference food, a statement must be included to compare the wholegrains percent of the subject food to the reference food.',
  },
  'CLM-MADEWITH': {
    family: 'made-with',
    threshold: '"made with (real) X" requires ingredient X to be present',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, §5.1 PDF p10 (printed p9) — nutrition claims suggest or imply a nutritive property; factual presence check against the label-declared ingredient list',
    sourceQuote: 'A nutrition claim suggests or implies that a food has a nutritive property. This property may be general or specific and it can be stated positively or negatively.',
  },
};

// review (P2-02): grey-zone / guide-tension routing — never queued, never an
// accusation, never a validation. See checkSugarThreshold (T1) and
// checkNoAddedSugar (T21).
// unverified (P2-11): non-accusation grey verdict for regulated-but-uncertified
// claims (organic) and unregulated marketing terms — rendered distinctly
// (grey, icon+word), NEVER phrased as false. Produced only by the P2-11
// expansion layer (scripts/p2-claim-unverified.mjs); the live 7a/7b checks
// below never emit it, so the frozen findings + golden pins stay byte-exact.
export const VERDICTS = ['contradicted', 'misleading', 'ok', 'review', 'unverified'];


// T3 label-rounding tolerance: HPB NIP values round to 1 decimal; a declared
// value within ±0.05 g of a sugar threshold is not a clear numeric
// contradiction (regulatory report §8 T3). Sugar thresholds only — the P1
// fibre/fat boundary behavior is frozen.
export const SUGAR_ROUNDING_EPSILON_G = 0.05;

// T21 grey zones: maltodextrin is a polysaccharide (NOT a free sugar); fruit
// puree is not explicitly listed in the HPB free-sugars definition. Both are
// technically defensible under "no added sugar" — route to review, never
// auto-contradict. "puree"/"purée"/"puré" only — never the word "pure".
export const GREY_ZONE_SUGAR_RE = /\b(?:maltodextrin|pur(?:ee|ée|é))\b/i;

// ---------------------------------------------------------------------------
// Provenance-aware nutrition access
// ---------------------------------------------------------------------------

// Tiers usable for claim checks: directly stated or arithmetically derived from
// label-declared values. Coarse "estimated" and "regulatory-limit" tiers are
// NOT a measurement basis and are excluded (schema: data/catalogue.schema.md).
export const SCOREABLE_TIERS = new Set(['exact', 'off-label', 'ocr-label', 'estimated-derived', 'label-declared']);

export function usableNutrient(product, key) {
  const n = product?.nutrition?.per100g?.[key];
  if (!n || typeof n.value !== 'number' || !Number.isFinite(n.value)) return null;
  if (!SCOREABLE_TIERS.has(n.provenanceTier)) return null;
  const withheld = product?.nutrition?.off?.withheldPer100g;
  if (Array.isArray(withheld) && withheld.some((w) => w.key === key && w.value === n.value)) return null;
  return { value: n.value, unit: n.unit, provenanceTier: n.provenanceTier };
}

// A panel under a definitive plausibility dispute (slice-6 data-flag: macro
// sum > 100 g/100 g, "definitive") is not a trustworthy basis for ANY nutrient
// accusation until the founder adjudicates. Read from the queue, not guessed.
export function disputedPanelEans(pendingItems) {
  const out = new Set();
  for (const item of pendingItems) {
    if (item?.kind === 'data-flag' && /macro sum/i.test(item.summary || '') && /definitive/i.test(item.summary || '')) {
      out.add(String(item.ean));
    }
  }
  return out;
}

export function nutritionSourceUrl(product, tier) {
  if (tier === 'off-label') return product?.nutrition?.off?.url ?? null;
  if (tier === 'ocr-label') return product?.nutrition?.ocr?.imageUrl ?? null;
  return product?.offers?.[0]?.sourceUrl ?? null;
}

export function energyKcalPer100g(product) {
  const kcal = usableNutrient(product, 'energy_kcal');
  if (kcal) return { value: kcal.value, provenanceTier: kcal.provenanceTier, derived: false };
  const kj = usableNutrient(product, 'energy_kj');
  if (kj) return { value: kj.value / 4.184, provenanceTier: kj.provenanceTier, derived: true };
  return null;
}

// ---------------------------------------------------------------------------
// Ingredient evidence + parsing
// ---------------------------------------------------------------------------

const ALLERGEN_CUT = /(?:^|[.;]\s*|\s•\s*|\n)\s*(?:Allergen (?:Information|advice)|Contains?\s*:|May contain|Contain cereals|Contains cereals|Contains cereal\b|Contains gluten|Contains oat\b|Contains wheat\b|Contains milk\b)/i;
const KNOWN_INGREDIENT_WORD = /\b(?:oats?|wheat|corn|rice|barley|rye|sugar|flour|semolina|grits?|milk|honey|malt|molasses|salt|grain|grains|cocoa|chocolate|nuts?|almonds?|pecans?|walnuts?|cashews?|pistachios?|hazelnuts?|oil|raisins?|dates?|cranberr|strawberr|blueberr|banana|goji|longan|sesame|beans?|triticale|buckwheat|starch|syrup|cream|whey|caseinate|vitamin|mineral|antioxidant|emulsifier|stabiliser|stabilizer|flavour|flavor|tocopherol|lecithin|gluten|vollkorn|avoine|weizen|haferflocken|rosinen|nüsse|salz|maize)\b/i;

export function cleanIngredientText(text) {
  if (typeof text !== 'string') return '';
  let t = text.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '');
  t = t.replace(/_/g, ''); // OFF-style emphasis markers (_Wheat_)
  t = t.replace(/^\[ingredients?\]\s*/i, '').replace(/^ingredients?\s*:\s*/i, '');
  t = t.replace(/^[•\s]+/, '');
  const cut = t.search(ALLERGEN_CUT);
  if (cut >= 0) t = t.slice(0, cut);
  return t.replace(/\s+/g, ' ').trim().replace(/[.,;]\s*$/, '');
}

export function ingredientTextUsable(text) {
  const t = cleanIngredientText(text);
  if (t.length < 4) return false;
  if (!KNOWN_INGREDIENT_WORD.test(t)) return false; // e.g. "hwjsjsjs"
  if (/^(?:contains?\s+)?(?:gluten|cereals containing gluten)\.?$/i.test(t)) return false; // allergen-only fragment
  return true;
}

// Catalogue ingredient text first (FairPrice label-declared); fall back to the
// classification sheet's verbatim ingredient evidence (incl. pack-photo OCR)
// when the catalogue field is null. Never invents ingredient data.
export function ingredientEvidence(product, sheetRow) {
  const ing = product?.ingredients;
  if (ing?.text && ingredientTextUsable(ing.text)) {
    return { text: cleanIngredientText(ing.text), raw: ing.text, source: `catalogue ingredients (${ing.provenanceTier})`, sourceUrl: ing.sourceUrl ?? product?.offers?.[0]?.sourceUrl ?? null, usable: true };
  }
  const ev = (sheetRow?.evidence ?? []).find((e) => (e.type === 'ingredients' || (e.type === 'pack-photo-ocr' && /^\[ingredients?\]/i.test(e.quote || ''))) && ingredientTextUsable(e.quote));
  if (ev) {
    return { text: cleanIngredientText(ev.quote), raw: ev.quote, source: `classification sheet evidence [${ev.type}] (${ev.ocrRecord ? 'pack-photo OCR, ' + ev.ocrRecord : 'label-declared'})`, sourceUrl: ev.sourceUrl ?? null, usable: true };
  }
  return { text: null, raw: ing?.text ?? null, source: ing ? `catalogue ingredients unusable (${ing.provenanceTier})` : 'no ingredient text published (honest gap)', sourceUrl: ing?.sourceUrl ?? null, usable: false };
}

// Split on commas at bracket depth 0; keep nesting for sub-ingredient scans.
function splitTopLevel(text) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of text) {
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    if (ch === ']' || ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function innerContent(token) {
  const i = token.search(/[\[({]/);
  if (i < 0) return null;
  // Tolerate OCR-truncated lists with an unclosed final bracket.
  return token.slice(i + 1).replace(/[\])}]\s*$/, '');
}

export const WHOLEGRAIN_RE = /\bwhole[\s-]?grain|\bwholegrain|\bwholemeal|\bwhole\s?wheat|\bwhole\s?oat|\brolled\s?oats?\b|\boat\s?flakes?\b|\bvollkorn|\bflocons\s?d[’']?avoine|\bwhole\s?corn|\bwholegrain\s?corn|\bbrown\s?rice|\bblack\s?rice|\bred\s?rice|\bwhole\s?rye|\bwhole\s?barley|(?:^|\s)oats?(?:\s|$|\d)/i;
export const REFINED_RE = /\bcorn\s?semolina|\bcorn\s?grits?|\bcorn\s?flour|\bcorn\s?meal|\bdegermed|\bsemolina|\brice\s?flour|\brice\s?semolina|\bwheat\s?flour|\bwheat\s?starch|\bcorn\s?starch|\bmaize\b|(?:^|\s)corn(?:\s|$|\()|(?:^|\s)rice(?:\s|$|\()/i;

// Free-sugar ingredients (HPB Aug-2024 free-sugars definition: added mono-/
// disaccharides + sugars naturally present in honey, syrups, fruit juices).
// Dried fruit (raisins/dates) is NOT listed as a free-sugar ingredient by the
// guide — slice-4 precedent (Alpen) stands; documented boundary, not a flag.
// Maltodextrin is a polysaccharide, not a free sugar. Lactose naturally present
// in milk (whey/milk powder) is excluded by the definition.
export const FREE_SUGAR_RE = /\b(?:cane\s?sugar|raw\s?sugar|brown\s?sugar|invert\s?sugar|coconut\s?sugar|palm\s?sugar|sugar|glucose\s?syrup|corn\s?syrup|rice\s?syrup|maple\s?syrup|golden\s?syrup|agave|molasses|treacle|jaggery|honey|malt\s?extract|barley\s?malt|malted\s?barley|malt|fructose|dextrose|sucrose|maltose|juice\s?concentrate|concentrated\s?(?:fruit\s?)?juice|fruit\s?juice|caramel(?:ized|ised)?\s?sugar\s?syrup)\b/i;
export const SWEETENER_RE = /\b(?:aspartame|sucralose|saccharin|acesulfame|steviol|stevia|neotame|advantame|alitame|cyclamate)\b/i;
export const SUGAR_ALCOHOL_RE = /\b(?:maltitol|sorbitol|xylitol|erythritol|isomalt|lactitol|mannitol)\b/i;

function classifyToken(raw) {
  const name = raw.replace(/[\[({][\s\S]*$/, '').replace(/\(.*$/, '').trim();
  const pct = raw.match(/(\d+(?:\.\d+)?)\s*%/);
  const wholegrain = WHOLEGRAIN_RE.test(raw);
  const refined = !wholegrain && REFINED_RE.test(raw);
  return {
    raw,
    name,
    percent: pct ? Number(pct[1]) : null,
    wholegrain,
    refined,
    freeSugar: FREE_SUGAR_RE.test(raw),
    sweetener: SWEETENER_RE.test(raw),
    sugarAlcohol: SUGAR_ALCOHOL_RE.test(raw),
  };
}

const GRAIN_GROUP_RE = /^(?:cereal\s?grains?|cereals?|grains?|cereal\s?flakes?|cereal)\s*[\[({]/i;

// Parse into top-level tokens (order = SG descending-weight order) plus a
// flattened all-depth list for free-sugar scanning.
export function parseIngredientList(text) {
  const top = splitTopLevel(text).map(classifyToken);
  const flat = [];
  const walk = (tokens) => {
    for (const t of tokens) {
      flat.push(t);
      const inner = innerContent(t.raw);
      if (inner) walk(splitTopLevel(inner).map(classifyToken));
    }
  };
  walk(top);
  // The effective first ingredient: descend into a leading grain group.
  let first = top[0] ?? null;
  if (first && GRAIN_GROUP_RE.test(first.raw)) {
    const inner = innerContent(first.raw);
    const sub = inner ? splitTopLevel(inner).map(classifyToken) : [];
    if (sub.length) first = sub[0];
  }
  return { top, flat, first };
}

// P2-10 consumption (merge-03 wiring, drift-resolved from runs/p2-10/wiring-patch.md
// PATCH 1): the structured parser is consumed ONLY when the gate-approved apply
// (scripts/p2-parser-apply.mjs) has written ingredients.structured AND its
// sourceTextSha256 still binds the CURRENT catalogue text. Pre-apply the legacy
// parse above runs unchanged — the spec's gate→apply→wire order is preserved
// even though the wiring lands first (dormant until the data apply). The legacy
// function stays frozen: the shadow old-side, golden byte-pins and the 7b/HCS
// layers still consume it this wave. Post-apply semantics (shadow-diffed +
// staged as the 7 p2-10 re-gate items): percent = declared exact product-basis
// only; `first` descends merged/empty-name wrappers to the innermost ingredient.
export function parsedIngredientsFor(product, ing, provenanceTier = 'label-declared') {
  const structured = product?.ingredients?.structured ?? null;
  if (structured && ing?.usable && ing.raw != null && ing.raw === product.ingredients.text
    && structured.sourceTextSha256 === parserTextSha256(ing.raw)) {
    return parseIngredientListStructured(ing.text, provenanceTier);
  }
  return parseIngredientList(ing.text);
}

// Declared wholegrain share: sum of stated percentages on tokens whose NAME
// is a wholegrain ingredient (all depths; a mixed group like "Cereal Flakes
// (21%) [Whole Wheat Flour, Sugar, ...]" is NOT counted as wholegrain).
// Null when no wholegrain token declares a percentage — never guessed.
export function wholegrainShare(parsed) {
  const wg = parsed.flat.filter((t) => t.percent !== null && WHOLEGRAIN_RE.test(t.name));
  if (!wg.length) return null;
  return Math.round(wg.reduce((s, t) => s + t.percent, 0) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Claim extraction — verbatim, with source location
// ---------------------------------------------------------------------------

const CLAIM_PATTERNS = [
  { family: 'no-added-sugar', re: /(?:contains?\s+|contain\s+)?(?:no|without)\s+added\s+sugar(?:\s+or\s+salt)?/gi },
  { family: 'unsweetened', re: /\bunsweetened\b/gi },
  { family: 'sugar-free', re: /\b(?:sugar[\s-]?free|free\s+of\s+sugar)\b/gi },
  { family: 'low-sugar', re: /\blow(?:\s+in)?\s+sugar\b/gi },
  { family: 'comparative-sugar', re: /\b(?:\d+(?:\.\d+)?%\s*)?(?:less\s+sugar|lower\s+(?:in\s+)?sugar|reduced\s+sugar)\b/gi },
  { family: 'source-fibre', re: /\b(?:source\s+of\s+(?:dietary\s+)?fib(?:re|er)|contains?\s+dietary\s+fib(?:re|er))\b/gi },
  { family: 'high-fibre', re: /\b(?:naturally\s+high\s+in\s+dietary\s+fib(?:re|er)|high\s+(?:in\s+)?(?:dietary\s+)?fib(?:re|er)|fib(?:re|er)[\s-]?rich|good\s+source\s+of\s+(?:dietary\s+)?fib(?:re|er)|rich\s+in\s+dietary\s+fib(?:re|er))\b/gi },
  { family: 'high-protein', re: /\b(?:high\s+(?:in\s+)?protein|good\s+source\s+of\s+protein|rich\s+in\s+protein|excellent\s+source\s+of\s+protein)\b/gi },
  { family: 'source-protein', re: /\b(?:source\s+of\s+protein|contains?\s+protein)\b/gi },
  { family: 'comparative-wholegrain', re: /\bhigher\s+in\s+whole[\s-]?grains?\b/gi },
  { family: 'wholegrain-main', re: /\bwhole[\s-]?grain\s+(?:as\s+(?:its\s+|the\s+)?)?(?:main\s+ingredient|#\s?1\s+ingredient)\b/gi },
  { family: 'wholegrain-percent', re: /\b\d+(?:\.\d+)?\s*%\s*(?:of\s+)?(?:whole[\s-]?grain|wholegrain|wholemeal)(?:\s+(?:[A-Za-z]+\s+)?(?:wheat|oats?|corn|rice|rye|barley))?\b/gi },
  { family: 'wholegrain-presence', re: /\bmade\s+with[^.;•]{0,30}?whole[\s-]?grain\b|\bwith\s+whole\s+grains?\b/gi },
  { family: 'wholegrain-unqualified', re: /\bwhole[\s-]?grain\s+guaranteed\b|\bwholegrain\s+beverage\b|\bwholegrain\s+oats?\b|\bwhole[\s-]?grain\b(?!\s*(?:wheat|corn|oats?|rice|rye|barley|flour|flakes|main|as|and|guaranteed|beverage|requirement|%|\d))/gi },
  { family: 'made-with', re: /\bmade\s+with\s+(?:real\s+)?(?:quaker\s+)?(honey|cocoa|strawberry\s+slices|strawberries|oats|fruit)\b/gi },
];

// "Source of fibre, protein and beta glucan" implies BOTH source claims.
const FIBRE_PROTEIN_COMBO = /source\s+of\s+(?:dietary\s+)?fib(?:re|er)[^.;•]{0,20}\bprotein\b/i;

function sentenceAround(text, index) {
  const start = Math.max(text.lastIndexOf('.', index) + 1, text.lastIndexOf('•', index) + 1, text.lastIndexOf(';', index) + 1, 0);
  let end = text.length;
  for (const sep of ['.', '•', ';']) {
    const i = text.indexOf(sep, index);
    if (i >= 0 && i < end) end = i;
  }
  return text.slice(start, end).trim();
}

const SOURCE_PRIORITY = { 'pack-photo-ocr': 3, 'marketing-copy': 2, 'key-information': 2, name: 1 };

// Extract claims from the product name + the sheet's verbatim positioning
// evidence. Each claim keeps the EXACT matched text + its source location.
export function extractClaims(product, sheetRow) {
  const sources = [{ location: 'product name (retailer listing)', text: product.name, sourceUrl: product?.offers?.[0]?.sourceUrl ?? null, priority: 1 }];
  for (const e of sheetRow?.evidence ?? []) {
    if (['marketing-copy', 'pack-photo-ocr', 'key-information'].includes(e.type) && e.quote) {
      sources.push({ location: `classification sheet evidence [${e.type}]`, text: e.quote, sourceUrl: e.sourceUrl ?? null, priority: SOURCE_PRIORITY[e.type] ?? 2, ocrRecord: e.ocrRecord ?? null });
    }
  }
  const byFamily = new Map();
  const skipped = [];
  for (const src of sources) {
    for (const { family, re } of CLAIM_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src.text)) !== null) {
        const quotedClaim = m[0].trim();
        const before = src.text.slice(0, m.index);
        // A bare "wholegrain" preceded by a percentage or "made with" belongs
        // to the percent/presence family, not the unqualified family.
        if (family === 'wholegrain-unqualified' && (/%\s*$/.test(before) || /made\s+with\s*$/i.test(before))) continue;
        // HCS certification context: "Lower in Sugar Higher in Wholegrains"
        // inside a HEALTHIER CHOICE logo is HPB certification, not an
        // unverified comparative claim (slice-4 precedent).
        if ((family === 'comparative-sugar' || family === 'comparative-wholegrain') && /HEALTHIER\s+CHOICE/i.test(src.text)) {
          skipped.push({ ean: product.ean, family, quotedClaim, reason: 'HCS (Healthier Choice Symbol) certification context — not an unverified claim (slice-4 precedent)', sourceUrl: src.sourceUrl });
          continue;
        }
        const claim = {
          family,
          quotedClaim,
          claimSource: { location: src.location, contextQuote: src.text, sourceUrl: src.sourceUrl, ocrRecord: src.ocrRecord ?? undefined },
          sentence: sentenceAround(src.text, m.index),
          priority: src.priority,
        };
        if (family === 'made-with') claim.subject = m[1].toLowerCase();
        if (family === 'wholegrain-percent') {
          claim.percent = Number(quotedClaim.match(/(\d+(?:\.\d+)?)\s*%/)[1]);
          const scope = quotedClaim.match(/%\s*(?:of\s+)?(?:whole[\s-]?grain|wholegrain|wholemeal)\s+((?:[A-Za-z]+\s+){0,2}(?:wheat|oats?|corn|rice|rye|barley))\b/i);
          claim.scopeGrain = scope ? scope[1].trim().toLowerCase() : null;
        }
        const key = family + (claim.subject ? ':' + claim.subject : '') + (claim.percent !== undefined ? ':' + claim.percent : '');
        const prev = byFamily.get(key);
        if (!prev || claim.priority > prev.priority) byFamily.set(key, claim);
      }
    }
    if (FIBRE_PROTEIN_COMBO.test(src.text) && !byFamily.has('source-protein')) {
      const m = src.text.match(/source\s+of\s+(?:dietary\s+)?fib(?:re|er)[^.;•]{0,20}\bprotein\b/i);
      byFamily.set('source-protein', {
        family: 'source-protein',
        quotedClaim: m[0].trim(),
        claimSource: { location: src.location, contextQuote: src.text, sourceUrl: src.sourceUrl },
        sentence: sentenceAround(src.text, m.index),
        priority: src.priority,
      });
    }
  }
  return { claims: [...byFamily.values()], skipped };
}

// ---------------------------------------------------------------------------
// Checks — deterministic verdicts
// ---------------------------------------------------------------------------

function finding(claim, product, ruleId, verdict, confidence, evidence, notes = []) {
  const rule = RULES[ruleId];
  const f = {
    ean: product.ean,
    productName: product.name,
    productPageUrl: product?.offers?.[0]?.sourceUrl ?? null,
    ruleId,
    claimFamily: claim.family,
    quotedClaim: claim.quotedClaim,
    claimSource: claim.claimSource,
    evidence,
    threshold: { rule: rule.threshold, sourceUrl: rule.sourceUrl, sourceQuote: rule.sourceQuote, pageRef: rule.pageRef },
    verdict,
    confidence,
    notes,
  };
  // P2-11 reg-40A promotion (gate-applied, decisionIds above): the wholegrain
  // verdict records carry the upgrade provenance. Key order matches
  // upgradeReg40aFinding's approved bytes (appended last) — golden-pinned.
  if (ruleId === 'CLM-WG-SHARE' || ruleId === 'CLM-WG-MAIN') f.wordingUpgrade = { ...REG40A_WORDING_UPGRADE_META };
  return f;
}

function ingredientEvidenceBlock(ing, quotedIngredient) {
  return { kind: 'ingredient', quotedIngredient, ingredientListQuote: ing.raw, ingredientSource: ing.source, sourceUrl: ing.sourceUrl };
}

function nutrientEvidenceBlock(product, key, n, detail) {
  return { kind: 'nutrient', nutrientKey: key, value: n.value, unit: n.unit, provenanceTier: n.provenanceTier, sourceUrl: nutritionSourceUrl(product, n.provenanceTier), detail };
}

function uncheckable(claim, product, reason) {
  return { ean: product.ean, productName: product.name, claimFamily: claim.family, quotedClaim: claim.quotedClaim, claimSource: claim.claimSource, reason };
}

const FAMILY_RULE = {
  'sugar-free': 'CLM-SUGARFREE',
  'no-added-sugar': 'CLM-NOADDEDSUGAR',
  unsweetened: 'CLM-UNSWEETENED',
  'low-sugar': 'CLM-LOWSUGAR',
  'comparative-sugar': 'CLM-LESSSUGAR',
  'source-fibre': 'CLM-FIBRESOURCE',
  'high-fibre': 'CLM-FIBREHIGH',
  'source-protein': 'CLM-PROTEINSOURCE',
  'high-protein': 'CLM-PROTEINHIGH',
  'wholegrain-main': 'CLM-WG-MAIN',
  'wholegrain-unqualified': 'CLM-WG-SHARE',
  'wholegrain-percent': 'CLM-WG-PERCENT',
  'wholegrain-presence': 'CLM-WG-PRESENCE',
  'comparative-wholegrain': 'CLM-WG-COMPARATIVE',
  'made-with': 'CLM-MADEWITH',
};

function checkSugarThreshold(claim, product, ruleId, limitPer100g, limitPerServing) {
  const sugars = usableNutrient(product, 'sugars');
  if (!sugars) return uncheckable(claim, product, 'no usable per-100g sugars value (missing or non-scoreable provenance tier)');
  if (sugars.value <= limitPer100g) {
    return finding(claim, product, ruleId, 'ok', sugars.provenanceTier === 'estimated-derived' ? 'medium' : 'high', nutrientEvidenceBlock(product, 'sugars', sugars, `sugars ${sugars.value} g/100g ≤ ${limitPer100g} g/100g threshold`));
  }
  // T3 (P2-02): borderline declared values within the label-rounding epsilon
  // are not a clear numeric contradiction — never flagged on rounding alone.
  if (sugars.value <= limitPer100g + SUGAR_ROUNDING_EPSILON_G) {
    return finding(claim, product, ruleId, 'ok', 'medium', nutrientEvidenceBlock(product, 'sugars', sugars, `sugars ${sugars.value} g/100g exceeds ${limitPer100g} g/100g by ≤ ${SUGAR_ROUNDING_EPSILON_G} g — within label-rounding tolerance (T3), not a clear numeric contradiction`), ['Rounding-tolerance pass (P2-02 T3): HPB NIP values round to 1 decimal; borderline declared values are not flagged.']);
  }
  if (limitPerServing !== undefined) {
    const ps = product?.nutrition?.perServing?.sugars;
    if (ps && typeof ps.value === 'number' && ps.value <= limitPerServing) {
      // T1 FIX (P2-02): per-serving pass + per-100g fail → REVIEW. The pre-fix
      // engine returned ok here (the inversion pinned by the old
      // claims.test.mjs "≤2 g/serving alternative ok" case). HPB §5.1 requires
      // the per-100g criterion while App. I lists a per-serving alternative —
      // a guide tension for founder adjudication, never auto-ok and never
      // auto-contradicted (regulatory report §8 T1).
      return finding(claim, product, ruleId, 'review', 'medium', {
        kind: 'nutrient', nutrientKey: 'sugars', value: sugars.value, unit: sugars.unit, provenanceTier: sugars.provenanceTier,
        sourceUrl: nutritionSourceUrl(product, sugars.provenanceTier),
        detail: `per-100g sugars ${sugars.value} g > ${limitPer100g} g/100g FAILS; per-serving sugars ${ps.value} g ≤ ${limitPerServing} g/serving PASSES — dual-basis tension (T1), routed to review`,
        perServing: { value: ps.value, unit: ps.unit, provenanceTier: ps.provenanceTier, declaredServingG: product?.nutrition?.servingSizeG ?? null },
      }, [
        'T1 dual-basis tension (P2-02 fix): HPB §5.1 requires the per-100g (solid) criterion; App. I lists a per-serving alternative. Per-serving pass + per-100g fail routes to REVIEW — never auto-ok (the pre-fix inversion), never auto-contradicted. Founder adjudicates the basis reading.',
        'REVIEW verdicts are never queued and never published as accusations (grey zones default to review — regulatory report §9.9).',
      ]);
    }
  }
  return finding(claim, product, ruleId, 'contradicted', sugars.provenanceTier === 'estimated-derived' ? 'medium' : 'high', nutrientEvidenceBlock(product, 'sugars', sugars, `sugars ${sugars.value} g/100g > ${limitPer100g} g/100g threshold`));
}

function checkNoAddedSugar(claim, product, ruleId, ing, parsed, stricter) {
  if (!ing.usable) return uncheckable(claim, product, `ingredient list not usable: ${ing.source}`);
  const offenders = parsed.flat.filter((t) => t.freeSugar || (stricter && (t.sweetener || t.sugarAlcohol)));
  if (offenders.length) {
    return finding(claim, product, ruleId, 'contradicted', 'high', ingredientEvidenceBlock(ing, offenders[0].raw), [
      stricter ? 'Unsweetened also bans sweetening substances and sugar alcohols (HPB Aug-2024, PDF p30).' : 'Free-sugar ingredient present; HPB Aug-2024 bans free sugars incl. honey/malt/malt extract/juice concentrate under "no added sugar".',
      ...offenders.slice(1, 4).map((t) => `Additional free-sugar ingredient: "${t.raw}"`),
    ]);
  }
  // T21 (P2-02): maltodextrin / fruit-puree grey zones — technically
  // defensible under "no added sugar", never auto-contradicted; routed to
  // REVIEW for founder adjudication instead of a silent ok.
  const grey = parsed.flat.filter((t) => GREY_ZONE_SUGAR_RE.test(t.raw));
  if (grey.length) {
    return finding(claim, product, ruleId, 'review', 'medium', ingredientEvidenceBlock(ing, grey[0].raw), [
      'T21 grey zone (P2-02): maltodextrin is a polysaccharide (NOT a free sugar) and fruit puree is not explicitly listed in the HPB Aug-2024 free-sugars definition — technically defensible under "no added sugar"/"unsweetened". Routed to REVIEW, never auto-contradicted; founder adjudicates. Glucose syrup/honey/malt/juice concentrate ARE free sugars and would have been contradicted above.',
      ...grey.slice(1, 4).map((t) => `Additional grey-zone ingredient: "${t.raw}"`),
    ]);
  }
  const sweet = parsed.flat.filter((t) => t.sweetener || t.sugarAlcohol);
  const notes = [];
  if (sweet.length) notes.push(stricter ? '' : `Sweetening substances/sugar alcohols present ("${sweet[0].raw}") — PERMITTED under HPB "no added sugar" (exception clause).`);
  const sugars = usableNutrient(product, 'sugars');
  if (sugars && sugars.value > 0.5) notes.push(`Total sugars ${sugars.value} g/100g (${sugars.provenanceTier}) are naturally occurring (e.g. raisins/milk lactose); "no added sugar" is an ingredient-based rule, not a sugar-free claim.`);
  return finding(claim, product, ruleId, 'ok', 'high', ingredientEvidenceBlock(ing, ing.text), notes.filter(Boolean));
}

function checkFibre(claim, product, ruleId, per100g, per100kcal, perServing) {
  const fibre = usableNutrient(product, 'fibre');
  const kcal = energyKcalPer100g(product);
  const paths = [];
  if (fibre) paths.push({ ok: fibre.value >= per100g, detail: `fibre ${fibre.value} g/100g vs ≥ ${per100g} g/100g`, n: fibre, key: 'fibre' });
  if (fibre && kcal) paths.push({ ok: (fibre.value / kcal.value) * 100 >= per100kcal, detail: `fibre ${((fibre.value / kcal.value) * 100).toFixed(2)} g/100kcal vs ≥ ${per100kcal} g/100kcal`, n: fibre, key: 'fibre' });
  const servingG = product?.nutrition?.servingSizeG;
  if (fibre && typeof servingG === 'number' && servingG > 0 && perServing !== undefined) {
    const perServingG = Math.round(fibre.value * servingG) / 100;
    paths.push({ ok: perServingG >= perServing, detail: `fibre ${perServingG} g/serving (${servingG} g declared serving, derived) vs ≥ ${perServing} g/serving`, n: fibre, key: 'fibre' });
  }
  if (!paths.length) return uncheckable(claim, product, 'no usable fibre basis (missing or non-scoreable provenance tier)');
  const pass = paths.find((p) => p.ok);
  const chosen = pass ?? paths[0];
  const conf = chosen.n.provenanceTier === 'estimated-derived' ? 'medium' : 'high';
  return finding(claim, product, ruleId, pass ? 'ok' : 'contradicted', conf, nutrientEvidenceBlock(product, 'fibre', chosen.n, chosen.detail), paths.filter((p) => p !== chosen).map((p) => `Alternative basis checked: ${p.detail} — ${p.ok ? 'passes' : 'fails'}`));
}

function checkProtein(claim, product, ruleId, minEnergyPct) {
  const protein = usableNutrient(product, 'protein');
  const kcal = energyKcalPer100g(product);
  if (!protein || !kcal) return uncheckable(claim, product, 'no usable protein and/or energy basis for the energy-share leg');
  const pct = (protein.value * 4 / kcal.value) * 100;
  const pctDetail = `protein ${protein.value} g/100g × 4 kcal/g ÷ ${Math.round(kcal.value * 10) / 10} kcal/100g = ${pct.toFixed(1)}% of energy (threshold ≥ ${minEnergyPct}%)`;
  if (pct < minEnergyPct) {
    return finding(claim, product, ruleId, 'misleading', 'high', nutrientEvidenceBlock(product, 'protein', protein, pctDetail), ['The energy-share leg is a necessary condition — it fails regardless of the daily-quantity leg.']);
  }
  const servingG = product?.nutrition?.servingSizeG;
  if (typeof servingG !== 'number' || servingG <= 0) return uncheckable(claim, product, `energy share passes (${pct.toFixed(1)}%) but no declared serving/daily quantity is published in our data for the ≥10 g/day leg`);
  const perDay = Math.round(protein.value * servingG) / 100;
  const proxyNote = `Daily-quantity leg uses the pack-declared serving (${servingG} g) as a labelled proxy for the recommended daily quantity (HPB requires a daily recommendation statement on the label; assumption recorded).`;
  if (perDay >= 10) {
    return finding(claim, product, ruleId, 'ok', 'medium', nutrientEvidenceBlock(product, 'protein', protein, `${pctDetail}; declared serving ${servingG} g provides ${perDay} g protein ≥ 10 g`), [proxyNote]);
  }
  return uncheckable(claim, product, `energy share passes (${pct.toFixed(1)}%) but the declared-serving proxy (${servingG} g) provides only ${perDay} g protein (< 10 g/day) and no daily recommendation statement is published in our data — label verification needed before any accusation (honest gap, NOT queued)`);
}

function findReferenceProduct(referenceText, catalogue, selfEan) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const ref = norm(referenceText);
  if (!ref) return null;
  for (const p of catalogue.products) {
    if (p.ean === selfEan) continue;
    const name = norm(p.name);
    if (name.includes(ref) || ref.includes(name)) return p;
    const refTokens = ref.split(' ').filter((t) => t.length > 2);
    const nameTokens = new Set(name.split(' '));
    if (refTokens.length >= 3 && refTokens.every((t) => nameTokens.has(t))) return p;
  }
  return null;
}

function checkComparativeSugar(claim, product, catalogue) {
  const ruleId = 'CLM-LESSSUGAR';
  const sentence = claim.sentence || claim.quotedClaim;
  const refMatch = sentence.match(/(?:as\s+)?compared?\s+to\s+([^.;•]+)|\bthan\s+([^.;•]+)/i);
  const referenceText = refMatch ? (refMatch[1] || refMatch[2]).split(/[),]/)[0].trim() : null;
  if (!referenceText) {
    return finding(claim, product, ruleId, 'misleading', 'high', { kind: 'claim-text', detail: `Comparative sugar claim with NO reference food stated: "${sentence}"`, sourceUrl: claim.claimSource.sourceUrl }, ['HPB §5.1 requires a reference-comparison statement; "less/lower sugar" requires ≥25% less than the reference food.']);
  }
  const generic = /\b(?:regular|average|ordinary|normal|typical)\b/i.test(referenceText) && !findReferenceProduct(referenceText, catalogue, product.ean);
  if (generic) {
    return finding(claim, product, ruleId, 'misleading', 'medium', { kind: 'claim-text', detail: `Generic category reference "${referenceText}" — no identifiable reference food or published weighted-average evidence: "${sentence}"`, sourceUrl: claim.claimSource.sourceUrl }, ['HPB glossary limb (ii) allows a weighted industry norm as reference, but no such evidence is published with the claim — founder adjudication proposed (consistent with the three founder-approved slice-4 flags).']);
  }
  const refProduct = findReferenceProduct(referenceText, catalogue, product.ean);
  if (!refProduct) return uncheckable(claim, product, `named reference "${referenceText}" not in the catalogue — 25% reduction not verifiable from our data`);
  const subj = usableNutrient(product, 'sugars');
  const ref = usableNutrient(refProduct, 'sugars');
  if (!subj || !ref) return uncheckable(claim, product, `named reference "${refProduct.name}" found but sugars basis missing on one side — 25% reduction not verifiable`);
  const reduction = ((ref.value - subj.value) / ref.value) * 100;
  const detail = `sugars ${subj.value} g/100g vs reference "${refProduct.name}" ${ref.value} g/100g → ${reduction.toFixed(1)}% reduction (threshold ≥ 25%)`;
  return finding(claim, product, ruleId, reduction >= 25 ? 'ok' : 'contradicted', 'high', nutrientEvidenceBlock(product, 'sugars', subj, detail));
}

function checkWholegrainMain(claim, product, ing, parsed) {
  if (!ing.usable) return uncheckable(claim, product, `ingredient list not usable: ${ing.source}`);
  const first = parsed.first;
  if (!first) return uncheckable(claim, product, 'ingredient list parsed empty');
  if (first.wholegrain) {
    return finding(claim, product, 'CLM-WG-MAIN', 'ok', first.percent !== null ? 'high' : 'medium', ingredientEvidenceBlock(ing, first.raw), ['First ingredient (SG descending-weight order) is wholegrain.']);
  }
  if (first.refined) {
    const wg = parsed.flat.filter((t) => t.wholegrain).map((t) => t.raw);
    const share = wholegrainShare(parsed);
    return finding(claim, product, 'CLM-WG-MAIN', 'contradicted', first.percent !== null || share !== null ? 'high' : 'medium', ingredientEvidenceBlock(ing, first.raw), [
      `First ingredient is REFINED ("${first.raw}"); wholegrain ingredients present: ${wg.length ? wg.map((w) => `"${w}"`).join(', ') : 'none'}.`,
      'A "main ingredient" claim means the largest single ingredient by weight (SG mandatory descending order).',
      REG40A_UPGRADED_NOTE,
    ]);
  }
  return uncheckable(claim, product, `first ingredient "${first.raw}" is neither clearly wholegrain nor refined — needs label verification`);
}

function checkWholegrainShare(claim, product, ing, parsed) {
  if (!ing.usable) return uncheckable(claim, product, `ingredient list not usable: ${ing.source}`);
  const first = parsed.first;
  const share = wholegrainShare(parsed);
  const reg40a = REG40A_UPGRADED_NOTE;
  if (first?.refined) {
    return finding(claim, product, 'CLM-WG-SHARE', 'misleading', first.percent !== null || share !== null ? 'high' : 'medium', ingredientEvidenceBlock(ing, first.raw), [
      `Unqualified wholegrain claim, but the FIRST ingredient is refined ("${first.raw}")${share !== null ? ` and the declared wholegrain share is only ${share}%` : ''}.`,
      reg40a,
    ]);
  }
  if (share !== null && share < 50 && !first?.wholegrain) {
    return finding(claim, product, 'CLM-WG-SHARE', 'misleading', 'medium', ingredientEvidenceBlock(ing, parsed.flat.filter((t) => t.wholegrain).map((t) => t.raw).join('; ') || ing.text), [`Declared wholegrain share ${share}% < 50% and wholegrain does not lead the ingredient list, under an unqualified wholegrain claim.`, reg40a]);
  }
  return finding(claim, product, 'CLM-WG-SHARE', 'ok', first?.wholegrain && first.percent !== null ? 'high' : 'medium', ingredientEvidenceBlock(ing, first?.raw ?? ing.text), [
    first?.wholegrain ? 'First ingredient is wholegrain (SG descending-weight order) — the wholegrain claim is led by the ingredient list.' : '',
    share !== null ? `Declared wholegrain share ${share}%.` : 'No refined grain ingredient found ahead of wholegrain ingredients.',
    reg40a,
  ].filter(Boolean));
}

function checkWholegrainPercent(claim, product, ing, parsed) {
  if (!ing.usable) return uncheckable(claim, product, `ingredient list not usable: ${ing.source}`);
  if (claim.scopeGrain) {
    const grain = claim.scopeGrain.split(/\s+/).pop();
    const wgToken = parsed.flat.find((t) => t.wholegrain && new RegExp(`\\b${grain}`, 'i').test(t.raw));
    if (wgToken) {
      return finding(claim, product, 'CLM-WG-PERCENT', 'ok', 'medium', ingredientEvidenceBlock(ing, wgToken.raw), [`Claim scopes the percentage to the named grain ingredient ("${claim.scopeGrain}"), not to total product composition — the ${grain} ingredient is wholegrain. Product-level wholegrain share may be lower (e.g. other ingredients).`]);
    }
    return finding(claim, product, 'CLM-WG-PERCENT', 'contradicted', 'medium', ingredientEvidenceBlock(ing, ing.text), [`No wholegrain ${grain} ingredient found for the ingredient-scoped claim "${claim.quotedClaim}".`]);
  }
  const share = wholegrainShare(parsed);
  if (share !== null) {
    const diff = claim.percent - share;
    if (Math.abs(diff) <= 2) return finding(claim, product, 'CLM-WG-PERCENT', 'ok', 'high', ingredientEvidenceBlock(ing, parsed.flat.filter((t) => t.wholegrain && t.percent !== null).map((t) => t.raw).join('; ')), [`Claimed ${claim.percent}% vs declared wholegrain share ${share}% (±2 pp tolerance).`]);
    if (diff > 2) return finding(claim, product, 'CLM-WG-PERCENT', 'contradicted', 'high', ingredientEvidenceBlock(ing, parsed.flat.filter((t) => t.wholegrain && t.percent !== null).map((t) => t.raw).join('; ') || ing.text), [`Claimed ${claim.percent}% wholegrain but declared wholegrain ingredients sum to ${share}%.`]);
    return finding(claim, product, 'CLM-WG-PERCENT', 'ok', 'high', ingredientEvidenceBlock(ing, ing.text), [`Declared wholegrain share ${share}% exceeds the claimed ${claim.percent}% (under-claim, not misleading).`]);
  }
  const refinedTokens = parsed.flat.filter((t) => t.refined);
  if (parsed.first?.wholegrain && !refinedTokens.length) {
    return finding(claim, product, 'CLM-WG-PERCENT', 'ok', 'medium', ingredientEvidenceBlock(ing, parsed.first.raw), ['No percentages declared; first ingredient wholegrain and no refined grain ingredients — consistent with the claim, percentage not independently verifiable.']);
  }
  if (refinedTokens.length) {
    return finding(claim, product, 'CLM-WG-PERCENT', 'misleading', 'medium', ingredientEvidenceBlock(ing, refinedTokens[0].raw), [`Percentage-qualified wholegrain claim but refined ingredients present ("${refinedTokens[0].raw}") and no wholegrain percentage declared — share not verifiable at the claimed level.`]);
  }
  return uncheckable(claim, product, 'no wholegrain percentage declared and ingredient composition inconclusive');
}

function checkWholegrainPresence(claim, product, ing, parsed) {
  if (!ing.usable) return uncheckable(claim, product, `ingredient list not usable: ${ing.source}`);
  const wg = parsed.flat.filter((t) => t.wholegrain);
  if (wg.length) return finding(claim, product, 'CLM-WG-PRESENCE', 'ok', 'high', ingredientEvidenceBlock(ing, wg[0].raw), ['Wholegrain ingredient present — "made with" is a presence claim.']);
  return finding(claim, product, 'CLM-WG-PRESENCE', 'contradicted', 'high', ingredientEvidenceBlock(ing, ing.text), ['No wholegrain ingredient in the declared list.']);
}

function checkComparativeWholegrain(claim, product, ing, parsed) {
  const sentence = claim.sentence || claim.quotedClaim;
  const hasRef = /compared?\s+to|\bthan\b/i.test(sentence);
  const share = ing.usable ? wholegrainShare(parsed) : null;
  if (share !== null && share < 10) {
    return finding(claim, product, 'CLM-WG-COMPARATIVE', 'contradicted', 'high', ingredientEvidenceBlock(ing, ing.text), [`Declared wholegrain share ${share}% < 10% minimum for "Higher in Wholegrains".`]);
  }
  if (!hasRef) {
    return finding(claim, product, 'CLM-WG-COMPARATIVE', 'misleading', 'medium', { kind: 'claim-text', detail: `Comparative wholegrain claim with NO reference-comparison statement: "${sentence}"`, sourceUrl: claim.claimSource.sourceUrl }, ['HPB §5.1: for wholegrains, a statement must compare the wholegrains percent of the subject food to the reference food; "Higher in Wholegrains" requires ≥10% wholegrains.']);
  }
  return uncheckable(claim, product, 'reference stated but reference wholegrain data not in the catalogue — comparison not verifiable');
}

const MADEWITH_SUBJECT_RE = {
  honey: /\bhoney\b/i,
  cocoa: /\bcocoa\b/i,
  strawberries: /strawberr/i,
  'strawberry slices': /strawberr/i,
  oats: /\boats?\b/i,
  fruit: /\b(?:raisins?|dates?|strawberr|blueberr|cranberr|banana|apple|goji|longan|fruit)\b/i,
};

function checkMadeWith(claim, product, ing, parsed) {
  if (!ing.usable) return uncheckable(claim, product, `ingredient list not usable: ${ing.source}`);
  const re = MADEWITH_SUBJECT_RE[claim.subject];
  if (!re) return uncheckable(claim, product, `unsupported "made with" subject: ${claim.subject}`);
  // A flavouring is not the real ingredient ("Honey Flavouring" ≠ honey).
  const hit = parsed.flat.find((t) => re.test(t.raw) && !/flavou?r|essence|artificial/i.test(t.raw));
  if (hit) return finding(claim, product, 'CLM-MADEWITH', 'ok', 'high', ingredientEvidenceBlock(ing, hit.raw), [`"${claim.subject}" ingredient present — presence claim satisfied.`]);
  const flavourOnly = parsed.flat.find((t) => re.test(t.raw));
  return finding(claim, product, 'CLM-MADEWITH', 'contradicted', 'high', ingredientEvidenceBlock(ing, flavourOnly?.raw ?? ing.text), [`No "${claim.subject}" ingredient in the declared list.${flavourOnly ? ` Only a flavouring ("${flavourOnly.raw}") — a flavouring is not the real ingredient.` : ''}`]);
}

export function checkClaim(claim, product, ctx) {
  const { ing, parsed, catalogue, disputed } = ctx;
  if (disputed && ['sugar-free', 'low-sugar', 'source-fibre', 'high-fibre', 'source-protein', 'high-protein'].includes(claim.family)) {
    return uncheckable(claim, product, 'nutrition panel under a definitive plausibility dispute (slice-6 data-flag, macro sum > 100 g/100g) — no nutrient accusation until founder adjudication');
  }
  switch (claim.family) {
    case 'sugar-free': return checkSugarThreshold(claim, product, 'CLM-SUGARFREE', 0.5);
    case 'low-sugar': return checkSugarThreshold(claim, product, 'CLM-LOWSUGAR', 5, 2);
    case 'no-added-sugar': return checkNoAddedSugar(claim, product, 'CLM-NOADDEDSUGAR', ing, parsed, false);
    case 'unsweetened': return checkNoAddedSugar(claim, product, 'CLM-UNSWEETENED', ing, parsed, true);
    case 'comparative-sugar': return checkComparativeSugar(claim, product, catalogue);
    case 'source-fibre': return checkFibre(claim, product, 'CLM-FIBRESOURCE', 3, 1.5);
    case 'high-fibre': return checkFibre(claim, product, 'CLM-FIBREHIGH', 6, 3, 4);
    case 'source-protein': return checkProtein(claim, product, 'CLM-PROTEINSOURCE', 12);
    case 'high-protein': return checkProtein(claim, product, 'CLM-PROTEINHIGH', 20);
    case 'wholegrain-main': return checkWholegrainMain(claim, product, ing, parsed);
    case 'wholegrain-unqualified': return checkWholegrainShare(claim, product, ing, parsed);
    case 'wholegrain-percent': return checkWholegrainPercent(claim, product, ing, parsed);
    case 'wholegrain-presence': return checkWholegrainPresence(claim, product, ing, parsed);
    case 'comparative-wholegrain': return checkComparativeWholegrain(claim, product, ing, parsed);
    case 'made-with': return checkMadeWith(claim, product, ing, parsed);
    default: return uncheckable(claim, product, `no rule for family ${claim.family}`);
  }
}

// ---------------------------------------------------------------------------
// Run over the catalogue
// ---------------------------------------------------------------------------

export function readPendingItems(pendingDir) {
  if (!existsSync(pendingDir)) return [];
  return readdirSync(pendingDir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(readFileSync(resolve(pendingDir, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

export function runClaimChecks({ catalogue, sheet, pendingItems = [] }) {
  const sheetByEan = new Map((sheet?.rows ?? []).map((r) => [String(r.ean), r]));
  const disputed = disputedPanelEans(pendingItems);
  const findings = [];
  const uncheckables = [];
  const skipped = [];
  const ukHeuristics = [];
  let claimsExtracted = 0;
  for (const product of catalogue.products) {
    const sheetRow = sheetByEan.get(String(product.ean));
    const { claims, skipped: sk } = extractClaims(product, sheetRow);
    claimsExtracted += claims.length;
    skipped.push(...sk);
    const ing = ingredientEvidence(product, sheetRow);
    // P2-10 PATCH 1 anchor C (tier-aware): the tier rides on every percent;
    // non-declared tiers never feed wholegrain share. Structured consumption
    // is dormant until the gate-approved apply (parsedIngredientsFor).
    const ingTier = product?.ingredients?.provenanceTier ?? (/pack-photo OCR/.test(ing.source) ? 'ocr-label' : 'label-declared');
    const parsed = ing.usable ? parsedIngredientsFor(product, ing, ingTier) : { top: [], flat: [], first: null };
    const ctx = { ing, parsed, catalogue, disputed: disputed.has(String(product.ean)) };
    for (const claim of claims) {
      const result = checkClaim(claim, product, ctx);
      if (result.verdict) findings.push(result);
      else uncheckables.push(result);
    }
    // UK traffic-light heuristics — informational, labelled, NEVER queued.
    for (const [key, limit, label] of [['sugars', 22.5, 'total sugars'], ['salt', 1.5, 'salt']]) {
      const n = usableNutrient(product, key);
      if (n && n.value > limit) {
        ukHeuristics.push({
          ean: product.ean, productName: product.name, nutrient: key, value: n.value, unit: n.unit, provenanceTier: n.provenanceTier,
          threshold: `${label} > ${limit} g/100g = RED`,
          label: 'UK NHS/FSA traffic-light heuristic — NOT SG law; informational only, not a claim flag',
          sourceUrl: NHS_LABELS_URL,
        });
      }
    }
  }
  const counts = {
    products: catalogue.products.length,
    claimsExtracted,
    findings: findings.length,
    contradicted: findings.filter((f) => f.verdict === 'contradicted').length,
    misleading: findings.filter((f) => f.verdict === 'misleading').length,
    ok: findings.filter((f) => f.verdict === 'ok').length,
    review: findings.filter((f) => f.verdict === 'review').length,
    uncheckable: uncheckables.length,
    skippedHcs: skipped.length,
    ukHeuristicNotes: ukHeuristics.length,
  };
  return { findings, uncheckable: uncheckables, skipped, ukHeuristics, counts };
}

// ---------------------------------------------------------------------------
// Queue proposals — contradicted/misleading ONLY, deduped, never self-approved.
// ok AND review verdicts are never queued (review = founder-adjudication
// material surfaced in findings.json, not a publishable accusation).
// ---------------------------------------------------------------------------

const VERDICT_RANK = { contradicted: 2, misleading: 1, ok: 0 };

export function existingClaimFlagEans(pendingItems) {
  return new Set(pendingItems.filter((i) => i?.kind === 'claim-flag').map((i) => String(i.ean)));
}

export function buildQueueItems(results, existingEans, nowIso) {
  const ts = nowIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-').replace('Z', 'Z');
  const flagged = results.findings.filter((f) => f.verdict === 'contradicted' || f.verdict === 'misleading');
  const byEan = new Map();
  for (const f of flagged) {
    if (!byEan.has(f.ean)) byEan.set(f.ean, []);
    byEan.get(f.ean).push(f);
  }
  const items = [];
  const deduped = [];
  for (const [ean, fs] of byEan) {
    if (existingEans.has(String(ean))) { deduped.push(ean); continue; }
    fs.sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict]);
    const worst = fs[0];
    const evShort = worst.evidence.kind === 'ingredient'
      ? `ingredient "${worst.evidence.quotedIngredient}"`
      : worst.evidence.kind === 'nutrient'
        ? `${worst.evidence.nutrientKey} ${worst.evidence.value}${worst.evidence.unit}/100g (${worst.evidence.provenanceTier})`
        : 'the claim text itself (no reference stated)';
    items.push({
      id: `${ts}-claim-flag-${ean}`,
      kind: 'claim-flag',
      ean: String(ean),
      createdAt: nowIso,
      createdBy: AGENT_ID,
      confidence: worst.confidence,
      summary: `${worst.productName}: "${worst.quotedClaim}" ${worst.verdict} vs ${evShort}. Rule ${worst.ruleId} (HPB Aug-2024 guide). Proposal only — washing-detection has no publish path.`,
      evidence: {
        quotedClaim: worst.quotedClaim,
        claimSource: `${worst.claimSource.location}: "${worst.claimSource.contextQuote}"`,
        quotedIngredient: worst.evidence.kind === 'ingredient' ? worst.evidence.quotedIngredient : undefined,
        nutrientEvidence: worst.evidence.kind === 'nutrient' ? { nutrient: worst.evidence.nutrientKey, value: worst.evidence.value, unit: worst.evidence.unit, provenanceTier: worst.evidence.provenanceTier, detail: worst.evidence.detail } : undefined,
        ingredientSource: worst.evidence.ingredientSource,
        sourceUrl: worst.claimSource.sourceUrl ?? worst.evidence.sourceUrl,
        productPageUrl: worst.productPageUrl,
        ruleId: worst.ruleId,
        thresholdSource: { url: worst.threshold.sourceUrl, quote: worst.threshold.sourceQuote, pageRef: worst.threshold.pageRef, evidenceCache: THRESHOLD_EVIDENCE_PATH },
        verdict: worst.verdict,
        findings: fs,
        proposedAction: 'Founder review: approve/reject publication of the claim flag(s). NO auto-reclassification — range unchanged; no public flag until approved (PRD stories 26/68). Approval is applied by the orchestrator, never by the washing-detection role.',
      },
      status: 'pending',
      review: null,
    });
  }
  return { items, dedupedEans: deduped };
}

// ---------------------------------------------------------------------------
// Write scope enforcement — queue-only role, NO publish path
// ---------------------------------------------------------------------------

export const ALLOWED_WRITE_PREFIXES = ['data/claims/', 'pending/', 'runs/'];

export function assertWriteScope(root, path) {
  const rel = relative(resolve(root), resolve(path)).split('\\').join('/');
  if (rel.startsWith('..') || !ALLOWED_WRITE_PREFIXES.some((p) => rel.startsWith(p))) {
    throw new Error(`WRITE SCOPE VIOLATION (washing-detection role): ${rel} — allowed only ${ALLOWED_WRITE_PREFIXES.join(', ')}`);
  }
  return rel;
}

function guardedWrite(root, path, content) {
  assertWriteScope(root, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function writeResults(results, queue, { root = ROOT, nowIso }) {
  const written = [];
  const findingsPath = resolve(root, 'data', 'claims', 'findings.json');
  const doc = {
    schemaVersion: 1,
    generatedAt: nowIso,
    generatedBy: AGENT_ID,
    scriptVersion: SCRIPT_VERSION,
    thresholdEvidence: THRESHOLD_EVIDENCE_PATH,
    thresholdSources: [
      { name: 'HPB A Guide to Nutrition Labelling for Food Products (Singapore), Revised August 2024', url: HPB_GUIDE_URL, verifiedAt: '2026-11-20T19:36:00Z' },
      { name: 'NHS food labels (UK traffic-light heuristic — NOT SG law)', url: NHS_LABELS_URL, verifiedAt: '2026-11-20T19:41:00Z' },
    ],
    counts: { ...results.counts, queueCreated: queue.items.length, queueDedupedExisting: queue.dedupedEans.length },
    findings: results.findings,
    uncheckable: results.uncheckable,
    skipped: results.skipped,
    ukHeuristics: results.ukHeuristics,
    queue: { created: queue.items.map((i) => i.id), dedupedExistingEans: queue.dedupedEans },
  };
  guardedWrite(root, findingsPath, JSON.stringify(doc, null, 2) + '\n');
  written.push(relative(root, findingsPath));
  for (const item of queue.items) {
    const p = resolve(root, 'pending', `${item.id}.json`);
    if (existsSync(p)) continue; // never overwrite an existing queue item
    guardedWrite(root, p, JSON.stringify(item, null, 2) + '\n');
    written.push(relative(root, p));
  }
  const runPath = resolve(root, 'runs', `7a-claim-run-${nowIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-')}.json`);
  guardedWrite(root, runPath, JSON.stringify({ ranAt: nowIso, agent: AGENT_ID, scriptVersion: SCRIPT_VERSION, counts: doc.counts, written, queueCreated: doc.queue.created, queueDedupedExistingEans: queue.dedupedEans }, null, 2) + '\n');
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
  const results = runClaimChecks({ catalogue, sheet, pendingItems });
  const queue = buildQueueItems(results, existingClaimFlagEans(pendingItems), nowIso);
  const dryRun = process.argv.includes('--dry-run');
  let written = [];
  if (!dryRun) written = writeResults(results, queue, { root, nowIso });
  console.log(JSON.stringify({ dryRun, counts: results.counts, queueCreated: queue.items.map((i) => `${i.ean} ${i.evidence.verdict}: ${i.evidence.quotedClaim}`), queueDedupedExistingEans: queue.dedupedEans, written }, null, 2));
  return { results, queue, written };
}

if (isMain(import.meta.url)) main();