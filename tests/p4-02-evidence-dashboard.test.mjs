// P4-02 — Evidence dashboard rebuild acceptance tests (docs/issues-p4/p4-02).
// Seam: DOM-stub boot of the REAL client on the built app/data.json (the
// p2-ux-*-ui / p3-app-reskin harness pattern). Asserts the Apple-style dashboard
// of boxes (each ≤2 surface lines + info icon), one plain line per flag (exactly
// once), the trimmed proof box (≤4 lines), plain additives (no dose maths),
// 4-number nutrition with colour dots, Good to know, the label-photo link-out,
// and the shared plain-verdict map. NEGATIVE canaries: no verdict/ruleId/
// confidence tags, no approval stamps, no regulation quotes/page refs, no dose
// boxes, no classifier internals. Plus the inline-map-matches-lib canary and a
// zero-data-writes pin. node --test, zero deps, zero network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadApp, runApp, esc } from '../scripts/p2-ux-harness.mjs';
import { PLAIN_VERDICTS, plainVerdict } from '../scripts/lib/plain-verdicts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { html, appScript, data } = loadApp();
const byEan = new Map(data.products.map((p) => [p.ean, p]));

const GOLD = '4800361310031';        // misleading WG-SHARE (photo)
const QUAKER = '9556174802601';      // contradicted betaglucan (photo, grade A)
const BROWN_RICE = '9556001249531';  // misleading + gapNote (no ingredient quote)
const CORNFLAKES = '8852756304053';  // clean decode, safe e306
const NO_ING = '884912342737';       // ingredients not published

// ---------------------------------------------------------------------------
// 0. Shared plain-verdict vocabulary: inline map === lib file (canary).
// ---------------------------------------------------------------------------

test('inline PLAIN_VERDICTS map matches scripts/lib/plain-verdicts.mjs EXACTLY (render-layer mirror)', () => {
  // The standalone app cannot import the mjs at runtime, so it inlines an
  // identical map. This canary fails if the two ever drift.
  assert.match(appScript, /scripts\/lib\/plain-verdicts\.mjs/, 'inline map references the lib source');
  const m = appScript.match(/var PLAIN_VERDICTS = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(m, 'inline PLAIN_VERDICTS object present');
  const inline = {};
  for (const pair of m[1].matchAll(/(\w+):\s*"([^"]*)"/g)) inline[pair[1]] = pair[2];
  assert.deepEqual(inline, { ...PLAIN_VERDICTS }, 'inline map === lib map (keys + wording)');
  assert.equal(plainVerdict('contradicted'), "doesn't match the label");
  assert.equal(plainVerdict('unverified'), "we couldn't check this");
  // Other verdicts pass through unchanged (existing plain-summary treatment).
  assert.equal(plainVerdict('misleading'), 'misleading');
  assert.equal(plainVerdict('borderline'), 'borderline');
});

// ---------------------------------------------------------------------------
// 1. Dashboard of discrete boxes; each flag exactly once on the surface.
// ---------------------------------------------------------------------------

test('detail renders as discrete dashboard boxes (top + what\'s inside + claim checks + nutrition + good to know + price + how we know)', () => {
  const app = runApp(data, appScript);
  app.openDetail(QUAKER);
  const h = app.main.innerHTML;
  assert.match(h, /class="card dash-top/);
  for (const heading of ["What's inside", 'Claim checks', 'Nutrition', 'Good to know', 'Price · both stores', 'How we know']) {
    assert.ok(h.includes(heading), `box present: ${heading}`);
  }
  // top box: pack photo + name + grade stamp + ONE-LINE plain verdict + price box.
  assert.match(h, /class="pack-shot"/);
  assert.match(h, /class="dash-name"/);
  assert.match(h, /rchip/);
  assert.equal((h.match(/class="dash-verdict"/g) ?? []).length, 1, 'one-line plain verdict');
  assert.match(h, /class="dash-price"/);
  assert.match(h, /class="price-big"/);
});

test('each flag appears EXACTLY ONCE on the surface; the triple repetition is gone', () => {
  const app = runApp(data, appScript);
  for (const p of data.products.filter((x) => x.claimFlags.length > 0)) {
    app.openDetail(p.ean);
    const h = app.main.innerHTML;
    assert.equal((h.match(/class="claim-line /g) ?? []).length, p.claimFlags.length, `${p.ean}: one claim line per flag`);
    // no plain-summary → verdict-card → claim-card triple repetition
    assert.equal(/plain-summary|verdict-why|claim-card|In plain words/.test(h), false, `${p.ean}: old triple repetition gone`);
    app.backToList();
  }
});

test('no box surface exceeds 2 visible lines before its info expansion (proof + full panels stay behind info)', () => {
  const app = runApp(data, appScript);
  app.openDetail(GOLD);
  const h = app.main.innerHTML;
  // Before any info tap: no proof box, no full nutrition panel, no full ingredient
  // list, no SFA table, no offers table — all are behind info icons.
  assert.equal(/proof-box|table class="nutrition"|<ol class="ingredient-list">|sfa-table|table class="offers"/.test(h), false);
  // Every box carries an info affordance (ⓘ) — claim proof or box info.
  assert.ok((h.match(/data-toggle-box|data-toggle-proof/g) ?? []).length >= 5);
  // What's inside surface = first 3 TOP-LEVEL names in plain words (bracketed
  // sub-ingredient detail stripped) + sugar teaspoon visual.
  const surface = h.match(/<p class="dash-surface inside-line">([^<]*)<\/p>/)[1];
  const decode = byEan.get(GOLD).ingredientDecode;
  const topLevel = (s) => s.split(/[(\[{]/)[0].trim();
  assert.ok(surface.includes(esc(topLevel(decode.ingredients[0]))));
  assert.equal(/[(\[{]/.test(surface), false, 'no bracketed sub-ingredient detail on the surface');
  assert.ok(surface.includes('…'), 'first 3 + ellipsis, not the full list');
  assert.match(h, /Sugar, in teaspoons/);
  // The sugar-teaspoon VISUAL renders for products with a per-serving sugar value.
  const wb = '9414942010750'; // Weet-Bix carries a per-serving teaspoon figure
  app.openDetail(wb);
  assert.match(app.main.innerHTML, /teaspoon fill/);
  assert.match(app.main.innerHTML, /class="sugar-figure"/);
});

// ---------------------------------------------------------------------------
// 1b. REAL surface-length sweep (merge-review blocker 2): every product's
//     "What's inside" surface line and every claim line must fit the documented
//     ≤2-visible-line char budget. SURFACE_MAX = 110 mirrors the app's
//     clampSurface budget (~55–60 chars/line at the dashboard box width).
//     Lengths are measured on the UNESCAPED rendered text (entities count as
//     one visible character). The deep proof box is exempt — it is the
//     one-tap-deeper layer, not a surface.
// ---------------------------------------------------------------------------

const SURFACE_MAX = 110;
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('surface sweep: ALL 80 products — What\'s-inside surface and every claim line ≤110 chars (≤2 visible lines)', () => {
  const app = runApp(data, appScript);
  assert.equal(data.products.length, 80);
  let insideChecked = 0, claimChecked = 0;
  for (const p of data.products) {
    app.openDetail(p.ean);
    const h = app.main.innerHTML;
    const inside = h.match(/<p class="dash-surface inside-line">([^<]*)<\/p>/);
    if (inside) {
      const len = unesc(inside[1]).length;
      assert.ok(len <= SURFACE_MAX, `${p.ean}: inside surface ${len} chars > ${SURFACE_MAX}`);
      insideChecked++;
    }
    // Ingredients-gap surface (the <strong>label.</strong> form; the nutrition
    // gap is a separate box outside this blocker's scope).
    const gap = h.match(/<p class="missing dash-surface"><strong>([\s\S]*?)<\/p>/);
    if (gap) {
      const len = unesc(gap[1].replace(/<[^>]+>/g, '')).length;
      assert.ok(len <= SURFACE_MAX, `${p.ean}: ingredients-gap surface ${len} chars > ${SURFACE_MAX}`);
      insideChecked++;
    }
    for (const m of h.matchAll(/<span class="claim-line-text">([^<]*)<\/span>/g)) {
      const len = unesc(m[1]).length;
      assert.ok(len <= SURFACE_MAX, `${p.ean}: claim line ${len} chars > ${SURFACE_MAX}: ${m[1]}`);
      claimChecked++;
    }
    app.backToList();
  }
  assert.equal(insideChecked, 80, 'every product has a What\'s-inside surface line');
  assert.ok(claimChecked >= 25, `claim lines swept: ${claimChecked}`);
});

test('long quotes are trimmed on the surface but the FULL exact quote survives in the proof box', () => {
  const app = runApp(data, appScript);
  // Koko Krunch Econ: 190-char raw quote — the old surface rendered 302 chars.
  const KOKO = '4800361292382';
  const f = byEan.get(KOKO).claimFlags[0];
  assert.ok(f.quotedClaim.length > 100, 'fixture: genuinely long quote');
  app.openDetail(KOKO);
  const line = unesc(app.main.innerHTML.match(/<span class="claim-line-text">([^<]*)<\/span>/)[1]);
  assert.ok(line.length <= SURFACE_MAX);
  assert.ok(line.includes(f.quotedClaim.slice(0, 40)), 'quote lead kept on the surface');
  assert.equal(line.includes(f.quotedClaim), false, 'full long quote NOT on the surface');
  app.click('proof', KOKO + '|0');
  const proof = app.main.innerHTML.match(new RegExp('<div class="proof-box" id="proof-' + KOKO + '-0"[\\s\\S]*?<\\/div>'))[0];
  assert.ok(proof.includes(esc(f.quotedClaim)), 'FULL exact quote preserved one tap deeper');
  // Quaker 3-in-1: 470-char old surface — now plain top-level names only.
  const QUAKER_3IN1 = '9556174815458';
  app.openDetail(QUAKER_3IN1);
  const surface = unesc(app.main.innerHTML.match(/<p class="dash-surface inside-line">([^<]*)<\/p>/)[1]);
  assert.ok(surface.length <= SURFACE_MAX);
  assert.equal(/Creamer \(/.test(surface), false, 'bracketed sub-ingredients stripped');
  assert.ok(surface.startsWith('Wholegrain Oat, Sugar, Creamer'), 'first 3 top-level names in plain words');
  app.click('box', QUAKER_3IN1 + '|inside');
  assert.ok(app.main.innerHTML.includes('Fully Hydrogenated Palm Fat'), 'full decoded detail one tap deeper');
});

// ---------------------------------------------------------------------------
// 2. Trimmed proof box: claim quote + label quote + one-line rule + source (+gap).
// ---------------------------------------------------------------------------

test('proof box keeps ONLY claim quote, label quote, one-line rule, source link, optional one-line gap (≤4 lines)', () => {
  // INTERPRETATION (confirmed founder intent): "proof ≤4 lines" means ≤4
  // CONTENT lines — claim / label / rule / source — counted as content <p>
  // elements, NOT visual wrap lines. Exact quotes are preserved verbatim even
  // when long. The ≤2-VISIBLE-line rule applies to box SURFACES only (see the
  // surface sweep above), never to the one-tap-deeper proof.
  const app = runApp(data, appScript);
  app.openDetail(QUAKER);
  app.click('proof', QUAKER + '|0');
  const proof = app.main.innerHTML.match(/<div class="proof-box"[\s\S]*?<\/div>/)[0];
  const lines = (proof.match(/<p /g) ?? []).length;
  assert.ok(lines <= 4, `proof ≤4 lines (got ${lines})`);
  const f = byEan.get(QUAKER).claimFlags[0];
  assert.ok(proof.includes(esc(f.quotedClaim)), 'exact claim quote');
  assert.match(proof, /Rule: /, 'one-line rule');
  assert.match(proof, /Source<\/a>/, 'source link');
  // honest gap case: Brown Rice has no ingredient quote — a PLAIN gap line renders
  // (the verbose gapNote with ruleId/page refs stays in the frozen data).
  app.openDetail(BROWN_RICE);
  const br = byEan.get(BROWN_RICE).claimFlags[0];
  assert.equal(br.quotedIngredient, null);
  app.click('proof', BROWN_RICE + '|0');
  const brProof = app.main.innerHTML.match(/<div class="proof-box"[\s\S]*?<\/div>/)[0];
  assert.match(brProof, /No ingredient list published yet — we couldn’t cross-check this\./, 'honest gap as one plain line');
  assert.equal(brProof.includes(esc(br.gapNote)), false, 'audit-language gapNote not on screen');
  assert.ok((brProof.match(/<p /g) ?? []).length <= 4);
});

// ---------------------------------------------------------------------------
// 2b. CANARY (merge-review blocker 1): no FALSE "No ingredient list published."
//     gap. That line is only truthful when p.ingredients is genuinely absent.
//     Panel-based flags (low-fat / kids-sugar) must render the STORED panel
//     nutrient value as the label-side evidence ("Label panel: fat/sugars …").
// ---------------------------------------------------------------------------

test('canary: "No ingredient list published" NEVER renders for a product that HAS ingredients (all 80 products, every proof)', () => {
  const app = runApp(data, appScript);
  let gapLines = 0;
  for (const p of data.products) {
    app.openDetail(p.ean);
    for (let i = 0; i < p.claimFlags.length; i++) {
      app.click('proof', `${p.ean}|${i}`);
      const proof = app.main.innerHTML.match(new RegExp('<div class="proof-box" id="proof-' + p.ean + '-' + i + '"[\\s\\S]*?<\\/div>'))[0];
      if (p.ingredients) {
        assert.equal(proof.includes('No ingredient list published'), false, `${p.ean}|${i}: FALSE gap — product HAS a published ingredient list`);
      } else if (proof.includes('No ingredient list published')) {
        gapLines++;
      }
    }
    app.backToList();
  }
  // The honest gap still renders where it is TRUE (Quaker Oats So Simple +
  // Brown Rice comparative both genuinely lack an ingredient list).
  assert.ok(gapLines >= 2, `truthful gap lines still render: ${gapLines}`);
});

test('panel-based flags render the stored label-panel value (low-fat → fat, kids-sugar → sugars) — verified EANs', () => {
  const app = runApp(data, appScript);
  const cases = [
    // [ean, flagIndex, nutrient, expected rounded value]
    ['9556174802274', 0, 'fat', 8.6],
    ['9556174711118', 0, 'fat', 9.1],
    ['8888030315033', 0, 'fat', 6.3],
    ['8888030315026', 0, 'fat', 5],
    ['4800361028165', 1, 'sugars', 28],
    ['8852756768046', 0, 'sugars', 33],
    ['4800361291446', 0, 'sugars', 29.3],
    ['4800361292382', 0, 'sugars', 29.8],
    ['4800361000239', 0, 'sugars', 29.8],
    ['4800361355872', 0, 'sugars', 24.9],
  ];
  for (const [ean, idx, nutrient, expected] of cases) {
    const p = byEan.get(ean);
    assert.ok(p.ingredients, `${ean}: has a published ingredient list`);
    const f = p.claimFlags[idx];
    assert.equal(f.quotedIngredient, null);
    assert.notEqual(f.verdict, 'unverified');
    // Expected value derived from the FROZEN stored panel value (no fabrication).
    const stored = p.per100g[nutrient];
    assert.equal(Math.round(stored.value * 10) / 10, expected, `${ean}: stored ${nutrient} rounds to ${expected}`);
    app.openDetail(ean);
    app.click('proof', `${ean}|${idx}`);
    const proof = app.main.innerHTML.match(new RegExp('<div class="proof-box" id="proof-' + ean + '-' + idx + '"[\\s\\S]*?<\\/div>'))[0];
    assert.ok(proof.includes(`Label panel: ${nutrient} ${expected} g/100g`), `${ean}: label-panel evidence line`);
    assert.equal(proof.includes('No ingredient list published'), false, `${ean}: no false gap`);
    assert.ok((proof.match(/<p /g) ?? []).length <= 4, `${ean}: proof still ≤4 content lines`);
    assert.ok(proof.includes(esc(f.quotedClaim)), `${ean}: full exact claim quote preserved`);
    app.backToList();
  }
  // Sweep: EVERY low-fat/kids-sugar flag renders a panel line, never the gap.
  for (const p of data.products) {
    p.claimFlags.forEach((f, i) => {
      if (f.claimFamily !== 'low-fat' && f.claimFamily !== 'kids-sugar') return;
      app.openDetail(p.ean);
      // PROOF_OPEN persists per app instance — only tap when not already open.
      if (!app.main.innerHTML.includes(`id="proof-${p.ean}-${i}"`)) app.click('proof', `${p.ean}|${i}`);
      const proof = app.main.innerHTML.match(new RegExp('<div class="proof-box" id="proof-' + p.ean + '-' + i + '"[\\s\\S]*?<\\/div>'))[0];
      assert.match(proof, /Label panel: (fat|sugars) [\d.]+ g\/100g/, `${p.ean}|${i}: panel evidence`);
      app.backToList();
    });
  }
});

// ---------------------------------------------------------------------------
// 2c. CANARY (P4 final-review blocker B1): ALL flagged products × EVERY flag —
//     the Rule line is PLAIN (no regulation text / internal roadmap jargon,
//     bounded length); an internal gap note is NEVER rendered as a "Label:"
//     quote; the label-side evidence is authentic (real quote / stored panel
//     value / truthful honest gap). The 3 comparative EANs are pinned exactly.
// ---------------------------------------------------------------------------

const INTERNAL_NOTE_RE = /honest gap|not published|cannot be cross-checked|slice \d|OFF\/OCR/i;
const RULE_JARGON_RE = /HPB|guide|Food Regulations|founder to rule|slice \d|OFF\/OCR|borderline; founder/i;
const PROOF_FORBIDDEN_RE = /HPB Aug-2024|Food Regulations|founder to rule|slice \d|OFF\/OCR|honest gap|borderline; founder/i;
const COMPARATIVE_RULE = "A 'lower in sugar' claim needs at least 25% less sugar than a clearly named reference.";
const GAP_LINE = 'No ingredient list published yet — we couldn’t cross-check this.';

function proofOf(app, ean, i) {
  if (!app.main.innerHTML.includes(`id="proof-${ean}-${i}"`)) app.click('proof', `${ean}|${i}`);
  return app.main.innerHTML.match(new RegExp('<div class="proof-box" id="proof-' + ean + '-' + i + '"[\\s\\S]*?<\\/div>'))[0];
}

test('B1 sweep: ALL flagged products × EVERY flag — plain bounded Rule, no internal note as Label quote, authentic label evidence', () => {
  const app = runApp(data, appScript);
  let proofs = 0;
  for (const p of data.products) {
    if (!p.claimFlags.length) continue;
    app.openDetail(p.ean);
    for (let i = 0; i < p.claimFlags.length; i++) {
      const f = p.claimFlags[i];
      const proof = proofOf(app, p.ean, i);
      proofs++;
      // Rule line: plain, bounded, zero regulation/roadmap jargon.
      const rule = unesc(proof.match(/<p class="proof-rule">Rule: ([^<]*)<\/p>/)[1]);
      assert.equal(RULE_JARGON_RE.test(rule), false, `${p.ean}|${i}: jargon in Rule: ${rule}`);
      assert.ok(rule.length <= 120, `${p.ean}|${i}: Rule too long (${rule.length}): ${rule}`);
      // No regulation citation / internal note anywhere in the proof.
      assert.equal(PROOF_FORBIDDEN_RE.test(unesc(proof)), false, `${p.ean}|${i}: regulation/internal text in proof`);
      // An internal gap note is NEVER a "Label:" quote.
      const labelQuote = proof.match(/<p class="proof-label">Label: “([^<]*)”<\/p>/);
      if (labelQuote) {
        assert.equal(INTERNAL_NOTE_RE.test(unesc(labelQuote[1])), false, `${p.ean}|${i}: internal note rendered as a Label quote`);
        assert.ok(f.quotedIngredient && f.quotedIngredient.includes(unesc(labelQuote[1])), `${p.ean}|${i}: Label quote is authentic stored text`);
      }
      if (f.quotedIngredient && INTERNAL_NOTE_RE.test(f.quotedIngredient)) {
        assert.equal(proof.includes(esc(f.quotedIngredient)), false, `${p.ean}|${i}: internal note text not on screen`);
        assert.match(proof, /class="proof-gap"/, `${p.ean}|${i}: honest gap line instead`);
      }
      // Label-side evidence is authentic: real quote / first-ingredient evidence
      // from the real list / stored panel value / truthful honest gap.
      const firstIng = proof.match(/<p class="proof-label">Label: first ingredient is ([^<]*)\.<\/p>/);
      const panel = proof.match(/<p class="proof-label">Label panel: (fat|sugars) ([\d.]+) g\/100g<\/p>/);
      const gap = proof.match(/<p class="proof-gap">([^<]*)<\/p>/);
      assert.ok(labelQuote || firstIng || panel || gap, `${p.ean}|${i}: exactly one authentic label-side line`);
      if (firstIng) {
        assert.ok(f.quotedIngredient && f.quotedIngredient.length > 120, `${p.ean}|${i}: first-ingredient form only for long real lists`);
        assert.ok(f.quotedIngredient.startsWith(unesc(firstIng[1])), `${p.ean}|${i}: first ingredient is real label text`);
        assert.equal(proof.includes(esc(f.quotedIngredient)), false, `${p.ean}|${i}: full long list not repeated in the proof`);
      }
      if (panel) {
        const stored = p.per100g[panel[1]];
        assert.equal(Number(panel[2]), Math.round(stored.value * 10) / 10, `${p.ean}|${i}: panel value === stored value`);
      }
      if (gap && unesc(gap[1]).startsWith('No ingredient list published')) {
        assert.equal(!!p.ingredients, false, `${p.ean}|${i}: gap line only when ingredients genuinely absent`);
      }
      // Budget + verbatim claim preserved.
      assert.ok((proof.match(/<p /g) ?? []).length <= 4, `${p.ean}|${i}: proof ≤4 content lines`);
      assert.ok(proof.includes(esc(f.quotedClaim)), `${p.ean}|${i}: FULL exact claim quote preserved`);
    }
    app.backToList();
  }
  assert.ok(proofs >= 30, `proofs swept: ${proofs}`);
});

test('B1 pins: the 3 comparative EANs render a plain rule + truthful label/gap (no regulation text, no internal notes)', () => {
  const app = runApp(data, appScript);
  // Nestum Multi-grain + Nestum All Family: borderline, NO published ingredient
  // list — the internal "honest gap" note becomes a truthful plain gap line.
  for (const ean of ['9556001300225', '9556001025524']) {
    const p = byEan.get(ean);
    const f = p.claimFlags[0];
    assert.equal(f.ruleId, null);
    assert.match(f.claimFamily, /^comparative-claim/);
    assert.equal(!!p.ingredients, false);
    assert.match(f.quotedIngredient, INTERNAL_NOTE_RE); // fixture: the frozen note IS internal
    app.openDetail(ean);
    const proof = proofOf(app, ean, 0);
    assert.ok(proof.includes('Rule: ' + esc(COMPARATIVE_RULE)), `${ean}: plain comparative rule`);
    assert.ok(proof.includes('<p class="proof-gap">' + GAP_LINE + '</p>'), `${ean}: truthful honest-gap line`);
    assert.equal(/Label: /.test(proof), false, `${ean}: no Label quote at all`);
    assert.equal(proof.includes(esc(f.thresholdContext)), false, `${ean}: raw thresholdContext never renders`);
    assert.ok(proof.includes(esc(f.quotedClaim)), `${ean}: full exact claim quote`);
    app.backToList();
  }
  // Super NutreMill: misleading, REAL full ingredient list (Sugar first) — the
  // proof shows the short relevant evidence; the full list lives behind info.
  const SN = '8888240054852';
  const sn = byEan.get(SN);
  const sf = sn.claimFlags[0];
  assert.equal(sf.ruleId, null);
  assert.ok(sn.ingredients && sf.quotedIngredient.startsWith('Sugar, Creamer'));
  app.openDetail(SN);
  const proof = proofOf(app, SN, 0);
  assert.ok(proof.includes('Rule: ' + esc(COMPARATIVE_RULE)), 'plain comparative rule');
  assert.ok(proof.includes('<p class="proof-label">Label: first ingredient is Sugar.</p>'), 'short real label evidence');
  assert.equal(proof.includes(esc(sf.quotedIngredient)), false, 'full 365-char list not in the proof');
  assert.equal(PROOF_FORBIDDEN_RE.test(unesc(proof)), false, 'no regulation/internal text');
  assert.ok(proof.includes(esc(sf.quotedClaim)), 'full exact claim quote');
  app.click('box', SN + '|inside');
  assert.ok(app.main.innerHTML.includes(esc(sf.quotedIngredient)), 'full exact list still one tap deeper in What\'s inside');
});

test('N3 canary: sodium key displays a whole mg number for EVERY product (salt×400 decimals rounded, display-only)', () => {
  const app = runApp(data, appScript);
  let checked = 0, hadDecimals = 0;
  for (const p of data.products) {
    const m = p.per100g || {};
    const raw = m.sodium ? m.sodium.value : (m.salt ? m.salt.value * 400 : null);
    app.openDetail(p.ean);
    const h = app.main.innerHTML;
    const key = h.match(/aria-label="Sodium ([\d.]+|not declared) mg per 100 g"/);
    if (raw == null) {
      assert.ok(!key || key[1] === 'not declared', `${p.ean}: no fabricated sodium`);
    } else {
      assert.ok(key, `${p.ean}: sodium key present`);
      assert.equal(key[1].includes('.'), false, `${p.ean}: sodium display has no decimals (${key[1]})`);
      assert.equal(Number(key[1]), Math.round(raw), `${p.ean}: display === rounded stored value`);
      if (Math.round(raw) !== raw) hadDecimals++;
      checked++;
    }
    app.backToList();
  }
  assert.ok(checked > 0 && hadDecimals > 0, `sodium keys swept: ${checked}, genuinely-decimal sources rounded: ${hadDecimals}`);
  // Display-only: the frozen data still holds the exact unrounded values.
  const dec = data.products.filter((p) => {
    const m = p.per100g || {};
    const raw = m.sodium ? m.sodium.value : (m.salt ? m.salt.value * 400 : null);
    return raw != null && Math.round(raw) !== raw;
  });
  assert.ok(dec.length >= 20, 'stored decimals untouched in the frozen projection');
});

test('NEGATIVE canary: no verdict/ruleId/confidence tags, approval stamps, regulation quotes, page refs or classifier internals in the detail view', () => {
  const app = runApp(data, appScript);
  for (const p of data.products) {
    app.openDetail(p.ean);
    // open every box + proof so the canary covers the whole rendered detail.
    for (const key of ['inside', 'nutrition', 'good', 'price', 'sources']) {
      if (app.main.innerHTML.includes(`data-toggle-box="${p.ean}|${key}"`)) app.click('box', `${p.ean}|${key}`);
    }
    for (let i = 0; i < p.claimFlags.length; i++) app.click('proof', `${p.ean}|${i}`);
    const h = app.main.innerHTML;
    assert.equal(/verdict: |confidence: |claim-verdict-tags/.test(h), false, `${p.ean}: no verdict/confidence tags`);
    assert.equal(/CLM-[A-Z]/.test(h), false, `${p.ean}: no ruleId tags`);
    assert.equal(/Founder-approved for publication|item D9-|item 2026/.test(h), false, `${p.ean}: no approval stamps`);
    assert.equal(/reg-quote|Cited threshold source|Regulator’s conclusion, quoted verbatim/.test(h), false, `${p.ean}: no regulation quotes`);
    assert.equal(/PDF pp|printed pp|Appendix II|reg 40A|pageRef/.test(h), false, `${p.ean}: no page refs`);
    assert.equal(/hand-classified sheet joined by EAN|Classifier |classifierId|exceptions-only review pending|Founder-confirmed classification/.test(h), false, `${p.ean}: no classifier internals`);
    assert.equal(/dose-box|data-toggle-dose|Dose context for a 30 kg child/.test(h), false, `${p.ean}: no dose boxes`);
    // P4 final-review B1: no regulation citations or internal roadmap jargon
    // anywhere in the rendered detail (surface + every expanded box/proof).
    assert.equal(/HPB Aug-2024|Food Regulations|founder to rule|slice \d|OFF\/OCR|borderline; founder/i.test(h), false, `${p.ean}: no regulation/internal-jargon text`);
    app.backToList();
  }
});

// ---------------------------------------------------------------------------
// 3. Additives: plain identity lines; flagged child-safety sentence + source.
// ---------------------------------------------------------------------------

test('additives render plain identity lines; flagged get ONE child-safety sentence + source; NO ADI / mg/kg / dose boxes', () => {
  const app = runApp(data, appScript);
  app.openDetail(GOLD);
  app.click('box', GOLD + '|inside');
  const h = app.main.innerHTML;
  assert.match(h, /E339iii — that’s Trisodium phosphate\./);
  assert.match(h, /Even a big bowl stays well under the safe daily limit for a child\./);
  const flagged = byEan.get(GOLD).ingredientDecode.additives.find((a) => a.flagged);
  assert.ok(h.includes(flagged.source.url), 'flagged additive source link');
  assert.match(h, /E306 — that’s Tocopherol-rich extract\. Safe\./);
  assert.equal(/mg\/kg|daily budget for|Max permitted level:|Published ADI:|ADI:|dose-box|= \d+ bowls/.test(h), false);
  // unverified flagged additive: honest plain omission, no number.
  const uv = data.products.find((p) => (p.ingredientDecode?.additives ?? []).some((a) => a.flagged && a.doseContext && a.doseContext.verified === false));
  app.openDetail(uv.ean);
  app.click('box', uv.ean + '|inside');
  assert.match(app.main.innerHTML, /No official safe limit is set for this additive, so we don’t give a number\./);
  assert.equal(/dose-box|mg\/kg/.test(app.main.innerHTML), false);
});

// ---------------------------------------------------------------------------
// 4. Nutrition (4 dots + full panel behind info), Good to know, label link-out.
// ---------------------------------------------------------------------------

test('Nutrition shows 4 key numbers with colour dots; the full panel opens behind info', () => {
  const app = runApp(data, appScript);
  app.openDetail(QUAKER);
  const h = app.main.innerHTML;
  assert.equal((h.match(/class="nutrition-key"/g) ?? []).length, 4, '4 key numbers');
  assert.equal((h.match(/class="nutrition-dot"/g) ?? []).length, 4, '4 colour dots');
  for (const label of ['Sugars', 'Sat fat', 'Fibre', 'Sodium']) assert.ok(h.includes(label), `key: ${label}`);
  assert.equal(/table class="nutrition"/.test(h), false, 'full panel hidden until info');
  app.click('box', QUAKER + '|nutrition');
  assert.match(app.main.innerHTML, /table class="nutrition"/);
});

test('Good to know carries Halal + allergens; sugar-teaspoon visual lives in What\'s inside', () => {
  const app = runApp(data, appScript);
  app.openDetail(CORNFLAKES);
  const h = app.main.innerHTML;
  const good = h.slice(h.indexOf('Good to know'), h.indexOf('Price · both stores'));
  assert.match(good, /Halal/);
  assert.match(good, /Contains:|No allergens derived/);
  assert.match(h, /Sugar, in teaspoons/);
  // full dietary assessments + SFA list one tap deeper.
  app.click('box', CORNFLAKES + '|good');
  assert.match(app.main.innerHTML, /Dietary assessments/);
  assert.match(app.main.innerHTML, /sfa-table/);
});

test('See the label photo link-out targets the HUMAN Open Food Facts product page for EVERY product (never the /api/v2/ JSON URL)', () => {
  const app = runApp(data, appScript);
  let linked = 0;
  for (const p of data.products) {
    app.openDetail(p.ean);
    const h = app.main.innerHTML;
    // P4 review fix S1: every product has a real EAN, so the human page is
    // always derivable — the link is always present and always /product/EAN.
    const m = h.match(/<a class="label-photo-link" href="([^"]+)"/);
    assert.ok(m, `${p.ean}: label-photo link present`);
    assert.equal(m[1], 'https://world.openfoodfacts.org/product/' + p.ean, `${p.ean}: human OFF product page`);
    assert.equal(/\/api\/v2\//.test(m[1]), false, `${p.ean}: NEVER the API JSON URL`);
    assert.match(h, /See the label photo ↗/);
    linked++;
    // The expanded "How we know" sources list also never links the JSON API.
    if (h.includes(`data-toggle-box="${p.ean}|sources"`)) {
      app.click('box', `${p.ean}|sources`);
      assert.equal(/href="[^"]*\/api\/v2\/product\//.test(app.main.innerHTML), false, `${p.ean}: no JSON link in sources`);
    }
    app.backToList();
  }
  assert.equal(linked, data.products.length, 'every product carries the human-page label-photo link');
  // Prefer the stored offProductUrl when present (it is already the human page).
  const withStored = data.products.filter((p) => p.result.image && p.result.image.offProductUrl);
  assert.ok(withStored.length > 0);
  for (const p of withStored) assert.equal(p.result.image.offProductUrl, 'https://world.openfoodfacts.org/product/' + p.ean);
  // It is a hyperlink — the static source still carries zero <img> tags (G3).
  assert.equal(/<img/i.test(html), false);
});

test('plain verdicts on the detail surface use the shared map (contradicted / unverified)', () => {
  const app = runApp(data, appScript);
  app.openDetail(QUAKER);
  assert.match(app.main.innerHTML, /doesn&#39;t match the label/);
  const uv = data.products.find((p) => p.claimFlags.some((f) => f.verdict === 'unverified'));
  app.openDetail(uv.ean);
  assert.match(app.main.innerHTML, /we couldn&#39;t check this/);
});

// ---------------------------------------------------------------------------
// 5. Display-only: data values untouched, zero data/ writes.
// ---------------------------------------------------------------------------

test('display-only: inline data === app/data.json; zero data/ writes', () => {
  const s = html.indexOf('/*__DATA_START__*/'), e = html.indexOf('/*__DATA_END__*/');
  const inline = JSON.parse(html.slice(s, e).match(/window\.__HEALTHHAWK_DATA__\s*=\s*([\s\S]*?);\s*$/)[1]);
  assert.equal(JSON.stringify(inline), JSON.stringify(data), 'inline block === app/data.json');
  const gitStatus = execFileSync('git', ['status', '--short', 'data/'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(gitStatus.trim(), '', 'zero data/ writes');
});