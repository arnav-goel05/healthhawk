// HealthHawk slice 9 — dietary & safety derivation rules (PURE, zero deps).
// Owned by T9 (app). Read-only inputs: catalogue records passed in.
//
// Method mirrors scripts/8-allergen-spotcheck.mjs (the delegated founder
// spot-check safety insurance, runs/8-allergen-spotcheck.md): ingredient-text
// keyword derivation (English + German) + depth-0 advisory split + PAL-first
// declaration parsing. Extended to the full SFA allergen list + dietary
// toggles + G6PD + halal assessment per docs/issues/09 + PRD dietary rules:
//   - Halal: STRICTLY certification/retailer attribute — never inferred.
//   - Gluten-free: LABEL CLAIM ONLY (SG legal definition ≤20 mg/kg) — never
//     inferred from ingredient absence.
//   - Veg/vegan: ingredient-assessed AND labelled "assessed from ingredients";
//     undeclared-source tokens (natural flavours, vitamin D3, enzymes) make the
//     assessment UNCERTAIN → excluded under an active toggle (safe direction).
//   - PAL "may contain X": EXCLUSION under X-free toggles, NEVER labelled
//     "contains". Lupin counts toward nut-free (documented peanut
//     cross-reactivity, conservative safety direction).
//   - No ingredient text → cannot-verify → excluded under any active
//     INGREDIENT-ASSESSED toggle (nut/dairy/veg/vegan; never silently included).
//     Gluten-free is CLAIM-BASED: a GF label claim IS the verification even
//     without ingredient text. Allergen/halal rows still honest.
//   - G6PD: fava/broad-bean ingredient warning badge (SG-specific risk).

// ---- SFA allergen groups (the expandable full list) + SG-relevant extras ----
export const SFA_ALLERGENS = [
  { key: 'gluten', label: 'Cereals containing gluten', kws: ['wheat', 'barley', 'oats', 'oat', 'rye', 'triticale', 'spelt', 'malt extract', 'malted barley', 'barley malt', 'malted flour', 'gluten', 'cereals containing gluten', 'cereal containing gluten', 'weizen', 'vollkornweizen', 'hafer', 'vollkornhaferflocken', 'haferflocken', 'gerste', 'roggen', 'dinkel'] },
  { key: 'crustaceans', label: 'Crustaceans', kws: ['crustacean', 'shrimp', 'prawn', 'crab', 'lobster', 'krebstiere', 'garnelen'] },
  { key: 'eggs', label: 'Eggs', kws: ['egg', 'ei', 'eier', 'albumin', 'ovalbumin'] },
  { key: 'fish', label: 'Fish', kws: ['fish', 'fisch', 'anchovy', 'sardine', 'tuna', 'salmon'] },
  { key: 'molluscs', label: 'Molluscs', kws: ['mollusc', 'mollusk', 'squid', 'octopus', 'mussel', 'oyster', 'scallop', 'clam', 'weichtiere'] },
  { key: 'peanuts', label: 'Peanuts', kws: ['peanut', 'groundnut', 'erdnuss'] },
  { key: 'soy', label: 'Soy', kws: ['soy', 'soya', 'soybean', 'soja'] },
  { key: 'milk', label: 'Milk', kws: ['milk', 'milch', 'mager milch pulver', 'whey', 'molke', 'molkenpulver', 'caseinate', 'lactose', 'cream', 'butter', 'skimmed milk'] },
  { key: 'treenuts', label: 'Tree nuts', kws: ['almond', 'mandeln', 'walnut', 'pecan', 'cashew', 'hazelnut', 'haselnusse', 'pistachio', 'macadamia', 'tree nut', 'nusse', 'nuts'] },
  // SFA declaration threshold is ≥10 mg/kg; a label declaring sulphites is
  // making that declaration. No quantity is ever guessed.
  { key: 'sulphites', label: 'Sulphites (declared ≥10 mg/kg)', kws: ['sulphite', 'sulfite', 'sulphur dioxide', 'sulfur dioxide', 'schwefeldioxid', 'e220', 'e221', 'e222', 'e223', 'e224', 'e226', 'e227', 'e228'] },
];
export const ADDITIONAL_ALLERGENS = [
  { key: 'lupin', label: 'Lupin', kws: ['lupin', 'lupine'] },
  { key: 'sesame', label: 'Sesame', kws: ['sesame', 'sesam'] },
  { key: 'celery', label: 'Celery', kws: ['celery', 'sellerie'] },
  { key: 'mustard', label: 'Mustard', kws: ['mustard', 'senf'] },
];
export const ALL_ALLERGENS = [...SFA_ALLERGENS, ...ADDITIONAL_ALLERGENS];
const LABEL_BY_KEY = Object.fromEntries(ALL_ALLERGENS.map((a) => [a.key, a.label]));
export const allergenLabel = (key) => LABEL_BY_KEY[key] ?? key;

// nut-free scope: peanuts + tree nuts + lupin (cross-reactivity, conservative).
export const NUT_KEYS = ['peanuts', 'treenuts', 'lupin'];
export const DAIRY_KEYS = ['milk'];

// ---- veg/vegan assessment tokens (ingredient region only) ----
const NON_VEG = ['meat', 'beef', 'pork', 'chicken', 'lamb', 'duck', 'turkey', 'bacon', 'ham', 'lard', 'gelatin', 'gelatine', 'rennet', 'carmine', 'cochineal', 'e120', 'anchovy', 'fish', 'shellfish', 'crustacean', 'mollusc', 'fleisch', 'schweinefleisch', 'huhn'];
const NON_VEGAN_EXTRA = ['milk', 'milch', 'whey', 'molke', 'caseinate', 'lactose', 'cream', 'butter', 'egg', 'ei', 'eier', 'albumin', 'honey', 'honig', 'beeswax', 'bienenwachs', 'shellac', 'e901', 'e904', 'lanolin'];
const UNCERTAIN = ['natural flavour', 'natural flavor', 'nature identical flavour', 'vitamin d3', 'cholecalciferol', 'enzymes', 'enzyme'];
const PORK_ALCOHOL = ['pork', 'bacon', 'ham', 'lard', 'alcohol', 'ethanol', 'liquor', 'liqueur', 'wine', 'beer', 'rum', 'brandy', 'whisky', 'whiskey'];
const GELATIN_UNCERTAIN = ['gelatin', 'gelatine'];
const FAVA = ['fava', 'broad bean', 'broadbean', 'kacang parang', 'vicia faba'];

// ---- text helpers (mirror 8-allergen-spotcheck / 8-occurrences) ----
export function normText(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/_/g, ' ').replace(/<[^>]+>/g, ' ').replace(/•/g, ' ').replace(/\s+/g, ' ');
}
function kwRegex(kw) {
  const k = normText(kw);
  return new RegExp('(?<![a-z])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?(?![a-z])', 'i');
}
export function deriveAllergens(text) {
  const n = normText(text);
  const found = new Set();
  for (const a of ALL_ALLERGENS) {
    for (const kw of a.kws) { if (kwRegex(kw).test(n)) { found.add(a.key); break; } }
  }
  return found;
}
function bracketDepths(s) {
  const d = new Array(s.length); let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') { d[i] = depth; depth++; }
    else if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); d[i] = depth; }
    else d[i] = depth;
  }
  return d;
}
const ADVISORY_RX = /(allergens?\s+(information|advice)|may\s+contain|processed\s+in\s+a\s+facility|contains?\s*:|contain(s)?\s+(cereals?\s+containing\s+gluten|cereal\s+containing\s+gluten|gluten|oats?\b|wheat|soy\b|milk)|with\s+gluten\s+containing\s+cereal|contains\s+prebiotic)/gi;
export function splitIngredientVsAdvisory(raw) {
  const s = String(raw).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/•/g, ' ');
  const depths = bracketDepths(s);
  ADVISORY_RX.lastIndex = 0;
  let m;
  while ((m = ADVISORY_RX.exec(s))) {
    if (depths[m.index] === 0 && m.index > 0) return { ingredients: s.slice(0, m.index), advisory: s.slice(m.index) };
  }
  return { ingredients: s, advisory: '' };
}
// PAL-first parsing: "may contain" phrases are extracted BEFORE the contains
// pass so PAL is never labelled "contains" (the core 09 safety rule).
export function declaredSets(advisory) {
  let n = normText(advisory);
  const contains = new Set(), mayContain = new Set();
  const mayPhrases = [];
  n = n.replace(/may\s+contain\s+(?:traces?\s+of\s+)?[^.;\n]+/gi, (m) => { mayPhrases.push(m); return ' '; });
  n = n.replace(/processed\s+in\s+a\s+facility[^.;\n]+/gi, (m) => { mayPhrases.push(m); return ' '; });
  for (const ph of mayPhrases) for (const a of deriveAllergens(ph)) mayContain.add(a);
  const conRx = /contains?\s*:?\s+([^.;\n]+)/gi;
  let m;
  while ((m = conRx.exec(n))) {
    const seg = m[1];
    if (/less than/i.test(seg)) continue; // "Contains less than 0.5%…" is an ingredient declaration
    for (const a of deriveAllergens(seg)) contains.add(a);
  }
  return { contains, mayContain, mayPhrases };
}
function tokensPresent(text, tokens) {
  const n = normText(text);
  return tokens.filter((t) => kwRegex(t).test(n));
}
function advisorySentences(advisory, kind) {
  const out = [];
  for (const sentence of String(advisory).split(/(?<=[.!?])\s+|\n+/)) {
    const t = sentence.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    if (kind === 'pal' && /may\s+contain|processed\s+in\s+a\s+facility/i.test(t)) out.push(t);
    if (kind === 'contains' && /contain/i.test(t) && !/may\s+contain|processed\s+in/i.test(t)) out.push(t);
  }
  return out;
}

// ---- the per-product derivation (build-time, deterministic) ----
export function deriveDietary(product) {
  const raw = product?.ingredients?.text ?? product?.nutrition?.off?.ingredientsText ?? null;
  const source = product?.ingredients?.text ? 'retailer ingredients' : (raw ? 'OFF ingredients text' : null);
  const assessable = Boolean(raw);
  const { ingredients, advisory } = assessable ? splitIngredientVsAdvisory(raw) : { ingredients: '', advisory: '' };
  const fromIngredients = assessable ? deriveAllergens(ingredients) : new Set();
  const declared = assessable ? declaredSets(advisory) : { contains: new Set(), mayContain: new Set(), mayPhrases: [] };

  // CONTAINS = declared-contains ∪ ingredient-assessed (ingredient presence IS
  // containment). PAL stays strictly separate — never merged, never "contains".
  const containsKeys = [...new Set([...declared.contains, ...fromIngredients])].sort();
  const palKeys = [...declared.mayContain].sort();
  const contains = containsKeys.map((key) => ({
    key, label: allergenLabel(key),
    sources: [
      ...(declared.contains.has(key) ? ['label-declared'] : []),
      ...(fromIngredients.has(key) ? ['ingredient-assessed'] : []),
    ],
  }));
  const pal = palKeys.map((key) => ({ key, label: allergenLabel(key) }));
  const hitKeys = new Set([...containsKeys, ...palKeys]);
  const hitsFor = (keys) => keys.filter((k) => hitKeys.has(k)).map((k) => ({ key: k, label: allergenLabel(k), via: declared.contains.has(k) || fromIngredients.has(k) ? 'contains' : 'PAL' }));

  const nutHits = hitsFor(NUT_KEYS);
  const dairyHits = hitsFor(DAIRY_KEYS);
  const gfClaim = product?.attributes?.glutenFreeClaim === true;
  const nonVeg = assessable ? tokensPresent(ingredients, NON_VEG) : [];
  const nonVegan = assessable ? tokensPresent(ingredients, NON_VEGAN_EXTRA) : [];
  const uncertain = assessable ? tokensPresent(ingredients, UNCERTAIN) : [];
  const vegConforms = assessable && nonVeg.length === 0 && uncertain.length === 0;
  const veganConforms = assessable && nonVeg.length === 0 && nonVegan.length === 0 && uncertain.length === 0;

  const halalStatus = product?.halal?.status;
  const halalState = halalStatus === 'certified' ? 'certified' : (halalStatus === 'not-certified' ? 'not-certified' : 'unknown');
  const porkAlcoholTokens = assessable ? tokensPresent(ingredients, PORK_ALCOHOL) : [];
  const gelatinUncertain = assessable ? tokensPresent(ingredients, GELATIN_UNCERTAIN) : [];
  const favaTokens = assessable ? tokensPresent(ingredients, FAVA) : [];

  const cannot = { conforms: false, basis: 'cannot-verify', reason: 'No ingredient text published — cannot verify; excluded while this ingredient-assessed toggle is active (never silently included). Gluten-free is claim-based: a GF label claim is its own verification.' };
  return {
    assessable, source,
    allergens: {
      contains, pal,
      containsStatements: advisorySentences(advisory, 'contains'),
      palStatements: advisorySentences(advisory, 'pal'),
      note: 'CONTAINS = label-declared ∪ ingredient-assessed. PAL ("may contain") is advisory, kept separate, and treated as an EXCLUSION under active free-from toggles — never labelled "contains".',
    },
    toggles: {
      nutFree: !assessable ? cannot : { conforms: nutHits.length === 0, basis: 'verified-free', hits: nutHits, scope: 'peanuts + tree nuts + lupin (cross-reactivity, conservative)' },
      dairyFree: !assessable ? cannot : { conforms: dairyHits.length === 0, basis: 'verified-free', hits: dairyHits, scope: 'milk' },
      glutenFree: { conforms: gfClaim, basis: gfClaim ? 'label-claim' : 'no-label-claim', note: 'Gluten-free is LABEL-CLAIM ONLY (SG legal definition ≤20 mg/kg) — never inferred from ingredient absence.' },
      vegetarian: !assessable ? cannot : { conforms: vegConforms, basis: 'assessed-from-ingredients', conflicts: nonVeg, uncertain, note: 'Assessed from ingredients — not a certification. Undeclared-source tokens (natural flavours, vitamin D3, enzymes) make the assessment uncertain → excluded under the toggle.' },
      vegan: !assessable ? cannot : { conforms: veganConforms, basis: 'assessed-from-ingredients', conflicts: [...nonVeg, ...nonVegan], uncertain, note: 'Assessed from ingredients — vegetarian rules plus milk/egg/honey/beeswax/shellac/lanolin exclusion; uncertain sources excluded.' },
    },
    halal: {
      state: halalState,
      certified: halalState === 'certified',
      basis: product?.halal?.basis ?? null,
      porkAlcohol: { flag: porkAlcoholTokens.length > 0, tokens: porkAlcoholTokens, uncertain: gelatinUncertain, note: 'Certification-only rule: Halal status is never inferred. Pork/alcohol tokens are an ingredient ASSESSMENT shown separately; gelatin with undeclared source is uncertain, never assumed pork.' },
    },
    g6pd: { fava: favaTokens.length > 0, tokens: favaTokens, assessable, note: 'G6PD deficiency (~1.5% of SG population): fava/broad-bean ingredients trigger a warning badge.' },
  };
}

// ---- filter predicate (client mirrors this exactly; build-time truth) ----
export const PRICE_BUCKETS = [
  { id: 'any', label: 'Any price' },
  { id: 'under5', label: 'Under $5', test: (p) => p < 5 },
  { id: '5to10', label: '$5–10', test: (p) => p >= 5 && p <= 10 },
];
export function passesFilters(product, filters) {
  const f = filters ?? {};
  if (f.halalOnly && product.dietary?.halal?.state !== 'certified') return false;
  if (f.store && f.store !== 'any') {
    const has = (product.offers ?? []).some((o) => o.store === f.store);
    if (!has) return false;
  }
  if (f.price && f.price !== 'any') {
    const bucket = PRICE_BUCKETS.find((b) => b.id === f.price);
    const price = product.displayOffer?.packPrice;
    if (!bucket?.test || typeof price !== 'number' || !bucket.test(price)) return false;
  }
  for (const key of ['nutFree', 'dairyFree', 'glutenFree', 'vegetarian', 'vegan']) {
    if (f[key] && product.dietary?.toggles?.[key]?.conforms !== true) return false;
  }
  return true;
}
