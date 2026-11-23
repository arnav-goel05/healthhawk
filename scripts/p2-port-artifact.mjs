#!/usr/bin/env node
// P2-06 native port artifact builder. READ-ONLY on app/, data/, scripts/.
// Ports the CURRENT app/index.html (already rebuilt by W2 merge — this script
// NEVER runs build-app.mjs and NEVER reads data/catalogue.json) to a
// standalone page artifact for the Hashmeta /compare rawHtml page:
//   - app/fuse.min.js inlined (the shell serves pages at their slug path; a
//     relative fuse.min.js fetch would 404 — spike §8 condition 4);
//   - <meta name="robots" content="noindex, nofollow"> added (PRD D1: app page
//     noindex; directory pages remain the crawl surface);
//   - title aligned with the page SEO title;
//   - NO draft banner (this is the real port, not a spike scratch).
// The inline __HEALTHHAWK_DATA__ block is kept VERBATIM from app/index.html
// and asserted equal to app/data.json (drift canary — never rebuilt here).
// Usage: node scripts/p2-port-artifact.mjs [outFile]
//   default out: runs/p2-06/port-artifact.html (+ .evidence.json)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isMain } from './is-main.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_START = '/*__DATA_START__*/';
export const DATA_END = '/*__DATA_END__*/';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Pure assembly — exported for the sync path (12-sync plan / p2-port-sync).
export function assemblePortArtifact(appHtml, fuseJs) {
  if (fuseJs.includes('</script')) throw new Error('fuse source contains </script — cannot inline safely');
  const start = appHtml.indexOf(DATA_START);
  const end = appHtml.indexOf(DATA_END);
  if (start < 0 || end < 0 || end < start) throw new Error('inline-data markers missing');
  const m = appHtml.slice(start, end).match(/window\.__HEALTHHAWK_DATA__ = ([\s\S]*?);\s*$/);
  if (!m) throw new Error('inline __HEALTHHAWK_DATA__ assignment not found');
  const data = JSON.parse(m[1]); // canary: the inline block must be valid JSON
  if (!Array.isArray(data.products) || data.products.length === 0) throw new Error('inline data has no products');
  if ((appHtml.match(/<script\b/g) ?? []).length !== 3) throw new Error('expected exactly 3 script blocks (fuse + data + app)');
  if (!appHtml.includes('<script src="fuse.min.js"></script>')) throw new Error('external fuse reference not found');
  // N4 (merge-06, final review): function-form replace — String.replace treats
  // $ patterns ($$, $&, $`) in the replacement string specially; the vendored
  // Fuse source contains $$ in regex getters, which collapsed to $ (4 chars).
  // Function form inserts the text literally.
  let html = appHtml.replace('<script src="fuse.min.js"></script>',
    () => '<script>/* app/fuse.min.js vendored inline (Apache-2.0) — native Hashmeta port, no external fetch */\n' + fuseJs + '\n</script>');
  html = html.replace('<title>HealthHawk — like-for-like grocery compare · Singapore</title>',
    () => '<title>Compare — HealthHawk</title>\n<meta name="robots" content="noindex, nofollow">');
  if (!html.includes('name="robots"')) throw new Error('noindex meta injection failed');
  return { html, data };
}

export function buildPortArtifact({ root = ROOT } = {}) {
  const appHtml = readFileSync(resolve(root, 'app', 'index.html'), 'utf8');
  const fuseJs = readFileSync(resolve(root, 'app', 'fuse.min.js'), 'utf8');
  const diskData = JSON.parse(readFileSync(resolve(root, 'app', 'data.json'), 'utf8'));
  const { html, data } = assemblePortArtifact(appHtml, fuseJs);
  if (JSON.stringify(data) !== JSON.stringify(diskData)) {
    throw new Error('DRIFT CANARY FAIL: app/index.html inline data != app/data.json — rebuild is owned elsewhere; port refused');
  }
  return {
    html,
    evidence: {
      builtAt: new Date().toISOString(),
      source: 'app/index.html (current artifact — NOT rebuilt)',
      bytes: Buffer.byteLength(html),
      sha256: sha256(html),
      sourceBytes: Buffer.byteLength(appHtml),
      sourceSha256: sha256(appHtml),
      fuseBytes: Buffer.byteLength(fuseJs),
      products: data.products.length,
      ratedCount: data.meta?.ratedCount ?? null,
      generatedAt: data.meta?.generatedAt ?? null,
      noindex: true,
      scriptBlocks: (html.match(/<script\b/g) ?? []).length,
    },
  };
}

function main() {
  const out = process.argv[2] ?? resolve(ROOT, 'runs', 'p2-06', 'port-artifact.html');
  const { html, evidence } = buildPortArtifact();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  writeFileSync(out.replace(/\.html$/, '') + '.evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ out, ...evidence }, null, 2));
}

if (isMain(import.meta.url)) main();