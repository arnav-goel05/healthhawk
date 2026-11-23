// P4-03 — Compare list simplify acceptance tests (docs/issues-p4/p4-03).
// Seam: DOM-stub boot of the REAL client on the built app/data.json (the
// p2-ux-*-ui / p3-app-reskin harness pattern). Asserts the three plain preset
// notes (ranking behaviour unchanged), removal of the label-watch strip and every
// listed-count line, one short filter-help line per group, the collapsed
// "How this works" footer + small legal line (no S(w) formula; attributions kept),
// and row flag badges using the shared plain-verdict map. NEGATIVE canaries: no
// label-watch strip, no count line, no S(w) formula, no caveat paragraphs. Honest
// "Not yet rated" labels stay. node --test, zero deps, zero network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadApp, runApp, esc } from '../scripts/p2-ux-harness.mjs';
import { PLAIN_VERDICTS } from '../scripts/lib/plain-verdicts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { html, appScript, data } = loadApp();
const byEan = new Map(data.products.map((p) => [p.ean, p]));
const PRESETS = ['best-value', 'balanced', 'healthiest'];

// ---------------------------------------------------------------------------
// 1. Preset notes: exact plain labels; ranking behaviour unchanged.
// ---------------------------------------------------------------------------

test('preset notes read EXACTLY the three plain labels', () => {
  const app = runApp(data, appScript);
  const note = () => (app.main.innerHTML.match(/<p class="preset-note">([^<]*)<\/p>/) || [])[1];
  assert.equal(note(), 'Health and price, equally'); // balanced default
  app.click('preset', 'best-value');
  assert.equal(note(), 'Best value for money · skips D/E grades');
  app.click('preset', 'healthiest');
  assert.equal(note(), 'Health first');
  // the old weighting-maths notes are gone
  assert.equal(/Price-weighted|Health-weighted|w = 0\.|Equal health and price \(w/.test(html), false);
});

test('preset ranking BEHAVIOUR unchanged: rendered order === engine projection under every preset', () => {
  for (const preset of PRESETS) {
    const app = runApp(data, appScript);
    app.click('preset', preset);
    for (const sec of app.sections()) {
      const range = byEan.get(sec.eans[0])?.range;
      if (!range || range === 'out-of-scope') continue;
      const entry = data.ranking.byRange[range][preset];
      assert.deepEqual(sec.eans, [...entry.ranked, ...entry.unpriceable, ...entry.unrated], `${preset} ${range} order === engine`);
    }
  }
  assert.deepEqual(data.ranking.presets.map((p) => p.w), [0.3, 0.5, 0.8], 'weights untouched');
});

// ---------------------------------------------------------------------------
// 2. No label-watch strip; flagged rows still carry plain badges.
// ---------------------------------------------------------------------------

test('NEGATIVE canary: no label-watch strip anywhere on the compare view; flagged rows still show plain badges', () => {
  const app = runApp(data, appScript);
  assert.equal(/label-watch|watch-card|data-watch-ean|data-watch-more/.test(app.main.innerHTML), false, 'no strip in default view');
  assert.equal(/class="label-watch"|\.hh-app \.label-watch|class="watch-card"/.test(html), false, 'strip CSS/markup removed from the app');
  // under a chip + search the strip stays gone
  app.click('chip', 'kids');
  assert.equal(/label-watch/.test(app.main.innerHTML), false);
  app.type('oats');
  assert.equal(/label-watch/.test(app.main.innerHTML), false);
  app.click('clearSearch');
  app.click('chip', 'all');
  // flagged rows carry a plain badge (shared map wording)
  const flagged = data.products.filter((p) => p.result.flagBadge && p.range !== 'out-of-scope');
  assert.ok(flagged.length > 0);
  for (const p of flagged) {
    const row = app.rowOf(p.ean);
    assert.match(row, /result-flag/, `${p.ean}: row flag badge present`);
    assert.ok(row.includes(esc(p.result.flagBadge.quotedClaim)), `${p.ean}: quoted claim on badge`);
  }
});

test('row flag badges use the shared plain-verdict map (visible wording); aria keeps the factual verdict', () => {
  const app = runApp(data, appScript);
  const contra = data.products.find((p) => p.result.flagBadge?.worst === 'contradicted');
  const unv = data.products.find((p) => p.result.flagBadge?.worst === 'unverified');
  // result-flag badge: visible verb is the plain map wording
  assert.ok(app.rowOf(contra.ean).includes(esc(PLAIN_VERDICTS.contradicted)), 'contradicted → plain wording');
  assert.ok(app.rowOf(unv.ean).includes(esc(PLAIN_VERDICTS.unverified)), 'unverified → plain wording');
  // aria-label retains the factual verdict word (screen readers / parity)
  assert.match(app.rowOf(unv.ean), /aria-label="Claim check: unverified/);
  // tag-strip claim badge also uses the plain map (expand +N if safety fills the cap)
  const gold = '4800361310031'; // misleading
  let row = app.rowOf(gold);
  if (!/claim-badge/.test(row)) { app.click('expandTags', gold); row = app.rowOf(gold); }
  assert.match(row, /⚑ misleading/); // misleading passes through unchanged
  const contraTag = data.products.find((p) => p.claimBadge?.worst === 'contradicted');
  let cRow = app.rowOf(contraTag.ean);
  if (!/claim-badge/.test(cRow)) { app.click('expandTags', contraTag.ean); cRow = app.rowOf(contraTag.ean); }
  assert.ok(cRow.includes(esc(PLAIN_VERDICTS.contradicted)), 'tag badge uses plain map');
});

// ---------------------------------------------------------------------------
// 3. No listed-count line anywhere on compare.
// ---------------------------------------------------------------------------

test('NEGATIVE canary: no listed-count line on compare (coverage line, aisle count, section count, result count, footer count)', () => {
  const app = runApp(data, appScript);
  const h = app.main.innerHTML;
  assert.equal(/coverage-line|cereals listed|products listed/.test(h), false, 'no coverage line');
  assert.equal(/dept-count/.test(h), false, 'no aisle count');
  assert.equal(/range-count/.test(h), false, 'no section count');
  assert.equal(/\d+ entries \(\d+ rated/.test(h), false, 'no footer directory count');
  assert.equal(/function coverageLineHTML/.test(appScript), false, 'coverage template removed');
  // search view: no result-count line (but the query is still named)
  app.type('oats');
  assert.match(app.main.innerHTML, /for “oats”/);
  assert.equal(/\d+ results? for/.test(app.main.innerHTML), false, 'no result count');
  // honest per-product "Not yet rated" labels STAY (check in the full default view)
  app.click('clearSearch');
  app.click('chip', 'all');
  const unrated = data.products.filter((p) => !p.rated && p.range !== 'out-of-scope');
  for (const p of unrated) assert.match(app.rowOf(p.ean) || '', /Not yet rated/, `${p.ean}: honest unrated label kept`);
});

// ---------------------------------------------------------------------------
// 3b. P4 final-review S2/N1: the REACHABLE empty/floor states carry no product
//     count either — filter-empty (chip=kids + q=oats) and the Best-value floor
//     note / floor-empty card. The explanation stays; the number goes.
// ---------------------------------------------------------------------------

const COUNT_PHRASE_RE = /\d+\s+(?:products?|options?|rated|unrated|matches)\b/i;

test('S2: filter-empty state (chip=kids + q=oats) renders a plain no-match hint with NO product count', () => {
  const app = runApp(data, appScript);
  app.click('chip', 'kids');
  app.type('oats');
  const h = app.main.innerHTML;
  assert.match(h, /No matches with these filters/, 'filter-empty state reached');
  assert.match(h, /No matches in this filter\. Try clearing it or searching all products\./, 'plain count-free hint');
  assert.equal(/elsewhere/.test(h), false, 'old elsewhere-count wording gone');
  assert.equal(COUNT_PHRASE_RE.test(h.replace(/<[^>]+>/g, ' ')), false, 'no product count in the filter-empty state');
  // escape hatches intact
  assert.match(h, /data-clear-filters/);
  assert.match(h, /data-clear-search/);
  app.click('clearFilters');
  assert.match(app.main.innerHTML, /for “oats”/, 'clear filters keeps the query');
});

test('N1: Best-value floor note + floor-empty card carry NO product count (explanation kept)', () => {
  const app = runApp(data, appScript);
  app.click('chip', 'kids');
  app.click('preset', 'best-value');
  const h = app.main.innerHTML;
  assert.match(h, /Lower-rated \(D\/E\) options are hidden by Best value\./, 'count-free floor note');
  assert.equal(/\d+ lower-rated/.test(h), false, 'old counted floor note gone');
  assert.match(h, /data-toggle-floor/, 'one-tap override kept');
  // Sweep every chip × best-value: any floor note / floor-empty card is count-free.
  for (const c of data.meta.chips) {
    app.click('chip', c.id);
    const view = app.main.innerHTML.replace(/<[^>]+>/g, ' ');
    for (const m of view.matchAll(/[^.]*\b(?:hidden by|health floor)[^.]*\./g)) {
      assert.equal(COUNT_PHRASE_RE.test(m[0]), false, `${c.id}: count in floor wording: ${m[0]}`);
    }
  }
  // Floor-empty card (search narrows a range to zero floor-passing rows).
  const app2 = runApp(data, appScript);
  app2.type('oats');
  app2.click('preset', 'best-value');
  const h2 = app2.main.innerHTML;
  if (/No options pass the/.test(h2)) {
    assert.match(h2, /The rated options matching your search\/filters in this range are graded/, 'count-free floor-empty explanation');
    assert.equal(/The \d+ rated/.test(h2), false, 'old counted floor-empty wording gone');
  }
});

// ---------------------------------------------------------------------------
// 4. Filter sheet: one short plain line per group; no caveat paragraphs.
// ---------------------------------------------------------------------------

test('filter sheet shows ONE short plain line per group; no caveat paragraph', () => {
  const app = runApp(data, appScript);
  app.click('openSheet');
  const h = app.main.innerHTML;
  const sheet = h.slice(h.indexOf('class="sheet"'));
  const helps = [...sheet.matchAll(/<p class="sheet-help">([^<]*)<\/p>/g)].map((m) => m[1]);
  assert.equal(helps.length, 4, 'one help line per group (Store, Price, Dietary, Claim checks)');
  for (const line of helps) assert.ok(line.length <= 80, `short line: ${line}`);
  // the old multi-sentence caveat paragraph is gone
  assert.equal(/Gluten-free = label claim only \(SG|Products without a published ingredient list cannot be verified and are excluded while/.test(sheet), false);
  // toggle semantics intact (vegan toggle still present)
  assert.match(sheet, /data-toggle-diet="vegan"/);
  app.click('closeSheet');
});

// ---------------------------------------------------------------------------
// 5. Footer: one collapsed "How this works" + small legal line; no S(w) formula.
// ---------------------------------------------------------------------------

test('footer is ONE collapsed "How this works" + a small legal line; attributions preserved; no S(w) formula on screen', () => {
  const app = runApp(data, appScript);
  const h = app.main.innerHTML;
  assert.match(h, /data-toggle-footer/, 'one collapsed How this works toggle');
  assert.equal((h.match(/data-toggle-footer/g) ?? []).length, 1);
  assert.match(h, /class="legal-line"/, 'small legal line present');
  // collapsed by default: the how-body is not rendered until tapped
  assert.equal(/class="box-body how-body"/.test(h), false);
  app.click('footer');
  assert.match(app.main.innerHTML, /class="box-body how-body"/);
  assert.match(app.main.innerHTML, /Filtering never re-prices the remaining options/);
  // NEGATIVE: the S(w) weighting formula + multi-paragraph methodology are cut.
  assert.equal(/S\(w\) = w·H \+ \(1−w\)·V/.test(html), false, 'no S(w) formula anywhere in the app');
  assert.equal(/Best value w = 0\.3, Balanced w = 0\.5/.test(html), false);
  // legal line keeps Nutri-Score attribution + photo licence + OFF ODbL + directory link.
  const legal = app.main.innerHTML.match(/<p class="legal-line">[\s\S]*?<\/p>/)[0];
  assert.match(legal, /Not an official Nutri-Score label/);
  assert.match(legal, /Nutri-Score 2023 algorithm/);
  assert.match(legal, /CC BY-SA 3\.0/);
  assert.match(legal, /ODbL 1\.0/);
  assert.ok(legal.includes('<a href="/products">/products</a>'), 'relative directory link kept');
});

// ---------------------------------------------------------------------------
// 6. Display-only: zero data/ writes; honest states preserved.
// ---------------------------------------------------------------------------

test('display-only: zero data/ writes; loading skeletons + two empty states preserved', () => {
  const gitStatus = execFileSync('git', ['status', '--short', 'data/'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(gitStatus.trim(), '', 'zero data/ writes');
  assert.match(html, /class="skeleton" aria-busy="true"/, 'loading skeleton kept');
  const app = runApp(data, appScript);
  app.type('xyzzyplughqwerty');
  assert.match(app.main.innerHTML, /We haven’t reviewed/, 'search-empty state kept');
  app.click('clearSearch');
  app.type('harraways');
  app.click('chip', 'kids');
  assert.match(app.main.innerHTML, /No matches with these filters/, 'filter-empty state kept');
});