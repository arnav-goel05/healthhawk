#!/usr/bin/env node
// HealthHawk compare-app projection builder — slice 1 stage C. Zero deps.
// Builds app/data.json (the PUBLIC projection) from data/catalogue.json and
// inlines it into app/index.html so the app works fully static (file:// safe;
// relative fetch('data.json') is the fallback when the inline block is absent).
//
// Honesty rules baked into the projection:
// - No fabricated values: every nutrition/offer number is copied verbatim from
//   the catalogue (with its provenance tier). Missing stays missing (null).
// - Approval gate: a grade is projected ONLY when record.rated === true AND a
//   score exists. A computed-but-unapproved score never leaks into the public
//   projection — the row shows grey "Not yet rated" with an honest reason.
// - No score internals (points/H/V/S) in the public projection.
// - Own-brand "Hawk Grade" + algorithm attribution; never official marks.
// - ODbL attribution for OFF data carried through to the detail footer.
// - Slice 4: the hand-classified sheet (data/classification/sheet.json) joins
//   by EAN at build time — READ-ONLY. Chips filter by range; ranking is
//   range-scoped (never crosses ranges); the sheet is never written here.
// - Merge-04b (wave 4 stage B): approved-only claim flags (pending/ approval +
//   sheet detectorFlagIds publication contract) project as evidence cards +
//   worst-flag row badges; safety tags (Halal/allergen/PAL) precede badges;
//   additive decode ("What's inside") with dose context ONLY on flagged
//   additives; dual-store offer display with honest "not carried" states.
//   Read-only inputs: data/claims/findings.json, data/additives/*.json.
// - Slice 3b: three one-tap presets (Best value w=0.3 · Balanced w=0.5
//   DEFAULT · Healthiest w=0.8) reorder the list via the scoring engine
//   (rankProducts). The projection carries ORDER ONLY (EAN lists per
//   range×preset) — never per-product score internals. p_min is fixed per
//   range against the FULL catalogue at build time (engine rangeMinPrice),
//   so chips/filters can never re-price the remaining products.
//
// Usage: node scripts/build-app.mjs

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { GRADE_DISPLAY_NAME, GRADE_ATTRIBUTION, PRESETS, rankProducts, rangeMinPrice, offerInStock } from './score.mjs';
import { isMain } from './is-main.mjs';
import { sha256 as parserTextSha256 } from './p2-parser-lib.mjs';
import { loadSheet, joinSheet, RANGE_ORDER } from './4-classify.mjs';
// P3-02: the single department-config seam — meta.departments / meta.chips /
// meta.rangeLabels / meta.rangeOrder are projected from here (the client
// renders from the projected meta; no hardcoded chip/range copies anywhere).
import { DEPARTMENTS, departmentIdsWithData, departmentMetaFor, chipsFor, rangeLabelsFor, rangeOrderFor } from './departments.config.mjs';
import { deriveDietary, passesFilters, SFA_ALLERGENS, ADDITIONAL_ALLERGENS, PRICE_BUCKETS, NUT_KEYS } from './9-lib.mjs';
import { UNVERIFIED_NOTE } from './p2-claim-unverified.mjs';

// P2-11: the "unverified" verdict renders DISTINCTLY (grey, icon+word) and is
// NEVER phrased as false. Same note text as the rule layer (single source).
export const UNVERIFIED_RENDER_NOTE = UNVERIFIED_NOTE;

export const DISCLAIMER = 'Within-category comparison, not medical advice.';
export const SUGAR_GRAMS_PER_TEASPOON = 5; // HPB convention
export const DATA_START = '/*__DATA_START__*/';
export const DATA_END = '/*__DATA_END__*/';
// P3-03: canonical design tokens (app/tokens.css, source: docs/design-tokens.md)
// are injected into the app's style region between these markers — the served
// single-file app carries the tokens. NEVER hand-edit the inline token block;
// always regenerate via this build (same discipline as the inline data block).
export const TOKENS_START = '/*__TOKENS_START__*/';
export const TOKENS_END = '/*__TOKENS_END__*/';

// Scope the canonical :root variables under the app wrapper so no global
// selector escapes into the site shell (P3-03 CSS-scoping contract).
export function scopeTokensCss(css, wrapper = '.hh-app') {
  return css.replace(/:root\b/g, wrapper);
}

export function injectTokens(html, tokensCss) {
  const start = html.indexOf(TOKENS_START);
  const end = html.indexOf(TOKENS_END);
  if (start < 0 || end < 0 || end < start) throw new Error(`inline-tokens markers missing (${TOKENS_START} … ${TOKENS_END})`);
  return html.slice(0, start + TOKENS_START.length) + '\n' + tokensCss + '\n' + html.slice(end);
}

// Merge-04b (wave 4 stage B): store display labels. Raw store ids stay
// verbatim in the projection (pinned contract); the UI normalizes display.
export const STORE_ORDER = ['FairPrice', 'ColdStorage'];
export const STORE_LABELS = { FairPrice: 'FairPrice', ColdStorage: 'Cold Storage' };
export const INGREDIENT_COLLAPSE_AFTER = 5; // 08 AC: collapsed after 5, full list one tap

// ---------------------------------------------------------------------------
// Slice 10: client-side fuzzy search (Fuse.js vendored at app/fuse.min.js,
// Apache-2.0, NO runtime CDN). ~50-entry synonym map: Malay/Chinese local
// wording, brand shorthand, common misspellings, product-family aliases.
// The client expands the query through this map and unions Fuse matches;
// display order ALWAYS stays the engine's range-scoped preset order (search
// removes rows, never reorders or re-prices — V filter-invariance preserved).
// ---------------------------------------------------------------------------
export const SEARCH_THRESHOLD = 0.3;
export const SEARCH_SYNONYMS = {
  // Malay / Chinese local wording
  'bijirin': 'cereal',
  'bijirin sarapan': 'breakfast cereal',
  'sarapan': 'breakfast cereal',
  '燕麦': 'oats',
  '麦片': 'cereal oats',
  '玉米片': 'corn flakes',
  '谷物': 'cereal',
  '早餐': 'breakfast cereal',
  '糙米': 'brown rice',
  '蜂蜜': 'honey',
  '巧克力': 'chocolate',
  'gandum': 'wheat',
  'barli': 'barley',
  'beras perang': 'brown rice',
  'madu': 'honey',
  'coklat': 'chocolate',
  'sihat': 'healthier',
  // product families / natural wording
  'oats': 'rolled oats',
  'oatmeal': 'oats instant oatmeal',
  'rolled oats': 'oats',
  'porridge': 'oatmeal instant',
  'instant cereal': 'instant oatmeal 3-in-1',
  '3in1': '3-in-1 nestum',
  '3 in 1': '3-in-1 nestum',
  'kids cereal': 'kids',
  'children cereal': 'kids',
  'baby cereal': 'kids',
  'wholegrain': 'whole grain',
  'whole grain': 'wholegrain',
  'no sugar': 'no added sugar',
  'sugar free': 'no added sugar',
  'breakfast': 'cereal',
  'cereal drink': 'nestum cereal milk drink',
  'milk drink': 'nestum cereal drink',
  // brand shorthand + common misspellings
  'kelloggs': "kellogg's",
  'kellogs': "kellogg's",
  'kellogg': "kellogg's",
  'nestle': 'nestlé nestle',
  'weetbix': 'weet-bix',
  'weet bix': 'weet-bix',
  'weetabix': 'weetabix protein',
  'cornflakes': 'corn flakes',
  'corn flakes': 'cornflakes',
  'cornflaks': 'corn flakes',
  'cocopops': 'coco pops',
  'koko krunch': 'koko krunch koko crunch',
  'honey bunches': 'honey bunches of oats',
  'nutremill': 'nutremill super nutremill',
  'bob red mill': "bob's red mill",
  'bobs red mill': "bob's red mill",
  'amazin graze': "amazin'graze",
  'amazingraze': "amazin'graze",
  'vogels': "vogel's",
  'lizis': "lizi's",
};

// ---------------------------------------------------------------------------
// Slice 10/12 contract: stale-price state. Slice 12 (publish-sync freeze)
// writes runs/stale-state.json; the build READS it if present and projects it
// verbatim into meta.stale. Shape: { freeze: boolean, blockedAt: ISO string,
// reason?: string, staleEans?: string[] | null } — freeze=true with staleEans
// null/absent means the WHOLE catalogue's prices are stale; a non-empty
// staleEans array scopes the per-row badge. An EMPTY array normalizes to null
// (unscoped = whole catalogue; fix round, review issue 3 — a freeze with no
// explicit scope applies to every price, never "badge nothing").
// blockedAt must parse as a date; garbage normalizes to null and the banner
// honestly omits "since" — never "Invalid Date" on a public surface.
// The app shows a banner + per-row "price stale" badges and keeps every
// honest "last good" priceCheckedAt timestamp. Absent file -> meta.stale null
// -> no banner, no badges (normal state).
// CORRUPT/PARTIAL JSON (slice 12 writes non-atomically): try/catch -> null +
// a build diagnostic — the rebuild is never blocked by a truncated file, and
// a half-written state is never guessed into a freeze (fix round, issue 2).
// ---------------------------------------------------------------------------
export function normalizeStaleState(s) {
  if (typeof s?.freeze !== 'boolean') return null; // malformed -> honest null, never a guess
  const blockedAt = typeof s.blockedAt === 'string' && Number.isFinite(Date.parse(s.blockedAt)) ? s.blockedAt : null;
  const staleEans = Array.isArray(s.staleEans) && s.staleEans.length > 0 ? s.staleEans : null;
  return { freeze: s.freeze, blockedAt, reason: s.reason ?? null, staleEans };
}

export function readStaleState(root = ROOT) {
  const p = resolve(root, 'runs', 'stale-state.json');
  if (!existsSync(p)) return null;
  try {
    return normalizeStaleState(JSON.parse(readFileSync(p, 'utf8')));
  } catch {
    return null; // corrupt/truncated mid-write file: treat as no-stale, never throw
  }
}

// Build diagnostic for main(): a state file that exists but could not be used.
export function staleStateDiagnostic(root = ROOT) {
  const p = resolve(root, 'runs', 'stale-state.json');
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof s?.freeze !== 'boolean') return 'runs/stale-state.json present but wrong-shape (no boolean freeze) — treated as no-stale; slice 12 should rewrite it';
    return null;
  } catch {
    return 'runs/stale-state.json present but corrupt/partial JSON (non-atomic write?) — treated as no-stale; slice 12 should rewrite it atomically';
  }
}

const round2 = (n) => Math.round(n * 100) / 100;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// One-line verdict, deterministic from the score components (never LLM prose).
function verdictWhy(product) {
  if (product.rated === true && product.score) {
    const neg = Object.entries(product.score.components?.negative ?? {})
      .filter(([, c]) => c.points > 0)
      .sort((a, b) => b[1].points - a[1].points)
      .slice(0, 2)
      .map(([k, c]) => `${k === 'saturatedFat' ? 'saturated fat' : k} (${c.points} pts)`);
    return neg.length > 0
      ? `${neg.join(' and ')} drive this grade under the 2023 algorithm.`
      : 'Low negative points under the 2023 algorithm.';
  }
  if (product.score) return 'Nutrition data is complete; the computed grade is awaiting the D9 auto-gate (two independent reviewer verdicts) before publish.';
  return 'Not enough verified label data to compute a grade yet.';
}

// P2-05 (D3 step 1): grade-on-complete-nutrition. Missing ingredients are a
// SEPARATE honest gap — they never block the grade and never render as a
// nutrition problem. The projection carries the gap explicitly so the detail
// surface can say "ingredients not published" in its own block.
export const INGREDIENTS_GAP_NOTE = 'No ingredient list has been published by the retailer or label sources for this product yet. This is a separate honest gap: the Hawk Grade is computed from the complete per-100g nutrition panel only (grade-on-complete-nutrition) and is unaffected by the missing ingredient list.';
export function ingredientsGapFor(product) {
  if (product?.ingredients) return null;
  return { status: 'not-published', label: 'Ingredients not published', note: INGREDIENTS_GAP_NOTE };
}

function sugarTeaspoons(nutrition) {
  const tsp = (map) => {
    const v = map?.sugars?.value;
    return isNum(v) ? round2(v / SUGAR_GRAMS_PER_TEASPOON) : null;
  };
  return {
    gramsPerTeaspoon: SUGAR_GRAMS_PER_TEASPOON,
    convention: 'HPB convention: 1 teaspoon of sugar = 5 g',
    perServing: tsp(nutrition?.perServing),
    per100g: tsp(nutrition?.per100g),
  };
}

// Panel disagreements (review issue 7): where the displayed per-100g value
// (non-OCR tier) differs from the OCR label-photo panel, the public detail
// must say so on the affected rows until the founder's basis decision.
// Data-driven: once the basis switches to the OCR panel (or values agree),
// the flags disappear automatically. Both values are verbatim layer copies.
export function panelDisagreements(nutrition) {
  const panel = nutrition?.ocr?.panel?.per100g;
  const displayed = nutrition?.per100g;
  if (!panel || !displayed) return [];
  const out = [];
  for (const [key, entry] of Object.entries(displayed)) {
    const photo = panel[key];
    if (!entry || typeof entry !== 'object' || !photo || typeof photo !== 'object') continue;
    if (entry.provenanceTier === 'ocr-label') continue; // already on the photo basis
    if (entry.unit === photo.unit && isNum(entry.value) && isNum(photo.value) && entry.value !== photo.value) {
      out.push({
        nutrient: key,
        displayed: { value: entry.value, unit: entry.unit, provenanceTier: entry.provenanceTier },
        labelPhoto: { value: photo.value, unit: photo.unit },
      });
    }
  }
  return out;
}

// Display ranking (slice 2b): rated products first, ordered by Hawk Grade
// (A best -> E), ties by name; unrated products LAST, by name. Deterministic,
// no score internals involved — the grade letter is the public score surface.
const GRADE_ORDER = { A: 0, B: 1, C: 2, D: 3, E: 4 };
export function sortForDisplay(products) {
  return [...products].sort((a, b) => {
    if (a.rated !== b.rated) return a.rated ? -1 : 1; // unrated always last
    if (a.rated && b.rated) {
      const ga = GRADE_ORDER[a.grade] ?? 99, gb = GRADE_ORDER[b.grade] ?? 99;
      if (ga !== gb) return ga - gb;
    }
    return String(a.name).localeCompare(String(b.name));
  });
}

// The price that drives ranking must be the price the row SHOWS (review
// issue 3): the cheapest IN-STOCK offer, same stock rule as the engine
// (offerInStock). Multi-offer rows render "from $X · store". No in-stock
// offer -> the cheapest last-checked offer is shown WITH an "Out of stock"
// badge (inStock:false) — browsable, never silently ranked (the engine gives
// V=null and rankProducts sinks it into the unpriceable block).
export function displayOfferFor(product) {
  const offers = product?.offers ?? [];
  if (offers.length === 0) return null;
  const valid = offers.filter((o) => isNum(o.pricePer100g) && o.pricePer100g > 0);
  const inStock = valid.filter(offerInStock);
  const candidates = inStock.length > 0 ? inStock : (valid.length > 0 ? valid : offers);
  const best = candidates.reduce((a, b) => (b.pricePer100g < a.pricePer100g ? b : a));
  return {
    store: best.store, packPrice: best.packPrice, packSize: best.packSize,
    packSizeGrams: best.packSizeGrams, pricePer100g: best.pricePer100g,
    priceCheckedAt: best.priceCheckedAt, sourceUrl: best.sourceUrl,
    inventoryStatus: best.inventoryStatus ?? null,
  };
}

export const DEFAULT_PRESET = 'balanced';

// ---------------------------------------------------------------------------
// P2-15 (D4) — result-first UX tracer. The RESULT layer is a deterministic
// projection over the unchanged precise record: a plain ≤8-word verdict, a
// grade chip (colour+letter+icon+word), the worst-flag badge (quoted claim +
// factual verb + count), ≤2 always-visible safety tags, a photo-or-icon image,
// a deterministic same-category healthier swap (C/D/E), and a request-a-rating
// flag (unrated). NOTHING is deleted — every evidence field below is preserved
// verbatim; the info layer (the product detail view, 1 tap from the card) holds
// it all. The tracer renders the new card for UX_TRACER_EANS only; every other
// product keeps the legacy row + detail (no regression). P2-16 flips UX_MODE to
// 'full' (all 80) — a scope flip, not a rewrite.
//
// Ranking integrity: this layer adds NO sort key. buildRanking / the preset
// order are untouched; the Label watch strip + "Flagged only" filter only
// spotlight / remove rows, never reorder (range-scoped S(w) invariant intact).
//
// P2-16 scope flip: UX_MODE stays 'tracer' as the DEFAULT for the frozen-input
// projection seam (the P2-15 tracer tests pin it). The full rollout is selected
// at the BUILD entry point — main() calls buildProjection(cat, {uxMode:'full'})
// so app/data.json + the inline block carry mode 'full' and every one of the 80
// cards + detail views renders the result/info split. buildProjection accepts a
// uxMode option; the precise record is identical in both modes (the plain layer
// is purely additive — projection-diff tested).
// ---------------------------------------------------------------------------
export const UX_MODE = 'tracer';
export const UX_FULL_MODE = 'full';
export const UX_VERDICT_MAX_WORDS = 8;
export const UX_TRACER_EANS = [
  '1200108003241', // R3 A — graded A, clean (sole R3)
  '5010029201246', // R4 B — graded B, clean (Alpen)
  '884912002372',  // R1 C — graded C + unverified flag (Post Cranberry Almond)
  '8852756708349', // R4 D — graded D, clean (Granola Dark Chocolate) + swap
  '7610023052806', // R5 E — graded E, clean (Choco Bits) + swap
  '8888030304150', // R1 unrated — request-a-rating CTA (FP Corn Flakes)
  '8888030315033', // BEV unrated + contradicted flag — drink + flagged + CTA
  '8888440007245', // R2 A + unverified flag — graded + flagged (Cowhead organic)
  '9556174802601', // R2 A + contradicted flag — graded + flagged (Quaker BETAGLUCAN)
  '8888082169103', // BEV unrated — drink + request-a-rating CTA (Nestum Brown Rice)
];

// Grade chip = colour (existing chip-A…E classes) + letter + icon + word. The
// letter is the primary non-colour cue; the icon + word reinforce it (WCAG
// 1.4.1 — never colour alone). Words are the plain detail verdicts (research §4).
export const GRADE_CHIP = {
  A: { icon: '✓', word: 'Great choice' },
  B: { icon: '✓', word: 'Good choice' },
  C: { icon: '◑', word: 'Okay sometimes' },
  D: { icon: '▲', word: 'Limit this one' },
  E: { icon: '▲', word: 'Occasional treat' },
};
// P3-08b fixes (review MINOR-2): story-13 wording unified — the unrated chip word
// matches the legacy row chip + the collection templates ("Not yet rated").
export const UNRATED_CHIP = { letter: '–', icon: '?', word: 'Not yet rated' };

// Plain-English card verdicts — grade 4–6 reading level, ≤8 words, no jargon,
// no intent words (never lies/fake/scam). Deterministic from the grade alone.
export const GRADE_VERDICT = {
  A: 'Great choice for everyday breakfast.',
  B: 'Good choice for most days.',
  C: 'Okay sometimes — not an everyday pick.',
  D: 'Limit this one — save it for treats.',
  E: 'Occasional treat — not for every day.',
};
export const UNRATED_VERDICT = "Not graded yet — we're still checking.";
// P3-04: the out-of-scope verdict vocabulary interpolates the Breakfast config
// (productNoun) — byte-identical to the pre-P3-04 literal for cereals; a second
// aisle's out-of-scope wording derives from ITS config when it lands.
export const OUT_OF_SCOPE_VERDICT = `Snack format — outside the ${DEPARTMENTS.Breakfast.productNoun} comparison.`;

// Flag badge render tokens. The factual verb stays in the controlled set
// (contradicted / misleading / borderline / unverified) — plain syntax around
// it, never an upgraded accusation (devil's-advocate R9). Tones map to the
// flag CSS (tinted outline badges, visually distinct from saturated grade chips).
export const FLAG_RENDER = {
  contradicted: { icon: '⚠', word: 'contradicted', tone: 'contradicted' },
  misleading: { icon: '⚠', word: 'misleading', tone: 'misleading' },
  borderline: { icon: '△', word: 'borderline', tone: 'misleading' },
  unverified: { icon: '?', word: 'unverified', tone: 'unverified' },
};
export const FLAG_QUOTE_MAX = 28;

export function plainVerdictFor(product) {
  if (product?.range === 'out-of-scope') return OUT_OF_SCOPE_VERDICT;
  if (product?.rated === true && product?.grade && GRADE_VERDICT[product.grade]) return GRADE_VERDICT[product.grade];
  return UNRATED_VERDICT;
}

export function verdictWordCount(verdict) {
  return String(verdict).split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

function truncateClaimQuote(quote) {
  const q = String(quote ?? '');
  return q.length > FLAG_QUOTE_MAX ? q.slice(0, FLAG_QUOTE_MAX - 1).trimEnd() + '…' : q;
}

// Worst-flag badge: quoted claim fragment (exact words, ellipsis if long) +
// one factual verb + count (devil's-advocate R11 minimum on-card evidence).
export function resultFlagBadgeFor(claimFlags) {
  const flags = (claimFlags ?? []).filter((f) => f.verdict && f.verdict !== 'ok');
  if (flags.length === 0) return null;
  const worst = flags.reduce((a, b) => ((CLAIM_SEVERITY[b.verdict] ?? 0) > (CLAIM_SEVERITY[a.verdict] ?? 0) ? b : a));
  const render = FLAG_RENDER[worst.verdict] ?? FLAG_RENDER.unverified;
  return {
    worst: worst.verdict, count: flags.length, more: flags.length - 1,
    quotedClaim: truncateClaimQuote(worst.quotedClaim), fullClaim: worst.quotedClaim ?? null,
    verb: render.word, icon: render.icon, tone: render.tone,
  };
}

const ALLERGEN_SHORT_UX = { gluten: 'gluten', crustaceans: 'crustaceans', eggs: 'egg', fish: 'fish', molluscs: 'molluscs', peanuts: 'peanuts', soy: 'soy', milk: 'milk', treenuts: 'tree nuts', sulphites: 'sulphites', lupin: 'lupin', sesame: 'sesame', celery: 'celery', mustard: 'mustard' };

// ≤2 always-visible safety tags for the card (icon + word, never colour alone).
// The card ALWAYS shows the Halal tag (P1 safety contract — never collapsed)
// plus the strongest allergen fact (contains > PAL > G6PD). The FULL ordered
// list stays on the detail surface (always visible there, never collapsed) —
// overflow is deferred, not deleted. Derived from the same build-time dietary
// truth as the legacy tags.
export function resultSafetyTagsFor(product) {
  const d = product?.dietary || {};
  const tags = [];
  const contains = (d.allergens && d.allergens.contains) || [];
  const pal = (d.allergens && d.allergens.pal) || [];
  const short = (a) => ALLERGEN_SHORT_UX[a.key] || a.label;
  if (contains.length > 0) tags.push({ kind: 'allergen', icon: '▲', word: 'Contains: ' + contains.map(short).join(', ') });
  if (pal.length > 0) tags.push({ kind: 'pal', icon: '▲', word: 'May contain: ' + pal.map(short).join(', ') });
  if (d.g6pd && d.g6pd.fava) tags.push({ kind: 'g6pd', icon: '⚠', word: 'G6PD: fava ingredients' });
  const halal = d.halal || { state: 'unknown' };
  tags.push({
    kind: 'halal',
    icon: halal.state === 'certified' ? '✓' : '○',
    word: halal.state === 'certified' ? 'Halal certified' : 'Halal: ' + (halal.state === 'not-certified' ? 'not certified' : 'unknown'),
  });
  return tags;
}

// Card selection: ≤2 tags, Halal always included + the strongest allergen fact.
export function resultCardSafetyTags(allTags) {
  const card = [];
  const allergenFact = (allTags ?? []).find((t) => t.kind !== 'halal');
  if (allergenFact) card.push(allergenFact);
  const halalTag = (allTags ?? []).find((t) => t.kind === 'halal');
  if (halalTag) card.push(halalTag);
  return card.slice(0, 2);
}

// Deterministic healthier swap (C/D/E only): same comparison range, strictly
// better grade, in-stock. Tie-break fully specified => deterministic (test).
const SWAP_GRADE_ORDER = { A: 0, B: 1, C: 2, D: 3, E: 4 };
export function healthierSwapFor(product, products) {
  if (!product?.rated || !['C', 'D', 'E'].includes(product.grade)) return null;
  const here = SWAP_GRADE_ORDER[product.grade];
  const candidates = (products ?? []).filter((q) =>
    q.ean !== product.ean && q.range === product.range && q.rated && q.grade
    && SWAP_GRADE_ORDER[q.grade] < here && q.inStock !== false && q.displayOffer);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    (SWAP_GRADE_ORDER[a.grade] - SWAP_GRADE_ORDER[b.grade])
    || (a.displayOffer.pricePer100g - b.displayOffer.pricePer100g)
    || String(a.name).localeCompare(String(b.name))
    || String(a.ean).localeCompare(String(b.ean)));
  const best = candidates[0];
  return {
    ean: best.ean, name: best.name, grade: best.grade, range: product.range,
    packPrice: best.displayOffer.packPrice, pricePer100g: best.displayOffer.pricePer100g,
  };
}

// P2-09 front-of-pack image manifest (consumed if present; icon fallback else).
// Contract: { schemaVersion, images: { "<ean>": { status:"captured"|"no-photo",
//   src:"images/<ean>.jpg" (self-hosted, relative to app/), attribution,
//   offProductUrl, license:"CC-BY-SA-3.0", capturedAt } } }. No retailer images,
// no AI lookalikes — a missing/unusable photo is ALWAYS the generic category
// icon (devil's-advocate R4). Corrupt/absent manifest => null => all icons.
export function loadImageManifest(root = ROOT) {
  const p = resolve(root, 'runs', 'p2-09', 'image-manifest.json');
  if (!existsSync(p)) return null;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    return doc && typeof doc.images === 'object' && doc.images !== null ? doc : null;
  } catch {
    return null;
  }
}

export function resultImageFor(product, manifest, departments = DEPARTMENTS) {
  // P3-04: the generic icon kind belongs to the product's department (config
  // icon). Breakfast resolves to 'cereal' exactly as before (byte-identical);
  // BEV keeps the drink pictogram. Unconfigured rows keep the legacy default.
  const fallbackIcon = product?.range === 'BEV' ? 'drink' : (departments[product?.department]?.icon ?? 'cereal');
  const entry = manifest?.images?.[product?.ean] ?? null;
  if (entry && entry.status === 'captured' && typeof entry.src === 'string' && entry.src) {
    return {
      status: 'photo', src: entry.src,
      alt: `${product?.brand ?? ''} ${product?.name ?? ''} pack`.trim(),
      fallbackIcon,
      attribution: entry.attribution ?? null,
      offProductUrl: entry.offProductUrl ?? null,
      license: entry.license ?? 'CC-BY-SA-3.0',
      packagingNote: 'Product photos from the Open Food Facts community; packaging may differ from local stock.',
      marketNote: entry.marketNote ?? null,
    };
  }
  return { status: 'icon', src: null, alt: '', fallbackIcon, attribution: null, offProductUrl: null, license: null, packagingNote: null, marketNote: null };
}

// P3-05 fix A (founder-approved, grill-me consensus 2026-11-22): EAN ->
// self-hosted Hashmeta media URL manifest, written by scripts/p3-image-migrate.mjs
// OUTSIDE data/ (app/media-manifest.json). Amended G3: self-hosted media URLs
// allowed, zero retailer hotlinks/external fetches; attribution + "packaging
// may differ" travel with every entry. Corrupt/absent manifest => null => the
// legacy base64 path below (pre-migration behaviour preserved).
export function loadMediaManifest(root = ROOT) {
  const p = resolve(root, 'app', 'media-manifest.json');
  if (!existsSync(p)) return null;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    return doc && typeof doc.images === 'object' && doc.images !== null ? doc : null;
  } catch {
    return null;
  }
}

// P2-09 merge-04 wiring (front-image-wiring.md §5), amended by P3-05 fix A:
// when the media manifest covers an EAN (url + sha256 matching the frozen
// P2-09 capture), the photo references the SELF-HOSTED media URL (lazy-loaded
// by the client) instead of embedding base64 — the inline data block shrinks
// by the whole photo payload. Without media coverage the legacy path inlines
// app/images/<ean>.jpg as a base64 data URL (relative paths 404 on the live
// Hashmeta shell — P2-04 spike §8 condition 4). A missing/unverifiable file
// falls back to the icon — never a broken img, never a retailer URL.
export function inlinePhotos(projection, root = ROOT) {
  const manifest = loadImageManifest(root);
  if (!manifest) return { inlined: 0, fallbacks: 0, urlReferenced: 0 };
  const media = loadMediaManifest(root);
  let inlined = 0, fallbacks = 0, urlReferenced = 0;
  for (const p of projection.products ?? []) {
    const im = p.result?.image;
    if (!im || im.status !== 'photo') continue;
    const entry = manifest.images?.[p.ean];
    const mediaEntry = media?.images?.[p.ean];
    if (mediaEntry && typeof mediaEntry.url === 'string' && mediaEntry.url
      && entry?.sha256 && mediaEntry.sha256 === entry.sha256) {
      im.src = mediaEntry.url;
      urlReferenced++;
      continue;
    }
    const file = resolve(root, 'app', im.src ?? '');
    let ok = false;
    if (entry?.sha256 && existsSync(file)) {
      const bytes = readFileSync(file);
      ok = createHash('sha256').update(bytes).digest('hex') === entry.sha256;
      if (ok) im.src = `data:image/jpeg;base64,${bytes.toString('base64')}`;
    }
    if (ok) inlined++;
    else { im.status = 'icon'; im.src = null; im.attribution = null; im.offProductUrl = null; im.license = null; im.packagingNote = null; im.marketNote = null; fallbacks++; }
  }
  return { inlined, fallbacks, urlReferenced };
}

// ---------------------------------------------------------------------------
// P2-16 — plain-English template layer + deterministic readability check.
// Inlined here so the projection builder stays SELF-CONTAINED (the frozen-HEAD
// clone rebuild test overlays only build-app.mjs). scripts/p2-ux-plain.mjs
// re-exports these for the readability gate / tests (single source of truth).
//
// The plain layer is a DERIVED overlay over the unchanged precise legal record
// (PRD D4 / stories 19–20): grade 4–6 reading level, controlled vocabulary,
// NEVER intent words (lies/fake/scam — devil's-advocate R9). The precise verdict
// verbs (contradicted / misleading / borderline / unverified) are preserved
// verbatim underneath in the info layer; the plain layer uses everyday wording
// around them and never upgrades an accusation.
//
// Readability method (honest): a syllable-based Flesch–Kincaid grade-level
// APPROXIMATION. FK = 0.39·(words/sentences) + 11.8·(syllables/words) − 15.59.
// Syllables use the standard vowel-group heuristic (silent-e / -ed trimming).
// Deterministic + tested, but an approximation — not a certified FK score. The
// contract is a CEILING of grade 6 (the issue's "grade 4–6" band): every plain
// template must score ≤ 6. Short verdicts score below 4 (even simpler), which
// satisfies the ceiling. Verbatim evidence quotes are NOT simplified (they are
// the legal record); readability is asserted on the template wording.
// ---------------------------------------------------------------------------
export const READING_LEVEL_CEILING = 6;
export const BANNED_INTENT = /\b(lies?|liar|fake|scam|fraud|fraudulent|toxic|poison|poisonous|dangerous|cheat|cheating|dishonest|illegal|unlawful|criminal)\b/i;
export const PLAIN_JARGON = /\b(per[- ]?100\s?g|nutri-?score|nutri-?grade|algorithm|provenance|OCR|threshold|reconstitut\w*|dry basis|as-consumed|kJ|kcal|saturated|trans fat|mg\/kg|ADI|CLM-|Reg-?40A|HPB|EFSA|IARC|JECFA|Codex)\b/i;

export function syllableCount(word) {
  let w = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/([^laeiouy])e$/, '$1'); // trailing silent "e" (keep "-le")
  w = w.replace(/([^td])ed$/, '$1');     // trailing silent "-ed" (keep "-ted"/"-ded")
  w = w.replace(/^y/, '');
  const groups = w.match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}
function plainTokenize(text) {
  return String(text).split(/\s+/).map((w) => w.replace(/[^A-Za-z0-9']/g, '')).filter((w) => /[A-Za-z]/.test(w));
}
export function fleschKincaidGrade(text) {
  const sentences = String(text).split(/[.!?]+/).map((s) => s.trim()).filter((s) => plainTokenize(s).length > 0);
  const words = plainTokenize(text);
  const S = Math.max(1, sentences.length);
  const W = Math.max(1, words.length);
  const syl = words.reduce((n, w) => n + syllableCount(w), 0);
  const raw = 0.39 * (W / S) + 11.8 * (syl / W) - 15.59;
  return {
    grade: Math.round(Math.max(0, raw) * 100) / 100,
    rawGrade: Math.round(raw * 100) / 100,
    words: W, sentences: S, syllables: syl,
    wordsPerSentence: Math.round((W / S) * 100) / 100,
    syllablesPerWord: Math.round((syl / W) * 100) / 100,
  };
}
export function readabilityCheck(text, { ceiling = READING_LEVEL_CEILING } = {}) {
  const fk = fleschKincaidGrade(text);
  const banned = BANNED_INTENT.test(text);
  const jargon = PLAIN_JARGON.test(text);
  return { ...fk, ceiling, bannedIntent: banned, jargon, pass: fk.grade <= ceiling && !banned && !jargon };
}

export const PLAIN_GRADE_EXPLAINER = {
  A: 'This is one of the best picks in its group. It is low in sugar, salt and bad fat. A good choice for most days.',
  B: 'This is a good pick in its group. It has a little more sugar or fat than the top picks. Still a good choice for most days.',
  C: 'This one is okay now and then. It has more sugar or fat than the top picks. Save it for some days, not every day.',
  D: 'This one has a lot of sugar or fat. Try to limit it. Pick a better option in this group most of the time.',
  E: 'This one is high in sugar or fat. Keep it as a treat now and then. It is not a good everyday pick.',
};
export const PLAIN_UNRATED_EXPLAINER = 'We have not graded this one yet. We are still checking the label. The price is shown so you can compare cost.';
// P3-04: interpolates the Breakfast config vocabulary (label + product nouns)
// — byte-identical to the pre-P3-04 literal for cereals.
export const PLAIN_OUT_OF_SCOPE_EXPLAINER = `This is a snack, not a ${DEPARTMENTS.Breakfast.label.toLowerCase()} ${DEPARTMENTS.Breakfast.productNoun}. We show its price, but we do not grade it against ${DEPARTMENTS.Breakfast.productNounPlural}.`;
export const PLAIN_FLAG = {
  contradicted: 'The label and the pack do not match on this claim (contradicted). The exact words are below.',
  misleading: 'This claim could give the wrong idea (misleading). The label shows more than the claim says.',
  borderline: 'This claim is close to the line (borderline). See the exact rule and words below.',
  unverified: 'No one checks this word, so we can not say if it is true (unverified). This is not a finding that the claim is false.',
};
export const PLAIN_GAP_UNRATED = 'Not yet rated. We are still checking the label. The price is live so you can compare cost.';
export const PLAIN_GAP_INGREDIENTS = 'We could not find the list of what is inside. The grade still counts — it comes from the nutrition panel, not the list.';
export const PLAIN_GAP_NUTRITION = 'We could not find the full nutrition panel. So we can not grade this one yet. Nothing is guessed.';
// P3-04: the dose plain line speaks the product department's configured serving
// unit/noun (default Breakfast = bowl/cereal — byte-identical for cereals).
export function plainDoseLine(doseContext, dept = DEPARTMENTS.Breakfast) {
  if (!doseContext) return null;
  const unit = dept?.servingUnit ?? 'serving';
  const unitPlural = dept?.servingUnitPlural ?? 'servings';
  const noun = dept?.productNoun ?? 'food';
  if (doseContext.verified === false) {
    return `We do not give a ${unit} number here. No official safe limit is set for this additive in ${noun}. The published daily limit and its source are below.`;
  }
  const bowls = doseContext.bowlsAtMaxLevel;
  const kg = doseContext.childWeightKg;
  if (typeof bowls === 'number' && typeof kg === 'number') {
    return `Worst case: a ${kg} kg child would need about ${bowls} ${unitPlural} a day to reach the safe limit. This assumes the most allowed and no other food. The source is below.`;
  }
  return `Worst case: a child would need many ${unitPlural} a day to reach the safe limit. This assumes the most allowed and no other food. The source is below.`;
}
export const PLAIN_RECORD_POINTER = 'The plain words above are a quick guide. The exact record sits below, word for word. It keeps each quote, rule, source and sign-off.';

export function plainSummaryFor(product, { gradeVerdict, unratedVerdict, outOfScopeVerdict, gradeChipWord, unratedChipWord, departments = DEPARTMENTS }) {
  const outOfScope = product?.range === 'out-of-scope';
  const rated = product?.rated === true && product?.grade;
  const verdict = outOfScope ? outOfScopeVerdict : (rated ? gradeVerdict[product.grade] : unratedVerdict);
  const explainer = outOfScope ? PLAIN_OUT_OF_SCOPE_EXPLAINER : (rated ? PLAIN_GRADE_EXPLAINER[product.grade] : PLAIN_UNRATED_EXPLAINER);
  const chipWord = rated ? gradeChipWord[product.grade] : unratedChipWord;
  const flags = (product?.claimFlags ?? [])
    .filter((f) => f.verdict && f.verdict !== 'ok')
    .map((f) => ({ verdict: f.verdict, quotedClaim: f.quotedClaim ?? null, plain: PLAIN_FLAG[f.verdict] ?? PLAIN_FLAG.unverified, unverified: f.verdict === 'unverified' }));
  const gaps = [];
  if (!rated && !outOfScope) gaps.push({ kind: 'unrated', plain: PLAIN_GAP_UNRATED });
  if (product?.ingredientsGap) gaps.push({ kind: 'ingredients', plain: PLAIN_GAP_INGREDIENTS });
  if (!product?.per100g && !product?.perServing && !outOfScope) gaps.push({ kind: 'nutrition', plain: PLAIN_GAP_NUTRITION });
  const dose = (product?.ingredientDecode?.additives ?? [])
    .filter((a) => a.flagged && a.doseContext)
    .map((a) => ({ id: a.id, name: a.name, plain: plainDoseLine(a.doseContext, departments[product?.department] ?? DEPARTMENTS.Breakfast) }))
    .filter((d) => d.plain);
  return { verdict, chipWord, explainer, flags, gaps, dose, recordPointer: PLAIN_RECORD_POINTER };
}

export function plainTemplateCorpus() {
  const out = [];
  for (const [g, t] of Object.entries(PLAIN_GRADE_EXPLAINER)) out.push({ id: `grade-explainer-${g}`, text: t });
  out.push({ id: 'unrated-explainer', text: PLAIN_UNRATED_EXPLAINER });
  out.push({ id: 'out-of-scope-explainer', text: PLAIN_OUT_OF_SCOPE_EXPLAINER });
  for (const [v, t] of Object.entries(PLAIN_FLAG)) out.push({ id: `flag-${v}`, text: t });
  out.push({ id: 'gap-unrated', text: PLAIN_GAP_UNRATED });
  out.push({ id: 'gap-ingredients', text: PLAIN_GAP_INGREDIENTS });
  out.push({ id: 'gap-nutrition', text: PLAIN_GAP_NUTRITION });
  out.push({ id: 'dose-verified', text: plainDoseLine({ verified: true, bowlsAtMaxLevel: 30, childWeightKg: 30 }) });
  out.push({ id: 'dose-unverified', text: plainDoseLine({ verified: false }) });
  out.push({ id: 'dose-generic', text: plainDoseLine({ verified: true }) });
  out.push({ id: 'record-pointer', text: PLAIN_RECORD_POINTER });
  return out;
}

// The full result-layer projection for one product (deterministic; swap needs
// the whole projected list). `tracer` gates the new card render in the client.
export function resultLayerFor(product, products, manifest, departments = DEPARTMENTS) {
  const safetyAll = resultSafetyTagsFor(product);
  const gradeChipWords = Object.fromEntries(Object.entries(GRADE_CHIP).map(([g, c]) => [g, c.word]));
  return {
    tracer: UX_TRACER_EANS.includes(product.ean),
    verdict: plainVerdictFor(product),
    gradeChip: product.rated && product.grade && GRADE_CHIP[product.grade]
      ? { letter: product.grade, ...GRADE_CHIP[product.grade] }
      : { ...UNRATED_CHIP },
    flagBadge: resultFlagBadgeFor(product.claimFlags),
    safetyTags: resultCardSafetyTags(safetyAll),
    safetyTagsAll: safetyAll,
    image: resultImageFor(product, manifest, departments),
    swap: healthierSwapFor(product, products),
    requestRating: product.rated !== true && product.range !== 'out-of-scope',
    // P2-16: the FULL plain-English template layer (grade 4–6). A derived
    // overlay — the precise record (verdictWhy / claimFlags / ingredientDecode
    // / doseContext / provenance) is byte-preserved underneath, never replaced.
    plain: plainSummaryFor(product, {
      gradeVerdict: GRADE_VERDICT,
      unratedVerdict: UNRATED_VERDICT,
      outOfScopeVerdict: OUT_OF_SCOPE_VERDICT,
      gradeChipWord: gradeChipWords,
      unratedChipWord: UNRATED_CHIP.word,
      departments,
    }),
  };
}

// ---------------------------------------------------------------------------
// Merge-04b: claim-check rendering (07a ACs 4–6). APPROVED-ONLY gate:
// a flag renders only when its pending/ item is founder-approved AND the
// classification sheet carries the item id in detectorFlagIds (the publication
// contract recorded by merge-04a §2b). ok verdicts render nothing; uncheckable
// gaps never render as flags; unapproved proposals never reach the projection.
// ---------------------------------------------------------------------------

// P2-11: unverified sits BELOW every accusation severity (it is a grey
// non-accusation verdict) but above ok — a row whose only flag is unverified
// still badges, distinctly grey. Existing verdict ordering is unchanged.
const CLAIM_SEVERITY = { contradicted: 3, misleading: 2, borderline: 1, unverified: 0.5, ok: 0 };

export function loadClaimItems(root = ROOT) {
  const dir = resolve(root, 'pending');
  // Graceful degradation (scratch/partial copies): no approval source -> no
  // approved flags -> nothing renders. The gate never fails open.
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(resolve(dir, n), 'utf8')))
    .filter((it) => it.kind === 'claim-flag');
}

function readJsonOrNull(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function itemApproved(it) {
  // Defense in depth (merge-04 review issue 5): require an explicit
  // decision:'approved' — a contradictory record (decision:'rejected' with a
  // stray approvedAt) must never pass the gate.
  return it.status === 'approved' && it.review != null && it.review.decision === 'approved';
}

// Slice-4 detector items carry no structured verdict; the founder-approved
// publication wording lives in review.claimNote ("approved … as a borderline /
// misleading comparative claim"). Extract it verbatim — never invent a verdict.
function approvedVerdict(it) {
  if (it.evidence?.verdict) return it.evidence.verdict;
  const m = /as\s+(?:a|an)\s+(borderline|misleading|contradicted)/i.exec(it.review?.claimNote ?? '');
  return m ? m[1].toLowerCase() : null;
}

function approvalBlock(it) {
  return {
    approver: it.review?.approver ?? null,
    reviewedAt: it.review?.reviewedAt ?? null,
    channel: it.review?.channel ?? null,
    decisionQuote: it.review?.decisionQuote ?? null,
    claimNote: it.review?.claimNote ?? null,
    // W3 merge-03: D9 gate-published flags cite their gate decisionId on the
    // card (additive provenance; founder-approved P1 items carry null).
    gateDecisionId: it.review?.gateDecisionId ?? null,
  };
}

// One evidence card per non-ok finding of an approved item. 7a items carry the
// full findings verbatim (quoted claim → quoted ingredient → cited threshold);
// slice-4 items carry the approved evidence fields + honest cross-check gaps.
export function claimCardsFor(item) {
  const verdict = approvedVerdict(item);
  const approval = approvalBlock(item);
  const gapNote = item.evidence?.gapNote ?? null;
  const hcsContext = item.evidence?.hcsContext ?? null;
  const findings = item.evidence?.findings;
  if (Array.isArray(findings) && findings.length > 0) {
    return findings.filter((f) => f.verdict && f.verdict !== 'ok').map((f) => ({
      itemId: item.id, verdict: f.verdict, ruleId: f.ruleId, claimFamily: f.claimFamily,
      quotedClaim: f.quotedClaim,
      claimSource: f.claimSource ?? null,
      quotedIngredient: f.evidence?.quotedIngredient ?? null,
      ingredientListQuote: f.evidence?.ingredientListQuote ?? null,
      ingredientSource: f.evidence?.ingredientSource ?? null,
      ingredientSourceUrl: f.evidence?.sourceUrl ?? null,
      productPageUrl: f.productPageUrl ?? null,
      threshold: f.threshold ?? null, thresholdContext: null,
      notes: f.notes ?? [], confidence: f.confidence ?? item.confidence,
      // P2-11: unverified cards carry the explicit non-accusation note.
      unverifiedNote: f.verdict === 'unverified' ? UNVERIFIED_RENDER_NOTE : null,
      gapNote, hcsContext, approval,
    }));
  }
  if (!verdict || verdict === 'ok') return [];
  return [{
    itemId: item.id, verdict, ruleId: item.evidence?.ruleId ?? null,
    claimFamily: 'comparative-claim (slice-4 detector)',
    quotedClaim: item.evidence?.quotedClaim ?? null,
    claimSource: { location: item.evidence?.claimSource ?? null, contextQuote: null, sourceUrl: item.evidence?.sourceUrl ?? null, ocrRecord: item.evidence?.ocrRecord ?? null },
    quotedIngredient: item.evidence?.quotedIngredient ?? null,
    ingredientListQuote: null,
    ingredientSource: item.evidence?.ingredientSource ?? null,
    ingredientSourceUrl: null,
    productPageUrl: item.evidence?.productPageUrl ?? item.evidence?.sourceUrl ?? null,
    threshold: null, thresholdContext: item.evidence?.thresholdContext ?? null,
    packPhotoUrl: item.evidence?.packPhotoUrl ?? null,
    notes: [], confidence: item.confidence,
    gapNote, hcsContext, approval,
  }];
}

// Row badge = worst approved flag + count (07a AC4). Clean products: null.
export function claimBadgeFor(claimFlags) {
  const flags = (claimFlags ?? []).filter((f) => f.verdict && f.verdict !== 'ok');
  if (flags.length === 0) return null;
  const worst = flags.reduce((a, b) => ((CLAIM_SEVERITY[b.verdict] ?? 0) > (CLAIM_SEVERITY[a.verdict] ?? 0) ? b : a));
  return { worst: worst.verdict, count: flags.length };
}

// ---------------------------------------------------------------------------
// Merge-04b: safety tags (07a AC6) — Halal certification + allergen warnings
// incl. PAL, extracted from the label text at build time. These render BEFORE
// claim badges and are never collapsed. Extraction mirrors the depth-0
// advisory guard of scripts/8-occurrences.mjs (sub-ingredient annotations like
// "(Contains Milk)" are ingredients, not advisories).
// ---------------------------------------------------------------------------

const ALLERGEN_WORDS = /\b(gluten|wheat|barley|rye|oats?|milk|soy[a]?|peanuts?|tree\s+nuts?|almonds?|hazelnuts?|cashews?|walnuts?|pecans?|pistachios?|macadamias?|eggs?|fish|shellfish|crustaceans?|sesame|celery|mustard|lupin|sulphites?|molluscs?)\b/i;
const stripHtmlTags = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/•/g, ' ').replace(/ /g, ' ');
const SAFETY_ADVISORY_RX = /(allergens?\s+(information|advice)|may\s+contain|processed\s+in\s+a\s+facility|contains?\s*:|contain(s)?\s+(cereals?\s+containing\s+gluten|cereal\s+containing\s+gluten|gluten|oats?\b|wheat|soy\b|milk)|with\s+gluten\s+containing\s+cereal)/gi;
function bracketDepthArray(s) {
  const d = new Array(s.length); let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') { d[i] = depth; depth++; }
    else if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); d[i] = depth; }
    else d[i] = depth;
  }
  return d;
}

export function safetyTagsFor(product) {
  const tags = [];
  if (product?.halal?.status === 'certified') tags.push({ kind: 'halal', text: 'Halal certified' });
  const raw = product?.ingredients?.text;
  if (!raw) return tags;
  const s = stripHtmlTags(raw);
  const depths = bracketDepthArray(s);
  SAFETY_ADVISORY_RX.lastIndex = 0;
  let m, start = -1;
  while ((m = SAFETY_ADVISORY_RX.exec(s))) { if (depths[m.index] === 0) { start = m.index; break; } }
  if (start >= 0) {
    const tail = s.slice(start);
    const seen = new Set();
    for (const sentence of tail.split(/(?<=[.!?])\s+|\n+/)) {
      const t = sentence.trim().replace(/\s+/g, ' ');
      if (!t || seen.has(t.toLowerCase())) continue;
      if (ALLERGEN_WORDS.test(t) && /contain|allergen|processed\s+in/i.test(t)) {
        seen.add(t.toLowerCase());
        tags.push({ kind: /may\s+contain|processed\s+in|traces/i.test(t) ? 'pal' : 'allergen', text: t });
      }
    }
  }
  // Explicit sub-ingredient allergen annotations, e.g. "(GLUTEN)" / "(SOYA)" /
  // "(Contains Milk)" — quoted label notes, never inferred allergen content.
  // Parentheticals INSIDE the advisory tail (e.g. "(Almonds and hazelnuts)" in
  // a PAL sentence) are already covered by the advisory tags — not re-listed.
  const notes = new Set();
  const noteRegion = start >= 0 ? s.slice(0, start) : s;
  for (const pm of noteRegion.matchAll(/\(([^()]{1,60})\)/g)) {
    const inner = pm[1].trim();
    if (/^(contains\s+|from\s+)?[a-z ,]+$/i.test(inner) && ALLERGEN_WORDS.test(inner) && !/^\d/.test(inner)) {
      notes.add(inner.toUpperCase().replace(/^(CONTAINS|FROM)\s+/, ''));
    }
  }
  if (notes.size > 0) tags.push({ kind: 'label-note', text: `Label allergen notes: ${[...notes].join(', ')} (sub-ingredient annotations)` });
  return tags;
}

// ---------------------------------------------------------------------------
// Merge-04b: additive decode (08 ACs 4–6). Ingredient splitting mirrors
// scripts/8-occurrences.mjs (depth-0 commas/newlines after HTML strip +
// depth-0 advisory truncation) so ordinals agree with the curated occurrence
// bands. Dose context is projected ONLY for flagged additives; packaging-use
// mentions (BHT on Blueberry Morning) are never listed as in-food additives.
// ---------------------------------------------------------------------------

function splitTopLevelIngredients(s) {
  const parts = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === '\n') && depth === 0) { if (cur.trim()) parts.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
function ingredientListText(raw) {
  const s = stripHtmlTags(raw);
  const depths = bracketDepthArray(s);
  SAFETY_ADVISORY_RX.lastIndex = 0;
  let m;
  while ((m = SAFETY_ADVISORY_RX.exec(s))) { if (depths[m.index] === 0) return s.slice(0, m.index); }
  return s;
}

export function ingredientDecodeFor(product, occurrences, verdicts, additiveEvidence = null) {
  const raw = product?.ingredients?.text;
  if (!raw) return null;
  // P2-10 PATCH 2 (merge-03 wiring): consume the gate-applied structured block
  // ONLY while its sourceTextSha256 still binds the current text (same drift
  // guard as the apply script + 7a parsedIngredientsFor); fallback = legacy split.
  const structuredBlock = product?.ingredients?.structured ?? null;
  const structured = structuredBlock && structuredBlock.sourceTextSha256 === parserTextSha256(raw) ? structuredBlock : null;
  const ingredients = structured?.appSegments ?? splitTopLevelIngredients(ingredientListText(raw));
  const byId = new Map();
  const packagingNotes = [];
  for (const [id, entries] of Object.entries(occurrences?.occurrences ?? {})) {
    for (const occ of entries) {
      if (occ.ean !== product.ean) continue;
      const verdict = verdicts?.verdicts?.[id] ?? null;
      if (occ.useNote && /packaging/i.test(occ.useNote)) {
        packagingNotes.push({ id, name: verdict?.name ?? id, excerpt: occ.excerpt, useNote: occ.useNote });
        continue; // never listed as an in-food additive (08-curation review issue 2)
      }
      if (!byId.has(id)) {
        // P2-14: verbatim regulator conclusion quote (data/additives/evidence.json).
        // Verified quote OR honest gap — never a paraphrase, never invented.
        const evRec = additiveEvidence?.evidence?.[id] ?? null;
        const conclusionQuote = !evRec ? null : (evRec.status === 'verified' && evRec.quote)
          ? { status: 'verified', quote: evRec.quote, sourceUrl: evRec.source?.canonicalUrl ?? null, retrievedAt: evRec.source?.retrievedAt ?? null, alignment: evRec.alignment ?? null }
          : { status: 'gap', quote: null, gapReason: evRec.gapReason ?? 'regulator conclusion quote not yet retrieved', sourceUrl: evRec.source?.canonicalUrl ?? verdict?.source?.url ?? null, retrievedAt: evRec.source?.retrievedAt ?? null };
        byId.set(id, {
          id, name: verdict?.name ?? id, eNumber: verdict?.eNumber ?? null,
          function: verdict?.function ?? [], evidenceTier: verdict?.evidenceTier ?? null,
          flagged: verdict?.flagged === true,
          safetyVerdict: verdict?.safetyVerdict ?? null,
          source: verdict?.source ?? null, adi: verdict?.adi ?? null,
          childExposureNote: verdict?.childExposureNote ?? null,
          // HARD RULE: dose context only inside flagged additives' expanders.
          doseContext: verdict?.flagged === true ? (verdict.doseContext ?? null) : null,
          curationNotes: verdict?.curationNotes ?? [],
          conclusionQuote,
          occurrences: [],
        });
      }
      byId.get(id).occurrences.push({
        excerpt: occ.excerpt, matchedTerm: occ.matchedTerm, matchType: occ.matchType,
        position: occ.position, totalIngredients: occ.totalIngredients,
        positionBand: occ.positionBand, positionNote: occ.positionNote ?? null,
      });
    }
  }
  const additives = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  // Mirrors 8-occurrences bracketsBalanced: unclosed source brackets make the
  // top-level split unreliable — say so honestly (bands are already withheld
  // per-occurrence as 'unknown' + positionNote by the curation layer).
  let depth = 0, balanced = true;
  for (const ch of stripHtmlTags(raw)) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth < 0) { balanced = false; break; }
  }
  if (depth !== 0) balanced = false;
  return {
    ingredients, totalIngredients: ingredients.length,
    // P2-10 PATCH 2 anchor E: structured percent projection (null pre-apply).
    // Render rules (PRD story 40): sub-ingredient basis = "% of <parent>",
    // ambiguous = "share not verifiable (label brackets malformed)", estimates
    // as estimates — never as declared values; null share = "no declared
    // wholegrain share", never 0.
    wholegrainShare: structured?.wholegrain?.share ?? null,
    wholegrainShareRule: 'product-basis declared percents only (p2-parser); nested sub-ingredient %, ambiguous-basis % and OFF/parser estimates never feed the share',
    ingredientPercents: structured?.percents ?? null,
    collapseAfter: INGREDIENT_COLLAPSE_AFTER,
    additives, packagingNotes,
    bracketsMalformed: !balanced,
    malformedNote: balanced ? null : 'Source ingredient brackets are unclosed/malformed — the list is shown exactly as parsed (segments may merge), and position bands are withheld (\'unknown\') rather than guessed. Additive identities are unaffected.',
    positionBandRule: occurrences?.meta?.positionBandRule ?? null,
    attribution: 'Additives knowledge base: Open Food Facts taxonomy (ODbL 1.0, https://world.openfoodfacts.org) + hand-curated verdicts with EFSA/JECFA sources.',
  };
}

// Slice 3b preset ranking projection. ORDER ONLY — EAN lists per range×preset,
// computed by the scoring engine (rankProducts) against the FULL catalogue.
// p_min is fixed per range here at BUILD TIME (engine rangeMinPrice over every
// catalogue record in the range, rated or not — prices are public facts and
// the stored approved scores use the same floor). The client only selects
// ranges (chips) and a preset, so applying filters can never re-price the
// remaining products: the ordering and the floor are precomputed constants.
//
// Health floor scope (PRD Implementation Decisions + 03b AC): BEST VALUE ONLY
// excludes D/E, with the explicit "show lower-rated (with warning)" override.
// The engine PRESETS also carry a conservative E-floor for Balanced/Healthiest;
// the app surfaces those E rows via the engine's documented allowLowerRated
// option because full SKU visibility is the app contract since slice 2b
// (every option keeps its live price; the saturated E chip is the warning).
// Best value uses the engine floor unmodified. Override display is GROUPED
// (honest design, review issue 2): floor-passing rows first in S-order, then
// the warned D/E block (S-order WITHIN the block) — not one merged S-order.
// Rated-but-unpriceable rows (all offers OOS) form their own block below the
// scored rows. No scoring math is reimplemented here — rankProducts /
// rangeMinPrice / offerInStock are the only ranking + pricing path.
export function buildRanking(fullCatalogue, rangeOrder = RANGE_ORDER) {
  const products = fullCatalogue ?? [];
  const byRange = {};
  const pMinByRange = {};
  for (const range of rangeOrder) {
    if (range === 'out-of-scope') continue; // never ranked, navigation only
    // Name order in = deterministic S-ties and unrated-by-name out
    // (rankProducts is a stable sort; unrated rows keep input order).
    const inRange = products.filter((p) => p.range === range)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (inRange.length === 0) continue;
    pMinByRange[range] = rangeMinPrice(products, range); // FULL catalogue floor
    byRange[range] = {};
    for (const preset of PRESETS) {
      const floorApplies = preset.id === 'best-value';
      const rows = rankProducts(products, inRange, preset.id, { allowLowerRated: !floorApplies });
      const ratedRows = rows.filter((r) => r.rated);
      const ranked = ratedRows.filter((r) => r.S !== null).map((r) => r.product.ean);
      // Rated but unpriceable (every offer out of stock -> V/S null): sink
      // below the scored block with an honest "Out of stock" state — never
      // ranked on a phantom price, never dropped from browsing.
      const unpriceable = ratedRows.filter((r) => r.S === null).map((r) => r.product.ean);
      const unrated = rows.filter((r) => !r.rated).map((r) => r.product.ean);
      let hidden = [];
      if (floorApplies) {
        const shown = new Set([...ranked, ...unpriceable]);
        hidden = rankProducts(products, inRange, preset.id, { allowLowerRated: true })
          .filter((r) => r.rated && !shown.has(r.product.ean))
          .map((r) => r.product.ean); // override block order = engine S-order within the block
      }
      byRange[range][preset.id] = { ranked, hidden, unpriceable, unrated };
    }
  }
  return {
    // Truthful floor metadata (review issue 7): the ENGINE default floor and
    // the floor AS DISPLAYED by the app are published separately — a consumer
    // must never read excludeGrades as "what the app hides" for Balanced /
    // Healthiest, where E rows stay visible (documented app-layer decision).
    presets: PRESETS.map((p) => ({
      id: p.id, label: p.label, w: p.w,
      engineExcludeGrades: p.excludeGrades,
      appliedExcludeGrades: p.id === 'best-value' ? p.excludeGrades : [],
      floorBehavior: p.id === 'best-value'
        ? 'D/E hidden by default; explicit one-tap "show lower-rated (with warning)" override; hidden block renders AFTER floor-passing rows (grouped display, S-order within each block)'
        : 'No display floor: E rows remain visible (engine E-floor not applied in app display; the saturated E chip is the warning). Founder confirmation of this app-layer scope pending.',
    })),
    defaultPreset: DEFAULT_PRESET,
    pMinByRange,
    byRange,
    note: 'Order-only projection computed by scripts/score.mjs rankProducts against the full catalogue on IN-STOCK offers. p_min is fixed per range at build time (filter-invariant). No per-product score internals are published.',
  };
}

// Slice 4 CS extension: the ranking projection must use the SHEET-JOINED
// ranges, not the raw catalogue placeholders — otherwise newly classified
// SKUs (catalogue still UNCLASSIFIED pre-sync) stay invisible in every chip
// view (03b-review issue 5). Shallow copies; the catalogue is never mutated.
// Exported so tests mirror the exact build convention (parity, not guesswork).
export function rankingInputFor(cat, sheetByEan) {
  return (cat.products ?? []).map((p) => {
    const row = sheetByEan.get(p.ean);
    return row ? { ...p, range: row.range, scoring_category: row.scoring_category } : p;
  });
}

export function buildProjection(cat, {
  now = new Date().toISOString(), sheet = loadSheet(),
  claimItems = loadClaimItems(),
  occurrences = readJsonOrNull(resolve(ROOT, 'data', 'additives', 'occurrences.json')),
  verdicts = readJsonOrNull(resolve(ROOT, 'data', 'additives', 'verdicts.json')),
  findings = readJsonOrNull(resolve(ROOT, 'data', 'claims', 'findings.json')),
  additiveEvidence = readJsonOrNull(resolve(ROOT, 'data', 'additives', 'evidence.json')),
  staleState = readStaleState(),
  uxMode = UX_MODE,
  // P3-02: department config override is a TEST fixture seam only (a second
  // aisle without touching the live config); production uses the config module.
  departments = DEPARTMENTS,
} = {}) {
  // Slice 4: the hand-classified sheet joins by EAN at BUILD TIME (read-only).
  // The sheet is human curation — this path never writes it (writeSheet in
  // 4-classify.mjs is the only sanctioned write path and refuses auto-overwrite).
  // Curated records (cornflakes) keep their own classification; UNCLASSIFIED
  // records without a sheet row stay honestly pending.
  const sheetByEan = joinSheet(cat, sheet);
  const rankingInput = rankingInputFor(cat, sheetByEan);
  const products = sortForDisplay((cat.products ?? []).map((p) => {
    const approved = p.rated === true && p.score != null;
    const n = p.nutrition ?? null;
    const row = sheetByEan.get(p.ean) ?? null;
    // Approved-only claim gate: founder approval in pending/ AND the sheet's
    // detectorFlagIds publication contract. Unapproved never projects.
    const approvedItems = claimItems.filter((it) => it.ean === p.ean && itemApproved(it) && (row?.detectorFlagIds ?? []).includes(it.id));
    const claimFlags = approvedItems.flatMap(claimCardsFor);
    // Slice 9: deterministic dietary/safety derivation (scripts/9-lib.mjs) —
    // allergens/PAL from ingredient text, GF label-claim-only, veg/vegan
    // ingredient-assessed, halal certification-only, G6PD fava check.
    const decode = ingredientDecodeFor(p, occurrences, verdicts, additiveEvidence);
    const dietary = deriveDietary(p);
    dietary.flaggedAdditives = decode ? decode.additives.filter((a) => a.flagged).length : 0;
    return {
      ean: p.ean,
      name: p.name,
      brand: p.brand,
      department: p.department,
      range: row ? row.range : p.range,
      scoringCategory: row ? row.scoring_category : (p.scoring_category && p.scoring_category !== 'UNCLASSIFIED' ? p.scoring_category : null),
      classificationAttributes: row ? row.attributes : (p.attributes ?? null),
      classification: row ? {
        breadcrumb: row.breadcrumb,
        confidence: row.confidence,
        classifierId: row.classifierId,
        date: row.date,
        humanConfirmed: row.humanConfirmed,
        underReview: row.underReview === true,
        exceptionId: row.exceptionId ?? null,
        detectorFlagIds: row.detectorFlagIds ?? [],
        ruling: row.ruling,
        // N2 (merge-06, final review): strip local cachePath from the PUBLIC
        // projection — absolute workspace paths leak username/directory layout
        // (225 strings × shell hydration). Full paths stay in the local
        // sheet/catalogue/audit; every other evidence field is preserved.
        evidence: (row.evidence ?? []).map(({ cachePath, ...rest }) => rest),
      } : null,
      classificationPending: row ? false : p.classificationPending === true,
      rated: approved,
      grade: approved ? p.score.grade : null,
      gradeDisplayName: GRADE_DISPLAY_NAME,
      gradeAttribution: GRADE_ATTRIBUTION,
      verdictWhy: verdictWhy(p),
      offers: (p.offers ?? []).map((o) => ({
        store: o.store, packPrice: o.packPrice, packSize: o.packSize,
        packSizeGrams: o.packSizeGrams, pricePer100g: o.pricePer100g,
        priceCheckedAt: o.priceCheckedAt, sourceUrl: o.sourceUrl,
      })),
      // Slice 3b fix: stock + the ranking-driving display offer. The offers
      // array stays a verbatim copy (its shape is a pinned contract); stock
      // status is index-aligned here and the chosen offer is copied verbatim.
      offerStockStatus: (p.offers ?? []).map((o) => o.inventoryStatus ?? null),
      inStock: (p.offers ?? []).some(offerInStock),
      displayOffer: displayOfferFor(p),
      servingSizeG: n?.servingSizeG ?? null,
      servingDescription: n?.servingDescription ?? null,
      servingSizeProvenanceTier: n?.servingSizeProvenanceTier ?? null,
      per100g: n?.per100g ?? null,
      perServing: n?.perServing ?? null,
      nutritionGap: n?.gap ?? null,
      panelDisagreements: panelDisagreements(n),
      basisDecisions: n?.basisDecisions ?? [],
      sugarTeaspoons: sugarTeaspoons(n),
      ingredients: p.ingredients ?? null,
      ingredientsGap: ingredientsGapFor(p),
      halal: p.halal ?? null,
      // Merge-04b: claim evidence (approved-only), safety tags (precede badges),
      // and the additive decode (dose context only on flagged additives).
      claimFlags,
      claimBadge: claimBadgeFor(claimFlags),
      safetyTags: safetyTagsFor(p),
      ingredientDecode: decode,
      dietary,
      confidence: p.confidence,
      classifierId: p.classifierId,
      timestamp: p.timestamp,
      provenance: {
        retailer: p.ingredients ? { sourceUrl: p.ingredients.sourceUrl, fetchedAt: p.ingredients.fetchedAt } : null,
        off: n?.off ? {
          source: n.off.source, url: n.off.url, fetchedAt: n.off.fetchedAt,
          license: n.off.license, attribution: n.off.attribution,
        } : null,
        ocr: n?.ocr ? {
          imageUrl: n.ocr.imageUrl, transcribedAt: n.ocr.transcribedAt,
          verbatimTranscription: n.ocr.verbatimTranscription,
          photoSupports: n.ocr.adjudication?.photoSupports ?? null,
        } : null,
      },
    };
  }));
  // P2-15: result-layer second pass (swap needs the whole projected list). The
  // precise record above is untouched — this only ADDS the plain result layer.
  const imageManifest = loadImageManifest();
  for (const p of products) p.result = resultLayerFor(p, products, imageManifest, departments);
  // P3-02: only departments WITH data surface (no empty shelves). Breakfast
  // today; a configured second aisle appears here automatically once its
  // catalogue rows exist — a data event, not a code change.
  const departmentIds = departmentIdsWithData(products, departments);
  const departmentRangeOrder = rangeOrderFor(departmentIds, departments);
  return {
    meta: {
      generatedAt: now,
      schemaVersion: cat.schemaVersion,
      productCount: products.length,
      ratedCount: products.filter((p) => p.rated).length,
      unratedCount: products.filter((p) => !p.rated).length,
      ux: {
        mode: uxMode,
        tracerEans: UX_TRACER_EANS,
        verdictMaxWords: UX_VERDICT_MAX_WORDS,
        resultLayer: 'photo-or-icon + grade chip (colour+letter+icon+word) + ≤8-word plain verdict + worst-flag badge (quoted claim + factual verb + count) + price big + $/100g small + ≤2 always-visible safety tags + one labelled "ⓘ How we know" tap',
        infoLayer: 'the product detail view (1 tap from the card) holds ALL evidence verbatim; its inline expanders are disclosure level 2 (max 2 levels — no third-level nesting)',
        plainLayer: 'P2-16 full plain-English template layer (result.plain): grade explainer + ≤8-word verdict + flag plain lines (factual verb preserved, never upgraded) + honest gaps ("Not yet rated") + worst-case dose context. Grade 4–6 reading level (deterministic syllable-based Flesch–Kincaid approximation, ceiling 6). A DERIVED overlay — the precise legal record (verdictWhy / claimFlags / ingredientDecode / doseContext / provenance) is byte-preserved underneath, never replaced; "contradicted/misleading" wording kept; never lies/fake/scam.',
        readingLevelCeiling: READING_LEVEL_CEILING,
        labelWatch: 'pinned strip above the ranked list, computed from the current preset/filter scope; a spotlight, NEVER a sort key — ranked order is mathematically unchanged under every preset',
        flaggedOnlyFilter: 'user-initiated filter that removes non-flagged rows; never reorders or re-prices (V filter-invariance preserved)',
        swapRule: 'same comparison range, strictly better grade, in-stock; deterministic tie-break (grade, pricePer100g, name, ean)',
        requestRating: 'unrated cards carry a "Request a rating" CTA feeding the native Request-a-product form (id 2) → demand-ranked coverage queue (scripts/p2-ux-demand.mjs)',
        imageManifest: 'runs/p2-09/image-manifest.json + app/media-manifest.json (P3-05 fix A) — self-hosted Hashmeta media URLs when migrated (CC-BY-SA thumbnails, lazy-loaded); legacy base64 inline otherwise; generic category icon fallback when no licensed photo; no retailer images, no AI lookalikes (amended G3)',
        scopeFlip: 'P2-16 sets mode=full at the build entry point (main): all 80 cards + detail views render the result/info split. The default projection seam stays mode=tracer (P2-15 frozen-input pins); the precise record is identical in both modes (plain layer purely additive, projection-diff tested). Full-mode cards keep the P1 safety-first tag strip (always-visible safety + claim badge with +N overflow) alongside the result layer, so the legacy UI contract is preserved.',
      },
      gradeDisplayName: GRADE_DISPLAY_NAME,
      gradeAttribution: GRADE_ATTRIBUTION,
      disclaimer: DISCLAIMER,
      sugarGramsPerTeaspoon: SUGAR_GRAMS_PER_TEASPOON,
      ratingContract: {
        rule: 'grade-on-complete-nutrition (P2 D3 step 1)',
        note: 'A grade requires complete per-100g nutrition only. Missing ingredients render as a separate honest "ingredients not published" gap and never block the grade. Beverages grade as prepared per 100ml once prep instructions are captured — never on a dry basis.',
        ingredientsNotPublishedCount: products.filter((p) => p.ingredientsGap).length,
      },
      // P3-02 single-source projection: departments (with data) carry their
      // chips/labels/icons/serving-unit/reference-quantity; the flat chip/
      // range views are derived from the SAME config for the client.
      departments: departmentMetaFor(departmentIds, products, departments),
      chips: chipsFor(departmentIds, departments),
      rangeLabels: rangeLabelsFor(departmentIds, departments),
      rangeOrder: departmentRangeOrder,
      stores: STORE_ORDER,
      storeLabels: STORE_LABELS,
      ingredientCollapseAfter: INGREDIENT_COLLAPSE_AFTER,
      search: {
        engine: 'Fuse.js 7.1.0 — vendored at app/fuse.min.js (Apache-2.0); no runtime CDN, fully client-side',
        threshold: SEARCH_THRESHOLD,
        ignoreLocation: true,
        keys: ['name', 'brand'],
        synonyms: SEARCH_SYNONYMS,
        note: 'Query expanded through the synonym map (Malay/Chinese/brand shorthand); matches unioned. Display order stays the engine range-scoped preset order — search removes rows, never reorders or re-prices.',
      },
      stale: normalizeStaleState(staleState),
      dietary: {
        sfaAllergens: SFA_ALLERGENS.map((a) => ({ key: a.key, label: a.label })),
        additionalAllergens: ADDITIONAL_ALLERGENS.map((a) => ({ key: a.key, label: a.label })),
        priceBuckets: PRICE_BUCKETS.map((b) => ({ id: b.id, label: b.label })),
        stores: STORE_ORDER,
        nutFreeScope: NUT_KEYS,
        rules: {
          halal: 'Certification/retailer attribute ONLY — never inferred from ingredients. States: certified / not-certified / unknown; pork-alcohol ingredient assessment shown separately (gelatin with undeclared source = uncertain, never assumed pork).',
          glutenFree: 'Label claim only (SG legal definition ≤20 mg/kg) — never inferred from ingredient absence.',
          vegVegan: 'Ingredient-assessed AND labelled "assessed from ingredients"; undeclared-source tokens (natural flavours, vitamin D3, enzymes) → uncertain → excluded under an active toggle.',
          pal: '"May contain" = EXCLUSION under active free-from toggles; never labelled "contains". Lupin counts toward nut-free (peanut cross-reactivity, conservative).',
          cannotVerify: 'No ingredient text → excluded under any active INGREDIENT-ASSESSED toggle (nut-free/dairy-free/vegetarian/vegan; never silently included). Gluten-free is claim-based — a GF label claim IS the verification even without ingredient text. Rows keep honest allergen/halal states.',
          derivation: 'Mirrors scripts/8-allergen-spotcheck.mjs (founder spot-check safety insurance): depth-0 advisory split, PAL-first declaration parsing, English+German keywords; CONTAINS = label-declared ∪ ingredient-assessed.',
        },
        note: 'Active dietary toggles EXCLUDE non-conforming products — never badge them. Allergen/Halal tags stay on-row regardless of filters.',
      },
      claimChecks: {
        approvedFlagItems: claimItems.filter(itemApproved).length,
        renderedFlags: products.reduce((a, p) => a + p.claimFlags.length, 0),
        publicationContract: 'pending/ claim-flag item founder-approved AND the item id present in the classification sheet detectorFlagIds',
        findingsFile: 'data/claims/findings.json',
        findingsCounts: findings?.counts ?? null,
        // Merge-04 review issue 4: the findings file is a PRE-MERGE coverage
        // snapshot (80 FP products, generated before the CS ingestion). The
        // verdict set is unchanged; annotate the staleness until the 7a
        // carry-forward re-run covers all 184 products. Never client-rendered.
        findingsCountsAsOf: findings?.generatedAt ?? null,
        findingsCountsScope: 'pre-merge coverage snapshot (FairPrice perimeter only) — full-catalogue re-run is the 7a carry-forward; verdict set unchanged',
        note: 'Only founder-approved flags render. ok verdicts render nothing; uncheckable gaps never render as flags; unapproved proposals never reach the projection.',
      },
      additives: {
        occurrences: 'data/additives/occurrences.json',
        verdicts: 'data/additives/verdicts.json',
        kbLicense: occurrences?.meta?.license ?? null,
        distinctAdditives: occurrences?.meta?.counts?.distinctAdditives ?? null,
        note: 'Dose context is projected only for flagged additives; packaging-use mentions are never listed as in-food additives.',
      },
      classification: sheet ? {
        sheet: 'data/classification/sheet.json',
        generatedAt: sheet.meta?.generatedAt ?? null,
        rowCount: sheet.rows?.length ?? 0,
        humanConfirmedCount: (sheet.rows ?? []).filter((r) => r.humanConfirmed === true).length,
        reviewModel: sheet.meta?.reviewModel ?? null,
        note: 'Joined by EAN at build time. The sheet is human curation — build/refresh paths read it and never write it.',
      } : null,
    },
    ranking: buildRanking(rankingInput, departmentRangeOrder),
    products,
  };
}

function main() {
  const cat = JSON.parse(readFileSync(resolve(ROOT, 'data', 'catalogue.json'), 'utf8'));
  // P2-16 full UX rollout: the built artifact carries mode 'full' (all 80 cards
  // + detail views). The default projection seam stays 'tracer' for the P2-15
  // frozen-input pins; the precise record is identical in both modes.
  const projection = buildProjection(cat, { uxMode: UX_FULL_MODE });
  // P2-09 merge-04 / P3-05 fix A: reference self-hosted Hashmeta media URLs
  // (manifest-covered EANs) or inline the frozen thumbnails as data URLs
  // (legacy fallback) BEFORE both writes (data.json + inline block stay
  // byte-identical — port canary).
  const photoDiag = inlinePhotos(projection);
  if (photoDiag.inlined > 0 || photoDiag.fallbacks > 0 || photoDiag.urlReferenced > 0) {
    projection.meta.ux.photos = {
      inlined: photoDiag.inlined, iconFallbacks: photoDiag.fallbacks, urlReferenced: photoDiag.urlReferenced,
      mode: photoDiag.urlReferenced > 0
        ? 'self-hosted-url (Hashmeta media library — P3-05 fix A, founder-approved; lazy-loaded; amended G3: zero retailer hotlinks/external fetches)'
        : 'data-url (live shell 404s relative paths — P2-04 spike §8 condition 4)',
      attribution: 'per-image CC-BY-SA-3.0 uploader credit + OFF product link + licence link + "packaging may differ" note rendered in the detail view',
    };
    console.log(`front photos: ${photoDiag.urlReferenced} self-hosted media URL(s), ${photoDiag.inlined} inlined data URL(s), ${photoDiag.fallbacks} icon fallback(s)`);
  }
  const appDir = resolve(ROOT, 'app');
  mkdirSync(appDir, { recursive: true });
  const dataPath = resolve(appDir, 'data.json');
  writeFileSync(dataPath, JSON.stringify(projection, null, 2) + '\n');

  const htmlPath = resolve(appDir, 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  const start = html.indexOf(DATA_START);
  const end = html.indexOf(DATA_END);
  if (start < 0 || end < 0 || end < start) {
    console.error(`FAIL: ${htmlPath} missing inline-data markers ${DATA_START} … ${DATA_END}`);
    process.exit(1);
  }
  const inlined = html.slice(0, start + DATA_START.length)
    + `\nwindow.__HEALTHHAWK_DATA__ = ${JSON.stringify(projection)};\n`
    + html.slice(end);
  // P3-03: regenerate the inline canonical-token block from app/tokens.css
  // (scoped to the .hh-app wrapper). Reads app/tokens.css only — no data/ write.
  const tokensCss = scopeTokensCss(readFileSync(resolve(appDir, 'tokens.css'), 'utf8'));
  const withTokens = injectTokens(inlined, tokensCss);
  writeFileSync(htmlPath, withTokens);
  console.log(`projection written: ${dataPath} (${projection.products.length} product(s))`);
  console.log(`inline data injected: ${htmlPath} (fully static, file:// safe)`);
  console.log(`canonical tokens injected: ${htmlPath} (source: app/tokens.css, scoped to .hh-app)`);
  const unrated = projection.products.filter((p) => !p.rated).length;
  if (unrated > 0) console.log(`honest state: ${unrated} product(s) projected as "Not yet rated" (unapproved grades never leak)`);
  const staleDiag = staleStateDiagnostic();
  if (staleDiag) console.log(`stale-state diagnostic: ${staleDiag}`);
}

if (isMain(import.meta.url)) main();