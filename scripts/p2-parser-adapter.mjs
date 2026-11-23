// HealthHawk P2-10 — consumption adapter: structured parser output → the exact
// seams the claim engine (7a) and the additive decode (build-app) consume.
//
// This module is the PROVEN consumption path (tests/p2-parser-adapter.test.mjs
// runs the real 7a checkClaim functions against adapter output). LIVE wiring
// into scripts/7a-claim-rules.mjs / scripts/build-app.mjs is owned by other
// agents this wave — the precise merge patch lives in runs/p2-10/wiring-patch.md.
//
// Legacy token contract (7a classifyToken shape):
//   { raw, name, percent, wholegrain, refined, freeSugar, sweetener, sugarAlcohol }
// Adapter semantics (the migration's meaning change, shadow-diffed + staged):
//   percent = the node's DECLARED EXACT PRODUCT-BASIS percent, else null.
//   Sub-ingredient-basis percents (parent compound declares its own %),
//   ambiguous-basis percents (unclosed ancestor bracket), bounded declarations
//   ("less than 0.5%") and estimates NEVER appear as legacy product percents —
//   so 7a wholegrainShare(parsed) becomes product-basis-only by construction.
//   The full percent object stays available as token.percentDetail.

import { parseStructured, WHOLEGRAIN_RE, DECLARED_TIERS } from './p2-parser-lib.mjs';

export function legacyPercent(node) {
  const p = node.percent;
  if (p && p.declared && p.value !== null && p.qualifier === null && p.basis === 'product' && DECLARED_TIERS.has(p.tier)) return p.value;
  return null;
}

function toLegacyToken(node) {
  return {
    raw: node.raw,
    name: node.name,
    percent: legacyPercent(node),
    wholegrain: node.flags.wholegrain,
    refined: node.flags.refined,
    freeSugar: node.flags.freeSugar,
    sweetener: node.flags.sweetener,
    sugarAlcohol: node.flags.sugarAlcohol,
    percentDetail: node.percent ?? null,
    estimate: node.estimate ?? null,
    basis: node.basis ?? 'product',
    path: node.path,
    depth: node.depth,
    additiveLinks: node.additiveLinks,
    annotations: node.annotations,
  };
}

// Drop-in replacement for 7a parseIngredientList(text) — same {top, flat, first}
// shape, same pre-order walk, same grain-group descent for `first`.
export function legacyParsedFromStructured(doc) {
  if (!doc) return { top: [], flat: [], first: null };
  const top = doc.tree.map(toLegacyToken);
  const flat = doc.flat.map(toLegacyToken);
  const first = doc.first ? toLegacyToken(doc.first) : null;
  return { top, flat, first };
}

// Convenience seam for the wiring patch: text (+ tier) → legacy parsed.
export function parseIngredientListStructured(text, provenanceTier = 'label-declared', opts = {}) {
  const doc = parseStructured(text, { profile: 'claims', provenanceTier, ...opts });
  return legacyParsedFromStructured(doc);
}

// Structured wholegrain share (product-basis declared percents only). Identical
// to 7a wholegrainShare(legacyParsedFromStructured(doc)) — pinned by tests.
export function structuredWholegrainShare(doc) {
  return doc?.wholegrain?.share ?? null;
}

// Decode projection: the legacy ingredient segment list (byte-identical to
// build-app splitTopLevelIngredients(ingredientListText(raw)) under the 'app'
// profile, and to the 8-occurrences segmentation under the 'decode' profile)
// plus per-segment additive hits with the curated position-band semantics.
export function decodeSegments(doc) {
  if (!doc) return [];
  return doc.additives.segments.map((s) => s.raw);
}

export function decodeAdditiveRecords(doc, ean, productName) {
  if (!doc) return [];
  const out = [];
  for (const seg of doc.additives.segments) {
    for (const h of seg.hits) {
      const rec = {
        ean: String(ean), productName,
        excerpt: seg.raw, matchedTerm: h.term, matchType: h.matchType,
        position: seg.position, totalIngredients: seg.totalIngredients,
        positionBand: seg.positionBand,
      };
      if (seg.positionNote) rec.positionNote = seg.positionNote;
      if (seg.useNote) rec.useNote = seg.useNote;
      out.push({ id: h.id, ...rec });
    }
  }
  return out;
}

// Catalogue-ready structured field (written by scripts/p2-parser-apply.mjs
// AFTER gate consensus — never by the parser itself).
export function structuredForCatalogue(parsedRecord) {
  if (!parsedRecord?.claims) return null;
  const { claims, decode, app } = parsedRecord;
  const percents = claims.flat.filter((n) => n.percent).map((n) => ({
    path: n.path, name: n.name, raw: n.raw,
    value: n.percent.value, min: n.percent.min, max: n.percent.max, estimate: n.percent.estimate,
    basis: n.percent.basis, basisReason: n.percent.basisReason, relativeTo: n.percent.relativeTo ?? null,
    tier: n.percent.tier, declared: n.percent.declared, qualifier: n.percent.qualifier ?? null,
  }));
  return {
    schema: claims.schema,
    parserVersion: claims.parserVersion,
    provenanceTier: claims.provenanceTier,
    sourceTextSha256: claims.sourceTextSha256,
    malformed: claims.malformed,
    prefixNoise: claims.prefixNoise,
    anomalies: claims.anomalies,
    tree: claims.tree,
    percents,
    wholegrain: claims.wholegrain,
    additiveLinks: claims.additives.links,
    additiveExclusions: claims.additives.exclusions,
    decode: {
      segments: decodeSegments(decode),
      additiveRecords: decode ? decode.additives.segments : [],
      bracketsMalformed: decode?.malformed ?? null,
    },
    appSegments: decodeSegments(app),
  };
}
