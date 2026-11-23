// P4-01 — parent-first homepage generator (PRD-P4-SIMPLIFY Implementation
// Decisions: Global + Homepage; User Stories 1–10, 27). Plain ESM, zero deps.
// Supersedes the P3-06 stats-heavy hero / exact-quote teaser rendering.
//
// READ-ONLY on every data source: app/data.json (the built projection),
// app/media-manifest.json (self-hosted media), scripts/departments.config.mjs
// (the single chip/label vocabulary). It NEVER writes data/ and never runs a
// data-writing pipeline. Output is a single rawHtml block for platform page 1
// (home) plus a derivation record for evidence/tests.
//
// NO hardcoded products or counts: every product, price, flag, chip, badge
// count and date below is derived from the projection/config/manifest. Static
// chrome prose (headlines, step descriptions, disclaimers) is voice, not data.
// Display-only: data verdict values stay frozen; plain wording comes from the
// shared render-layer map in scripts/lib/plain-verdicts.mjs.
//
// Regeneration (CMS has no data-binding — re-run when the catalogue changes):
//   node scripts/p3-homepage-build.mjs
//   → runs/p3-06/homepage-block.html + runs/p3-06/homepage-derivation.json
// then stage runs/p3-06/homepage-block.html into page 1 via update_page (manual
// publish mode; the P4 publish slice is the only publish point).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPARTMENTS, departmentIdsWithData, chipsFor } from './departments.config.mjs';
import { plainVerdict } from './lib/plain-verdicts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const GRADE_ORDER = { A: 0, B: 1, C: 2, D: 3, E: 4 };
const SEVERITY = { contradicted: 0, misleading: 1, borderline: 2, unverified: 3 };
const sev = (v) => (SEVERITY[v] == null ? 9 : SEVERITY[v]);

// Parent-friendly claim-source vocabulary (generic chrome, not product data).
function claimWhere(location) {
  const l = String(location || '');
  if (/pack-photo-ocr|pack back|pack front|\[front\]|\[claims\]/i.test(l)) return 'on the pack';
  if (/marketing-copy/i.test(l)) return 'in the marketing copy';
  if (/product name|retailer listing/i.test(l)) return 'in the product listing';
  return 'on the label';
}

// P4 teaser topic vocabulary: a short PARAPHRASE per claim family (generic
// chrome keyed by the dataset's claimFamily — never the exact quotedClaim).
// The exact quote lives one tap deeper in the evidence view, not on the home.
const CLAIM_TOPIC = {
  'wholegrain-main': 'whole grain',
  'wholegrain-unqualified': 'whole grain',
  'comparative-wholegrain': 'more whole grain',
  'low-fat': 'low fat',
  'betaglucan-cholesterol': 'lower cholesterol',
  'heart-implied': 'good for your heart',
  'organic': 'organic',
  'high-protein': 'high protein',
  'kids-sugar': 'good for kids',
  'unregulated-term': 'a healthy-sounding word',
  'comparative-claim (slice-4 detector)': 'better than the rest',
};

// One plain sentence per catch, built from the shared plain-verdict map.
// No exact quotes, no "(contradicted)" tags, no internal policy notes.
function teaserSentence(flag) {
  const topic = CLAIM_TOPIC[flag.claimFamily] || 'healthy';
  const v = plainVerdict(flag.verdict);
  if (flag.verdict === 'contradicted') return `Says “${topic}” — but that ${v}.`;
  return `Says “${topic}” — ${v}.`;
}

// Featured-pick badge in plain words, count DERIVED from the dataset badge.
// "? 1 claim we couldn't check" / "? 2 claims we couldn't check"; real flags
// use the same shared vocabulary ("…that don't match the label").
function flagBadgeText(b) {
  const n = b.count;
  const s = n === 1 ? '' : 's';
  const phrase = plainVerdict(b.worst);
  if (b.worst === 'unverified') return `${b.icon} ${n} claim${s} ${phrase.replace(/\s+this$/, '')}`;
  if (b.worst === 'contradicted') return `${b.icon} ${n} claim${s} that ${n === 1 ? phrase : phrase.replace("doesn't", "don't")}`;
  return `${b.icon} ${n} claim${s} — ${phrase}`;
}

// Raw quote + one-sentence explanation, one tap deeper (≤2 lines). The
// explanation is the dataset plain line with the verdict tag stripped.
function flagProof(p, badge) {
  const pf = ((p.result && p.result.plain && p.result.plain.flags) || []).find((x) => x.quotedClaim === badge.quotedClaim);
  if (!pf) return null;
  const cleaned = String(pf.plain).replace(/\s*\((contradicted|misleading|borderline|unverified)\)/g, '');
  const why = cleaned.split(/(?<=\.)\s+/)[0].trim();
  return { quote: badge.quotedClaim, why };
}

function fmtDate(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const money = (n) => `S$${Number(n).toFixed(2)}`;
const wordCount = (s) => String(s || '').trim().split(/\s+/).filter((w) => w && w !== '—' && w !== '–').length;

function sugarsValue(p) {
  const s = p.per100g && p.per100g.sugars;
  return s && typeof s.value === 'number' ? s.value : Infinity;
}

// ---- derivation (pure; fixture-testable) ---------------------------------

export function deriveHomepage(data, { departments = DEPARTMENTS, manifest = null } = {}) {
  const meta = data.meta || {};
  const products = data.products || [];
  const byEan = {};
  products.forEach((p) => { byEan[p.ean] = p; });

  // Counts stay in the derivation RECORD (drift guard + tests) but are never
  // rendered on the homepage surface (P4: no counts on home).
  const listed = products.length;
  const rated = products.filter((p) => p.rated).length;
  const unrated = listed - rated;
  if (meta.productCount != null && meta.productCount !== listed) throw new Error(`count drift: meta.productCount ${meta.productCount} != ${listed}`);
  if (meta.ratedCount != null && meta.ratedCount !== rated) throw new Error(`count drift: meta.ratedCount ${meta.ratedCount} != ${rated}`);
  if (meta.unratedCount != null && meta.unratedCount !== unrated) throw new Error(`count drift: meta.unratedCount ${meta.unratedCount} != ${unrated}`);

  const deptIds = departmentIdsWithData(products, departments);
  const deptMeta = deptIds.map((id) => ({ id, label: departments[id].label, nounPlural: departments[id].productNounPlural || 'products' }));

  // Chips: the projected config vocabulary (meta.chips). Kids-first display
  // order per the approved ASCII structure; every other chip keeps config order.
  const chips = (meta.chips || chipsFor(deptIds, departments)).map((c) => ({ id: c.id, label: c.label }));
  const kidsIdx = chips.findIndex((c) => c.id === 'kids');
  if (kidsIdx > 0) chips.unshift(chips.splice(kidsIdx, 1)[0]);

  const presets = ((data.ranking && data.ranking.presets) || []).map((p) => ({ id: p.id, label: p.label }));

  // Stores: live offer sources from the records drive the trust line
  // (FairPrice-only wording — the actual price source, not the scope list).
  const storeLabels = meta.storeLabels || {};
  const storesInScope = (meta.stores || []).map((s) => storeLabels[s] || s);
  const offerStores = [...new Set(products.flatMap((p) => (p.offers || []).map((o) => o.store)))].map((s) => storeLabels[s] || s);
  let latestCheck = '';
  products.forEach((p) => (p.offers || []).forEach((o) => { if (o.priceCheckedAt && o.priceCheckedAt > latestCheck) latestCheck = o.priceCheckedAt; }));

  // Label-watch teaser: the 3 strongest REAL catches. Sort every approved flag
  // by verdict severity then EAN; greedily take distinct brands AND distinct
  // claim families so the teaser is varied. Display = one plain sentence from
  // the shared plain-verdict map + a ~60px self-hosted pack thumbnail.
  const allFlags = [];
  products.forEach((p) => (p.claimFlags || []).forEach((f) => allFlags.push({ p, f })));
  allFlags.sort((a, b) => sev(a.f.verdict) - sev(b.f.verdict) || a.p.ean.localeCompare(b.p.ean));
  const seenBrand = new Set();
  const seenFamily = new Set();
  const catches = [];
  for (const { p, f } of allFlags) {
    if (seenBrand.has(p.brand) || seenFamily.has(f.claimFamily)) continue;
    seenBrand.add(p.brand);
    seenFamily.add(f.claimFamily);
    const m = manifest && manifest.images && manifest.images[p.ean];
    catches.push({
      ean: p.ean,
      name: p.name,
      brand: p.brand,
      grade: p.grade,
      rated: p.rated,
      verdict: f.verdict,
      quotedClaim: f.quotedClaim,
      where: claimWhere(f.claimSource && f.claimSource.location),
      sentence: teaserSentence(f),
      image: m && m.url ? { src: m.url, alt: m.alt || `${p.name} pack`, attribution: m.attribution || '', packagingNote: m.packagingNote || '' } : null,
      evidenceUrl: `/compare#/product/${p.ean}`,
    });
    if (catches.length === 3) break;
  }

  const usedEans = new Set();
  const cardFor = (p, role) => {
    const offer = p.displayOffer || (p.offers && p.offers[0]) || null;
    const img = (p.result && p.result.image) || null;
    const verdict = (p.result && p.result.verdict) || '';
    if (wordCount(verdict) > (meta.ux && meta.ux.verdictMaxWords || 8)) throw new Error(`verdict too long for ${p.ean}: ${verdict}`);
    usedEans.add(p.ean);
    const badge = (p.result && p.result.flagBadge) || null;
    return {
      role,
      ean: p.ean,
      name: p.name,
      grade: p.grade,
      rated: p.rated,
      gradeDisplayName: p.gradeDisplayName || 'Hawk Grade',
      gradeChip: (p.result && p.result.gradeChip) || { letter: p.grade || '–', icon: '', word: p.rated ? '' : 'Unrated' },
      verdict,
      flagBadge: badge,
      flagBadgeText: badge ? flagBadgeText(badge) : null,
      flagProof: badge ? flagProof(p, badge) : null,
      howWeKnow: (p.result && p.result.plain && p.result.plain.explainer) || '',
      safetyTags: ((p.result && p.result.safetyTags) || []).slice(0, 2),
      image: img,
      packPrice: offer ? offer.packPrice : null,
      pricePer100g: offer ? offer.pricePer100g : null,
      store: offer ? (storeLabels[offer.store] || offer.store) : null,
      checkedAt: offer ? offer.priceCheckedAt : null,
      evidenceUrl: `/compare#/product/${p.ean}`,
    };
  };

  // Healthiest pick: each range's ENGINE #1 under the healthiest preset
  // (like-with-like respected), then editorial best grade → lowest sugars → name.
  const byRange = (data.ranking && data.ranking.byRange) || {};
  const rangeOrder = meta.rangeOrder || [];
  const healthCandidates = [];
  rangeOrder.forEach((r) => {
    const entry = byRange[r] && byRange[r].healthiest;
    if (entry && entry.ranked && entry.ranked[0]) {
      const p = byEan[entry.ranked[0]];
      if (p) healthCandidates.push(p);
    }
  });
  healthCandidates.sort((a, b) => (GRADE_ORDER[a.grade] ?? 9) - (GRADE_ORDER[b.grade] ?? 9) || sugarsValue(a) - sugarsValue(b) || a.name.localeCompare(b.name));
  const healthiest = healthCandidates[0] ? cardFor(healthCandidates[0], 'Healthiest pick') : null;

  // Best value pick: rated A–C (the best-value display floor), cheapest per
  // 100g → grade → name; skip any product already featured (distinct cards).
  const valueCandidates = products.filter((p) => p.rated && ['A', 'B', 'C'].includes(p.grade) && p.displayOffer && p.displayOffer.pricePer100g != null && !usedEans.has(p.ean));
  valueCandidates.sort((a, b) => a.displayOffer.pricePer100g - b.displayOffer.pricePer100g || (GRADE_ORDER[a.grade] ?? 9) - (GRADE_ORDER[b.grade] ?? 9) || a.name.localeCompare(b.name));
  const bestValue = valueCandidates[0] ? cardFor(valueCandidates[0], 'Best value') : null;

  // Biggest catch: worst flag verdict → most flags → name; distinct cards.
  const catchCandidates = products.filter((p) => p.claimBadge && !usedEans.has(p.ean));
  catchCandidates.sort((a, b) => sev(a.claimBadge.worst) - sev(b.claimBadge.worst) || b.claimBadge.count - a.claimBadge.count || a.name.localeCompare(b.name));
  const biggestCatch = catchCandidates[0] ? cardFor(catchCandidates[0], 'Biggest catch') : null;

  return {
    counts: { listed, rated, unrated },
    departments: deptMeta,
    chips,
    presets,
    storesInScope,
    offerStores,
    priceCheckedAt: latestCheck,
    priceCheckedLabel: fmtDate(latestCheck),
    catches,
    picks: [healthiest, bestValue, biggestCatch].filter(Boolean),
  };
}

// ---- rendering (canonical platform classes + token-only scoped layout) ----

function tagClass(icon) {
  if (icon === '✓') return 'hh-tag hh-tag-safe';
  if (icon === '▲' || icon === '⚠') return 'hh-tag hh-tag-warn';
  return 'hh-tag';
}

function gradeStamp(card) {
  const c = card.gradeChip;
  const cls = card.rated && card.grade ? `hh-grade hh-grade-${card.grade.toLowerCase()}` : 'hh-grade hh-grade-unknown';
  const aria = `${card.gradeDisplayName} ${c.letter}: ${c.word}`.trim();
  return `<span class="${cls}" role="img" aria-label="${esc(aria)}"><span class="hh-grade-letter">${esc(c.letter)}</span> <span aria-hidden="true">${esc(c.icon)}</span> ${esc(c.word)}</span>`;
}

// Tone-aware flag badge, now in plain words (P4). Real flags keep the
// canonical red .hh-flag; unverified keeps the honest grey dashed treatment.
// The raw quote + one-sentence explanation sit one tap deeper in a <details>
// (≤2 lines, no JS). Dataset icon + honest aria are preserved.
function flagStamp(card) {
  const b = card.flagBadge;
  if (!b) return '';
  const unverified = b.tone === 'unverified';
  const cls = unverified ? 'hh-flag hh-flag-unverified' : 'hh-flag';
  const text = card.flagBadgeText || flagBadgeText(b);
  const aria = `Claim check: ${b.count} flag${b.count === 1 ? '' : 's'} — ${plainVerdict(b.worst)}${unverified ? ' (unverified — not a false-claim finding)' : ''}`;
  if (card.flagProof) {
    return `<details class="hh-claim"><summary class="${cls}" aria-label="${esc(aria)}">${esc(text)}</summary><p class="hh-claimproof">“${esc(card.flagProof.quote)}” — ${esc(card.flagProof.why)}</p></details>`;
  }
  return `<span class="${cls}" aria-label="${esc(aria)}">${esc(text)}</span>`;
}

function watchItem(c) {
  const thumb = c.image
    ? `<img class="hh-watchthumb" src="${esc(c.image.src)}" alt="${esc(c.image.alt)}" width="60" height="60" loading="lazy" decoding="async">`
    : `<span class="hh-watchthumb hh-watchicon" aria-hidden="true">▣</span>`;
  return `<li class="hh-watchitem">
${thumb}
<div class="hh-watchbody">
<b>${esc(c.name)}</b>
<p class="hh-watchline">${esc(c.sentence)}</p>
<a class="hh-seeproof" href="${esc(c.evidenceUrl)}">See proof →</a>
</div>
</li>`;
}

function pickCard(card) {
  const img = card.image && card.image.status === 'photo' && card.image.src
    ? `<div class="hh-packshot"><img src="${esc(card.image.src)}" alt="${esc(card.image.alt || card.name + ' pack')}" width="120" height="120" loading="lazy" decoding="async"></div>`
    : `<div class="hh-packshot" aria-hidden="true"><span class="hh-packicon">▣</span></div>`;
  const flag = flagStamp(card);
  const tags = card.safetyTags.map((t) => `<span class="${tagClass(t.icon)}">${esc(t.icon)} ${esc(t.word)}</span>`).join('');
  const price = card.packPrice != null
    ? `<div><span class="hh-price">${money(card.packPrice)}</span><span class="hh-unit">${money(card.pricePer100g)} / 100g</span></div>`
    : `<div><span class="hh-price text-muted">Price unknown</span></div>`;
  const fresh = card.store ? `<span class="hh-source">${esc(card.store)} · checked ${esc(fmtDate(card.checkedAt))}</span>` : '';
  const credit = card.image && card.image.status === 'photo'
    ? `<span class="hh-source">${esc(card.image.attribution || '')} ${esc(card.image.packagingNote || '')}</span>`
    : `<span class="hh-source">No licensed photo yet — a generic icon is shown, not the real pack.</span>`;
  const how = card.howWeKnow ? `<p class="hh-howweknow"><b>How we know:</b> ${esc(card.howWeKnow)}</p>` : '';
  return `<article class="hh-card hh-pick hh-reveal">
<span class="eyebrow">${esc(card.role)}</span>
${img}
${gradeStamp(card)}
<h3 class="hh-pickname"><a href="${esc(card.evidenceUrl)}">${esc(card.name)}</a></h3>
<p class="hh-verdict">${esc(card.verdict)}</p>
${flag}
${price}
<div class="cluster">${tags}</div>
${fresh}
${how}
<a class="hh-evidence" href="${esc(card.evidenceUrl)}">See the evidence →</a>
${credit}
</article>`;
}

export function renderHomepage(d) {
  const { chips, presets, catches, picks } = d;
  const presetLinks = presets.map((p) => `<a class="hh-pill" href="/compare?preset=${encodeURIComponent(p.id)}">${esc(p.label)}</a>`).join('\n');
  const chipLinks = chips.map((c) => `<a class="hh-pill" href="/compare?chip=${encodeURIComponent(c.id)}">${esc(c.label)}</a>`).join('\n');
  const trust = `Prices from ${esc(d.offerStores.join(', ') || '—')} · checked ${esc(d.priceCheckedLabel)}`;
  const watchItems = catches.map(watchItem).join('\n');
  const watchCredit = catches.some((c) => c.image)
    ? `<p class="hh-watchnote">Pack photos: Open Food Facts community, CC BY-SA 3.0 · packaging may differ.</p>`
    : '';
  const pickCards = picks.map(pickCard).join('\n');

  return `<style>
#hh-home .hh-searchrow{display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-3)}
#hh-home .hh-searchrow .input{flex:1 1 260px;min-height:48px;background:hsl(var(--card));border:var(--border-width) solid hsl(var(--foreground));border-radius:var(--radius-md);color:hsl(var(--foreground));padding:12px 16px;font:inherit}
#hh-home .hh-searchrow .btn{min-height:48px}
#hh-home .hh-pills{display:flex;flex-wrap:wrap;gap:var(--space-1);align-items:center;margin-top:var(--space-3)}
#hh-home .hh-pills .lbl{font-size:var(--eyebrow-size);font-weight:var(--weight-bold);letter-spacing:var(--eyebrow-tracking);text-transform:uppercase;color:hsl(var(--primary-foreground)/0.85);margin-right:var(--space-1)}
#hh-home .hh-pill{display:inline-flex;align-items:center;min-height:44px;padding:8px 20px;border-radius:var(--radius-pill);border:var(--border-width) solid hsl(var(--primary-foreground));color:hsl(var(--primary-foreground));text-decoration:none;font-weight:var(--weight-bold);font-size:var(--text-sm)}
#hh-home .hh-pill:hover{background:hsl(var(--primary-foreground));color:var(--hh-teal-deep);text-decoration:none}
#hh-home .hh-trustline{margin-top:var(--space-3);font-size:var(--text-sm);color:hsl(var(--primary-foreground)/0.85)}
#hh-home section:not(.hero){padding-block:var(--section-y-sm)}
#hh-home .hh-sechead{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:var(--space-2);margin-bottom:var(--space-3)}
#hh-home .hh-sechead h2{margin:0}
#hh-home .hh-sechead .meta{font-size:var(--text-sm);color:hsl(var(--muted-foreground))}
#hh-home .hh-watch{padding:var(--space-3)}
#hh-home .hh-watchlist{list-style:none;margin:var(--space-2) 0 0;padding:0;display:grid;gap:var(--space-3)}
#hh-home .hh-watchitem{display:grid;grid-template-columns:60px 1fr;gap:var(--space-2);align-items:start;padding-left:var(--space-2);border-left:var(--border-width) solid var(--hh-line)}
#hh-home .hh-watchthumb{width:60px;height:60px;object-fit:contain;border:1px solid var(--hh-line);border-radius:8px;background:hsl(var(--card))}
#hh-home .hh-watchicon{display:flex;align-items:center;justify-content:center;font-size:var(--text-lg);color:hsl(var(--muted-foreground))}
#hh-home .hh-watchline{margin:var(--space-1) 0 0}
#hh-home .hh-seeproof{display:inline-flex;align-items:center;min-height:44px;font-weight:var(--weight-bold)}
#hh-home .hh-watchnote{margin-top:var(--space-2);font-size:var(--text-sm);color:hsl(var(--muted-foreground))}
#hh-home .hh-steps{display:grid;gap:var(--grid-gap);grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr))}
#hh-home .hh-stepnum{font-family:var(--font-heading);font-size:var(--text-h2);color:hsl(var(--link))}
#hh-home .hh-steps h3{margin:var(--space-1) 0}
#hh-home .hh-picks{display:grid;gap:var(--grid-gap);grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr))}
#hh-home .hh-pick{display:flex;flex-direction:column;gap:var(--space-2)}
#hh-home .hh-pick .hh-packshot{max-width:160px}
#hh-home .hh-flag-unverified{color:var(--hh-grey);background:hsl(var(--card));border:var(--border-width) dashed var(--hh-grey)}
#hh-home .hh-claim summary{display:flex;align-items:center;gap:var(--space-1);min-height:44px;cursor:pointer}
#hh-home .hh-claim summary::after{content:"▾";margin-left:auto}
#hh-home .hh-claim[open] summary::after{content:"▴"}
#hh-home .hh-claimproof{margin:var(--space-1) 0 0;font-size:var(--text-sm);color:hsl(var(--muted-foreground));display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
#hh-home .hh-howweknow{margin:0;font-size:var(--text-sm);color:hsl(var(--muted-foreground))}
#hh-home .hh-packicon{font-size:var(--text-h1);color:hsl(var(--muted-foreground))}
#hh-home .hh-pickname{font-size:var(--text-lg);font-weight:var(--weight-bold);margin:0}
#hh-home .hh-pickname a{color:hsl(var(--foreground));text-decoration:none}
#hh-home .hh-pickname a:hover{color:hsl(var(--link))}
#hh-home .hh-evidence{display:inline-flex;align-items:center;min-height:44px;font-weight:var(--weight-bold)}
#hh-home .hh-request{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-3)}
#hh-home .hh-request h2{margin:0;font-size:var(--text-h3)}
#hh-home .hh-browse{margin-top:var(--space-3)}
#hh-home .hh-browse a{display:inline-flex;align-items:center;min-height:44px;font-weight:var(--weight-bold)}
#hh-home .hh-disclaimer{margin:0;font-size:var(--text-sm);line-height:1.5;color:hsl(var(--muted-foreground))}
</style>
<div id="hh-home">
<section class="hero" aria-label="Search the grocery aisle">
<div class="container">
<h1 class="hero-title">The box says healthy. <em>We checked.</em></h1>
<p class="hero-lede">Real grades, real prices, and the claims that don't add up.</p>
<form class="hh-searchrow" action="/compare" method="get" role="search">
<input class="input" type="search" name="q" placeholder="Search — name, brand, bijirin, 燕麦…" aria-label="Search products">
<button class="btn btn-primary" type="submit">Compare</button>
</form>
<div class="hh-pills" role="group" aria-label="Intent presets">
<span class="lbl">I want</span>
${presetLinks}
</div>
<div class="hh-pills" role="group" aria-label="Categories">
${chipLinks}
</div>
<p class="hh-trustline">${trust}</p>
</div>
</section>

<section aria-label="Label watch">
<div class="container">
<div class="hh-sechead"><h2>This week’s label watch</h2><span class="meta">Claims checked against the pack</span></div>
<div class="hh-watch hh-reveal">
<span class="hh-flag">⚑ Label watch</span>
<ul class="hh-watchlist">
${watchItems}
</ul>
${watchCredit}
</div>
</div>
</section>

<section class="section-muted" aria-label="How it works">
<div class="container">
<div class="hh-sechead"><h2>How HealthHawk works</h2><span class="meta"><a href="/methodology">Full methodology →</a></span></div>
<div class="hh-steps">
<div class="hh-card hh-reveal"><span class="hh-stepnum">1</span><h3>Read the label</h3><p class="text-muted">We record the nutrition panel and ingredient list, with the source and date for every number.</p><a class="hh-evidence" href="/methodology#labels">How we read labels →</a></div>
<div class="hh-card hh-reveal"><span class="hh-stepnum">2</span><h3>Grade it</h3><p class="text-muted">A transparent Hawk Grade (A–E), derived using the Nutri-Score 2023 algorithm, beside the S$ price per 100g.</p><a class="hh-evidence" href="/methodology#grade">How the grade works →</a></div>
<div class="hh-card hh-reveal"><span class="hh-stepnum">3</span><h3>Check the claims</h3><p class="text-muted">Marketing claims are checked against what the pack actually says. Every flag is one tap from its evidence.</p><a class="hh-evidence" href="/methodology#claims">How claims are checked →</a></div>
</div>
</div>
</section>

<section aria-label="Featured picks">
<div class="container">
<div class="hh-sechead"><h2>Featured picks</h2><span class="meta">Prices checked ${esc(d.priceCheckedLabel)}</span></div>
<div class="hh-picks">
${pickCards}
</div>
<p class="hh-browse"><a href="/products">Browse all products →</a></p>
</div>
</section>

<section aria-label="Request a product">
<div class="container">
<div class="hh-card hh-request hh-reveal">
<div><h2>Can’t find your product?</h2><p class="text-muted">Request any product — no extra fields. Your requests rank which aisle we open next.</p></div>
<a class="btn btn-primary" href="/request">Request a product</a>
</div>
</div>
</section>

<section aria-label="The small print">
<div class="container">
<p class="hh-disclaimer">Hawk Grades compare products within the same category only. They are not medical or dietary advice. Grades are derived using the Nutri-Score 2023 algorithm (Santé publique France) — not an official Nutri-Score mark. Prices and labels change — always check the pack in store. HealthHawk is independent and not affiliated with the retailers or brands listed. Pack photos: Open Food Facts community, CC BY-SA 3.0, self-hosted with attribution; packaging may differ.</p>
</div>
</section>
</div>`;
}

// ---- CLI ------------------------------------------------------------------

export function main() {
  const data = JSON.parse(readFileSync(resolve(ROOT, 'app', 'data.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'app', 'media-manifest.json'), 'utf8'));
  const derived = deriveHomepage(data, { manifest });
  // Photo URLs must be the self-hosted manifest URLs (amended G3).
  for (const pick of derived.picks) {
    if (pick.image && pick.image.status === 'photo') {
      const m = manifest.images && manifest.images[pick.ean];
      if (!m || m.url !== pick.image.src) throw new Error(`photo URL not manifest-backed for ${pick.ean}`);
    }
  }
  for (const c of derived.catches) {
    if (c.image) {
      const m = manifest.images && manifest.images[c.ean];
      if (!m || m.url !== c.image.src) throw new Error(`teaser photo URL not manifest-backed for ${c.ean}`);
    }
  }
  const html = renderHomepage(derived);
  const outDir = resolve(ROOT, 'runs', 'p3-06');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'homepage-block.html'), html);
  writeFileSync(resolve(outDir, 'homepage-derivation.json'), JSON.stringify(derived, null, 2));
  console.log(`homepage block: ${html.length} chars → runs/p3-06/homepage-block.html`);
  console.log(`counts ${derived.counts.listed}/${derived.counts.rated}/${derived.counts.unrated} · picks ${derived.picks.map((p) => p.role + '=' + p.ean).join(', ')} · catches ${derived.catches.map((c) => c.ean).join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();