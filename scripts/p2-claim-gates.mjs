// HealthHawk P2-11 — per-family disease-risk-reduction gates (washing-detection
// role, claim-rule expansion). Deterministic checked-in code — no LLM discretion.
//
// Families (HPB Aug-2024 guide, Appendix II "Reduction of disease risk claims";
// sources cached + re-verified in runs/p2-11/sources.md):
//   CLM-HEART-GATE     generic heart gate (Cardiovascular #2, PDF pp59-60) with
//                      the FULL DISJUNCTIVE sugar limb: low sugar OR sugar free
//                      OR unsweetened OR no added sugar.
//   CLM-HEART-FIBRE    wholegrain-fibre heart claim (Cardiovascular #3, PDF p60):
//                      low/fat-free + high fibre + >=25% of fibre soluble.
//   CLM-BETAGLUCAN     beta-glucan cholesterol gate (Cardiovascular #5, PDF
//                      pp61-63) — its OWN STRICTER criteria, never conflated
//                      with the generic heart gate: cholesterol <=20 mg/100g
//                      (vs <=100), sat+trans COMBINED <=1.5 g/100g, <=10% kcal
//                      from sat+trans, PLUS mandatory 3 g/day statement + NIP
//                      declarations. EFSA 2011;9(12):2471 / 2010;8(12):1885
//                      corroborate the science (jurisdiction-labelled).
//   CLM-HEART-IMPLIED  implied "heart healthy" wording — NOT a gazetted claim
//                      wording -> REVIEW (grey zone, never auto-accused), with
//                      the gate analysis attached for founder adjudication.
//
// Grey-zone discipline (PRD stories 39/52, D9 rule 4): a condition that cannot
// be evaluated from the evidence we hold is a GAP, never a silent pass and
// never an accusation. Any clear numeric FAIL on an EXPLICIT disease-risk
// claim -> contradicted; any gap-only result -> review; implied wording ->
// review regardless. review/unverified verdicts are NEVER queued as accusations.
//
// ROLE SEPARATION: this module is a DRY-RUN expansion layer. It does NOT modify
// the live 7a/7b engine output (the frozen findings + 17 golden pins stay
// byte-exact until the merge promotes these rules THROUGH the D9 auto-gate).
// Writes only under runs/ via the 7a assertWriteScope guard.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ROOT, HPB_GUIDE_URL, usableNutrient, energyKcalPer100g, nutritionSourceUrl,
  parseIngredientList, disputedPanelEans,
  FREE_SUGAR_RE, SWEETENER_RE, SUGAR_ALCOHOL_RE, GREY_ZONE_SUGAR_RE,
} from './7a-claim-rules.mjs';
import { sweepIngredientEvidence, ANIMAL_TOKEN_RE } from './7b-claim-sweep.mjs';
import { referenceQuantityG } from './departments.config.mjs';

export { ROOT };
export const AGENT_ID = 'agent:p2-11-claims';
export const SCRIPT_VERSION = '1.0.0';
export const SOURCES_PATH = 'runs/p2-11/sources.md';

export const FOOD_REGS_URL = 'https://sso.agc.gov.sg/SL/SFA1973-RG1';
export const EFSA_BARLEY_URL = 'https://efsa.onlinelibrary.wiley.com/doi/pdf/10.2903/j.efsa.2011.2471';
export const EFSA_BARLEY_PMC_URL = 'https://pmc.ncbi.nlm.nih.gov/articles/PMC13093201/';
export const EFSA_OAT_REF = 'EFSA Journal 2010;8(12):1885 (oat beta-glucan, Article 14); EFSA Journal 2009;7(9):1254 (Article 13(1))';

// Breakfast-cereal reference quantity (HPB guide Fig. 6; regulatory research
// §3 9p). The generic heart gate's sodium limb: reference quantity must not
// exceed 25% of the 2000 mg sodium RDA = 500 mg per 60 g.
// P3-02: resolved from the single department config (default = today's 60 g).
export const CEREAL_REFERENCE_QTY_G = referenceQuantityG('Breakfast');
export const SODIUM_RDA_MG = 2000;
export const HEART_SODIUM_LIMIT_MG_PER_REF = 0.25 * SODIUM_RDA_MG; // 500 mg

export const GATE_RULES = {
  'CLM-HEART-GATE': {
    family: 'heart-disease',
    threshold: 'generic heart-disease risk-reduction gate (ALL must hold): low sat fat (<=1.5 g/100g AND <=10% kcal) OR sat-fat-free (<=0.5 g/100g AND trans <=1% of total fat); AND trans fat free (<0.5 g/100g); AND [low sugar (<=5 g/100g or <=2.5 g/100ml) OR sugar free (<=0.5 g/100g) OR unsweetened OR no added sugar] (full disjunctive); AND cholesterol <=100 mg/100g; AND sodium <=25% of the 2000 mg RDA per reference quantity (60 g cereal -> <=500 mg)',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, Appendix II Cardiovascular claim 2, PDF pp59-60 (printed pp58-59); reference quantity Fig. 6; gazetting note §6.3 PDF p21; Food Regulations Reg 9A/9B',
    sourceQuote: 'A healthy diet low in saturated fat and trans fat, may reduce the risk of heart disease. (Name of food) is free of/ low in saturated fats, trans fats. • Low in saturated fat (≤1.5g saturated fat per 100g, and ≤10% of kilocalories from saturated fat) or Free of saturated fat (≤0.5g saturated fat per 100g, and ≤1% of the total fat is trans fat) and • Free of trans fat (<0.5g per 100g) and • Low in sugar (≤5g per 100g or ≤2.5 g per 100ml) or Sugar free (≤0.5g per 100g) or Unsweetened or No added sugar; and • Cholesterol at ≤100mg per 100g and • Its reference quantity should not exceed 25% of sodium RDA, which is taken as 2000mg',
  },
  'CLM-HEART-FIBRE': {
    family: 'fibre-heart',
    threshold: 'wholegrain-fibre heart claim: product from whole grains/fruit/vegetables/fibre-fortified foods; AND low fat (<=3 g/100g or <=1.5 g/100ml) OR fat free (<=0.15 g/100g or 100ml); AND high fibre (>=3 g/100kcal or >=6 g/100g or 100ml); AND >=25% of the dietary fibre comprising soluble fibre',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, Appendix II Cardiovascular claim 3, PDF p60 (printed p59)',
    sourceQuote: 'A healthy diet rich in whole grains, fruits and vegetables that contain dietary fibre, may reduce the risk of heart disease. (Name of food) is low/free of fat and high in dietary fibre. • A product from these food groups - whole grains, fruit, vegetables or fibre fortified foods; and • Low in fat: ≤3g fat per 100g or ≤1.5g fat per 100ml, or Fat free: ≤0.15g fat per 100g or 100ml; and • High in dietary fibre: ≥3g per 100 kcal or ≥6g per 100g or 100ml; and • With at least 25% of the dietary fibre comprising soluble fibre.',
  },
  'CLM-BETAGLUCAN': {
    family: 'betaglucan-cholesterol',
    threshold: 'beta-glucan cholesterol gate (OWN stricter criteria, != generic heart gate): solid — cholesterol <=20 mg/100g; saturated + trans fatty acids COMBINED <=1.5 g/100g; <=10% of kilocalories from sat + trans combined. Liquid — <=10 mg cholesterol/100ml; <=0.75 g sat+trans/100ml; <=10% kcal. PLUS mandatory label information: >=3 g/day barley/oat beta-glucan cholesterol-lowering statement AND NIP declaration of beta-glucan, cholesterol, saturated and trans fatty acid amounts. No sugar limb applies to this gate.',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, Appendix II Cardiovascular claim 5, PDF pp61-63 (printed pp60-62); criteria also §6.3 table PDF pp57-58; EFSA Journal 2011;9(12):2471 (barley) + 2010;8(12):1885 (oat) — international corroboration, jurisdiction-labelled',
    sourceQuote: 'Barley beta-glucans / Oat beta-glucans have been shown to lower/reduce blood cholesterol. High blood cholesterol is a risk factor in the development of coronary heart disease. • The cholesterol, saturated fatty acids and trans fatty acids present in the food must be within the following levels: (iii) in the case of solid food — a. not more than 20 mg of cholesterol per 100 g; b. not more than 1.5 g of saturated fatty acids and c. trans fatty acids per 100 g; and d. not more than 10% of kilocalories from e. saturated fatty acids and trans fatty acids; ... • The following mandatory information must be declared on the product label: a. a statement or statements to the like effect that consumption of at least 3 g of barley beta‑glucans or oat beta-glucans (as the case may be) in a day has been shown to lower blood cholesterol levels; and b. the amounts of barley beta‑glucan or oat beta-glucans (as the case may be), cholesterol, saturated fatty acids and trans fatty acids, present in the food under the nutrition information panel.',
    efsaCorroboration: {
      quote: 'The Panel concludes that a cause and effect relationship has been established between the consumption of barley beta-glucans and lowering of blood LDL-cholesterol concentrations. ... At least 3 g of barley beta-glucans should be consumed per day in order to obtain the claimed effect.',
      source: 'EFSA NDA Panel, EFSA Journal 2011;9(12):2471, doi:10.2903/j.efsa.2011.2471 (abstract verbatim, fetched 2026-11-21T17:28Z)',
      url: EFSA_BARLEY_PMC_URL,
      jurisdiction: 'EU/EFSA — foreign, comparative context only; the SG verdict cites the HPB gazetted criteria',
      oatReference: EFSA_OAT_REF,
    },
  },
  'CLM-HEART-IMPLIED': {
    family: 'heart-implied',
    threshold: 'implied heart-health wording ("heart healthy", "healthy heart", "good for your heart") is NOT a gazetted reduction-of-disease-risk claim wording. New disease-risk claims must be gazetted first (guide §6.3). Grey zone -> REVIEW with the generic heart gate analysis attached; never auto-accused, never published as an accusation (D9 rule 4 resolves grey zones to unverified/withheld).',
    sourceUrl: HPB_GUIDE_URL,
    pageRef: 'HPB Aug-2024 guide, §6.3 PDF p21 (printed p20) gazetting note + Appendix II Cardiovascular claim 2 PDF pp59-60 (gate analysis); Appendix IV implied-claim signs PDF pp66-69; Food Regulations Reg 9A/9B',
    sourceQuote: 'Note: New claims pertaining to reduction of disease risk, must be gazetted in the Food Regulations before businesses may use them on their food products.',
    heuristic: 'implied-wording routing is an engine grey-zone discipline (PRD D5 #1), not a numeric legal threshold',
  },
};

// ---------------------------------------------------------------------------
// Claim extraction — explicit disease-risk wording vs implied wording vs
// beta-glucan presence. Verbatim, with source location (7a convention).
// ---------------------------------------------------------------------------

const GATE_PATTERNS = [
  // Explicit cholesterol-lowering (the gazetted beta-glucan claim's effect).
  { family: 'betaglucan-cholesterol', re: /\b(?:lower(?:s|ing)?|reduce(?:s|d|ing)?)\s+(?:blood\s+)?cholesterol\b|\bcholesterol[\s-]?lowering\b/gi },
  // Explicit heart-disease risk reduction (generic gate wording).
  { family: 'heart-disease', re: /\breduce(?:s|d)?\s+(?:the\s+)?risk\s+of\s+(?:coronary\s+)?heart\s+disease\b/gi },
  // Explicit wholegrain/fibre heart claim (#3) — must mention fibre/wholegrain.
  { family: 'fibre-heart', re: /\b(?:whole[\s-]?grains?|fib(?:re|er))[^.;•]{0,60}reduce(?:s|d)?\s+(?:the\s+)?risk\s+of\s+heart\s+disease\b/gi },
  // Implied heart-health wording — grey zone, REVIEW.
  { family: 'heart-implied', re: /\bheart[\s-]?healthy\b|\bhealthy\s+heart\b|\bgood\s+for\s+(?:your\s+)?heart\b|\bheart[\s-]?smart\b/gi },
  // Beta-glucan PRESENCE only (no disease wording) — informational, no gate.
  { family: 'betaglucan-presence', re: /\b(?:contains?|with|source\s+of)\s+beta[\s-]?glucans?\b/gi },
];

const SOURCE_PRIORITY = { 'pack-photo-ocr': 3, 'marketing-copy': 2, 'key-information': 2, name: 1 };

function sentenceAround(text, index) {
  const start = Math.max(text.lastIndexOf('.', index) + 1, text.lastIndexOf('•', index) + 1, text.lastIndexOf(';', index) + 1, 0);
  let end = text.length;
  for (const sep of ['.', '•', ';']) {
    const i = text.indexOf(sep, index);
    if (i >= 0 && i < end) end = i;
  }
  return text.slice(start, end).trim();
}

export function extractGateClaims(product, sheetRow) {
  const sources = [{ location: 'product name (retailer listing)', text: product.name, sourceUrl: product?.offers?.[0]?.sourceUrl ?? null, priority: 1 }];
  for (const e of sheetRow?.evidence ?? []) {
    if (['marketing-copy', 'pack-photo-ocr', 'key-information'].includes(e.type) && e.quote) {
      sources.push({ location: `classification sheet evidence [${e.type}]`, text: e.quote, sourceUrl: e.sourceUrl ?? null, priority: SOURCE_PRIORITY[e.type] ?? 2, ocrRecord: e.ocrRecord ?? null });
    }
  }
  const byFamily = new Map();
  for (const src of sources) {
    for (const { family, re } of GATE_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src.text)) !== null) {
        // "cholesterol free" / "naturally cholesterol free" are nutrient-content
        // claims owned by CLM-CHOLFREE (7b) — never disease-risk lowering claims.
        if (family === 'betaglucan-cholesterol' && /free/i.test(src.text.slice(m.index, m.index + m[0].length + 6))) continue;
        const claim = {
          family,
          quotedClaim: m[0].trim(),
          claimSource: { location: src.location, contextQuote: src.text, sourceUrl: src.sourceUrl, ocrRecord: src.ocrRecord ?? undefined },
          sentence: sentenceAround(src.text, m.index),
          priority: src.priority,
        };
        const prev = byFamily.get(family);
        if (!prev || claim.priority > prev.priority) byFamily.set(family, claim);
      }
    }
  }
  // An explicit fibre-heart wording supersedes the generic heart-disease match
  // on the same sentence (per-family criteria, never double-gated).
  if (byFamily.has('fibre-heart') && byFamily.has('heart-disease')) {
    const fh = byFamily.get('fibre-heart');
    const hd = byFamily.get('heart-disease');
    if (fh.sentence === hd.sentence) byFamily.delete('heart-disease');
  }
  return [...byFamily.values()];
}

// ---------------------------------------------------------------------------
// Condition evaluators — pass / fail / gap, each with cited evidence.
// A GAP is never a silent pass and never an accusation (grey-zone discipline).
// ---------------------------------------------------------------------------

const cond = (condition, status, detail, extra = {}) => ({ condition, status, detail, ...extra });

function nutrientCond(product, key, label, limit, comparator, unitSuffix = 'g/100g') {
  const n = usableNutrient(product, key);
  if (!n) return cond(label, 'gap', `no usable per-100g ${key} value (missing or non-scoreable provenance tier) — not evaluable from the evidence we hold`);
  const ok = comparator === '<=' ? n.value <= limit : n.value < limit;
  return cond(label, ok ? 'pass' : 'fail', `${key} ${n.value} ${n.unit}/100g ${ok ? (comparator === '<=' ? '≤' : '<') : (comparator === '<=' ? '>' : '≥')} ${limit} ${unitSuffix}`, { value: n.value, unit: n.unit, provenanceTier: n.provenanceTier, sourceUrl: nutritionSourceUrl(product, n.provenanceTier) });
}

// Cholesterol: declared value, else the solely-plant source branch (7b
// CLM-CHOLFREE precedent: plant-only list -> 0 mg implicit, labelled).
function cholesterolCond(product, ing, parsed, limitMg) {
  const declared = usableNutrient(product, 'cholesterol');
  if (declared) {
    const ok = declared.value <= limitMg;
    return cond(`cholesterol ≤${limitMg} mg/100g`, ok ? 'pass' : 'fail', `cholesterol ${declared.value} mg/100g ${ok ? '≤' : '>'} ${limitMg} mg/100g`, { value: declared.value, unit: 'mg', provenanceTier: declared.provenanceTier, sourceUrl: nutritionSourceUrl(product, declared.provenanceTier) });
  }
  if (!ing.usable) return cond(`cholesterol ≤${limitMg} mg/100g`, 'gap', 'no cholesterol value published and ingredient list not usable — plant-source branch not verifiable');
  const animal = parsed.flat.find((t) => ANIMAL_TOKEN_RE.test(t.raw));
  if (animal) {
    const matched = animal.raw.match(ANIMAL_TOKEN_RE)[0];
    const tokenQuote = animal.raw.length > 90 ? animal.raw.slice(0, 90) + '…' : animal.raw;
    return cond(`cholesterol ≤${limitMg} mg/100g`, 'gap', `no cholesterol value published; animal-derived ingredient declared ("${matched}" within the declared token "${tokenQuote}") — the solely-plant 0 mg branch does not apply and ≤${limitMg} mg is not verifiable`);
  }
  return cond(`cholesterol ≤${limitMg} mg/100g`, 'pass', `no cholesterol value published; declared ingredients are solely plant-derived ("${ing.text.slice(0, 120)}${ing.text.length > 120 ? '…' : ''}") — 0 mg cholesterol implicit via the plant-source branch (CLM-CHOLFREE precedent, labelled assumption)`, { plantSourceBranch: true });
}

// FULL DISJUNCTIVE sugar limb: low sugar OR sugar free OR unsweetened OR
// no added sugar. Any passing branch satisfies the limb; the passing branch
// is recorded. Grey-zone ingredients (T21 maltodextrin/puree) make the
// ingredient-based branches grey, never an automatic fail.
export function sugarDisjunctiveCond(product, ing, parsed) {
  const label = 'sugar limb (low sugar OR sugar free OR unsweetened OR no added sugar)';
  const sugars = usableNutrient(product, 'sugars');
  const branches = [];
  if (sugars) {
    if (sugars.value <= 0.5) branches.push({ branch: 'sugar free', ok: true, detail: `sugars ${sugars.value} g/100g ≤ 0.5 g/100g` });
    else if (sugars.value <= 5) branches.push({ branch: 'low sugar', ok: true, detail: `sugars ${sugars.value} g/100g ≤ 5 g/100g` });
    else branches.push({ branch: 'low sugar / sugar free', ok: false, detail: `sugars ${sugars.value} g/100g > 5 g/100g (and > 0.5 g/100g)` });
  }
  if (ing.usable) {
    const offenders = parsed.flat.filter((t) => FREE_SUGAR_RE.test(t.raw));
    const grey = parsed.flat.filter((t) => GREY_ZONE_SUGAR_RE.test(t.raw));
    const sweet = parsed.flat.filter((t) => SWEETENER_RE.test(t.raw) || SUGAR_ALCOHOL_RE.test(t.raw));
    if (!offenders.length && !grey.length) {
      branches.push({ branch: 'no added sugar', ok: true, detail: `no free-sugar ingredient in the declared list${sweet.length ? ` (sweeteners/sugar alcohols permitted under the HPB exception clause: "${sweet[0].raw}")` : ''}` });
      if (!sweet.length) branches.push({ branch: 'unsweetened', ok: true, detail: 'no free sugars, sweetening substances or sugar alcohols in the declared list' });
      else branches.push({ branch: 'unsweetened', ok: false, detail: `sweetening substance/sugar alcohol present ("${sweet[0].raw}") — banned under unsweetened` });
    } else if (offenders.length) {
      branches.push({ branch: 'no added sugar / unsweetened', ok: false, detail: `free-sugar ingredient declared: "${offenders[0].raw}" (HPB free-sugars definition: honey/malt/malt extract/juice concentrate/syrups/sugar)` });
    } else {
      branches.push({ branch: 'no added sugar / unsweetened', ok: null, detail: `grey-zone ingredient "${grey[0].raw}" (T21: maltodextrin is a polysaccharide, fruit puree not explicitly listed) — technically defensible, founder adjudication; never an automatic fail` });
    }
  }
  if (!branches.length) return cond(label, 'gap', 'no usable sugars value and no usable ingredient list — the disjunctive sugar limb is not evaluable');
  const pass = branches.find((b) => b.ok === true);
  if (pass) return cond(label, 'pass', `DISJUNCTIVE limb satisfied via "${pass.branch}": ${pass.detail}`, { branches, sugars: sugars ? { value: sugars.value, unit: sugars.unit, provenanceTier: sugars.provenanceTier, sourceUrl: nutritionSourceUrl(product, sugars.provenanceTier) } : null });
  const anyGrey = branches.some((b) => b.ok === null) || !sugars || !ing.usable;
  const detail = branches.map((b) => `[${b.branch}] ${b.ok === false ? 'FAILS' : b.ok === null ? 'GREY' : 'passes'}: ${b.detail}`).join(' | ');
  return cond(label, anyGrey ? 'gap' : 'fail', `ALL evaluable branches fail${anyGrey ? ' (with grey/missing legs — routed to review, never auto-accused)' : ''}: ${detail}`, { branches, sugars: sugars ? { value: sugars.value, unit: sugars.unit, provenanceTier: sugars.provenanceTier, sourceUrl: nutritionSourceUrl(product, sugars.provenanceTier) } : null });
}

function overall(conditions) {
  if (conditions.some((c) => c.status === 'fail')) return 'fail';
  if (conditions.some((c) => c.status === 'gap')) return 'gap';
  return 'pass';
}

// Generic heart gate — Appendix II Cardiovascular #2.
export function evalGenericHeartGate(product, ing, parsed) {
  const sat = usableNutrient(product, 'saturated_fat');
  const trans = usableNutrient(product, 'trans_fat');
  const fat = usableNutrient(product, 'fat');
  const kcal = energyKcalPer100g(product);
  const conditions = [];
  // sat-fat limb: low (<=1.5 AND <=10% kcal) OR free (<=0.5 AND trans <=1% fat)
  if (!sat) {
    conditions.push(cond('low sat fat OR sat-fat-free', 'gap', 'no usable saturated-fat value — limb not evaluable'));
  } else {
    const energyPct = kcal ? (sat.value * 9 / kcal.value) * 100 : null;
    const low = sat.value <= 1.5 && energyPct !== null && energyPct <= 10;
    const transPctOfFat = trans && fat && fat.value > 0 ? (trans.value / fat.value) * 100 : null;
    const free = sat.value <= 0.5 && transPctOfFat !== null && transPctOfFat <= 1;
    const detail = `saturated fat ${sat.value} g/100g (low limb ≤1.5 g${energyPct !== null ? ` AND ${energyPct.toFixed(1)}% kcal ≤10%` : ', energy share not computable (kcal gap)'})${free || sat.value <= 0.5 ? `; free limb ≤0.5 g${transPctOfFat !== null ? ` AND trans ${transPctOfFat.toFixed(2)}% of total fat ≤1%` : ' (trans/fat basis gap)'}` : ''}`;
    conditions.push(cond('low sat fat OR sat-fat-free', low || free ? 'pass' : (energyPct === null && sat.value <= 1.5 ? 'gap' : 'fail'), detail, { value: sat.value, unit: 'g', provenanceTier: sat.provenanceTier, sourceUrl: nutritionSourceUrl(product, sat.provenanceTier) }));
  }
  // trans-fat-free limb (strict <0.5)
  conditions.push(trans ? nutrientCond(product, 'trans_fat', 'trans fat free (<0.5 g/100g)', 0.5, '<') : cond('trans fat free (<0.5 g/100g)', 'gap', 'no trans-fat value published in the catalogue — <0.5 g/100g criterion not verifiable'));
  // FULL disjunctive sugar limb
  conditions.push(sugarDisjunctiveCond(product, ing, parsed));
  // cholesterol <=100 mg/100g
  conditions.push(cholesterolCond(product, ing, parsed, 100));
  // sodium <=25% RDA per the department reference quantity (config lookup)
  const sodium = usableNutrient(product, 'sodium');
  if (!sodium) {
    conditions.push(cond(`sodium ≤25% of 2000 mg RDA per ${CEREAL_REFERENCE_QTY_G} g reference quantity`, 'gap', 'no usable sodium value — limb not evaluable'));
  } else {
    const perRef = Math.round(sodium.value * CEREAL_REFERENCE_QTY_G / 100 * 100) / 100;
    const ok = perRef <= HEART_SODIUM_LIMIT_MG_PER_REF;
    conditions.push(cond(`sodium ≤25% of 2000 mg RDA per ${CEREAL_REFERENCE_QTY_G} g reference quantity`, ok ? 'pass' : 'fail', `sodium ${sodium.value} mg/100g × ${CEREAL_REFERENCE_QTY_G} g reference quantity = ${perRef} mg ${ok ? '≤' : '>'} 500 mg (25% of the 2000 mg RDA)`, { value: sodium.value, unit: 'mg', provenanceTier: sodium.provenanceTier, perReferenceQtyMg: perRef, sourceUrl: nutritionSourceUrl(product, sodium.provenanceTier) }));
  }
  return { gate: 'CLM-HEART-GATE', conditions, result: overall(conditions) };
}

// Beta-glucan cholesterol gate — Appendix II Cardiovascular #5. STRICTER and
// DISTINCT from the generic heart gate: cholesterol <=20 mg (not <=100),
// sat+trans COMBINED <=1.5 g, <=10% kcal from the combined sat+trans, plus
// mandatory label statements. No sugar limb.
export function evalBetaGlucanGate(product, ing, parsed, sheetRow) {
  const conditions = [];
  conditions.push(cholesterolCond(product, ing, parsed, 20));
  const sat = usableNutrient(product, 'saturated_fat');
  const trans = usableNutrient(product, 'trans_fat');
  const kcal = energyKcalPer100g(product);
  if (!sat) {
    conditions.push(cond('saturated + trans fatty acids COMBINED ≤1.5 g/100g', 'gap', 'no usable saturated-fat value — combined limb not evaluable'));
    conditions.push(cond('≤10% of kilocalories from saturated + trans fatty acids', 'gap', 'no usable saturated-fat value — energy-share limb not evaluable'));
  } else {
    if (trans) {
      const combined = Math.round((sat.value + trans.value) * 10000) / 10000;
      const ok = combined <= 1.5;
      conditions.push(cond('saturated + trans fatty acids COMBINED ≤1.5 g/100g', ok ? 'pass' : 'fail', `saturated fat ${sat.value} g + trans fat ${trans.value} g = ${combined} g/100g ${ok ? '≤' : '>'} 1.5 g/100g (COMBINED criterion — stricter than the generic heart gate's sat-fat-alone limb)`, { value: combined, unit: 'g', provenanceTier: sat.provenanceTier, sourceUrl: nutritionSourceUrl(product, sat.provenanceTier) }));
    } else if (sat.value > 1.5) {
      conditions.push(cond('saturated + trans fatty acids COMBINED ≤1.5 g/100g', 'fail', `saturated fat ${sat.value} g/100g alone EXCEEDS the 1.5 g/100g combined limit; trans fat ≥ 0 can only add — the combined criterion fails regardless of the missing trans-fat value (robust fail)`, { value: sat.value, unit: 'g', provenanceTier: sat.provenanceTier, transFatMissing: true, sourceUrl: nutritionSourceUrl(product, sat.provenanceTier) }));
    } else {
      conditions.push(cond('saturated + trans fatty acids COMBINED ≤1.5 g/100g', 'gap', `saturated fat ${sat.value} g/100g ≤ 1.5 g but trans fat is not published — the COMBINED total is not verifiable (never a silent pass)`));
    }
    if (kcal && trans) {
      const pct = ((sat.value + trans.value) * 9 / kcal.value) * 100;
      const ok = pct <= 10;
      conditions.push(cond('≤10% of kilocalories from saturated + trans fatty acids', ok ? 'pass' : 'fail', `(sat ${sat.value} g + trans ${trans.value} g) × 9 kcal/g ÷ ${Math.round(kcal.value * 10) / 10} kcal/100g = ${pct.toFixed(1)}% ${ok ? '≤' : '>'} 10%`, { value: Math.round(pct * 100) / 100, unit: '%', provenanceTier: sat.provenanceTier }));
    } else if (kcal && sat.value * 9 / kcal.value * 100 > 10) {
      const pct = (sat.value * 9 / kcal.value) * 100;
      conditions.push(cond('≤10% of kilocalories from saturated + trans fatty acids', 'fail', `saturated fat alone contributes ${pct.toFixed(1)}% of energy (> 10%); trans fat ≥ 0 can only add — robust fail`, { value: Math.round(pct * 100) / 100, unit: '%', provenanceTier: sat.provenanceTier }));
    } else {
      conditions.push(cond('≤10% of kilocalories from saturated + trans fatty acids', 'gap', `${!kcal ? 'no usable energy value' : 'trans fat not published'} — combined energy share not verifiable`));
    }
  }
  // Mandatory label information (partial pack panels in our data -> gap, never
  // an accusation on absence alone).
  const texts = [product?.name ?? '', ...(sheetRow?.evidence ?? []).map((e) => e.quote ?? '')];
  const has3gStatement = texts.some((t) => /(?:at\s+least\s+)?3\s*g[^.;•]{0,60}beta[\s-]?glucan|beta[\s-]?glucan[^.;•]{0,60}3\s*g/i.test(t) && /day|daily|per\s+day/i.test(t));
  const hasNipBetaGlucan = product?.nutrition?.per100g?.beta_glucan != null || texts.some((t) => /beta[\s-]?glucan[^.;•]{0,30}\d+(?:\.\d+)?\s*g/i.test(t));
  conditions.push(cond('mandatory label information (≥3 g/day beta-glucan statement + NIP beta-glucan/cholesterol/sat/trans amounts)', has3gStatement && hasNipBetaGlucan ? 'pass' : 'gap', `${has3gStatement ? '≥3 g/day statement found' : 'no ≥3 g/day beta-glucan cholesterol-lowering statement in the evidence we hold'}; ${hasNipBetaGlucan ? 'beta-glucan amount declared' : 'no beta-glucan amount in the NIP data we hold'} — pack panels in our data are partial; absence is a verification gap, not an accusation`));
  return { gate: 'CLM-BETAGLUCAN', conditions, result: overall(conditions) };
}

// Wholegrain-fibre heart claim — Appendix II Cardiovascular #3.
export function evalFibreHeartGate(product, ing, parsed) {
  const conditions = [];
  const fat = usableNutrient(product, 'fat');
  if (!fat) conditions.push(cond('low fat (≤3 g/100g) OR fat free (≤0.15 g/100g)', 'gap', 'no usable fat value'));
  else {
    const ok = fat.value <= 3;
    conditions.push(cond('low fat (≤3 g/100g) OR fat free (≤0.15 g/100g)', ok ? 'pass' : 'fail', `fat ${fat.value} g/100g ${ok ? '≤' : '>'} 3 g/100g`, { value: fat.value, unit: 'g', provenanceTier: fat.provenanceTier, sourceUrl: nutritionSourceUrl(product, fat.provenanceTier) }));
  }
  const fibre = usableNutrient(product, 'fibre');
  const kcal = energyKcalPer100g(product);
  if (!fibre) conditions.push(cond('high fibre (≥6 g/100g or ≥3 g/100kcal)', 'gap', 'no usable fibre value'));
  else {
    const per100kcal = kcal ? (fibre.value / kcal.value) * 100 : null;
    const ok = fibre.value >= 6 || (per100kcal !== null && per100kcal >= 3);
    conditions.push(cond('high fibre (≥6 g/100g or ≥3 g/100kcal)', ok ? 'pass' : 'fail', `fibre ${fibre.value} g/100g${per100kcal !== null ? ` (${per100kcal.toFixed(2)} g/100kcal)` : ''} ${ok ? 'meets' : 'fails'} ≥6 g/100g or ≥3 g/100kcal`, { value: fibre.value, unit: 'g', provenanceTier: fibre.provenanceTier, sourceUrl: nutritionSourceUrl(product, fibre.provenanceTier) }));
  }
  conditions.push(cond('≥25% of the dietary fibre comprising soluble fibre', 'gap', 'soluble-fibre share is not declared in any panel we hold — not verifiable (never a silent pass, never an accusation on absence alone)'));
  const wg = ing.usable ? parsed.flat.some((t) => t.wholegrain) : false;
  conditions.push(cond('product from whole grains / fruit / vegetables / fibre-fortified foods', wg ? 'pass' : 'gap', wg ? 'wholegrain ingredient declared' : 'food-group eligibility not verifiable from the evidence we hold'));
  return { gate: 'CLM-HEART-FIBRE', conditions, result: overall(conditions) };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

function gateFinding(claim, product, ruleId, verdict, confidence, gateEval, notes) {
  const rule = GATE_RULES[ruleId];
  const failing = gateEval.conditions.filter((c) => c.status === 'fail');
  const headline = failing[0] ?? gateEval.conditions.find((c) => c.status === 'gap') ?? gateEval.conditions[0];
  return {
    ean: product.ean,
    productName: product.name,
    productPageUrl: product?.offers?.[0]?.sourceUrl ?? null,
    ruleId,
    claimFamily: claim.family,
    quotedClaim: claim.quotedClaim,
    claimSource: claim.claimSource,
    evidence: {
      kind: 'gate-analysis',
      gate: gateEval.gate,
      gateResult: gateEval.result,
      conditions: gateEval.conditions,
      headline: headline.detail,
      detail: `${claim.family === 'heart-implied' ? 'IMPLIED wording (not gazetted) — generic heart gate analysis' : 'Explicit disease-risk claim — per-family gate analysis'}: ${gateEval.result.toUpperCase()}${failing.length ? `; failing condition(s): ${failing.map((c) => c.condition).join('; ')}` : ''}`,
      sourceUrl: headline.sourceUrl ?? product?.offers?.[0]?.sourceUrl ?? null,
    },
    threshold: { rule: rule.threshold, sourceUrl: rule.sourceUrl, sourceQuote: rule.sourceQuote, pageRef: rule.pageRef, heuristic: rule.heuristic ?? undefined },
    verdict,
    confidence,
    notes,
    layer: 'p2-11',
  };
}

function gateUncheckable(claim, product, reason) {
  return { ean: product.ean, productName: product.name, claimFamily: claim.family, ruleId: FAMILY_RULE[claim.family], quotedClaim: claim.quotedClaim, claimSource: claim.claimSource, reason, layer: 'p2-11' };
}

const FAMILY_RULE = {
  'heart-disease': 'CLM-HEART-GATE',
  'fibre-heart': 'CLM-HEART-FIBRE',
  'betaglucan-cholesterol': 'CLM-BETAGLUCAN',
  'heart-implied': 'CLM-HEART-IMPLIED',
  'betaglucan-presence': 'CLM-BETAGLUCAN',
};

const GREY_NOTES = [
  'Grey-zone discipline (PRD stories 39/52; D9 rule 4): REVIEW verdicts are founder-adjudication material — never queued, never published as an accusation. The D9 auto-gate resolves grey zones to "unverified"/"withheld".',
  'HPB guide criteria are guidance (post-market surveillance); disease-risk claims must also be gazetted (Food Regulations Reg 9A/9B; guide §6.3). Guide-criteria findings never overstate legal force (trap T23).',
];

export function checkGateClaim(claim, product, ctx) {
  const { ing, parsed, sheetRow, disputed } = ctx;
  if (claim.family === 'betaglucan-presence') {
    return {
      kind: 'informational', ean: product.ean, productName: product.name, ruleId: 'CLM-BETAGLUCAN',
      quotedClaim: claim.quotedClaim, claimSource: claim.claimSource, layer: 'p2-11',
      note: 'Beta-glucan PRESENCE claim ("contains/with beta-glucan") with no disease-risk wording — no gate applies. Oats/barley naturally contain beta-glucan; no SG numeric criterion exists for a bare presence claim. Informational only, never queued. The cholesterol-lowering gate (CLM-BETAGLUCAN) applies only to explicit lowering/reduction wording.',
    };
  }
  if (disputed && claim.family !== 'heart-implied') {
    return gateUncheckable(claim, product, 'nutrition panel under a definitive plausibility dispute (slice-6 data-flag) — no nutrient-based gate accusation until founder adjudication');
  }
  if (claim.family === 'heart-implied') {
    const gateEval = evalGenericHeartGate(product, ing, parsed);
    return gateFinding(claim, product, 'CLM-HEART-IMPLIED', 'review', 'medium', gateEval, [
      `"${claim.quotedClaim}" is IMPLIED heart-health wording, not a gazetted reduction-of-disease-risk claim wording (HPB guide §6.3: new disease-risk claims must be gazetted first). Routed to REVIEW — never auto-accused (PRD D5 #1).`,
      `Generic heart gate analysis attached for founder adjudication: ${gateEval.result.toUpperCase()}. ${gateEval.result === 'fail' ? 'The gate would bar a gazetted heart-disease claim on this composition — the founder decides whether the implied wording warrants a flag.' : gateEval.result === 'gap' ? 'Some gate conditions are not evaluable from the evidence we hold.' : 'The composition would satisfy the generic heart gate.'}`,
      ...GREY_NOTES,
    ]);
  }
  const gateEval = claim.family === 'betaglucan-cholesterol' ? evalBetaGlucanGate(product, ing, parsed, sheetRow)
    : claim.family === 'fibre-heart' ? evalFibreHeartGate(product, ing, parsed)
      : evalGenericHeartGate(product, ing, parsed);
  const ruleId = FAMILY_RULE[claim.family];
  if (gateEval.result === 'fail') {
    const failing = gateEval.conditions.filter((c) => c.status === 'fail');
    const robust = failing.every((c) => c.transFatMissing !== true);
    const tierMedium = failing.some((c) => c.provenanceTier === 'estimated-derived');
    return gateFinding(claim, product, ruleId, 'contradicted', tierMedium || !robust ? 'medium' : 'high', gateEval, [
      `Explicit disease-risk-reduction claim; the per-family compositional gate FAILS: ${failing.map((c) => c.detail).join(' | ')}`,
      claim.family === 'betaglucan-cholesterol' ? 'Beta-glucan gate criteria are STRICTER than and distinct from the generic heart gate (cholesterol ≤20 mg/100g vs ≤100; sat+trans COMBINED ≤1.5 g/100g; mandatory ≥3 g/day statement + NIP declarations). EFSA 2011;9(12):2471 / 2010;8(12):1885 corroborate the 3 g/day science (EU jurisdiction, context only).' : 'Per-family gate criteria applied (never a universal nutrient-profile gate — SG has none; regulatory research §5).',
      'Factual claim-accuracy finding, not a safety accusation: the composition is what it is; the disease-risk claim is barred by the gazetted gate criteria.',
      ...GREY_NOTES,
    ]);
  }
  if (gateEval.result === 'gap') {
    return gateFinding(claim, product, ruleId, 'review', 'medium', gateEval, [
      'Explicit disease-risk claim, but one or more gate conditions are not evaluable from the evidence we hold (gaps listed in the analysis) — routed to REVIEW, never auto-accused and never a silent ok.',
      ...GREY_NOTES,
    ]);
  }
  return gateFinding(claim, product, ruleId, 'ok', 'medium', gateEval, [
    'All evaluable gate conditions pass on the evidence we hold (labelled assumptions recorded in the analysis).',
    ...GREY_NOTES,
  ]);
}

// ---------------------------------------------------------------------------
// Dry-run over the catalogue
// ---------------------------------------------------------------------------

export function runGates({ catalogue, sheet, pendingItems = [] }) {
  const sheetByEan = new Map((sheet?.rows ?? []).map((r) => [String(r.ean), r]));
  const disputed = disputedPanelEans(pendingItems);
  const findings = [];
  const uncheckable = [];
  const informational = [];
  let claimsExtracted = 0;
  for (const product of catalogue.products) {
    const sheetRow = sheetByEan.get(String(product.ean));
    const claims = extractGateClaims(product, sheetRow);
    claimsExtracted += claims.length;
    if (!claims.length) continue;
    const ing = sweepIngredientEvidence(product, sheetRow);
    const parsed = ing.usable ? parseIngredientList(ing.text) : { top: [], flat: [], first: null };
    const ctx = { ing, parsed, sheetRow, disputed: disputed.has(String(product.ean)) };
    for (const claim of claims) {
      const result = checkGateClaim(claim, product, ctx);
      if (result.kind === 'informational') informational.push(result);
      else if (result.verdict) findings.push(result);
      else uncheckable.push(result);
    }
  }
  const counts = {
    products: catalogue.products.length,
    claimsExtracted,
    findings: findings.length,
    contradicted: findings.filter((f) => f.verdict === 'contradicted').length,
    review: findings.filter((f) => f.verdict === 'review').length,
    ok: findings.filter((f) => f.verdict === 'ok').length,
    uncheckable: uncheckable.length,
    informational: informational.length,
  };
  return { findings, uncheckable, informational, counts };
}