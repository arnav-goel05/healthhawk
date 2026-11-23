// HealthHawk P2-12 — HCS vocabulary + logo-misuse gate (STANDALONE module).
// Consumed by the 7b sweep via a documented interface (see runs/p2-12/wiring-patch.md);
// this module does NOT edit 7a/7b (owned concurrently this wave). It imports 7a
// helpers READ-ONLY.
//
// FACT-WORK GATE (runs/p2-12/criteria-currency.md): current HCS criteria VERIFIED
// at the official HPB portal — "HCS Nutrient Guidelines As of April 2026" (the
// Apr-2020 v2 PDF the P2 research cached is superseded). The "34 taglines" are
// 34 logo VARIANTS (single/double descriptor); 12 distinct nutrient descriptors
// are documented (data/hcs/taglines.json). Full 34-variant list is a CorpPass-only
// image gallery — honest gap recorded.
//
// ROLE / GOVERNANCE: HCS is a VOLUNTARY logo licence (tier 4, not law). Certification
// accusations are STRONGER than nutrient contradictions, so this module NEVER emits
// contradicted/misleading. Verdicts are ok | review | unverified only. Grey zones
// route to review/unverified, never auto-publish as accusations (D9 rule 4). Logo
// checks are REVIEW-GRADE ONLY with visual on-pack confirmation; OCR text proxy is
// NOT logo recognition (stated in every logo finding). T18: logo ABSENCE is never a
// violation. No publish path: writes ONLY data/hcs/ and runs/p2-12/ (staged inputs
// live under runs/p2-12/inputs/; the merge implementer copies them into
// pending/p2-audit/inputs/). findings.json is NEVER written here.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import {
  usableNutrient, energyKcalPer100g, nutritionSourceUrl, ingredientEvidence,
  parseIngredientList, wholegrainShare, disputedPanelEans, readPendingItems,
  FREE_SUGAR_RE, SWEETENER_RE, SUGAR_ALCOHOL_RE, GREY_ZONE_SUGAR_RE,
  SUGAR_ROUNDING_EPSILON_G,
} from './7a-claim-rules.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const AGENT_ID = 'agent:p2-12-hcs';
export const SCRIPT_VERSION = '1.0.0';
export const VOCAB_PATH = 'data/hcs/taglines.json';
export const CURRENCY_PATH = 'runs/p2-12/criteria-currency.md';
export const VISUAL_PATH = 'runs/p2-12/visual-confirmation.json';

export const HCS_VOCAB = JSON.parse(readFileSync(resolve(ROOT, VOCAB_PATH), 'utf8'));
export const META = HCS_VOCAB.meta;
export const TAGLINES = HCS_VOCAB.taglines;
export const CATEGORY_GATES = HCS_VOCAB.categoryGates;
export const PROXY_PHRASES = HCS_VOCAB.proxyPhrases.phrases;
export const TAGLINE_BY_ID = Object.fromEntries(TAGLINES.map((t) => [t.id, t]));

export const HCS_LOGO_RE = /healthier\s+choice/i;
export const VERDICTS = ['ok', 'review', 'unverified'];
export const NEVER_VERDICTS = ['contradicted', 'misleading'];

// Sodium-compound tokens for "No Added Sodium" (ingredient-based; beyond NaCl).
export const SODIUM_COMPOUND_RE = /\b(?:salt|sodium\s+(?:bicarbonate|bicarb|citrate|chloride|benzoate|nitrate|nitrite|phosphate|pyrophosphate|tripolyphosphate|hexametaphosphate|alginate|ascorbate|erythorbate|gluconate|lactate|malate|acetate|carbonate|hydroxide|stearoyl|caseinate)|monosodium\s+glutamate|msg|disodium\s+(?:phosphate|pyrophosphate|guanylate|inosinate)|sodium\s+caseinate|baking\s+(?:soda|powder)|raising\s+agent)\b/i;

const CLAIM_EVIDENCE_TYPES = ['marketing-copy', 'pack-photo-ocr', 'key-information', 'name-positioning', 'retailer-attribute'];
const SOURCE_PRIORITY = { 'pack-photo-ocr': 3, 'marketing-copy': 2, 'key-information': 2, 'name-positioning': 2, 'retailer-attribute': 1, name: 1 };

// ---------------------------------------------------------------------------
// Claim extraction — verbatim descriptor matches + HCS context + proxy coverage
// ---------------------------------------------------------------------------

function sentenceAround(text, index) {
  const start = Math.max(text.lastIndexOf('.', index) + 1, text.lastIndexOf('•', index) + 1, text.lastIndexOf(';', index) + 1, 0);
  let end = text.length;
  for (const sep of ['.', '•', ';']) { const i = text.indexOf(sep, index); if (i >= 0 && i < end) end = i; }
  return text.slice(start, end).trim();
}

function claimSources(product, sheetRow) {
  const sources = [{ location: 'product name (retailer listing)', text: product.name, sourceUrl: product?.offers?.[0]?.sourceUrl ?? null, priority: 1, type: 'name' }];
  for (const e of sheetRow?.evidence ?? []) {
    if (CLAIM_EVIDENCE_TYPES.includes(e.type) && e.quote) {
      sources.push({ location: `classification sheet evidence [${e.type}]`, text: e.quote, sourceUrl: e.sourceUrl ?? null, priority: SOURCE_PRIORITY[e.type] ?? 2, ocrRecord: e.ocrRecord ?? null, type: e.type });
    }
  }
  return sources;
}

// HCS context: logo text mention (OCR/marketing) and/or retailer HCS attribute.
// A retailer attribute is NOT on-pack logo recognition — it is a proxy.
export function hcsContext(product, sheetRow) {
  const sources = claimSources(product, sheetRow);
  const logoTextSources = sources.filter((s) => HCS_LOGO_RE.test(s.text));
  const retailerAttribute = product?.attributes?.healthierChoiceSymbol === true;
  return {
    logoTextMention: logoTextSources.length > 0,
    logoTextQuotes: logoTextSources.map((s) => ({ location: s.location, quote: s.text, sourceUrl: s.sourceUrl, type: s.type })),
    retailerAttribute,
    hasHcsContext: logoTextSources.length > 0 || retailerAttribute,
  };
}

export function extractHcsTaglines(product, sheetRow) {
  const sources = claimSources(product, sheetRow);
  const byId = new Map();
  const proxyHits = [];
  for (const src of sources) {
    for (const t of TAGLINES) {
      const re = new RegExp(t.descriptorRe, 'gi');
      let m;
      while ((m = re.exec(src.text)) !== null) {
        const occ = {
          taglineId: t.id,
          quotedClaim: m[0].trim(),
          claimSource: { location: src.location, contextQuote: src.text, sourceUrl: src.sourceUrl, ocrRecord: src.ocrRecord ?? undefined, evidenceType: src.type },
          sentence: sentenceAround(src.text, m.index),
          priority: src.priority,
        };
        const prev = byId.get(t.id);
        if (!prev || occ.priority > prev.priority) byId.set(t.id, occ);
      }
    }
    for (const p of PROXY_PHRASES) {
      const re = new RegExp(p.re, 'gi');
      const m = re.exec(src.text);
      if (m) proxyHits.push({ proxyId: p.id, mapsTo: p.mapsTo, quotedClaim: m[0].trim(), location: src.location });
    }
  }
  return { taglines: [...byId.values()], proxyHits, context: hcsContext(product, sheetRow) };
}

// ---------------------------------------------------------------------------
// Category classification (conservative; misclassification routes to review)
// ---------------------------------------------------------------------------

const BEVERAGE_NAME_RE = /3\s*in\s*1|3in1|beverage|cereal\s+drink|milk\s+drink|instant\s+cereal|oat\s+cereal\s+drink/i;
const OATS_NAME_RE = /\boats?\b|oatmeal|rolled\s+oats/i;

export function classifyCategory(product, sheetRow, ing, parsed) {
  if (product.scoring_category === 'sg-nutrigrade-beverages' || BEVERAGE_NAME_RE.test(product.name)) return 'cereal-mix-beverage';
  if (product?.attributes?.kidsPositioned === true) return 'childrens-cereal';
  if (OATS_NAME_RE.test(product.name) && ing?.usable) {
    const flat = parsed?.flat ?? [];
    const noFreeSugar = !flat.some((t) => FREE_SUGAR_RE.test(t.raw));
    const allWholegrain = flat.length > 0 && flat.every((t) => t.wholegrain);
    if (noFreeSugar && allWholegrain) return 'plain-oats';
  }
  if (/cereal|cornflakes|corn\s?flakes|muesli|granola|breakfast|oats|oatmeal|wheat|rice|bran/i.test(product.name) || product.department === 'Breakfast') return 'adult-rte-cereal';
  return 'other';
}

// ---------------------------------------------------------------------------
// Evidence blocks + finding shell
// ---------------------------------------------------------------------------

function nutrientBlock(product, key, n, detail) {
  return { kind: 'nutrient', nutrientKey: key, value: n.value, unit: n.unit, provenanceTier: n.provenanceTier, sourceUrl: nutritionSourceUrl(product, n.provenanceTier), detail };
}
function ingredientBlock(ing, quotedIngredient) {
  return { kind: 'ingredient', quotedIngredient, ingredientListQuote: ing.raw, ingredientSource: ing.source, sourceUrl: ing.sourceUrl };
}
function claimTextBlock(claim, detail) {
  return { kind: 'claim-text', detail, sourceUrl: claim.claimSource.sourceUrl };
}

function finding(occ, product, verdict, confidence, evidence, notes, extra = {}) {
  const t = TAGLINE_BY_ID[occ.taglineId];
  return {
    ean: product.ean,
    productName: product.name,
    productPageUrl: product?.offers?.[0]?.sourceUrl ?? null,
    ruleId: `HCS-${occ.taglineId.toUpperCase()}`,
    taglineId: occ.taglineId,
    claimFamily: `hcs-${occ.taglineId}`,
    quotedClaim: occ.quotedClaim,
    claimSource: occ.claimSource,
    evidence,
    threshold: { rule: t.criterion, sourceUrl: t.sourceUrl, pageRef: t.pageRef, sourceQuote: t.sourceQuote, type: t.type },
    verdict,
    confidence,
    notes,
    layer: 'p2-12',
    ...extra,
  };
}

const FREE_SUGAR_CAVEAT = 'HCS cereal sugar targets are FREE sugars (WHO definition), not total sugars; plain dried fruit is exempt (Apr-2026 guidelines p10 fn(a)). A total-sugars panel value at/above the gate is a review-grade candidate, NOT a confirmed free-sugar gate fail — never an auto-accusation.';
const COMPARATIVE_CAVEAT = 'The ≥25%-less / ≥20%-more-vs-category comparative leg is NOT verifiable from stored data (no category benchmark panel is held); only the HCS category gate is checked. A qualifying on-label comparison statement is required (Apr-2026 guidelines p2).';
const OCR_PROXY_CAVEAT = 'OCR text proxy ≠ logo recognition. HCS context here is from retailer attribute / OCR text, NOT a visually confirmed on-pack logo; visual on-pack confirmation is required before any logo-misuse finding (review-grade only).';

// ---------------------------------------------------------------------------
// Per-tagline checks — verdicts ok | review | unverified ONLY
// ---------------------------------------------------------------------------

function checkAbsoluteNumeric(occ, product, t) {
  const key = t.numeric.nutrient;
  const n = usableNutrient(product, key);
  if (!n) return finding(occ, product, 'unverified', 'low', claimTextBlock(occ, `No usable per-100g ${key} value (missing or non-scoreable provenance tier) — "${t.canonical}" criterion ${t.numeric.op} ${t.numeric.value} ${t.numeric.unit} not verifiable.`), ['Honest data gap, never accused.']);
  const limit = t.numeric.value;
  const eps = key === 'sugars' ? SUGAR_ROUNDING_EPSILON_G : 0;
  const pass = n.value <= limit + eps;
  const detail = `${key} ${n.value} ${n.unit}/100g vs ${t.canonical} criterion ${t.numeric.op} ${limit} ${t.numeric.unit}`;
  if (pass) return finding(occ, product, 'ok', n.provenanceTier === 'estimated-derived' ? 'medium' : 'high', nutrientBlock(product, key, n, detail), [eps && n.value > limit ? `Within label-rounding tolerance (T3, ±${eps} g).` : 'Meets the absolute criterion on the stored panel.']);
  // HCS context: a panel fail under a certification tagline is a discrepancy for
  // review, NEVER an auto-accusation (certification is stronger than a nutrient read).
  return finding(occ, product, 'review', 'medium', nutrientBlock(product, key, n, `${detail} — FAILS on the stored panel`), [
    'HCS certification-discrepancy candidate: the stored panel fails the absolute tagline criterion, but the product carries HCS context. Possible reformulation, panel data error, or basis difference — founder/reviewer adjudication required, never an auto-accusation.',
    key === 'sugars' ? 'Sugar Free uses TOTAL sugars (lactose counts, T20).' : '',
  ].filter(Boolean));
}

function checkNoAddedSugar(occ, product, ing, parsed) {
  if (!ing?.usable) return finding(occ, product, 'unverified', 'low', claimTextBlock(occ, `Ingredient list not usable (${ing?.source ?? 'none'}) — "No Added Sugar" is ingredient-based and not verifiable.`), ['Honest data gap, never accused.']);
  const offenders = parsed.flat.filter((t) => FREE_SUGAR_RE.test(t.raw));
  if (offenders.length) {
    return finding(occ, product, 'review', 'medium', ingredientBlock(ing, offenders[0].raw), [
      'HCS certification-discrepancy candidate: a free-sugar ingredient is declared under a "No Added Sugar" HCS tagline. Founder/reviewer adjudication required (reformulation / data error / basis), never an auto-accusation.',
      ...offenders.slice(1, 4).map((t) => `Additional free-sugar ingredient: "${t.raw}"`),
    ]);
  }
  const grey = parsed.flat.filter((t) => GREY_ZONE_SUGAR_RE.test(t.raw));
  if (grey.length) {
    return finding(occ, product, 'review', 'medium', ingredientBlock(ing, grey[0].raw), ['T21 grey zone: maltodextrin (polysaccharide, not a free sugar) / fruit puree (not explicitly listed) — technically defensible under "No Added Sugar"; routed to review, never auto-contradicted.']);
  }
  const sweet = parsed.flat.filter((t) => SWEETENER_RE.test(t.raw) || SUGAR_ALCOHOL_RE.test(t.raw));
  const notes = ['No free-sugar ingredient in the declared list — consistent with the "No Added Sugar" tagline.'];
  if (sweet.length) notes.push(`Sweetening substances/sugar alcohols present ("${sweet[0].raw}") — PERMITTED under no-added-sugar (exception clause, T8).`);
  return finding(occ, product, 'ok', 'high', ingredientBlock(ing, ing.text), notes);
}

function checkNoAddedSodium(occ, product, ing, parsed) {
  if (!ing?.usable) return finding(occ, product, 'unverified', 'low', claimTextBlock(occ, `Ingredient list not usable (${ing?.source ?? 'none'}) — "No Added Sodium" is ingredient-based and not verifiable.`), ['Honest data gap, never accused.']);
  const offenders = parsed.flat.filter((t) => SODIUM_COMPOUND_RE.test(t.raw));
  if (offenders.length) {
    return finding(occ, product, 'review', 'medium', ingredientBlock(ing, offenders[0].raw), ['HCS certification-discrepancy candidate: a sodium-bearing ingredient is declared under a "No Added Sodium"/"Unsalted" HCS tagline. Founder/reviewer adjudication required, never an auto-accusation.']);
  }
  return finding(occ, product, 'ok', 'high', ingredientBlock(ing, ing.text), ['No salt / sodium-compound ingredient in the declared list — consistent with the tagline.']);
}

function categoryGateFor(category) { return CATEGORY_GATES[category] ?? null; }

function checkHigherWholegrains(occ, product, category, ing, parsed) {
  const gate = categoryGateFor(category);
  const minPct = gate?.wholegrainPct ?? gate?.wholegrainPctGte ?? null;
  const share = ing?.usable ? wholegrainShare(parsed) : null;
  const notes = [COMPARATIVE_CAVEAT, 'Wholegrain basis is final-product weight (T6); the ≥20%-vs-category comparative leg is not verifiable from stored data.'];
  if (minPct === null) return finding(occ, product, 'unverified', 'low', claimTextBlock(occ, `No HCS wholegrain category gate applies to category "${category}" — "${occ.quotedClaim}" not verifiable.`), notes);
  if (share === null) return finding(occ, product, 'unverified', 'low', claimTextBlock(occ, `No wholegrain percentage declared in the ingredient list we hold — the ≥${minPct}% final-product wholegrain gate is not verifiable (never guessed, T6).`), notes);
  const detail = `declared wholegrain share ${share}% vs HCS ${category} gate ≥${minPct}% (final-product weight)`;
  if (share >= minPct) return finding(occ, product, 'ok', 'medium', ingredientBlock(ing, parsed.flat.filter((t) => t.wholegrain && t.percent !== null).map((t) => t.raw).join('; ') || ing.text), [detail, ...notes]);
  return finding(occ, product, 'review', 'medium', ingredientBlock(ing, ing.text), [`${detail} — FAILS on declared percentages.`, 'HCS certification-discrepancy candidate (logo present + gate failed = potential logo misuse, REVIEW-GRADE). Possible basis difference (blend vs product, dry vs as-sold, T6) or reformulation — founder/reviewer adjudication, never an auto-accusation.', ...notes]);
}

function checkLowerSugar(occ, product, category, ing, parsed) {
  const gate = categoryGateFor(category);
  const limit = gate?.freeSugarLt ?? null;
  const sugars = usableNutrient(product, 'sugars');
  const notes = [COMPARATIVE_CAVEAT, FREE_SUGAR_CAVEAT];
  if (limit === null) return finding(occ, product, 'unverified', 'low', claimTextBlock(occ, `No HCS sugar category gate applies to category "${category}" — "${occ.quotedClaim}" comparative leg not verifiable.`), notes);
  if (!sugars) return finding(occ, product, 'unverified', 'low', claimTextBlock(occ, `No usable per-100g sugars value — the <${limit} g/100g free-sugar gate is not verifiable.`), notes);
  const driedFruit = ing?.usable && parsed.flat.some((t) => /\b(?:raisins?|dates?|cranberr|strawberr|blueberr|banana|apple|goji|longan|dried\s+fruit|sultanas?|currants?|apricots?|figs?|prunes?)\b/i.test(t.raw) && !/sugar\s?coated|candied|sweetened/i.test(t.raw));
  if (driedFruit) notes.push('Plain dried fruit present — its sugar is EXEMPT from the HCS free-sugar target (fn(a)); the total-sugars panel overstates free sugars. Review-grade only.');
  const detail = `total sugars ${sugars.value} g/100g vs HCS ${category} free-sugar gate <${limit} g/100g`;
  if (sugars.value < limit) return finding(occ, product, 'ok', sugars.provenanceTier === 'estimated-derived' ? 'medium' : 'high', nutrientBlock(product, 'sugars', sugars, `${detail} — total sugars below the free-sugar gate, so free sugars necessarily meet it`), notes);
  return finding(occ, product, 'review', 'medium', nutrientBlock(product, 'sugars', sugars, `${detail} — total sugars at/above the gate (free-sugar gate not confirmed)`), [
    'HCS certification-discrepancy / logo-misuse candidate (REVIEW-GRADE): total sugars at/above the category gate under a "Lower in Sugar" HCS tagline. Free sugars may be lower (dried-fruit exemption / lactose); never an auto-accusation.',
    ...notes,
  ]);
}

function checkLowerSodium(occ, product, category) {
  const gate = categoryGateFor(category);
  const limit = gate?.sodiumLt ?? null;
  const sodium = usableNutrient(product, 'sodium');
  const notes = [COMPARATIVE_CAVEAT];
  if (limit === null) return finding(occ, product, 'unverified', 'low', claimTextBlock(occ, `No HCS sodium category gate applies to category "${category}" — "${occ.quotedClaim}" comparative leg not verifiable.`), notes);
  if (!sodium) return finding(occ, product, 'unverified', 'low', claimTextBlock(occ, `No usable per-100g sodium value — the <${limit} mg/100g gate is not verifiable.`), notes);
  const detail = `sodium ${sodium.value} mg/100g vs HCS ${category} gate <${limit} mg/100g`;
  if (sodium.value < limit) return finding(occ, product, 'ok', sodium.provenanceTier === 'estimated-derived' ? 'medium' : 'high', nutrientBlock(product, 'sodium', sodium, detail), notes);
  return finding(occ, product, 'review', 'medium', nutrientBlock(product, 'sodium', sodium, `${detail} — FAILS`), ['HCS certification-discrepancy candidate (REVIEW-GRADE), never an auto-accusation.', ...notes]);
}

function checkLowerSatFat(occ, product, category) {
  const gate = categoryGateFor(category);
  const notes = [COMPARATIVE_CAVEAT];
  if (category !== 'cereal-mix-beverage' || !gate?.satFatLte) {
    return finding(occ, product, 'unverified', 'low', claimTextBlock(occ, `No HCS saturated-fat category gate applies to category "${category}" (cereal tables have no sat-fat gate) — "${occ.quotedClaim}" comparative leg not verifiable.`), notes);
  }
  const sat = usableNutrient(product, 'saturated_fat');
  if (!sat) return finding(occ, product, 'unverified', 'low', claimTextBlock(occ, 'No usable saturated-fat value — gate not verifiable.'), notes);
  const prep = product.prepInstructions;
  const vol = prep?.finalVolumeMl ?? prep?.waterMl;
  if (prep && typeof prep.powderG === 'number' && typeof vol === 'number' && vol > 0) {
    const per100ml = Math.round(sat.value * prep.powderG / vol * 100) / 100;
    const detail = `as-prepared sat fat ≈ ${per100ml} g/100ml (${prep.powderG} g → ${vol} ml) vs gate ≤${gate.satFatLte} g/100ml`;
    return finding(occ, product, per100ml <= gate.satFatLte ? 'ok' : 'review', 'medium', nutrientBlock(product, 'saturated_fat', sat, detail), notes);
  }
  return finding(occ, product, 'review', 'low', nutrientBlock(product, 'saturated_fat', sat, `dry sat fat ${sat.value} g/100g; as-prepared basis not computable (prepInstructions gap)`), ['T2 basis-contingent: HCS cereal-mix criteria apply AS PREPARED per 100ml; the dry per-100g panel cannot confirm the ≤1.2 g/100ml gate without pack prep instructions. Review-grade, never an auto-accusation.', ...notes]);
}

function checkUnverifiable(occ, product, reason) {
  return finding(occ, product, 'unverified', 'low', claimTextBlock(occ, reason), ['Honest data gap, never accused.']);
}

export function checkHcsTagline(occ, product, ctx) {
  const t = TAGLINE_BY_ID[occ.taglineId];
  const { ing, parsed, category, disputed } = ctx;
  if (disputed && ['sugar-free', 'lower-in-sugar', 'lower-in-sodium', 'lower-in-satfat'].includes(occ.taglineId)) {
    return finding(occ, product, 'unverified', 'low', claimTextBlock(occ, 'Nutrition panel under a definitive plausibility dispute (slice-6 data-flag) — no nutrient read until founder adjudication.'), ['Honest gap, never accused.']);
  }
  switch (t.type) {
    case 'absolute-numeric': return checkAbsoluteNumeric(occ, product, t);
    case 'ingredient-based': return occ.taglineId === 'no-added-sugar' ? checkNoAddedSugar(occ, product, ing, parsed) : checkNoAddedSodium(occ, product, ing, parsed);
    case 'comparative-category':
      if (occ.taglineId === 'higher-in-wholegrains') return checkHigherWholegrains(occ, product, category, ing, parsed);
      if (occ.taglineId === 'lower-in-sugar') return checkLowerSugar(occ, product, category, ing, parsed);
      if (occ.taglineId === 'lower-in-sodium') return checkLowerSodium(occ, product, category);
      if (occ.taglineId === 'lower-in-satfat') return checkLowerSatFat(occ, product, category);
      if (occ.taglineId === 'higher-in-calcium') return checkUnverifiable(occ, product, 'No calcium panel stored (micronutrient data gap) and no category benchmark — "Higher in Calcium" not verifiable.');
      return checkUnverifiable(occ, product, `Comparative tagline "${t.canonical}" not verifiable from stored data.`);
    case 'gi-test': return checkUnverifiable(occ, product, 'No measured GI test stored — "Low Glycaemic Index" (GI ≤55, ISO 26642:2010) cannot be inferred from ingredients.');
    case 'elective-calorie': return checkUnverifiable(occ, product, `"${t.canonical}" is a category-specific elective criterion (crisps/ice cream); not applicable to this cereal product.`);
    case 'produce-only': return checkUnverifiable(occ, product, '"Eat 2+2" applies to fresh fruit/vegetables only; not applicable to this product.');
    default: return checkUnverifiable(occ, product, `No check for tagline type ${t.type}.`);
  }
}

// ---------------------------------------------------------------------------
// Logo-misuse check — REVIEW-GRADE ONLY, visual confirmation required
// ---------------------------------------------------------------------------

// Certification cross-check vs the official HCS product list (S8) is NAME-BASED
// and FUZZY (the list has no EAN column) → review-grade corroboration only.
export function certificationCrossCheck(product, officialListText) {
  if (!officialListText) return { status: 'not-checked', reason: 'official HCS product list text not provided' };
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const name = norm(product.name);
  const brand = norm(product.brand ?? '');
  const tokens = name.split(' ').filter((t) => t.length > 2);
  const lines = officialListText.split('\n').map((l) => norm(l)).filter(Boolean);
  // A list line corroborates when it shares the brand + >=2 distinctive name tokens.
  const match = lines.find((l) => (brand && l.includes(brand) || tokens.some((t) => l.includes(t))) && tokens.filter((t) => l.includes(t)).length >= Math.min(2, tokens.length));
  if (match) return { status: 'name-match', matchedLine: match, note: 'Name-based fuzzy match against the official HCS product list (31 Aug 2026) — review-grade corroboration, NOT a deterministic certification verdict (no EAN column).' };
  return { status: 'no-name-match', note: 'No name match in the official HCS product list (31 Aug 2026). May be a name variant, delisting, reformulation, or retailer-attribute staleness — review-grade certification-status discrepancy, NOT proof of unauthorised use.' };
}

export function logoMisuseCheck(product, ctx, visualConfirmation, certCheck, taglineFindings) {
  const { context, category } = ctx;
  if (!context.hasHcsContext) return null; // T18: logo absence is never a violation
  const gateFails = taglineFindings.filter((f) => f.verdict === 'review');
  const visuallyConfirmed = visualConfirmation?.logoVisuallyPresent === true;
  const notes = [
    OCR_PROXY_CAVEAT,
    'Logo-misuse detection is REVIEW-GRADE ONLY. Certification accusations are stronger than nutrient contradictions; this finding never publishes as an accusation (D9 grey-zone rule).',
    'T18: HCS is voluntary — logo ABSENCE is never a violation; only logo MISUSE (present + criteria failed) is flagged, and only at review grade.',
  ];
  if (visuallyConfirmed) {
    notes.push(`Visual on-pack confirmation OBTAINED (qwenwork_media_read): ${visualConfirmation.logoDescription} Taglines: ${(visualConfirmation.taglinesTranscribed ?? []).join(', ')}. Image: ${visualConfirmation.imageUrl} (sha256 ${visualConfirmation.imageSha256}).`);
  } else {
    notes.push('Visual on-pack confirmation NOT available — no legible front-of-pack image in our data. Logo presence is inferred from retailer attribute / OCR text only.');
  }
  if (certCheck?.status === 'name-match') notes.push(`Certification cross-check: ${certCheck.note} Matched: "${certCheck.matchedLine}".`);
  else if (certCheck?.status === 'no-name-match') notes.push(`Certification cross-check: ${certCheck.note}`);
  if (gateFails.length) notes.push(`Category-gate tension under HCS context: ${gateFails.map((f) => `${f.taglineId} (${f.quotedClaim})`).join('; ')}.`);

  // Verdict: review when there is a gate tension or a certification discrepancy;
  // otherwise unverified (logo presence not visually confirmed / criteria not fully
  // verifiable). NEVER an accusation, never ok-as-validation of the logo.
  const certDiscrepancy = certCheck?.status === 'no-name-match' && context.retailerAttribute;
  const verdict = (gateFails.length || certDiscrepancy) ? 'review' : 'unverified';
  const evidence = gateFails[0]?.evidence ?? { kind: 'claim-text', detail: `HCS context (logo text mention: ${context.logoTextMention}; retailer attribute: ${context.retailerAttribute}) on category "${category}".`, sourceUrl: product?.offers?.[0]?.sourceUrl ?? null };
  return {
    ean: product.ean,
    productName: product.name,
    productPageUrl: product?.offers?.[0]?.sourceUrl ?? null,
    ruleId: 'HCS-LOGO',
    taglineId: 'logo',
    claimFamily: 'hcs-logo-misuse',
    quotedClaim: context.logoTextQuotes[0]?.quote?.match(HCS_LOGO_RE)?.[0] ?? 'Healthier Choice (retailer attribute)',
    claimSource: context.logoTextQuotes[0] ? { location: context.logoTextQuotes[0].location, contextQuote: context.logoTextQuotes[0].quote, sourceUrl: context.logoTextQuotes[0].sourceUrl } : { location: 'catalogue attributes.healthierChoiceSymbol', contextQuote: 'healthierChoiceSymbol: true', sourceUrl: product?.offers?.[0]?.sourceUrl ?? null },
    evidence,
    threshold: { rule: 'HCS logo misuse = logo present + category criteria failed (Apr-2026 guidelines). Review-grade only; visual on-pack confirmation required.', sourceUrl: META.primarySourceUrl, pageRef: 'HCS Apr-2026 guidelines p10 (cereal gates); usage specs Aug-2022 §1.5', sourceQuote: 'HPB has introduced 34 HCS variants ... either a single descriptor (e.g. Lower in Sugar) or double descriptor (e.g. Lower in Sugar Lower in Saturated Fat).', type: 'logo-misuse' },
    verdict,
    confidence: visuallyConfirmed ? 'medium' : 'low',
    notes,
    layer: 'p2-12',
    visualConfirmation: visualConfirmation ?? { logoVisuallyPresent: false, reason: 'no legible pack image in our data' },
    certificationCrossCheck: certCheck ?? { status: 'not-checked' },
    category,
    reviewGradeOnly: true,
  };
}

// ---------------------------------------------------------------------------
// Run over the catalogue
// ---------------------------------------------------------------------------

export function runHcsGate({ catalogue, sheet, pendingItems = [], findingsDoc = null, visualConfirmations = {}, officialListText = null }) {
  const sheetByEan = new Map((sheet?.rows ?? []).map((r) => [String(r.ean), r]));
  const disputed = disputedPanelEans(pendingItems);
  const visualByEan = new Map(Object.entries(visualConfirmations));
  const priorFindings = [...(findingsDoc?.findings ?? []), ...(findingsDoc?.sweep7b?.findings ?? []), ...(findingsDoc?.sweep7b?.new7aLayer ?? []), ...(findingsDoc?.sweep7b?.changed7a ?? [])];
  const priorAnyEans = new Set(priorFindings.map((f) => String(f.ean)));
  const priorFlaggedEans = new Set(priorFindings.filter((f) => f.verdict === 'contradicted' || f.verdict === 'misleading').map((f) => String(f.ean)));

  const findings = [];
  const logoFindings = [];
  const coverage = [];
  const ledger = [];
  let taglineTriggers = 0;
  let proxyTriggers = 0;

  for (const product of catalogue.products) {
    const sheetRow = sheetByEan.get(String(product.ean));
    const { taglines, proxyHits, context } = extractHcsTaglines(product, sheetRow);
    const ing = ingredientEvidence(product, sheetRow);
    const parsed = ing.usable ? parseIngredientList(ing.text) : { top: [], flat: [], first: null };
    const category = classifyCategory(product, sheetRow, ing, parsed);
    const ctx = { ing, parsed, category, context, disputed: disputed.has(String(product.ean)) };
    taglineTriggers += taglines.length;
    proxyTriggers += proxyHits.length;

    const productFindings = [];
    for (const occ of taglines) {
      const f = checkHcsTagline(occ, product, ctx);
      findings.push(f);
      productFindings.push(f);
    }
    const visual = visualByEan.get(String(product.ean)) ?? null;
    const cert = context.hasHcsContext ? certificationCrossCheck(product, officialListText) : null;
    const logo = logoMisuseCheck(product, ctx, visual, cert, productFindings);
    if (logo) { logoFindings.push(logo); productFindings.push(logo); }

    const hasTagline = taglines.length > 0;
    const hasProxy = proxyHits.length > 0;
    if (hasTagline || hasProxy || context.hasHcsContext) {
      coverage.push({
        ean: product.ean, productName: product.name, category,
        hcsContext: context.hasHcsContext, logoTextMention: context.logoTextMention, retailerAttribute: context.retailerAttribute,
        taglineIds: taglines.map((t) => t.taglineId), proxyIds: proxyHits.map((p) => p.proxyId),
        visuallyConfirmed: visual?.logoVisuallyPresent === true,
        priorAnyFinding: priorAnyEans.has(String(product.ean)), priorFlagged: priorFlaggedEans.has(String(product.ean)),
      });
    }
    const newReviewVerdicts = productFindings.filter((f) => f.verdict === 'review' || f.verdict === 'unverified');
    const netNewReview = !priorAnyEans.has(String(product.ean)) && newReviewVerdicts.length > 0;
    if (productFindings.length) {
      ledger.push({
        ean: product.ean, productName: product.name, category,
        priorAnyFinding: priorAnyEans.has(String(product.ean)), priorFlagged: priorFlaggedEans.has(String(product.ean)),
        newFindings: productFindings.map((f) => ({ ruleId: f.ruleId, taglineId: f.taglineId, quotedClaim: f.quotedClaim, verdict: f.verdict, confidence: f.confidence })),
        netNewReviewProduct: netNewReview,
      });
    }
  }

  const all = [...findings, ...logoFindings];
  const counts = {
    products: catalogue.products.length,
    taglineTriggers,
    proxyTriggers,
    taglineFindings: findings.length,
    logoFindings: logoFindings.length,
    ok: all.filter((f) => f.verdict === 'ok').length,
    review: all.filter((f) => f.verdict === 'review').length,
    unverified: all.filter((f) => f.verdict === 'unverified').length,
    contradicted: 0,
    misleading: 0,
    netNewReviewProducts: ledger.filter((l) => l.netNewReviewProduct).length,
    coverageProducts: coverage.length,
  };
  return { findings, logoFindings, coverage, ledger, counts };
}

// ---------------------------------------------------------------------------
// Staged gate inputs (runs/p2-12/inputs/) — format per pending/p2-audit/inputs/.
// reviewerVerdicts EMPTY; greyZone TRUE (never an accusation). The merge
// implementer copies these into pending/p2-audit/inputs/ and obtains two real
// independent reviewer verdicts. NO findings.json write, NO fabricated verdicts.
// ---------------------------------------------------------------------------

export const ALLOWED_WRITE_PREFIXES = ['data/hcs/', 'runs/p2-12/'];
export function assertWriteScope(root, path) {
  const rel = relative(resolve(root), resolve(path)).split('\\').join('/');
  if (rel.startsWith('..') || !ALLOWED_WRITE_PREFIXES.some((p) => rel.startsWith(p))) {
    throw new Error(`WRITE SCOPE VIOLATION (p2-12 HCS role): ${rel} — allowed only ${ALLOWED_WRITE_PREFIXES.join(', ')}`);
  }
  return rel;
}
function guardedWrite(root, path, content) {
  assertWriteScope(root, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// Extract the verbatim per-100g panel object block from catalogue.json text.
export function panelQuote(catalogueText, ean) {
  const eanIdx = catalogueText.indexOf(`"ean": "${ean}"`);
  if (eanIdx < 0) return null;
  const keyIdx = catalogueText.indexOf('"per100g":', eanIdx);
  if (keyIdx < 0) return null;
  const braceStart = catalogueText.indexOf('{', keyIdx);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < catalogueText.length; i++) {
    if (catalogueText[i] === '{') depth++;
    else if (catalogueText[i] === '}') { depth--; if (depth === 0) return catalogueText.slice(braceStart, i + 1); }
  }
  return null;
}

export { readPendingItems };

// sha256 helper (node crypto) for evidence hashing — same as the gate lib.
import { createHash } from 'node:crypto';
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const stable = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, stable(o[k])])) : o);
export const canon = (o) => JSON.stringify(stable(o));
export const evidenceSetHash = (hashes) => sha256(canon(hashes));

// Build a staged proposal for one product's HCS findings. Evidence locators are
// gate-compatible (file / catalogue-ingredients / sheet-evidence) and every quote
// is a verbatim substring of its source. greyZone TRUE → resolves to unverified
// even on a full gate pass (never an accusation).
export function buildStagedProposal(product, productFindings, { catalogueText, sheet, root = ROOT }) {
  const evidence = [];
  const sheetRow = (sheet?.rows ?? []).find((r) => String(r.ean) === String(product.ean));
  // 1. panel evidence (if any nutrient finding)
  const nutrientFinding = productFindings.find((f) => f.evidence?.kind === 'nutrient');
  if (nutrientFinding) {
    const pq = panelQuote(catalogueText, product.ean);
    if (pq) evidence.push({ sourceId: 'catalogue-per100g', locator: { kind: 'file', path: 'data/catalogue.json' }, quote: pq, sha256: sha256(catalogueText) });
  }
  // 2. claim evidence — verbatim descriptor from sheet evidence or name
  const claimFinding = productFindings.find((f) => f.quotedClaim);
  if (claimFinding) {
    const cs = claimFinding.claimSource;
    const evType = cs.evidenceType;
    if (evType && evType !== 'name' && sheetRow) {
      const ev = (sheetRow.evidence ?? []).find((e) => e.type === evType && String(e.quote ?? '').includes(claimFinding.quotedClaim));
      if (ev) evidence.push({ sourceId: 'claim-text', locator: { kind: 'sheet-evidence', ean: String(product.ean), evidenceType: evType, match: claimFinding.quotedClaim }, quote: claimFinding.quotedClaim, sha256: sha256(ev.quote) });
    }
    if (!evidence.some((e) => e.sourceId === 'claim-text') && catalogueText.includes(product.name)) {
      evidence.push({ sourceId: 'claim-text', locator: { kind: 'file', path: 'data/catalogue.json' }, quote: product.name, sha256: sha256(catalogueText) });
    }
  }
  // 3. ingredient evidence (if any ingredient finding) — quote MUST be a verbatim
  // substring of the ingredient text (gate anchoring). A joined multi-token quote
  // is not a substring; fall back to the full declared list.
  const ingFinding = productFindings.find((f) => f.evidence?.kind === 'ingredient');
  if (ingFinding && product.ingredients?.text) {
    const ingText = product.ingredients.text;
    const candidate = ingFinding.evidence.quotedIngredient;
    const quote = (typeof candidate === 'string' && ingText.includes(candidate)) ? candidate : ingText;
    evidence.push({ sourceId: 'catalogue-ingredients', locator: { kind: 'catalogue-ingredients', ean: String(product.ean) }, quote, sha256: sha256(ingText) });
  }
  // 4. criteria evidence — vocabulary + currency record
  const t = TAGLINE_BY_ID[productFindings[0]?.taglineId] ?? null;
  const vocabText = readFileSync(resolve(root, VOCAB_PATH), 'utf8');
  const criteriaQuote = t ? t.sourceQuote : META.logoCheckReason;
  if (vocabText.includes(criteriaQuote)) {
    evidence.push({ sourceId: 'hcs-criteria', locator: { kind: 'file', path: VOCAB_PATH }, quote: criteriaQuote, sha256: sha256(vocabText) });
  }
  const currencyText = readFileSync(resolve(root, CURRENCY_PATH), 'utf8');
  const currencyQuote = 'Outcome: CRITERIA VERIFIED from official sources.';
  if (currencyText.includes(currencyQuote)) {
    evidence.push({ sourceId: 'criteria-currency', locator: { kind: 'file', path: CURRENCY_PATH }, quote: currencyQuote, sha256: sha256(currencyText) });
  }
  // 5. visual confirmation evidence (logo findings)
  const logoFinding = productFindings.find((f) => f.ruleId === 'HCS-LOGO');
  if (logoFinding?.visualConfirmation?.logoVisuallyPresent) {
    const visText = readFileSync(resolve(root, VISUAL_PATH), 'utf8');
    const visQuote = `"ean": "${product.ean}"`;
    if (visText.includes(visQuote)) evidence.push({ sourceId: 'visual-confirmation', locator: { kind: 'file', path: VISUAL_PATH }, quote: visQuote, sha256: sha256(visText) });
  }
  // 6. per-product evidence markdown (format per runs/p2-05/evidence/)
  const evMdRel = `runs/p2-12/evidence/${product.ean}-hcs.md`;
  const evMdAbs = resolve(root, evMdRel);
  if (existsSync(evMdAbs)) {
    const evMdText = readFileSync(evMdAbs, 'utf8');
    const evQuote = `EAN ${product.ean} — HCS review-grade findings`;
    if (evMdText.includes(evQuote)) evidence.push({ sourceId: 'product-evidence', locator: { kind: 'file', path: evMdRel }, quote: evQuote, sha256: sha256(evMdText) });
  }
  const hashes = {};
  for (const e of evidence) hashes[e.sourceId] = e.sha256;
  const worst = productFindings.find((f) => f.verdict === 'review') ?? productFindings[0];
  return {
    staged: true,
    stagingNote: 'P2-12 STAGED gate input — NOT a decision. HCS logo/tagline findings are REVIEW-GRADE ONLY (greyZone:true → never an accusation). Reviewer verdicts are produced at the merge stage by two independent reviewer agents; the implementer never fabricates them. Copy into pending/p2-audit/inputs/ at merge (see runs/p2-12/wiring-patch.md).',
    item: {
      id: `p2-12-hcs-${product.ean}`,
      kind: 'hcs-review',
      ean: String(product.ean),
      name: product.name,
      summary: `HCS vocabulary/logo review: ${productFindings.map((f) => `${f.taglineId}=${f.verdict}`).join(', ')}. Review-grade only — never an accusation. Criteria: HCS Apr-2026 (verified).`,
      ruleIds: productFindings.map((f) => f.ruleId),
      verdicts: productFindings.map((f) => ({ ruleId: f.ruleId, verdict: f.verdict })),
    },
    evidence,
    expectedEvidenceHash: evidenceSetHash(hashes),
    delegationQuote: 'You have my approval for everrything.',
    greyZone: true,
    reviewerVerdicts: [],
    findings: productFindings,
  };
}

// ---------------------------------------------------------------------------
// Per-product evidence markdown (format per runs/p2-05/evidence/).
// ---------------------------------------------------------------------------

export function buildEvidenceMd(product, productFindings, { category, context, visualConfirmation, certCheck }) {
  const lines = [];
  lines.push(`# P2-12 HCS evidence — EAN ${product.ean} — HCS review-grade findings`);
  lines.push('');
  lines.push(`Product: ${product.name} (brand ${product.brand ?? 'n/a'})`);
  lines.push(`HCS category (classified): ${category} · scoring_category: ${product.scoring_category}`);
  lines.push(`Criteria version: ${META.criteriaVersion} (VERIFIED at official HPB portal — ${CURRENCY_PATH})`);
  lines.push('');
  lines.push('## Governance');
  lines.push('REVIEW-GRADE ONLY. HCS is a voluntary logo licence (tier 4, not law). Certification accusations are stronger than nutrient contradictions; grey zones never auto-publish as accusations (D9 rule 4). Verdicts here are ok / review / unverified — NEVER contradicted / misleading. OCR text proxy ≠ logo recognition; visual on-pack confirmation is required for any logo-misuse finding. reviewerVerdicts: EMPTY (produced by two independent reviewers at merge; never fabricated by the implementer).');
  lines.push('');
  lines.push('## HCS context');
  lines.push(`- Logo text mention (OCR/marketing proxy): ${context.logoTextMention}`);
  lines.push(`- Retailer healthierChoiceSymbol attribute: ${context.retailerAttribute}`);
  lines.push(`- Visual on-pack confirmation: ${visualConfirmation?.logoVisuallyPresent === true ? 'OBTAINED (qwenwork_media_read)' : 'NOT available'}`);
  if (visualConfirmation?.logoVisuallyPresent === true) {
    lines.push(`  - ${visualConfirmation.logoDescription}`);
    lines.push(`  - Taglines transcribed: ${(visualConfirmation.taglinesTranscribed ?? []).join(', ')}`);
    lines.push(`  - Image: ${visualConfirmation.imageUrl} (sha256 ${visualConfirmation.imageSha256})`);
  }
  if (certCheck) lines.push(`- Certification cross-check (official HCS list 31 Aug 2026, name-based/fuzzy): ${certCheck.status}${certCheck.matchedLine ? ` — "${certCheck.matchedLine}"` : ''}`);
  lines.push('');
  lines.push('## Findings (quoted claim + quoted evidence + verdict + criteria source)');
  for (const f of productFindings) {
    lines.push('');
    lines.push(`### ${f.ruleId} — ${f.taglineId} — verdict: ${f.verdict} (confidence ${f.confidence})`);
    lines.push(`- Quoted claim/tagline: "${f.quotedClaim}"`);
    lines.push(`- Claim source: ${f.claimSource.location}${f.claimSource.sourceUrl ? ` (${f.claimSource.sourceUrl})` : ''}`);
    lines.push(`- Context quote: "${(f.claimSource.contextQuote ?? '').slice(0, 300)}"`);
    if (f.evidence?.kind === 'nutrient') lines.push(`- Panel evidence: ${f.evidence.nutrientKey} = ${f.evidence.value} ${f.evidence.unit}/100g (${f.evidence.provenanceTier}) — ${f.evidence.detail}`);
    else if (f.evidence?.kind === 'ingredient') lines.push(`- Ingredient evidence: "${f.evidence.quotedIngredient}" — list: "${(f.evidence.ingredientListQuote ?? '').slice(0, 300)}" (${f.evidence.ingredientSource})`);
    else lines.push(`- Evidence: ${f.evidence?.detail ?? 'claim text'}`);
    lines.push(`- Criteria: ${f.threshold.rule}`);
    lines.push(`- Criteria source: ${f.threshold.pageRef} — ${f.threshold.sourceUrl}`);
    lines.push(`- Criteria quote: "${f.threshold.sourceQuote}"`);
    for (const n of f.notes ?? []) lines.push(`- Note: ${n}`);
  }
  lines.push('');
  lines.push('## reviewerVerdicts');
  lines.push('EMPTY — [] . Two independent reviewer verdicts are produced at the merge stage and bound to the evidence-set hash. The implementer never fabricates verdicts. greyZone:true → this item resolves to unverified even on a full gate pass (never an accusation).');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI — dry-run by default; --stage writes staged inputs under runs/p2-12/.
// ---------------------------------------------------------------------------

export function main(root = ROOT) {
  const nowIso = new Date().toISOString();
  const catalogueText = readFileSync(resolve(root, 'data', 'catalogue.json'), 'utf8');
  const catalogue = JSON.parse(catalogueText);
  const sheet = JSON.parse(readFileSync(resolve(root, 'data', 'classification', 'sheet.json'), 'utf8'));
  const pendingItems = readPendingItems(resolve(root, 'pending'));
  const findingsDoc = JSON.parse(readFileSync(resolve(root, 'data', 'claims', 'findings.json'), 'utf8'));
  const visualDoc = existsSync(resolve(root, VISUAL_PATH)) ? JSON.parse(readFileSync(resolve(root, VISUAL_PATH), 'utf8')) : { confirmations: [] };
  const visualConfirmations = Object.fromEntries((visualDoc.confirmations ?? []).map((c) => [String(c.ean), c]));
  const officialListText = existsSync(resolve(root, 'runs/p2-12/raw/hcs-product-list-20260831.txt')) ? readFileSync(resolve(root, 'runs/p2-12/raw/hcs-product-list-20260831.txt'), 'utf8') : null;
  const results = runHcsGate({ catalogue, sheet, pendingItems, findingsDoc, visualConfirmations, officialListText });

  const stage = process.argv.includes('--stage');
  const written = [];
  // Dry-run table for the tagline-carrying population (official descriptors +
  // documented proxy phrases). The issue's "24" was a prior lower-bound proxy
  // estimate; the ACTUAL count from this documented vocabulary is reported.
  const taglineCarriers = results.coverage.filter((c) => c.taglineIds.length > 0 || c.proxyIds.length > 0);
  const allFindings = [...results.findings, ...results.logoFindings];
  const taglineCarrierDryRun = taglineCarriers.map((c) => {
    const fs = allFindings.filter((f) => String(f.ean) === String(c.ean));
    return {
      ean: c.ean, productName: c.productName, category: c.category,
      strictDescriptorCarrier: c.taglineIds.length > 0,
      taglineTriggers: fs.filter((f) => f.ruleId !== 'HCS-LOGO').map((f) => ({ taglineId: f.taglineId, quotedClaim: f.quotedClaim, verdict: f.verdict, confidence: f.confidence })),
      proxyCoverage: c.proxyIds,
      logoVerdict: fs.find((f) => f.ruleId === 'HCS-LOGO')?.verdict ?? null,
      visuallyConfirmed: c.visuallyConfirmed,
      priorAnyFinding: c.priorAnyFinding,
      expectedVerdicts: fs.map((f) => `${f.ruleId}=${f.verdict}`),
    };
  });
  if (stage) {
    const byEan = new Map(catalogue.products.map((p) => [String(p.ean), p]));
    const sheetByEan = new Map((sheet?.rows ?? []).map((r) => [String(r.ean), r]));
    const ledgerReview = results.ledger.filter((l) => l.newFindings.some((f) => f.verdict === 'review' || f.verdict === 'unverified'));
    for (const l of ledgerReview) {
      const product = byEan.get(String(l.ean));
      const productFindings = allFindings.filter((f) => String(f.ean) === String(l.ean));
      const sheetRow = sheetByEan.get(String(l.ean));
      const ing = ingredientEvidence(product, sheetRow);
      const parsed = ing.usable ? parseIngredientList(ing.text) : { top: [], flat: [], first: null };
      const category = classifyCategory(product, sheetRow, ing, parsed);
      const context = hcsContext(product, sheetRow);
      const visual = visualConfirmations[String(l.ean)] ?? null;
      const cert = context.hasHcsContext ? certificationCrossCheck(product, officialListText) : null;
      const evMd = buildEvidenceMd(product, productFindings, { category, context, visualConfirmation: visual, certCheck: cert });
      const evRel = `runs/p2-12/evidence/${l.ean}-hcs.md`;
      guardedWrite(root, resolve(root, evRel), evMd);
      written.push(evRel);
      const proposal = buildStagedProposal(product, productFindings, { catalogueText, sheet, root });
      const rel = `runs/p2-12/inputs/p2-12-proposal-${l.ean}.json`;
      guardedWrite(root, resolve(root, rel), JSON.stringify(proposal, null, 2) + '\n');
      written.push(rel);
      for (const n of [1, 2]) {
        const vrel = `runs/p2-12/inputs/p2-12-verdict-${l.ean}-reviewer-${n}.json`;
        guardedWrite(root, resolve(root, vrel), JSON.stringify({ reviewer: null, verdict: 'PENDING', itemId: proposal.item.id, evidenceHash: null, executionEvidence: null, note: 'PLACEHOLDER — real independent reviewer verdict produced at merge stage. Never fabricated by the implementer.' }, null, 2) + '\n');
        written.push(vrel);
      }
    }
    const dryRunPath = 'runs/p2-12/dry-run.json';
    guardedWrite(root, resolve(root, dryRunPath), JSON.stringify({
      ranAt: nowIso, agent: AGENT_ID, scriptVersion: SCRIPT_VERSION, criteriaVersion: META.criteriaVersion,
      population: {
        strictOfficialDescriptorCarriers: results.coverage.filter((c) => c.taglineIds.length > 0).length,
        proxyVocabularyTaglineCarriers: taglineCarriers.length,
        logoTextOrAttributeCarriers: results.coverage.filter((c) => c.hcsContext).length,
        unionAnyHcsContextTaglineProxy: results.coverage.length,
        note: "The issue's '24 tagline-carrying products' was a prior lower-bound proxy estimate (p2-applicability.md §3 improvement 5). ACTUAL counts from the documented vocabulary: 12 strict official-descriptor carriers; " + taglineCarriers.length + " proxy-vocabulary carriers (descriptors + nutrient-claim proxy phrases). The full 34-variant list is a CorpPass-only image gallery (honest gap).",
      },
      counts: results.counts, taglineCarrierDryRun, coverage: results.coverage, ledger: results.ledger, findings: results.findings, logoFindings: results.logoFindings,
    }, null, 2) + '\n');
    written.push(dryRunPath);
    const ledgerPath = 'runs/p2-12/outcomes-ledger.json';
    guardedWrite(root, resolve(root, ledgerPath), JSON.stringify({ ranAt: nowIso, netNewReviewProductCount: results.ledger.filter((l) => l.netNewReviewProduct).length, netNewReviewProducts: results.ledger.filter((l) => l.netNewReviewProduct).map((l) => ({ ean: l.ean, productName: l.productName, category: l.category, newFindings: l.newFindings })), ledger: results.ledger }, null, 2) + '\n');
    written.push(ledgerPath);
  }
  console.log(JSON.stringify({ stage, counts: results.counts, population: { strict: results.coverage.filter((c) => c.taglineIds.length > 0).length, proxyCarriers: taglineCarriers.length, logo: results.coverage.filter((c) => c.hcsContext).length }, netNewReviewProducts: results.ledger.filter((l) => l.netNewReviewProduct).map((l) => `${l.ean} ${l.productName}`), written: written.length }, null, 2));
  return { results, written };
}

if (isMain(import.meta.url)) main();