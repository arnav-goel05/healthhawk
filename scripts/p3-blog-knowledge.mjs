#!/usr/bin/env node
// HealthHawk P3 — blog-knowledge feeder (read-only derivation, freeze-safe).
// Derives deterministic KB facts + entries from the catalogue, claim findings
// and approval queue. NEVER writes data/, app/ or pending/ — output lands
// ONLY under the out dir (default runs/blog-knowledge/). Zero deps, no network.
//
// Reused contracts (single source of truth, never re-implemented):
//   - approval gate: scripts/approval-gate.mjs (gradeApproved, readPendingQueue)
//   - eligibility:   scripts/12-basket.mjs (rated===true && score.grade &&
//                    numeric S[best-value] && gradeApproved)
//   - presets:       scripts/score.mjs PRESETS (Healthiest w=0.8, excludes E)
//   - primaryOffer:  scripts/12-sync.mjs (lowest pack price, tie store asc)
// Ranking: stored score.S[healthiest] desc, tie-break EAN asc (12-basket
// convention). Missing data stays 'Unknown' / 'Not yet rated' — never invented.
//
// Usage: node scripts/p3-blog-knowledge.mjs build [--out <dir>]
//        [--catalogue <path>] [--pending <dir>] [--findings <path>]  (test overrides)
// Exit codes: 0 ok · 2 corrupt/missing catalogue (or findings) / unsafe out dir.
// Idempotent: byte-identical output except _meta.derivedAt (and the freshness
// entry that quotes it). Contract doc: docs/blog-knowledge-feeder.md.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPendingQueue, gradeApproved } from './approval-gate.mjs';
import { PRESETS } from './score.mjs';
import { primaryOffer } from './12-sync.mjs';
import { isMain } from './is-main.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const APP_BASE = 'https://healthhawk.geo.hashmeta.tech';
export const COMPARE_URL = `${APP_BASE}/compare`;
export const CONTENT_MAX = 4000;
export const KEYWORDS_MAX = 30;

const WEETBIX_EAN = '9414942010378';
const CORNFLAKES_EAN = '8852756304053';
const GOLD_EAN = '4800361310031';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const productUrl = (ean) => `${APP_BASE}/products/${ean}`;
const day = (iso) => (typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : 'Unknown');
const money = (n) => (isNum(n) ? `S$${n.toFixed(2)}` : 'Unknown');
const num = (n) => (isNum(n) ? String(n) : 'Unknown');

// ---------- pure derivation ----------

export function computeCoverage(cat) {
  const products = cat.products;
  const ratedCount = products.filter((p) => p.rated === true).length;
  const stores = [...new Set(products.flatMap((p) => (p.offers ?? []).map((o) => o.store)).filter(Boolean))].sort();
  const rangeCounts = {};
  for (const p of products) rangeCounts[p.range] = (rangeCounts[p.range] ?? 0) + 1;
  return {
    totalProducts: products.length,
    ratedCount,
    unratedCount: products.length - ratedCount,
    stores,
    beverageCount: products.filter((p) => p.range === 'BEV').length,
    cerealCount: products.filter((p) => /^R[1-5]$/.test(p.range)).length,
    outOfScopeCount: products.filter((p) => p.range === 'out-of-scope').length,
    rangeCounts,
    splitBasis: 'range field: BEV = beverages (sg-nutrigrade-beverages); R1-R5 = cereal comparison ranges; out-of-scope excluded from both',
    source: 'data/catalogue.json',
  };
}

export function computeGradeDistribution(cat) {
  const counts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  let ratedMissingGrade = 0;
  for (const p of cat.products) {
    if (p.rated !== true) continue;
    const g = p.score?.grade;
    if (g && Object.hasOwn(counts, g)) counts[g] += 1;
    else ratedMissingGrade += 1;
  }
  return { counts, ratedMissingGrade, source: 'data/catalogue.json (score.grade as stored)' };
}

// Basket eligibility gate (12-basket.mjs) + Healthiest preset ranking.
export function computeTopPicks(cat, queue, top = 5) {
  const preset = PRESETS.find((p) => p.id === 'healthiest');
  const rated = cat.products.filter((p) => p.rated === true && p.score?.grade && isNum(p.score?.S?.['best-value']));
  const approved = rated.filter((p) => gradeApproved(queue, p.ean, p.score.grade));
  const pool = approved
    .filter((p) => !preset.excludeGrades.includes(p.score.grade) && isNum(p.score.S[preset.id]))
    .sort((a, b) => b.score.S[preset.id] - a.score.S[preset.id] || String(a.ean).localeCompare(String(b.ean)));
  const picks = pool.slice(0, top).map((p) => {
    const offer = primaryOffer(p);
    return {
      name: p.name, ean: p.ean, grade: p.score.grade, range: p.range,
      healthiestS: p.score.S[preset.id],
      price: offer?.packPrice ?? null, packSize: offer?.packSize ?? null, store: offer?.store ?? null,
      pricePer100g: offer?.pricePer100g ?? null, priceCheckedAt: offer?.priceCheckedAt ?? null,
      sourceUrl: offer?.sourceUrl ?? null, productUrl: productUrl(p.ean),
    };
  });
  const wValue = Math.round((1 - preset.w) * 100) / 100;
  return {
    preset: `healthiest (w=${preset.w}, S=${preset.w}*H+${wValue}*V, excludeGrades:[${preset.excludeGrades.join(',')}])`,
    eligibility: '12-basket.mjs gate: rated===true && score.grade && numeric S[best-value] && gradeApproved(pending grade-change, status approved + review + proposedGrade match)',
    eligibleCount: approved.length,
    ratedCount: rated.length,
    excludedUnapproved: rated.length - approved.length,
    picks,
    source: 'data/catalogue.json + pending/ (grade-change approvals); logic scripts/12-basket.mjs + scripts/approval-gate.mjs + scripts/score.mjs PRESETS',
  };
}

function priceBlock(p) {
  const offer = primaryOffer(p);
  if (!offer) return null;
  return {
    price: offer.packPrice ?? null, packSize: offer.packSize ?? null, store: offer.store ?? null,
    pricePer100g: offer.pricePer100g ?? null, priceCheckedAt: offer.priceCheckedAt ?? null, sourceUrl: offer.sourceUrl ?? null,
  };
}

function gradeApprovalFor(queue, ean, grade, { withScope = false } = {}) {
  const item = (queue ?? []).find((it) => it.kind === 'grade-change' && it.ean === ean
    && it.status === 'approved' && it.review != null
    && (it.proposedGrade == null || it.proposedGrade === grade));
  if (!item) return null;
  const out = { itemId: item.id, proposedGrade: item.proposedGrade ?? null, approvedAt: item.review.approvedAt ?? null };
  if (withScope) out.scope = item.review.scope ?? null;
  else out.approver = item.review.approver ?? null;
  out.source = `pending/${item.id}.json`;
  return out;
}

function claimFlagFor(queue, ean, verdict) {
  return (queue ?? []).find((it) => it.kind === 'claim-flag' && it.ean === ean
    && it.status === 'approved' && it.review != null && it.evidence?.verdict === verdict) ?? null;
}

function findingFor(findings, ean, ruleId, verdict) {
  return (findings ?? []).find((f) => f.ean === ean && f.ruleId === ruleId && f.verdict === verdict) ?? null;
}

function weetBixBlock(cat, queue, findings) {
  const p = cat.products.find((x) => x.ean === WEETBIX_EAN);
  if (!p) return null;
  const finding = findingFor(findings, WEETBIX_EAN, 'CLM-WG-PERCENT', 'ok');
  const blogDraft = (queue ?? []).find((it) => it.kind === 'blog-draft' && it.status === 'approved'
    && it.review != null && /honesty beat/.test(it.review.scope ?? '') && /Weet-Bix/.test(it.review.scope ?? ''));
  const unverified = claimFlagFor(queue, WEETBIX_EAN, 'unverified');
  return {
    ean: p.ean, name: p.name, range: p.range, rated: p.rated === true,
    grade: p.score?.grade ?? null, points: p.score?.points ?? null,
    H: p.score?.H ?? null, V: p.score?.V ?? null, S: p.score?.S ?? null,
    price: priceBlock(p),
    productUrl: productUrl(p.ean),
    wholegrainClaimCheck: finding,
    wholegrainClaimCheckSource: 'data/claims/findings.json (findings[] ruleId CLM-WG-PERCENT, verdict ok)',
    wholegrainOkApproval: blogDraft ? {
      note: 'No standalone pending/ approval item exists for the CLM-WG-PERCENT ok finding. It is published via the approved blog-draft honesty beat.',
      blogDraftItem: blogDraft.id,
      blogDraftApprovedAt: blogDraft.review.approvedAt ?? null,
      blogDraftScopeQuote: (blogDraft.review.scope ?? '').match(/honesty beat \([^)]*\)/)?.[0] ?? null,
      source: `pending/${blogDraft.id}.json (review.scope, approvedAt)`,
    } : null,
    gradeApproval: gradeApprovalFor(queue, WEETBIX_EAN, p.score?.grade),
    unverifiedClaimFlag: unverified ? {
      itemId: unverified.id,
      quotedClaim: unverified.evidence.quotedClaim ?? null,
      verdict: unverified.evidence.verdict,
      approvedAt: unverified.review.approvedAt ?? null,
      caveatVerbatim: unverified.review.claimNote ?? null,
      source: `pending/${unverified.id}.json`,
    } : null,
    source: 'data/catalogue.json + data/claims/findings.json + pending/',
  };
}

function cornflakesBlock(cat, queue) {
  const p = cat.products.find((x) => x.ean === CORNFLAKES_EAN);
  if (!p) return null;
  const s = p.score ?? {};
  return {
    ean: p.ean, name: p.name, range: p.range, rated: p.rated === true,
    grade: s.grade ?? null, points: s.points ?? null,
    pointsBreakdown: {
      negativePoints: s.negativePoints ?? null, positivePoints: s.positivePoints ?? null,
      proteinCounted: s.proteinCounted ?? null, components: s.components ?? null,
    },
    price: priceBlock(p),
    gradeApproval: gradeApprovalFor(queue, CORNFLAKES_EAN, s.grade, { withScope: true }),
    productUrl: productUrl(p.ean),
    source: 'data/catalogue.json + pending/',
  };
}

function goldCornflakesBlock(cat, queue, findings) {
  const p = cat.products.find((x) => x.ean === GOLD_EAN);
  if (!p) return null;
  const flag = claimFlagFor(queue, GOLD_EAN, 'misleading');
  const finding = findingFor(findings, GOLD_EAN, 'CLM-WG-SHARE', 'misleading');
  return {
    ean: p.ean, name: p.name, range: p.range,
    grade: p.score?.grade ?? null, points: p.score?.points ?? null,
    price: priceBlock(p),
    quotedClaim: flag?.evidence?.quotedClaim ?? null,
    quotedLabelEvidence: flag?.evidence?.quotedIngredient ?? null,
    ingredientListQuote: finding?.evidence?.ingredientListQuote ?? null,
    claimSourceContext: flag?.evidence?.claimSource ?? null,
    ruleId: flag?.evidence?.ruleId ?? null,
    verdict: flag?.evidence?.verdict ?? null,
    approvalDate: flag?.review?.approvedAt ?? null,
    approver: flag?.review?.approver ?? null,
    caveatVerbatim: flag?.review?.claimNote ?? null,
    approvalScope: flag?.review?.scope ?? null,
    thresholdSource: flag?.evidence?.thresholdSource ?? null,
    catalogueClaimCheck: finding,
    productUrl: productUrl(p.ean),
    source: flag ? `pending/${flag.id}.json + data/claims/findings.json + data/catalogue.json` : 'data/claims/findings.json + data/catalogue.json',
  };
}

export function buildFacts(cat, { queue = [], findings = [], derivedAt = new Date().toISOString() } = {}) {
  return {
    _meta: {
      derivedAt,
      catalogueUpdatedAt: cat.updatedAt ?? null,
      sources: ['data/catalogue.json', 'data/claims/findings.json', 'pending/ (grade-change + claim-flag + blog-draft approvals)'],
      readOnly: true,
    },
    coverage: computeCoverage(cat),
    gradeDistribution: computeGradeDistribution(cat),
    topPicks: computeTopPicks(cat, queue),
    weetBix: weetBixBlock(cat, queue, findings),
    cornflakes: cornflakesBlock(cat, queue),
    goldCornflakes: goldCornflakesBlock(cat, queue, findings),
  };
}

// ---------- KB entries ----------

const DISCLAIMER = 'Hawk Grades compare products within the same category only — not medical or dietary advice. Prices and labels change; always check the pack in store.';

function latestPriceDate(cat) {
  const dates = cat.products.flatMap((p) => (p.offers ?? []).map((o) => o.priceCheckedAt)).filter((d) => typeof d === 'string').sort();
  return dates.length > 0 ? day(dates[dates.length - 1]) : 'Unknown';
}

function coverageEntry(facts, priceDate) {
  const c = facts.coverage;
  const ranges = Object.entries(c.rangeCounts).map(([r, n]) => `${r}: ${n}`).join(' · ');
  return {
    matchTitle: 'Catalogue coverage today', category: 'site', title: 'Catalogue coverage today', pinned: true,
    keywords: ['coverage', 'catalogue', 'rated', 'unrated', 'products', 'FairPrice', 'HealthHawk', 'ranges', 'beverages', 'cereals', 'Not yet rated'],
    content: [
      `Catalogue coverage (source: data/catalogue.json, catalogue updated ${facts._meta.catalogueUpdatedAt ?? 'Unknown'}; facts derived ${facts._meta.derivedAt}).`,
      `- Total products: ${c.totalProducts}. Rated: ${c.ratedCount}. Not yet rated: ${c.unratedCount} — browsable but never ranked; no fabricated scores.`,
      `- Stores: ${c.stores.join(', ') || 'Unknown'}.`,
      `- Comparison ranges: ${ranges}. Beverages (BEV): ${c.beverageCount}; cereals (R1–R5): ${c.cerealCount}; out-of-scope: ${c.outOfScopeCount} (excluded from comparisons).`,
      `- Prices checked ${priceDate} (per-offer priceCheckedAt in data/catalogue.json; retailer product pages).`,
      DISCLAIMER,
    ].join('\n'),
  };
}

function distributionEntry(facts) {
  const d = facts.gradeDistribution;
  const counts = Object.entries(d.counts).map(([g, n]) => `${g}: ${n}`).join(' · ');
  return {
    matchTitle: null, category: 'site', title: 'Grade distribution — rated products', pinned: false,
    keywords: ['Hawk Grade', 'grade distribution', 'A', 'B', 'C', 'D', 'E', 'rated', 'Nutri-Score 2023', 'Nutri-Grade', 'HealthHawk'],
    content: [
      `Hawk Grade distribution — rated products only (source: data/catalogue.json score.grade as stored, catalogue updated ${facts._meta.catalogueUpdatedAt ?? 'Unknown'}; derived ${facts._meta.derivedAt}).`,
      `${counts} (total rated: ${facts.coverage.ratedCount}; rated missing grade: ${d.ratedMissingGrade}).`,
      `Grades are HealthHawk's own "Hawk Grade", derived using the Nutri-Score 2023 algorithm (Santé publique France) — never the official Nutri-Score mark. Beverages use SG Nutri-Grade A–D (no E). Unrated products (${facts.coverage.unratedCount}) show "Not yet rated", never a guess.`,
      DISCLAIMER,
    ].join('\n'),
  };
}

function topPicksEntry(facts, priceDate) {
  const t = facts.topPicks;
  const lines = t.picks.map((p, i) => `${i + 1}. ${p.name} — Hawk Grade ${p.grade}, ${money(p.price)} / ${p.packSize ?? 'Unknown'} (${isNum(p.pricePer100g) ? `S$${p.pricePer100g} per 100g` : 'per-100g Unknown'}), ${p.store ?? 'Unknown'}, price checked ${day(p.priceCheckedAt)}. ${p.productUrl} · source: ${p.sourceUrl ?? 'Unknown'}`);
  return {
    matchTitle: null, category: 'site', title: 'Top picks — Healthiest preset', pinned: false,
    keywords: ['top picks', 'healthiest', 'preset', 'rolled oats', 'Hawk Grade A', 'FairPrice', 'price per 100g', 'approval gate', 'HealthHawk'],
    content: [
      `Top picks — Healthiest preset (${t.preset}). Source: data/catalogue.json stored scores + pending/ grade-change approvals; prices checked ${priceDate}; derived ${facts._meta.derivedAt}.`,
      ...lines,
      `Eligibility: rated + approved grade (approval gate); ${t.eligibleCount} of ${t.ratedCount} rated products eligible (${t.excludedUnapproved} rated-but-unapproved excluded). Cheapest pack price at check time — always verify in store.`,
      DISCLAIMER,
    ].join('\n'),
  };
}

function weetBixEntry(facts) {
  const w = facts.weetBix;
  const title = 'Weet-Bix 375g (FairPrice)';
  if (!w) {
    return { matchTitle: null, category: 'product', title, pinned: false, keywords: ['Weet-Bix', 'Sanitarium', 'Unknown'], content: `${title}: Unknown — EAN ${WEETBIX_EAN} is not in the current catalogue (source: data/catalogue.json, derived ${facts._meta.derivedAt}). Not yet rated.` };
  }
  const f = w.wholegrainClaimCheck;
  const lines = [
    `${w.name} (EAN ${w.ean}, ${w.price?.store ?? 'Unknown'}). Source: data/catalogue.json, updated ${facts._meta.catalogueUpdatedAt ?? 'Unknown'}; derived ${facts._meta.derivedAt}.`,
    `Hawk Grade ${w.grade ?? 'Not yet rated'} (${num(w.points)} points). Price ${money(w.price?.price)} / ${w.price?.packSize ?? 'Unknown'} = ${isNum(w.price?.pricePer100g) ? `S$${w.price.pricePer100g} per 100g` : 'per-100g Unknown'}, checked ${day(w.price?.priceCheckedAt)} (source: ${w.price?.sourceUrl ?? 'Unknown'}).`,
  ];
  if (f) {
    lines.push(`Claim check — "${f.quotedClaim}": verdict ${f.verdict.toUpperCase()}. Label evidence: "${f.evidence?.quotedIngredient ?? 'Unknown'}" (${f.evidence?.ingredientSource ?? 'Unknown'}). Rule ${f.ruleId}: ${f.threshold?.rule ?? 'Unknown'}. Source: data/claims/findings.json; ${f.threshold?.pageRef ?? 'Unknown'} (${f.threshold?.sourceUrl ?? 'Unknown'}).`);
  } else {
    lines.push('Wholegrain claim check: Unknown (no CLM-WG-PERCENT ok finding in data/claims/findings.json).');
  }
  if (w.wholegrainOkApproval) lines.push(`Publication approval: blog draft ${w.wholegrainOkApproval.blogDraftItem}, approved ${w.wholegrainOkApproval.blogDraftApprovedAt ?? 'Unknown'} — scope "${w.wholegrainOkApproval.blogDraftScopeQuote ?? 'Unknown'}" (${w.wholegrainOkApproval.source}).`);
  if (w.gradeApproval) lines.push(`Grade approval: ${w.gradeApproval.itemId} (grade ${w.gradeApproval.proposedGrade ?? 'Unknown'}), approved ${w.gradeApproval.approvedAt ?? 'Unknown'} — HealthHawk approval record (${w.gradeApproval.source}).`);
  if (w.unverifiedClaimFlag) lines.push(`Also flagged: "${w.unverifiedClaimFlag.quotedClaim}" — ${w.unverifiedClaimFlag.verdict.toUpperCase()} (no SG statutory definition). Caveat verbatim: "${w.unverifiedClaimFlag.caveatVerbatim}" Approved ${w.unverifiedClaimFlag.approvedAt ?? 'Unknown'} (${w.unverifiedClaimFlag.source}).`);
  lines.push(`Product page: ${w.productUrl}`);
  return { matchTitle: null, category: 'product', title, pinned: false, keywords: ['Weet-Bix', 'Sanitarium', '97% wholegrain', 'wholegrain', 'Hawk Grade A', 'FairPrice', 'claim check', 'long-lasting goodness', 'unverified', '9414942010378'], content: lines.join('\n') };
}

function cornflakesEntry(facts) {
  const c = facts.cornflakes;
  const title = "Kellogg's Cornflakes 275g (FairPrice)";
  if (!c) {
    return { matchTitle: title, category: 'product', title, pinned: false, keywords: ['Kellogg', 'Cornflakes', 'Unknown'], content: `${title}: Unknown — EAN ${CORNFLAKES_EAN} is not in the current catalogue (source: data/catalogue.json, derived ${facts._meta.derivedAt}). Not yet rated.` };
  }
  const b = c.pointsBreakdown;
  const neg = b.components?.negative;
  const pos = b.components?.positive;
  const lines = [
    `${c.name} (EAN ${c.ean}, ${c.price?.store ?? 'Unknown'}). Source: data/catalogue.json, updated ${facts._meta.catalogueUpdatedAt ?? 'Unknown'}; derived ${facts._meta.derivedAt}.`,
    `Hawk Grade ${c.grade ?? 'Not yet rated'} (${num(c.points)} points). Price ${money(c.price?.price)} / ${c.price?.packSize ?? 'Unknown'} = ${isNum(c.price?.pricePer100g) ? `S$${c.price.pricePer100g} per 100g` : 'per-100g Unknown'}, checked ${day(c.price?.priceCheckedAt)} (source: ${c.price?.sourceUrl ?? 'Unknown'}).`,
  ];
  if (neg) {
    lines.push(`Points breakdown (Nutri-Score 2023 general foods, per 100g): negative ${num(b.negativePoints)} = energy ${num(neg.energy?.points)} (${num(neg.energy?.value)} kJ) + sugars ${num(neg.sugars?.points)} (${num(neg.sugars?.value)} g) + saturated fat ${num(neg.saturatedFat?.points)} (${num(neg.saturatedFat?.value)} g) + salt ${num(neg.salt?.points)} (${num(neg.salt?.sodiumMg)} mg sodium). Positive ${num(b.positivePoints)} (fvl ${num(pos?.fvl?.points)}, fibre ${num(pos?.fibre?.points)} at ${num(pos?.fibre?.value)} g); protein ${num(pos?.protein?.points)} points ${b.proteinCounted ? 'counted' : 'NOT counted (N≥11 rule)'}.`);
  }
  if (c.gradeApproval) {
    lines.push(`Grade approval: ${c.gradeApproval.itemId}, approved ${c.gradeApproval.approvedAt ?? 'Unknown'}. Scope verbatim: "${c.gradeApproval.scope}" (${c.gradeApproval.source}).`);
  }
  lines.push(`Product page: ${c.productUrl}`);
  return { matchTitle: title, category: 'product', title, pinned: false, keywords: ['Kellogg', 'Cornflakes', 'Hawk Grade D', 'FairPrice', 'sodium', 'salt', 'points breakdown', 'Nutri-Score 2023', '8852756304053'], content: lines.join('\n') };
}

function goldCornflakesEntry(facts) {
  const g = facts.goldCornflakes;
  const title = 'Nestlé Gold Cornflakes 500g (FairPrice)';
  if (!g) {
    return { matchTitle: null, category: 'product', title, pinned: false, keywords: ['Nestlé', 'Gold Cornflakes', 'Unknown'], content: `${title}: Unknown — EAN ${GOLD_EAN} is not in the current catalogue (source: data/catalogue.json, derived ${facts._meta.derivedAt}). Not yet rated.` };
  }
  const lines = [
    `${g.name} (EAN ${g.ean}, ${g.price?.store ?? 'Unknown'}). Source: data/catalogue.json, updated ${facts._meta.catalogueUpdatedAt ?? 'Unknown'}; derived ${facts._meta.derivedAt}.`,
    `Hawk Grade ${g.grade ?? 'Not yet rated'} (${num(g.points)} points). Price ${money(g.price?.price)} / ${g.price?.packSize ?? 'Unknown'} = ${isNum(g.price?.pricePer100g) ? `S$${g.price.pricePer100g} per 100g` : 'per-100g Unknown'}, checked ${day(g.price?.priceCheckedAt)} (source: ${g.price?.sourceUrl ?? 'Unknown'}).`,
  ];
  if (g.verdict) {
    lines.push(`Claim flag — ${g.verdict.toUpperCase()} (rule ${g.ruleId}), approved ${g.approvalDate ?? 'Unknown'} — HealthHawk approval record.`);
    lines.push(`Quoted claim (pack front, OCR): "${g.quotedClaim}". Quoted label evidence (ingredient list): "${g.quotedLabelEvidence}".`);
    const note = g.catalogueClaimCheck?.notes?.[0];
    if (note) lines.push(`Finding note verbatim: "${note}"`);
    if (g.thresholdSource) lines.push(`Threshold: ${g.thresholdSource.pageRef} — ${g.thresholdSource.url}`);
    lines.push(`Caveat verbatim: "${g.caveatVerbatim}" Approval: ${g.source.split(' + ')[0]}.`);
  } else {
    lines.push('Claim flag: Unknown (no approved misleading claim-flag item in pending/).');
  }
  lines.push(`Product page: ${g.productUrl}`);
  return { matchTitle: null, category: 'product', title, pinned: false, keywords: ['Nestlé', 'Gold Cornflakes', 'Whole Grain Guaranteed', 'misleading', 'wholegrain', 'Corn Semolina', 'CLM-WG-SHARE', 'reg 40A', 'Hawk Grade C', '4800361310031'], content: lines.join('\n') };
}

function compareLinkEntry(facts) {
  return {
    matchTitle: 'Compare app link', category: 'site', title: 'Compare app link', pinned: true,
    keywords: ['compare', 'app link', 'HealthHawk', 'compare page', 'native app'],
    content: [
      `HealthHawk compare app: ${COMPARE_URL} — the native app page (slug "compare", scripts/12-sync.mjs APP_PAGE). Use this link on every blog/content surface (facts derived ${facts._meta.derivedAt}).`,
      'The old QW Page compare link is RETIRED — never link it.',
      DISCLAIMER,
    ].join('\n'),
  };
}

function freshnessEntry(facts) {
  return {
    matchTitle: null, category: 'site', title: 'Blog facts freshness', pinned: false,
    keywords: ['freshness', 'derivedAt', 'contract', 'approval gate', 'read-only', 'idempotent', 'blog facts'],
    content: [
      `Blog facts freshness: derived ${facts._meta.derivedAt} from catalogue updated ${facts._meta.catalogueUpdatedAt ?? 'Unknown'}.`,
      'Contract: read-only derivation (node scripts/p3-blog-knowledge.mjs build) from data/catalogue.json + data/claims/findings.json + pending/ approvals. Approval gate: a grade is public only with an approved grade-change record (status approved + review + proposedGrade match). Every number carries source + date; missing data stays "Unknown" / "Not yet rated" — never fabricated. Output is idempotent except derivedAt. Full contract: docs/blog-knowledge-feeder.md.',
    ].join('\n'),
  };
}

export function buildEntries(facts, cat, { seed = [] } = {}) {
  const priceDate = latestPriceDate(cat);
  const entries = [
    coverageEntry(facts, priceDate),
    distributionEntry(facts),
    topPicksEntry(facts, priceDate),
    weetBixEntry(facts),
    cornflakesEntry(facts),
    goldCornflakesEntry(facts),
    compareLinkEntry(facts),
    freshnessEntry(facts),
    ...seed,
  ];
  validateEntries(entries);
  return entries;
}

export function validateEntries(entries) {
  for (const e of entries) {
    if (typeof e.title !== 'string' || e.title.length === 0) throw new Error('entry missing title');
    if (typeof e.category !== 'string' || e.category.length === 0) throw new Error(`entry "${e.title}" missing category`);
    if (typeof e.content !== 'string' || e.content.length === 0) throw new Error(`entry "${e.title}" missing content`);
    if (e.content.length > CONTENT_MAX) throw new Error(`entry "${e.title}" content ${e.content.length} chars > ${CONTENT_MAX}`);
    if (!Array.isArray(e.keywords) || e.keywords.length > KEYWORDS_MAX) throw new Error(`entry "${e.title}" keywords missing or > ${KEYWORDS_MAX}`);
    if (!('matchTitle' in e) || typeof e.pinned !== 'boolean') throw new Error(`entry "${e.title}" missing matchTitle/pinned`);
  }
  return entries;
}

// ---------- CLI ----------

function fail2(msg) {
  console.error(msg);
  process.exit(2);
}

const isInside = (child, parent) => child === parent || child.startsWith(parent + sep);

function guardOutDir(out) {
  const forbidden = ['data', 'app', 'pending'].map((d) => resolve(ROOT, d));
  if (out === ROOT || forbidden.some((f) => isInside(out, f) || isInside(f, out))) {
    fail2(`unsafe out dir: ${out} — writes are allowed only outside data/, app/, pending/ (and never the repo root)`);
  }
}

function readCatalogue(path) {
  let cat;
  try {
    cat = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail2(`corrupt or missing catalogue (${path}): ${e.message}`);
  }
  if (!cat || typeof cat !== 'object' || !Array.isArray(cat.products)) fail2(`corrupt catalogue (${path}): missing products array`);
  return cat;
}

function readFindings(path) {
  if (!existsSync(path)) return [];
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail2(`corrupt findings (${path}): ${e.message}`);
  }
  return Array.isArray(doc?.findings) ? doc.findings : [];
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const cmd = args[0];
  if (cmd !== 'build') {
    console.error('Usage: node scripts/p3-blog-knowledge.mjs build [--out <dir>] [--catalogue <path>] [--pending <dir>] [--findings <path>]');
    process.exit(2);
  }
  const out = resolve(arg('--out') ?? resolve(ROOT, 'runs', 'blog-knowledge'));
  guardOutDir(out);
  const cat = readCatalogue(resolve(arg('--catalogue') ?? resolve(ROOT, 'data', 'catalogue.json')));
  const queue = readPendingQueue(resolve(arg('--pending') ?? resolve(ROOT, 'pending')));
  const findings = readFindings(resolve(arg('--findings') ?? resolve(ROOT, 'data', 'claims', 'findings.json')));
  const seedPath = resolve(ROOT, 'scripts', 'p3-blog-knowledge-seed.json');
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

  const facts = buildFacts(cat, { queue, findings });
  const entries = buildEntries(facts, cat, { seed });
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'facts.json'), JSON.stringify(facts, null, 2) + '\n');
  writeFileSync(resolve(out, 'entries.json'), JSON.stringify(entries, null, 2) + '\n');
  console.log(JSON.stringify({ out, facts: resolve(out, 'facts.json'), entries: resolve(out, 'entries.json'), entryCount: entries.length, coverage: { total: facts.coverage.totalProducts, rated: facts.coverage.ratedCount, unrated: facts.coverage.unratedCount }, derivedAt: facts._meta.derivedAt }, null, 2));
}

if (isMain(import.meta.url)) main();