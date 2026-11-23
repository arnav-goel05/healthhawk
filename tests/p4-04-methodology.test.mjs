// P4-04 — methodology simplify canaries. Reads the local simplified draft
// (runs/p4-04/methodology-new.html) and asserts the three anchor sections,
// kept content (A–E ladder, Cornflakes vs Weet-Bix, FAQ, sources/licences,
// limitations) and the absence of everything the PRD cuts from screen.
// Zero deps. Display-only slice: no data/ reads or writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(ROOT, 'runs', 'p4-04', 'methodology-new.html'), 'utf8');

const section = (id) => {
  const m = html.match(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`));
  assert.ok(m, `section #${id} exists`);
  return m[0];
};

// ---- A. three anchor sections, each 3–5 plain lines ------------------------

test('exactly three top-level sections with ids labels, grade, claims (in order)', () => {
  const ids = [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['labels', 'grade', 'claims']);
  for (const id of ids) {
    const count = html.split(`id="${id}"`).length - 1;
    assert.equal(count, 1, `id="${id}" appears exactly once (unique scroll anchor)`);
  }
});

test('each anchor section has 3–5 plain lines', () => {
  for (const id of ['labels', 'grade', 'claims']) {
    const lines = section(id).match(/<p class="line">/g) || [];
    assert.ok(lines.length >= 3 && lines.length <= 5, `#${id} has ${lines.length} lines (want 3–5)`);
  }
});

test('section headings match the homepage how-it-works link labels', () => {
  assert.match(section('labels'), /<h2[^>]*>How we read the label<\/h2>/);
  assert.match(section('grade'), /<h2[^>]*>How the grade works<\/h2>/);
  assert.match(section('claims'), /<h2[^>]*>How claims are checked<\/h2>/);
});

test('on-page anchor nav links to all three sections', () => {
  for (const id of ['labels', 'grade', 'claims']) {
    assert.ok(html.includes(`href="#${id}"`), `nav link to #${id}`);
  }
});

test('anchor sections set scroll-margin so the sticky header does not cover them', () => {
  assert.match(html, /scroll-margin-top:\s*\d+px/);
});

// ---- B. kept content --------------------------------------------------------

test('A–E grade ladder present in #grade (five filled stamps, letter + word)', () => {
  const s = section('grade');
  assert.ok(s.includes('grade-ladder'), 'visual ladder container');
  for (const g of ['a', 'b', 'c', 'd', 'e']) {
    assert.ok(s.includes(`hh-grade-${g}`), `grade ${g.toUpperCase()} stamp`);
  }
  const letters = [...s.matchAll(/hh-grade-letter">([A-E])</g)].map((m) => m[1]);
  for (const letter of ['A', 'B', 'C', 'D', 'E']) {
    assert.ok(letters.includes(letter), `ladder letter ${letter}`);
  }
  assert.match(s, /rung-word">Best</);
  assert.match(s, /rung-word">Worst</);
});

test('Cornflakes vs Weet-Bix story present in #grade with the panel-not-packaging line', () => {
  const s = section('grade');
  assert.match(s, /Cornflakes/);
  assert.match(s, /Weet-Bix/);
  assert.match(s, /Same shelf, same algorithm: D vs A/);
  assert.match(s, /the difference is in the panel, not the packaging/);
});

test('simplified FAQ present (at least three plain Q/A pairs)', () => {
  assert.match(html, /<h2>FAQ<\/h2>/);
  const faq = html.match(/<h2>FAQ<\/h2>[\s\S]*?<\/div>\s*<\/div>/)[0];
  const pairs = faq.match(/<details>\s*<summary>[^<]+<\/summary>\s*<p>[\s\S]*?<\/p>\s*<\/details>/g) || [];
  assert.ok(pairs.length >= 3, `FAQ has ${pairs.length} Q/A pairs (want >= 3)`);
  assert.match(faq, /official Nutri-Score/);
  assert.match(faq, /Not yet rated/);
});

test('sources & licences present: FairPrice, OFF ODbL + CC BY-SA, Nutri-Score attribution, HPB guide', () => {
  assert.match(html, /Sources &amp; licences/);
  assert.match(html, /FairPrice/);
  assert.match(html, /fairprice\.com\.sg/);
  assert.match(html, /Open Food Facts, licensed under ODbL 1\.0/);
  assert.match(html, /CC BY-SA/);
  assert.match(html, /packaging may differ/);
  assert.match(html, /Nutri-Score 2023 algorithm \(Santé publique France\)/);
  assert.match(html, /not the official mark/);
  assert.ok(
    html.includes('https://isomer-user-content.by.gov.sg/484/52300722-8fa4-41aa-a3b3-4bed2258b59c/a-guide-to-nutrition-labelling-for-food-products-(aug24)-(3).pdf'),
    'HPB nutrition labelling guide link'
  );
  assert.ok(html.includes('https://www.hpb.gov.sg/healthy-living/food-and-beverage/nutri-grade/'), 'HPB Nutri-Grade link');
});

test('honest limitations present, including Not yet rated and not-medical-advice framing', () => {
  assert.match(html, /<h2>Honest limitations<\/h2>/);
  const lim = html.match(/<h2>Honest limitations<\/h2>[\s\S]*?<\/div>\s*<\/div>/)[0];
  assert.match(lim, /Not yet rated/);
  assert.match(lim, /never make up a grade/);
  assert.match(lim, /Not medical or dietary advice/);
  assert.match(lim, /check the pack in store/);
});

test('Hashmeta theme variables/classes kept so the draft renders in-theme', () => {
  for (const token of [
    'hsl(var(--background))',
    'hsl(var(--card))',
    'var(--section-y)',
    'var(--container-narrow)',
    'var(--container-pad)',
    'var(--text-h1)',
    'var(--text-h2)',
    'var(--border-width)',
    'page-block-methodology-',
    'container-narrow',
  ]) {
    assert.ok(html.includes(token), `theme token ${token}`);
  }
});

test('tap targets >= 44px on anchor nav and FAQ summaries', () => {
  assert.match(html, /\.anchor-nav a \{[^}]*min-height: 44px/);
  assert.match(html, /summary \{[^}]*min-height: 44px/);
});

// ---- C. negative canaries: everything the PRD cuts from screen --------------

test('no H/V/S(w) formulas or weighting maths', () => {
  assert.doesNotMatch(html, /S\(w\)/);
  assert.doesNotMatch(html, /w\s*=\s*0\.\d/);
  assert.doesNotMatch(html, /\bclamp\(/i);
  assert.doesNotMatch(html, /H \(Health\)/);
  assert.doesNotMatch(html, /V \(Value\)/);
  assert.doesNotMatch(html, /p_min/);
  assert.doesNotMatch(html, /health per dollar/i);
});

test('no point tables or numeric scoring tables (no tables at all)', () => {
  assert.doesNotMatch(html, /<table/i);
  assert.doesNotMatch(html, /\bpoints?\b/i);
  assert.doesNotMatch(html, /(?<!Nutri-)score\s+\d/i);
  assert.doesNotMatch(html, /Negative total/i);
  assert.doesNotMatch(html, /point derivation/i);
});

test('no six-locks gate prose', () => {
  assert.doesNotMatch(html, /six locks/i);
  assert.doesNotMatch(html, /\blocks\b/i);
  assert.doesNotMatch(html, /audit log/i);
  assert.doesNotMatch(html, /reviewer agents/i);
});

test('no additive-wording guidelines', () => {
  assert.doesNotMatch(html, /additive wording/i);
  assert.doesNotMatch(html, /chemophobia/i);
  assert.doesNotMatch(html, /aspartame/i);
  assert.doesNotMatch(html, /nitrite/i);
  assert.doesNotMatch(html, /Southampton/i);
  assert.doesNotMatch(html, /IARC/);
  assert.doesNotMatch(html, /\bADI\b/);
  assert.doesNotMatch(html, /mg\/kg/);
});

test('no Yuka comparison', () => {
  assert.doesNotMatch(html, /yuka/i);
});

test('no PARKED / launch-scope internal language', () => {
  assert.doesNotMatch(html, /PARKED/);
  assert.doesNotMatch(html, /launch scope/i);
  assert.doesNotMatch(html, /not faked/i);
  assert.doesNotMatch(html, /launch gate/i);
});

test('no Cold Storage reference (kills the stale price contradiction)', () => {
  assert.doesNotMatch(html, /Cold Storage/i);
  assert.doesNotMatch(html, /S\$6\.45/);
});

test('no hardcoded product/drink counts', () => {
  assert.doesNotMatch(html, /17 cereal drinks/i);
  assert.doesNotMatch(html, /\b80 products\b/i);
  assert.doesNotMatch(html, /\d+\s+(?:products|SKUs|cereal drinks)\b/i);
  assert.doesNotMatch(html, /\b57 rated\b/i);
  assert.doesNotMatch(html, /\b23 unrated\b/i);
  assert.doesNotMatch(html, /\b104\b/);
  assert.doesNotMatch(html, /\b80\b/);
});

test('no internal jargon (ruleId, confidence, classifier, EAN, OCR, provenance)', () => {
  assert.doesNotMatch(html, /ruleId/i);
  assert.doesNotMatch(html, /confidence/i);
  assert.doesNotMatch(html, /classifier/i);
  assert.doesNotMatch(html, /\bEAN\b/);
  assert.doesNotMatch(html, /\bOCR\b/);
  assert.doesNotMatch(html, /provenance/i);
  assert.doesNotMatch(html, /deterministic/i);
  assert.doesNotMatch(html, /\btier\b/i);
});

// ---- D. staged block array matches the draft --------------------------------

test('methodology-blocks.json: same layout shape, html concatenation equals the draft', () => {
  const blocks = JSON.parse(readFileSync(resolve(ROOT, 'runs', 'p4-04', 'methodology-blocks.json'), 'utf8'));
  assert.ok(Array.isArray(blocks) && blocks.length >= 3);
  for (const b of blocks) {
    assert.equal(typeof b.id, 'string');
    assert.equal(b.containerWidth, 'full');
    assert.equal(b.blockType, 'rawHtml');
    assert.ok(b.html.includes('page-block-methodology-'));
  }
  assert.equal(blocks.map((b) => b.html).join(''), html);
});