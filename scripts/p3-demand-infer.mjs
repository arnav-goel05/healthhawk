// HealthHawk P3-10 — department inference for request demand logging.
// PURE function module (zero deps, zero I/O). Consumes the SINGLE department
// config seam (scripts/departments.config.mjs, slice P3-02) — it never copies
// chip/range/label vocabulary; every keyword is DERIVED from the config labels
// at call time, so a new aisle is a config/data event, not a code change.
//
// Honesty rule: a product whose text carries no configured aisle vocabulary is
// logged as "unclassified" — never guessed into an aisle. Ambiguous ties
// between departments are also "unclassified" (honest ambiguity).
//
// Consumers: scripts/p3-demand-sync.mjs (queue entries) and
// scripts/p3-demand-readout.mjs (zero-result search terms).

import { DEPARTMENTS } from './departments.config.mjs';

export const UNCLASSIFIED = 'unclassified';

// Generic words that carry no aisle signal (English stopwords + generic
// modifiers). This is NOT department vocabulary — the aisle words themselves
// come only from the config labels.
const STOPWORDS = new Set([
  'all', 'and', 'the', 'of', 'with', 'for', 'plain', 'hot', 'flavoured',
  'flavored', 'instant', 'outside', 'comparison', 'nutri', 'grade', 'kids',
]);

// Tokenize + normalize: lowercase letters only, crude singularization
// (oats→oat, flakes→flake, cereals→cereal, bars→bar) so pack wording matches
// the config labels regardless of plural.
export function normalizeTokens(text) {
  const out = [];
  for (const raw of String(text ?? '').toLowerCase().split(/[^a-z]+/)) {
    if (!raw) continue;
    const t = raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw;
    if (!STOPWORDS.has(t)) out.push(t);
  }
  return out;
}

// Derive the aisle keyword vocabulary from the config ONLY: department label
// + every range label + every chip label. Returned as dept → sorted token set.
// The optional `departments` override is the same TEST-fixture seam the config
// helpers use (a second aisle without touching the live config).
export function vocabularyTokens(departments = DEPARTMENTS) {
  const out = {};
  for (const [id, d] of Object.entries(departments)) {
    const labels = [d.label, ...Object.values(d.ranges).map((r) => r.label), ...d.chips.map((c) => c.label)];
    const tokens = new Set();
    for (const label of labels) for (const t of normalizeTokens(label)) tokens.add(t);
    out[id] = [...tokens].sort();
  }
  return out;
}

// Infer the department for a requested product name/brand (free text).
// Pure + deterministic: score = count of DISTINCT configured aisle tokens
// present in the text; the unique highest scorer wins; zero score or a tie
// → UNCLASSIFIED (never guessed). matchedTokens is sorted for stable logs.
export function inferDepartment(text, departments = DEPARTMENTS) {
  const tokens = new Set(normalizeTokens(text));
  const vocab = vocabularyTokens(departments);
  let best = null;
  let bestScore = 0;
  let tie = false;
  const matched = {};
  for (const [id, words] of Object.entries(vocab)) {
    const hits = words.filter((w) => tokens.has(w));
    matched[id] = hits;
    if (hits.length > bestScore) { best = id; bestScore = hits.length; tie = false; }
    else if (hits.length === bestScore && hits.length > 0) tie = true;
  }
  if (!best || tie) {
    return { department: UNCLASSIFIED, via: 'unclassified', matchedTokens: [] };
  }
  return { department: best, via: 'config-vocabulary', matchedTokens: matched[best] };
}

// Map a zero-result log's chip id to its owning department via the config.
// The shared "all" chip spans every aisle (aisle-wide escape hatch) — it is
// NOT department evidence, so it maps to null and the caller falls back to
// query-text inference. Unknown chip ids → null.
export function departmentForChip(chipId, departments = DEPARTMENTS) {
  if (!chipId || chipId === 'all') return null;
  const owners = Object.entries(departments)
    .filter(([, d]) => d.chips.some((c) => c.id === chipId))
    .map(([id]) => id);
  return owners.length === 1 ? owners[0] : null;
}