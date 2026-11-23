// HealthHawk P3-02 — the SINGLE department-config seam (PRD-PROTOTYPE3
// Implementation Decisions: generalisation seam). Plain ESM, zero deps.
//
// ONE definition of departments → comparison ranges → chips/labels/icons/
// serving-unit/reference-quantity. Consumers:
//   - scripts/4-classify.mjs  — range/chip vocabulary (derived, never copied)
//   - scripts/build-app.mjs   — projection meta.departments / meta.chips /
//                               meta.rangeLabels / meta.rangeOrder
//   - scripts/p2-claim-gates.mjs — reference quantity (heart-gate sodium limb)
//   - scripts/8-verdicts.mjs  — representative serving (dose-context bowls)
//   - app/index.html client   — reads the projected meta ONLY (no hardcoded
//                               chip/range copies; drift-tested)
//
// A new aisle is a DATA event: add ONE department entry here + catalogue
// rows carrying that department. No classifier, build or client edits.
// Departments with no catalogue data never surface (no empty shelves).
//
// Cereal defaults are the EXACT pre-P3 constants (byte-identical behaviour):
// reference quantity 60 g (HPB guide Fig. 6), representative bowl 30 g
// (label-declared serving on multiple launch SKUs).

// Breakfast launch ranges (PRD three-key model). R1–R5 = cereal ranges;
// BEV = cereal drinks (SG Nutri-Grade, ranked only against drinks);
// out-of-scope = not a cereal (bars/nuts → Snacks): visible with price +
// store, never ranked inside a cereal range. Defined ONCE; the "All" chip
// derives from this list.
const BREAKFAST_RANGE_ORDER = ['R1', 'R2', 'R3', 'R4', 'R5', 'BEV', 'out-of-scope'];

// scoring keys map to the engine constants in scripts/score.mjs
// (general → SCORING_CATEGORY_GENERAL, beverage → SCORING_CATEGORY_BEVERAGE,
// null → never scored). The engine ids themselves stay owned by score.mjs.
export const DEPARTMENTS = {
  Breakfast: {
    label: 'Breakfast',
    icon: 'cereal',
    // P3-04: the aisle's copy vocabulary (single source — the client/build/
    // generator interpolate these, never hardcode cereal words in chrome).
    // iconShape selects the generic pictogram shape for the icon kind above.
    iconShape: 'bowl',
    productNoun: 'cereal',
    productNounPlural: 'cereals',
    // The Codex GSFA food category consulted for this aisle's additive limits
    // (factual regulatory citation, interpolated into dose-context copy).
    codexCategoryLabel: 'breakfast-cereal (06.3)',
    servingUnit: 'bowl',
    servingUnitPlural: 'bowls',
    referenceQuantityG: 60,
    representativeServingG: 30,
    rangeOrder: BREAKFAST_RANGE_ORDER,
    ranges: {
      R1: { label: 'Plain flakes & puffed', scoring: 'general' },
      R2: { label: 'Plain oats & hot cereal', scoring: 'general' },
      R3: { label: 'Flavoured instant & porridge', scoring: 'general' },
      R4: { label: 'Muesli & granola', scoring: 'general' },
      R5: { label: 'Kids cereals', scoring: 'general' },
      // P3-04: range notes are aisle vocabulary too (factual descriptions of
      // THIS department's ranges) — defined once here, projected via meta,
      // rendered by the client from data (no hardcoded range-id branches).
      BEV: {
        label: 'Cereal drinks · Nutri-Grade',
        scoring: 'beverage',
        note: '3-in-1 & instant cereal drinks, graded SG Nutri-Grade A–D reconstituted per 100 ml as consumed (pack instructions) — ranked only against other drinks, never against porridge mixes.',
      },
      'out-of-scope': {
        label: 'Outside cereal comparison',
        scoring: null,
        note: 'Not a cereal (snack format) — shown with live price and store, outside every comparison range and never ranked.',
      },
    },
    // Category chips (user story 3). Plain-language labels; each chip maps to
    // one or more WHOLE ranges — ranking never crosses ranges. Beverages
    // surface under "Instant & flavoured" as their own labelled section
    // (honest grouping: ranked only within BEV on the Nutri-Grade basis).
    chips: [
      { id: 'all', label: 'All', ranges: [...BREAKFAST_RANGE_ORDER] },
      { id: 'kids', label: 'Kids', ranges: ['R5'] },
      { id: 'oats', label: 'Oats', ranges: ['R2'] },
      { id: 'granola-muesli', label: 'Granola & muesli', ranges: ['R4'] },
      { id: 'instant-flavoured', label: 'Instant & flavoured', ranges: ['R3', 'BEV'] },
      { id: 'plain-flakes', label: 'Plain flakes', ranges: ['R1'] },
    ],
  },
};

// Stable display/iteration order (config insertion order).
export const DEPARTMENT_ORDER = Object.keys(DEPARTMENTS);

export function getDepartment(id) {
  return DEPARTMENTS[id] ?? null;
}

// Per-department constant lookups. Unknown departments THROW — cereal
// constants are never silently borrowed by another aisle.
export function referenceQuantityG(id = 'Breakfast') {
  const d = getDepartment(id);
  if (!d) throw new Error(`departments.config: unknown department "${id}" (no reference quantity)`);
  return d.referenceQuantityG;
}

export function representativeServingG(id = 'Breakfast') {
  const d = getDepartment(id);
  if (!d) throw new Error(`departments.config: unknown department "${id}" (no representative serving)`);
  return d.representativeServingG;
}

// Flattened vocabulary over a set of departments (config order, deduped).
// The optional `departments` override exists for fixture projections in
// tests (a second aisle without touching the live config); production
// callers always use the live DEPARTMENTS.
export function rangeOrderFor(ids, departments = DEPARTMENTS) {
  const out = [];
  for (const id of ids) {
    const d = departments[id];
    if (!d) throw new Error(`departments.config: unknown department "${id}"`);
    for (const r of d.rangeOrder) if (!out.includes(r)) out.push(r);
  }
  return out;
}

export function rangeLabelsFor(ids, departments = DEPARTMENTS) {
  const out = {};
  for (const id of ids) {
    const d = departments[id];
    if (!d) throw new Error(`departments.config: unknown department "${id}"`);
    for (const r of d.rangeOrder) out[r] = d.ranges[r].label;
  }
  return out;
}

// Chips over a set of departments, in department order. The shared "All"
// chip spans EVERY included department's ranges (an aisle-wide escape
// hatch); department-specific chips keep their configured whole ranges.
export function chipsFor(ids, departments = DEPARTMENTS) {
  const allRanges = rangeOrderFor(ids, departments);
  const out = [];
  for (const id of ids) {
    const d = departments[id];
    if (!d) throw new Error(`departments.config: unknown department "${id}"`);
    for (const c of d.chips) {
      out.push(c.id === 'all' ? { ...c, ranges: [...allRanges] } : { ...c, ranges: [...c.ranges] });
    }
  }
  return out;
}

// Only departments WITH catalogue data surface (no empty shelves). Unknown
// department values on products are ignored here — the config is the
// vocabulary; unconfigured aisles get no shelf until they are configured.
export function departmentIdsWithData(products, departments = DEPARTMENTS) {
  const present = new Set((products ?? []).map((p) => p?.department).filter(Boolean));
  return Object.keys(departments).filter((id) => present.has(id));
}

// Per-department projection meta (the client renders from this).
export function departmentMetaFor(ids, products, departments = DEPARTMENTS) {
  return ids.map((id) => {
    const d = departments[id];
    const rangeLabels = {};
    const rangeNotes = {};
    for (const r of d.rangeOrder) {
      rangeLabels[r] = d.ranges[r].label;
      if (d.ranges[r].note) rangeNotes[r] = d.ranges[r].note;
    }
    return {
      id,
      label: d.label,
      icon: d.icon,
      // P3-04 copy vocabulary (optional per department; the client falls back
      // to generic words when an aisle has not configured them).
      iconShape: d.iconShape ?? null,
      productNoun: d.productNoun ?? null,
      productNounPlural: d.productNounPlural ?? null,
      codexCategoryLabel: d.codexCategoryLabel ?? null,
      servingUnit: d.servingUnit,
      servingUnitPlural: d.servingUnitPlural,
      referenceQuantityG: d.referenceQuantityG,
      representativeServingG: d.representativeServingG,
      rangeOrder: [...d.rangeOrder],
      rangeLabels,
      rangeNotes,
      chips: d.chips.map((c) => ({ ...c, ranges: [...c.ranges] })),
      productCount: (products ?? []).filter((p) => p?.department === id).length,
    };
  });
}