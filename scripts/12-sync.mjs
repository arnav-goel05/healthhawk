#!/usr/bin/env node
// HealthHawk slice 12 — publish-sync (EAN-keyed, diff-guarded, idempotent).
// Catalogue (read-only source of truth) -> Hashmeta Products collection plan.
// The script NEVER writes the catalogue, the human-classified sheet, or
// Hashmeta itself: it computes a plan (runs/12-sync-plan-*.json); the agent
// session executes the plan through the Hashmeta MCP tools
// (save_collection_entries -> build_collection_pages -> publish_changes),
// then `commit` records the new last-sync snapshot (runs/12-sync-state.json).
//
// Guards (all machine-tested in tests/publish-sync.test.mjs):
//   - catalogue canary (validateCatalogue) + collection-schema canary BEFORE
//     any write is planned;
//   - approval gate: grade changes (incl. removal) without an approved
//     grade-change record are REJECTED; other reputational field changes
//     without any approved queue item for the EAN are REJECTED;
//   - G4 content-hash binding (founder-os slice 10, ADDITIVE): an approved
//     non-grade queue item carrying review.evidenceContentHash binds the
//     approval to the EXACT evidence text; changed evidence content under
//     such an approval is REJECTED with an explicit hash-mismatch reason
//     (fresh gate pass required). Legacy approvals without the field keep
//     EAN-level semantics; the grade path (D9/F2) is untouched;
//   - price-only changes (price/pricePer100g/priceCheckedAt) -> auto-publish;
//   - diff-guard: only entries whose data hash changed are upserted; a re-run
//     after commit plans ZERO writes;
//   - halt-on-block freeze: runs/stale-state.json stale:true -> frozen, no
//     writes planned until a successful refresh clears it;
//   - curated cornflakes entry (8852756304053): existing curated field text is
//     preserved verbatim; only price fields may refresh;
//   - sheet protection: sheet sha256 recorded at plan, re-verified at commit.
//
// Usage:
//   node scripts/12-sync.mjs seed --entries <list_collection_entries dump.json>
//   node scripts/12-sync.mjs plan [--schema runs/12-collection-schema.json]
//   node scripts/12-sync.mjs commit --plan runs/12-sync-plan-<ts>.json
//        [--written ean1,ean2] [--publish runs/12-publish-evidence.json]
//        [--app-readback runs/p2-06/readback-app.json]
//        [--collection-readback runs/p2-06/readback-collection.json]
//   node scripts/12-sync.mjs status
//
// P2-06 single-surface atomic release: plan now ALSO projects the native
// /compare app page (standalone artifact assembled read-only from app/ by
// p2-port-artifact.mjs). One release unit = app page + Products collection,
// published in ONE publish_changes call; commit requires readback of BOTH
// surfaces (verifyReadback) and refuses dirty/half states. The gate-leak
// guard halts the app release when collection rejections exist. Protocol
// model + partial-failure consistency: simulateRelease (machine-tested in
// tests/p2-sync-atomic.test.mjs).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateCatalogue } from './validate-catalogue.mjs';
import { readPendingQueue, gradeApproved } from './approval-gate.mjs';
import { buildPortArtifact } from './p2-port-artifact.mjs';
import { isMain } from './is-main.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_PATH = resolve(ROOT, 'runs', '12-sync-state.json');
export const STALE_PATH = resolve(ROOT, 'runs', 'stale-state.json');
// ---------------------------------------------------------------------------
// Slice 15 DATA FREEZE guard (additions only — library functions stay pure;
// the CLI entry points enforce the freeze). While runs/freeze-state.json has
// frozen:true, refresh crons may RUN but write NOTHING: plan exits 2 (the
// daily cron's frozen/halt contract → review report + finish) with a
// frozen-no-writes note (runs/15-freeze-note.json); seed/commit refuse (exit 1). Corrupt freeze state fails CLOSED.
// Unfreeze (founder-only): set frozen:false in runs/freeze-state.json or
// remove the file — documented in docs/reports/15-hardening.md.
// ---------------------------------------------------------------------------
export const FREEZE_PATH = resolve(ROOT, 'runs', 'freeze-state.json');
export function readFreeze(path = FREEZE_PATH) {
  if (!existsSync(path)) return { frozen: false };
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (s?.frozen === true) return { frozen: true, frozenAt: s.frozenAt ?? null, snapshotPath: s.snapshotPath ?? null, reason: s.reason ?? null };
    if (s?.frozen === false) return { frozen: false };
    return { frozen: true, corrupt: true }; // wrong shape -> fail closed
  } catch {
    return { frozen: true, corrupt: true }; // corrupt/partial -> fail closed
  }
}
export function freezeRefusal(cmd, freeze, runsDir = resolve(ROOT, 'runs')) {
  const note = {
    frozen: true, cmd, at: new Date().toISOString(), writes: 0,
    frozenAt: freeze.frozenAt ?? null, corrupt: freeze.corrupt === true,
    message: 'FROZEN — prototype data freeze active; refresh may run but writes NOTHING. Unfreeze (founder): set frozen:false in runs/freeze-state.json or remove the file.',
  };
  try { writeFileSync(resolve(runsDir, '15-freeze-note.json'), JSON.stringify(note, null, 2) + '\n'); } catch { /* note is best-effort */ }
  return note;
}
export const SHEET_PATH = resolve(ROOT, 'data', 'classification', 'sheet.json');
export const CAT_PATH = resolve(ROOT, 'data', 'catalogue.json');
export const COLLECTION = {
  projectId: '94cd94ad-83a5-49fa-bcd5-447a76cb3fa7',
  templateId: '3748f1aa-89bc-4e3b-be53-b5571ea48380',
  siteUrl: 'https://healthhawk.geo.hashmeta.tech',
};
// P2-06: the compare app is a NATIVE Hashmeta page (/compare, pageId 2).
// One release unit = app page + Products collection (single publish_changes
// release; readback of BOTH surfaces required before commit; dirty-state
// detection refuses half-commits). See planAppSurface / verifyReadback /
// detectDirty / simulateRelease below and tests/p2-sync-atomic.test.mjs.
export const APP_PAGE = { pageId: 2, slug: 'compare', path: '/compare' };
export const CURATED_EAN = '8852756304053';
export const ENTRY_FIELDS = ['ean', 'name', 'brand', 'store', 'packSize', 'price', 'pricePer100g', 'grade', 'gradeAttribution', 'range', 'department', 'ingredients', 'nutrition', 'provenance', 'sourceUrl', 'priceCheckedAt', 'disclaimer', 'halal', 'ingredientDecode', 'claimChecks', 'panelNotes'];
export const PRICE_FIELDS = ['price', 'pricePer100g', 'priceCheckedAt'];
export const DISCLAIMER = 'Hawk Grades compare products within the same category only. Not medical or dietary advice. Prices and labels change — always check the pack in store. Contains information from Open Food Facts (https://world.openfoodfacts.org), licensed under ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/).';
export const STORE_LABELS = { FairPrice: 'FairPrice', ColdStorage: 'Cold Storage' };

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const compact = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
const stable = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, stable(o[k])])) : o);
const canon = (o) => JSON.stringify(stable(o));
export const dataHash = (data) => sha256(canon(data));
const sgtDate = (iso) => new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 10);
const fmt = (n, dp = 2) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(dp) : '');

// ---------- deterministic entry projection (pure) ----------

// Primary offer = lowest pack price (tie: store label asc). Never invents.
export function primaryOffer(p) {
  const offers = (p.offers ?? []).filter((o) => typeof o.packPrice === 'number' && o.packPrice > 0);
  if (offers.length === 0) return null;
  return [...offers].sort((a, b) => a.packPrice - b.packPrice || String(a.store).localeCompare(String(b.store)))[0];
}

const NUTRIENT_ORDER = ['energy_kj', 'energy_kcal', 'fat', 'saturated_fat', 'carbohydrate', 'sugars', 'fibre', 'protein', 'sodium', 'salt'];
const NUTRIENT_LABELS = { energy_kj: 'energy', energy_kcal: '', fat: 'fat', saturated_fat: 'saturated fat', carbohydrate: 'carbohydrate', sugars: 'sugars', fibre: 'fibre', protein: 'protein', sodium: 'sodium', salt: 'salt' };

export function nutritionSummary(p) {
  const n = p.nutrition;
  if (!n || !n.per100g) return '';
  const parts = [];
  for (const key of NUTRIENT_ORDER) {
    const e = n.per100g[key];
    if (!e || typeof e.value !== 'number') continue;
    if (key === 'energy_kcal') { parts[parts.length - 1] += ` / ${e.value} kcal`; continue; }
    parts.push(`${NUTRIENT_LABELS[key]} ${e.value} ${e.unit}`);
  }
  let out = parts.length ? `Per 100 g: ${parts.join('; ')}.` : '';
  if (n.perServing && n.servingSizeG) {
    const sp = [];
    for (const key of NUTRIENT_ORDER) {
      const e = n.perServing[key];
      if (!e || typeof e.value !== 'number') continue;
      if (key === 'energy_kcal') { sp[sp.length - 1] += ` / ${e.value} kcal`; continue; }
      sp.push(`${NUTRIENT_LABELS[key]} ${e.value} ${e.unit}`);
    }
    if (sp.length) out += ` Per ${n.servingSizeG} g serving (label-declared): ${sp.join('; ')}.`;
  }
  return out;
}

export function provenanceText(p, offer) {
  const bits = [];
  const day = (t) => (t ? String(t).slice(0, 10) : 'unknown date');
  if (p.ingredients?.text) bits.push(`Ingredients: ${p.ingredients.provenanceTier ?? 'label-declared'} from ${p.ingredients.sourceUrl ?? 'retailer listing'}, fetched ${day(p.ingredients.fetchedAt)}.`);
  const tiers = new Set(Object.values(p.nutrition?.per100g ?? {}).map((e) => e?.provenanceTier).filter(Boolean));
  if (tiers.has('off-label')) bits.push(`Per-100g nutrition: Open Food Facts (off-label, ODbL 1.0), fetched ${day(p.nutrition?.off?.fetchedAt)}.`);
  if (tiers.has('ocr-label')) bits.push(`Some per-100g values: OCR of the OFF label photo (ocr-label), founder-approved basis (see catalogue nutrition.basisDecisions).`);
  if (tiers.has('estimated-derived')) bits.push(`Salt estimated-derived from sodium (mg / 1000 x 2.5).`);
  if (tiers.has('label-declared')) bits.push(`Per-serving panel: retailer listing, label-declared.`);
  if (p.eanKind === 'coldstorage-item-code') bits.push(`EAN "${p.ean}" is a Cold Storage internal item code, NOT a verified GTIN (gtinVerified:false) — never barcode-matched. Cold Storage is price-only: no ingredients/nutrition published; unrated until label data exists.`);
  if (offer) bits.push(`Price: ${STORE_LABELS[offer.store] ?? offer.store} ${offer.sourceUrl ?? ''}, checked ${day(offer.priceCheckedAt)}${offer.inventoryStatus ? ` (${offer.inventoryStatus})` : ''}.`);
  const stores = [...new Set((p.offers ?? []).map((o) => STORE_LABELS[o.store] ?? o.store))];
  if (stores.length > 1) bits.push(`Carried at: ${stores.join(' + ')} (card shows the lowest pack price).`);
  bits.push(`Halal: ${p.halal?.status === 'certified' ? 'certified (retailer dietary attribute)' : 'Unknown — no certification attribute stated; never inferred from ingredients'}.`);
  return bits.join(' ');
}

// ---------- slice 11b evidence projection (pure; additive fields only) ----------
// Evidence sources are read-only curated artifacts: data/additives/occurrences.json
// + verdicts.json (slice 8, founder-delegated curation) and APPROVED claim-flag
// queue items (pending/, review != null). Nothing here changes grades, prices or
// approval semantics; unapproved flags never render.

export function ingredientDecodeText(p, evidence) {
  const occ = evidence?.occurrences; const verdicts = evidence?.verdicts;
  if (!occ || !verdicts) return '';
  const ean = String(p.ean);
  const blocks = [];
  const packaging = [];
  for (const id of Object.keys(occ).sort()) {
    const rows = (occ[id] ?? []).filter((r) => String(r.ean) === ean);
    if (rows.length === 0) continue;
    const v = verdicts[id];
    if (!v) continue;
    for (const r of rows) {
      const ex = String(r.excerpt ?? '').replace(/\s+/g, ' ').trim();
      const term = String(r.matchedTerm ?? '');
      let quote = ex;
      const at = term ? ex.toLowerCase().indexOf(term.toLowerCase()) : -1;
      if (at >= 0 && ex.length > 180) {
        const s = Math.max(0, at - 70); const e = Math.min(ex.length, at + term.length + 90);
        quote = `${s > 0 ? '…' : ''}${ex.slice(s, e)}${e < ex.length ? '…' : ''}`;
      } else if (ex.length > 180) {
        quote = `${ex.slice(0, 177)}…`;
      }
      // Curator useNote (e.g. packaging-material BHT): never list as an in-food
      // additive; render separately with the curator's note, no in-food verdict.
      if (r.useNote) {
        packaging.push(`${v.name}. Label: "${quote}". ${r.useNote}`);
        continue;
      }
      const pos = r.positionBand === 'unknown'
        ? 'position withheld — unclosed source brackets, never guessed'
        : `position: ${r.positionBand}`;
      const lines = [`${v.name} (${(v.function ?? []).join('/')}). Label: "${quote}" [${pos}].`, v.safetyVerdict];
      // P2-14: verbatim regulator conclusion quote (or honest gap) — same contract as the app.
      const er = evidence?.additiveEvidence?.[id] ?? null;
      if (er) {
        if (er.status === 'verified' && er.quote) {
          lines.push(`Regulator conclusion (verbatim): "${er.quote}" — ${er.source?.canonicalUrl ?? v.source?.url ?? ''}${er.source?.retrievedAt ? ` (retrieved ${String(er.source.retrievedAt).slice(0, 10)})` : ''}.`);
        } else if (er.status === 'gap') {
          lines.push(`Regulator conclusion quote pending: ${er.gapReason ?? 'not yet retrieved'}${er.source?.canonicalUrl ? ` — ${er.source.canonicalUrl}` : ''}.`);
        }
      }
      if (v.adi?.value != null) lines.push(`ADI: ${v.adi.value} ${v.adi.unit} (${v.adi.provenance}${v.adi.source ? `; ${v.adi.source}` : ''}).`);
      if (v.flagged && v.doseContext) {
        lines.push(v.doseContext.verified === true
          ? `Dose context (flagged): ${v.doseContext.statement}`
          : `Dose context (flagged): numeric bowl count withheld — ${String(v.doseContext.reason || v.doseContext.note || 'no official Codex GSFA breakfast-cereal (06.3) max level exists for this additive').replace(/\.$/, '')}.`);
      }
      if (v.source?.url) lines.push(`Evidence: ${v.source.url} (${v.evidenceTier}).`);
      blocks.push(lines.join('\n'));
    }
  }
  if (blocks.length === 0 && packaging.length === 0) return '';
  const parts = [];
  if (blocks.length > 0) parts.push(`Additive decode — curated verdicts, ${blocks.length} ${packaging.length > 0 ? 'in-food occurrence(s)' : 'occurrence(s)'}. Safe additives are stated as safe; no chemophobia.\n\n${blocks.join('\n\n')}`);
  if (packaging.length > 0) parts.push(`Packaging/contact-material declarations — NOT in-food additives (curator useNote honoured):\n\n${packaging.join('\n')}`);
  return parts.join('\n\n');
}

// Proposal-era wording is historical queue record; strip it at RENDER time only
// (merge-05 review issue 2) — the queue items themselves are never rewritten.
const renderSummary = (s) => {
  const t = String(s ?? '')
    .replace(/Proposal only — washing-detection has no publish path\.?/g, '')
    .replace(/\s+$/, '')
    .replace(/\.\.$/, '.');
  return t && !/[.!?]$/.test(t) ? `${t}.` : t;
};

export function claimChecksText(p, evidence) {
  const flags = (evidence?.approvedFlags ?? []).filter((i) => String(i.ean) === String(p.ean) && i.kind === 'claim-flag' && i.status === 'approved' && i.review != null);
  if (flags.length === 0) return '';
  // Slice-4 items carry no evidence.verdict/ruleId; fall back to the deterministic
  // findings of record (flagged verdicts only) so the severity label is faithful.
  const flagged = (evidence?.findings ?? []).filter((f) => String(f.ean) === String(p.ean) && (f.verdict === 'misleading' || f.verdict === 'contradicted'));
  const fallbackVerdict = flagged.length > 0 && flagged.every((f) => f.verdict === flagged[0].verdict) ? flagged[0].verdict : null;
  const fallbackRules = [...new Set(flagged.map((f) => f.ruleId).filter(Boolean))];
  const blocks = flags.map((i) => {
    const e = i.evidence ?? {};
    const t = e.thresholdSource ?? {};
    const verdict = e.verdict ? String(e.verdict).toUpperCase() : (fallbackVerdict ? fallbackVerdict.toUpperCase() : 'APPROVED FLAG');
    const ruleIds = e.ruleId ? [e.ruleId] : fallbackRules;
    const rule = e.ruleId ? ` — rule ${e.ruleId}` : (fallbackRules.length > 0 ? ` — rule(s) ${fallbackRules.join(', ')}` : '');
    const threshold = t.pageRef
      ? `Threshold: ${t.pageRef}${t.url ? ` — ${t.url}` : ''}.`
      : (e.thresholdContext ? `Threshold context: ${e.thresholdContext}` : '');
    // Approval-conditional caveats (merge-05 review issue 1): render VERBATIM —
    // finding notes of record, fixRound annotations, merge annotations, and the
    // founder's claimNote. Never drop the conditions an approval was made under.
    const caveatLines = [];
    const rules = new Set(ruleIds);
    const notes = (evidence?.findings ?? [])
      .filter((f) => String(f.ean) === String(p.ean) && (rules.size === 0 || rules.has(f.ruleId)))
      .flatMap((f) => Array.isArray(f.notes) ? f.notes : (f.notes ? [f.notes] : []));
    for (const n of notes) caveatLines.push(`Finding note: ${n}`);
    for (const a of e.fixRound?.annotations ?? []) {
      if (a.text) {
        caveatLines.push(`Caveat [${a.type}]: ${a.text}`);
      } else if (a.data) {
        const d = a.data;
        caveatLines.push(`Caveat [${a.type}]: ${d.label ?? ''} — assumed volume ${d.assumedVolumeMl} ml, declared serving ${d.declaredServingG} g, fat ≈${d.fatPer100ml} g/100ml vs liquid criterion ≤${d.liquidCriterionGPer100ml} g/100ml.`);
      }
    }
    if (e.merge05Annotation?.note) caveatLines.push(`Derivation note: ${e.merge05Annotation.note}`);
    if (i.review?.claimNote) caveatLines.push(`Approval conditions (founder claimNote): ${i.review.claimNote}`);
    const lines = [
      `[${verdict}] "${e.quotedClaim ?? renderSummary(i.summary)}"${rule}${i.confidence ? ` (confidence: ${i.confidence})` : ''}.`,
      `Claim source: ${e.claimSource ?? 'see approval item'}.`,
      e.quotedIngredient ? `Evidence: "${e.quotedIngredient}" (${e.ingredientSource ?? 'label'}).` : `Context: ${renderSummary(i.summary) || 'see approval item.'}`,
      threshold,
      ...caveatLines,
      `Approved by ${i.review.approver ?? i.review.reviewer} on ${String(i.review.approvedAt ?? i.review.reviewedAt ?? '').slice(0, 10)} (${i.review.channel ?? 'founder approval'}; item ${i.id}).`,
    ];
    return lines.filter(Boolean).join('\n');
  });
  return `Claim checks — ${blocks.length} APPROVED flag(s) only. Unapproved proposals never render. Quoted claim vs quoted label evidence, cited threshold, approval-conditional caveats verbatim, founder approval provenance.\n\n${blocks.join('\n\n')}`;
}

export function panelNotesText(p) {
  const n = p.nutrition;
  if (!n) return '';
  const lines = [];
  const disc = n.off?.crossCheck?.discrepancies ?? [];
  for (const d of disc) lines.push(`Panel cross-check: ${d}`);
  for (const b of n.basisDecisions ?? []) {
    lines.push(`Basis decision (${b.nutrient}, ${String(b.decidedAt ?? '').slice(0, 10)}, ${b.approver ?? 'founder'}): ${b.note ?? b.decisionQuote ?? ''}`);
  }
  if (n.off?.supersededPer100g?.reason) lines.push(`Superseded values preserved, never deleted: ${n.off.supersededPer100g.reason}`);
  if (lines.length === 0) return '';
  return `Honest panel notes — disagreements between sources are surfaced, not hidden:\n\n${lines.join('\n')}`;
}

// Build the desired collection entry for one catalogue product. For the
// curated EAN with an existing entry, curated text is preserved verbatim and
// ONLY price fields refresh (price-only auto-publish path).
export function buildEntry(p, { queue = [], existing = null, evidence = null } = {}) {
  const offer = primaryOffer(p);
  const grade = p.rated === true && p.score?.grade ? p.score.grade : '';
  const base = {
    ean: String(p.ean),
    name: p.name ?? '',
    brand: p.brand ?? '',
    store: offer ? (STORE_LABELS[offer.store] ?? offer.store) : '',
    packSize: offer?.packSize ?? '',
    price: fmt(offer?.packPrice),
    pricePer100g: fmt(offer?.pricePer100g),
    grade,
    gradeAttribution: grade ? (p.score?.attribution ?? '') : '',
    range: p.range === 'UNCLASSIFIED' ? '' : (p.range ?? ''),
    department: p.department ?? '',
    ingredients: p.ingredients?.text ?? '',
    nutrition: nutritionSummary(p),
    provenance: provenanceText(p, offer),
    sourceUrl: offer?.sourceUrl ?? '',
    priceCheckedAt: offer?.priceCheckedAt ? String(offer.priceCheckedAt).slice(0, 10) : '',
    disclaimer: DISCLAIMER,
    halal: p.halal?.status === 'certified' ? 'Certified (retailer attribute)' : 'Unknown',
  };
  // 11b additive evidence fields — only when evidence is supplied AND non-empty.
  if (evidence) {
    const decode = ingredientDecodeText(p, evidence);
    const claims = claimChecksText(p, evidence);
    const notes = panelNotesText(p);
    if (decode) base.ingredientDecode = decode;
    if (claims) base.claimChecks = claims;
    if (notes) base.panelNotes = notes;
  }
  let data = base;
  if (p.ean === CURATED_EAN && existing) {
    data = { ...existing };
    for (const f of PRICE_FIELDS) data[f] = base[f];
  }
  const title = p.ean === CURATED_EAN && existing?.title ? existing.title : (offer?.packSize && !String(p.name).includes(offer.packSize) ? `${p.name} ${offer.packSize}` : p.name);
  return { slug: String(p.ean), title, data: { ...data, slug: String(p.ean), title } };
}

// ---------- diff classification (pure) ----------

export function classifyChange(prevData, nextData) {
  if (!prevData) return 'new';
  const keys = new Set([...Object.keys(prevData), ...Object.keys(nextData)]);
  const changed = [...keys].filter((k) => JSON.stringify(prevData[k]) !== JSON.stringify(nextData[k]));
  if (changed.length === 0) return 'unchanged';
  if (changed.every((k) => PRICE_FIELDS.includes(k))) return 'price-only';
  // P3-07: a department-only ADDITION (empty -> non-empty aisle label from the
  // frozen catalogue/config vocabulary) is structural, not reputational — it
  // carries no grade/flag/claim text. Value changes or removals stay gated.
  if (changed.length === 1 && changed[0] === 'department' && !String(prevData.department ?? '').trim() && String(nextData.department ?? '').trim()) return 'structural';
  return 'reputational';
}

// ---------- P2-06 atomic dual-surface release (pure) ----------

// App-page surface plan: hash the standalone port artifact against the
// last-sync state's appPage record. 'new' = first port; 'changed' = artifact
// drift since last release; 'unchanged' = diff-guard (no app write planned).
export function planAppSurface(artifactHtml, state = { entries: {} }) {
  const sha = sha256(artifactHtml);
  const prev = state.appPage ?? null;
  const change = !prev ? 'new' : (prev.sha256 !== sha ? 'changed' : 'unchanged');
  return { pageId: APP_PAGE.pageId, slug: APP_PAGE.slug, path: APP_PAGE.path, sha256: sha, bytes: Buffer.byteLength(artifactHtml), change, prevSha256: prev?.sha256 ?? null };
}

// Readback contract: EVERY release reads back BOTH surfaces, even when one of
// them had no planned writes (readback proves live == intended, not just
// "write accepted"). appReadback: { ok, sourceSha256, url, status, fetchedAt,
// servedDiff } produced by scripts/p2-port-verify.mjs (served rawHtml block
// reversed through the shell's script-deferral transform, then byte-compared
// to the artifact). collectionReadback: { ok, pages: [{ url, status, checks:
// [{ name, pass }] }], fetchedAt } — >=2 product pages, all checks pass.
export function verifyReadback({ plan, appReadback = null, collectionReadback = null }) {
  const problems = [];
  if (!plan?.appPage) return { ok: true, problems }; // legacy collection-only plan
  if (!appReadback) problems.push('app-surface readback missing (both surfaces required on every publish)');
  else {
    if (appReadback.ok !== true) problems.push(`app-surface readback failed: ${appReadback.reason ?? 'ok!=true'}`);
    if (appReadback.sourceSha256 !== plan.appPage.sha256) problems.push('app-surface readback sha256 does not match the planned artifact (dirty state)');
    if (appReadback.status !== 200) problems.push(`app-surface readback HTTP ${appReadback.status}`);
  }
  if (!collectionReadback) problems.push('collection-surface readback missing (both surfaces required on every publish)');
  else {
    if (collectionReadback.ok !== true) problems.push(`collection-surface readback failed: ${collectionReadback.reason ?? 'ok!=true'}`);
    const pages = collectionReadback.pages ?? [];
    if (pages.length < 2) problems.push('collection-surface readback needs >=2 product pages');
    for (const p of pages) {
      if (p.status !== 200) problems.push(`collection readback ${p.url}: HTTP ${p.status}`);
      for (const c of p.checks ?? []) if (!c.pass) problems.push(`collection readback ${p.url}: check "${c.name}" failed`);
      if ((p.checks ?? []).length === 0) problems.push(`collection readback ${p.url}: no checks`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// Dirty-state detection: compare live surfaces against the last-sync state.
// Any mismatch = dirty (a release happened without a commit, or an out-of-band
// write); the next plan still shows the diff and commit refuses until a
// successful readback converges state with live.
export function detectDirty({ state, liveAppSha256 = null, liveEntries = null }) {
  const problems = [];
  if (liveAppSha256 != null) {
    if (!state.appPage) problems.push({ surface: 'app-page', problem: 'live app page present but no appPage in last-sync state' });
    else if (state.appPage.sha256 !== liveAppSha256) problems.push({ surface: 'app-page', expected: state.appPage.sha256, live: liveAppSha256 });
  }
  for (const [ean, liveData] of Object.entries(liveEntries ?? {})) {
    const s = state.entries?.[ean];
    if (!s) { problems.push({ surface: 'collection', ean, problem: 'live entry absent from last-sync state' }); continue; }
    if (dataHash(liveData) !== s.sha256) problems.push({ surface: 'collection', ean, problem: 'live data hash != last-sync hash' });
  }
  return { dirty: problems.length > 0, problems };
}

// Protocol model of the atomic release pipeline (machine-tested contract for
// the agent-executed MCP steps; the platform's single publish_changes release
// is what makes live atomicity real). Steps before 'publish' only stage
// drafts/snapshots — live keeps the PREVIOUS consistent state. 'publish'
// releases BOTH surfaces in one release. Commit happens only after BOTH
// readbacks pass. Any failure leaves live fully-old or fully-new (never
// half-updated) and the local state either committed-consistent or dirty
// (detectable + recoverable), never half-committed.
export const RELEASE_STEPS = ['save-entries', 'update-page', 'build', 'publish', 'readback-app', 'readback-collection', 'commit'];
export function simulateRelease({ plan, failAt = null, readbackAppOk = true, readbackCollectionOk = true }) {
  if (failAt != null && !RELEASE_STEPS.includes(failAt)) throw new Error(`unknown release step: ${failAt}`);
  const idx = failAt == null ? RELEASE_STEPS.length : RELEASE_STEPS.indexOf(failAt);
  const done = (s) => idx > RELEASE_STEPS.indexOf(s);
  const liveReleased = done('publish');
  const readbacksOk = done('readback-app') && done('readback-collection') && readbackAppOk && readbackCollectionOk;
  const committed = done('commit') && liveReleased && readbacksOk;
  const dirty = liveReleased && !committed;
  let recovery;
  if (!failAt) recovery = 'none — released + committed';
  else if (!liveReleased) recovery = 'live untouched (drafts only); fix the failed step and re-run the release (idempotent upserts + optimistic-lock update)';
  else if (!readbacksOk) recovery = 'live released but readback failed/dirty: diagnose served surfaces; re-readback + commit if live is correct, else restore runs/p2-06/before/ content + rollback';
  else recovery = 'live released and verified; re-run readback + commit to converge last-sync state';
  return { failedAt: failAt, liveReleased, committed, liveConsistent: true, halfState: false, dirty, recovery };
}

// ---------- state / stale helpers ----------

export function loadState(path = STATE_PATH) {
  if (!existsSync(path)) return { version: 1, syncedAt: null, entries: {} };
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function readStale(path = STALE_PATH) {
  if (!existsSync(path)) return { stale: false };
  // Fail-CLOSED (review #6): a corrupt/truncated stale-state must never
  // silently unfreeze the sync. Unparseable or malformed -> frozen.
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.stale !== 'boolean') {
    return { stale: true, freeze: true, corrupt: true, blockedAt: null, store: null, reason: 'stale-state.json unparseable/malformed — fail-closed freeze; inspect the file, then re-run a successful refresh to clear' };
  }
  return parsed;
}

// ---------- approval gate (pure; defense-in-depth over the catalogue canary) ----------

// G4 content-hash binding (founder-os slice 10 — ADDITIVE only, never relaxes).
// The evidence content an approval authorizes = the canonical projection of the
// entry's evidence-text fields below (label text + rendered evidence blocks;
// grade/price/identity fields are NOT evidence content — the grade path has its
// own exact-match gate and price-only changes never gate). An approved queue
// item may carry review.evidenceContentHash (additive field, computed with
// evidenceContentHash at approval time); when ANY approved item for the EAN
// carries it, the current evidence content must match at least one bound hash
// or the change is REJECTED with an explicit hash-mismatch reason (needs a
// fresh gate pass). Approvals WITHOUT the field keep the legacy EAN-level
// semantics (documented wildcard, mirroring proposedGrade:null on the grade
// path) — existing behaviour is preserved, nothing is relaxed.
export const EVIDENCE_CONTENT_FIELDS = ['ingredients', 'nutrition', 'ingredientDecode', 'claimChecks', 'panelNotes'];
export function evidenceContentHash(data) {
  const picked = {};
  for (const f of EVIDENCE_CONTENT_FIELDS) picked[f] = data?.[f] ?? '';
  return dataHash(picked);
}
function evidenceHashBindingCheck(approvedItems, nextData) {
  const bound = approvedItems.filter((i) => typeof i.review?.evidenceContentHash === 'string' && i.review.evidenceContentHash.trim() !== '');
  if (bound.length === 0) return null; // legacy wildcard approvals only — unchanged behaviour
  const actual = evidenceContentHash(nextData);
  const match = bound.find((i) => i.review.evidenceContentHash === actual);
  if (match) return { ok: true, evidenceContentHash: actual, boundApproval: match.id ?? null };
  return {
    ok: false,
    code: 'EVIDENCE_HASH_MISMATCH',
    needsReview: true,
    evidenceHashExpected: bound.map((i) => i.review.evidenceContentHash),
    evidenceHashActual: actual,
    boundApprovals: bound.map((i) => i.id ?? null),
    reason: `evidence content hash mismatch (G4): current evidence content ${actual.slice(0, 12)}… matches none of the content-bound approval(s) ${bound.map((i) => i.id ?? '(no id)').join(', ')} — changed evidence text under an old approval requires a fresh gate pass (re-approve the current content before publish)`,
  };
}

// A grade change (incl. removal back to unrated) needs an approved
// grade-change record matching the new grade (null proposedGrade = legacy
// wildcard, used for removals). Any other reputational field change needs at
// least one approved queue item for the EAN. Price-only changes never gate.
export function approvalGateCheck({ ean, prevData, nextData, change, queue = [] }) {
  if (change === 'price-only' || change === 'unchanged' || change === 'structural') return { ok: true };
  const prevGrade = prevData?.grade ?? '';
  const nextGrade = nextData?.grade ?? '';
  if (nextGrade !== prevGrade) {
    const ok = nextGrade
      ? gradeApproved(queue, ean, nextGrade)
      : (queue ?? []).some((i) => i.kind === 'grade-change' && i.ean === ean && i.status === 'approved' && i.review != null && i.proposedGrade == null);
    return ok ? { ok: true } : { ok: false, reason: `grade change "${prevGrade || '(unrated)'}" -> "${nextGrade || '(unrated)'}" without an approved grade-change record` };
  }
  if (change === 'reputational' || change === 'new') {
    const approvedItems = (queue ?? []).filter((i) => i.ean === ean && i.status === 'approved' && i.review != null);
    if (change === 'new') {
      // admission: grade gate above already applied; unrated/new data is honest.
      // G4 additive: content-bound approvals still bind at admission.
      return evidenceHashBindingCheck(approvedItems, nextData) ?? { ok: true };
    }
    if (approvedItems.length === 0) return { ok: false, reason: 'reputational field change (non-price) without any approved queue item for this EAN' };
    return evidenceHashBindingCheck(approvedItems, nextData) ?? { ok: true };
  }
  return { ok: true };
}

// ---------- plan (pure; canaries + gate + diff) ----------

export function planSync(cat, { queue = [], state = { entries: {} }, schema = null, stale = { stale: false }, sheetSha256 = null, evidence = null, appArtifact = null, portAuthorization = null, now = new Date().toISOString() } = {}) {
  const plan = { createdAt: now, agent: 'script:12-sync.mjs', collection: COLLECTION, frozen: false, canary: { catalogue: 'pending', schema: 'pending' }, toUpsert: [], rejected: [], unchanged: [], summary: {}, sheetSha256, catalogueSha256: sha256(JSON.stringify(cat)), appPage: null, release: null };
  if (stale?.stale === true) {
    plan.frozen = true;
    plan.canary = { catalogue: 'skipped (frozen)', schema: 'skipped (frozen)' };
    plan.summary = { frozen: true, blockedAt: stale.blockedAt ?? null, store: stale.store ?? null, toUpsert: 0, rejected: 0, unchanged: 0 };
    return plan;
  }
  const catErrors = validateCatalogue(cat, { queue });
  if (catErrors.length > 0) {
    plan.canary.catalogue = 'FAIL';
    plan.canary.errors = catErrors;
    plan.summary = { canaryFail: true, toUpsert: 0, rejected: 0, unchanged: 0 };
    return plan;
  }
  plan.canary.catalogue = 'PASS';
  const schemaKeys = schema ? schema.map((f) => f.key) : ENTRY_FIELDS;
  const required = schema ? schema.filter((f) => f.required).map((f) => f.key) : ['ean', 'name'];
  plan.canary.schemaSource = schema ? 'live collection variableSchema' : 'built-in ENTRY_FIELDS';
  const schemaErrors = [];
  const entries = [];
  for (const p of cat.products) {
    const prev = state.entries?.[p.ean] ?? null;
    const entry = buildEntry(p, { queue, existing: prev?.data ?? null, evidence });
    for (const k of Object.keys(entry.data)) {
      if (!schemaKeys.includes(k) && k !== 'slug' && k !== 'title') schemaErrors.push(`${p.ean}: field "${k}" not in collection schema`);
    }
    for (const k of required) {
      if (!String(entry.data[k] ?? '').trim()) schemaErrors.push(`${p.ean}: required field "${k}" empty`);
    }
    entries.push({ p, prev, entry });
  }
  if (schemaErrors.length > 0) {
    plan.canary.schema = 'FAIL';
    plan.canary.errors = schemaErrors;
    plan.summary = { canaryFail: true, toUpsert: 0, rejected: 0, unchanged: 0 };
    return plan;
  }
  plan.canary.schema = 'PASS';
  for (const { p, prev, entry } of entries) {
    const change = classifyChange(prev?.data ?? null, entry.data);
    if (change === 'unchanged') { plan.unchanged.push(p.ean); continue; }
    const gate = approvalGateCheck({ ean: p.ean, prevData: prev?.data ?? null, nextData: entry.data, change, queue });
    if (!gate.ok) {
      // G4: hash-mismatch rejections carry structured audit fields (expected vs
      // actual hash + bound approval ids) into plan.rejected and the commit run
      // record — honest, never silent.
      plan.rejected.push({ ean: p.ean, name: p.name, reason: gate.reason, grade: entry.data.grade || null,
        ...(gate.code ? { code: gate.code, needsReview: gate.needsReview === true, evidenceHashExpected: gate.evidenceHashExpected, evidenceHashActual: gate.evidenceHashActual, boundApprovals: gate.boundApprovals } : {}) });
      continue;
    }
    plan.toUpsert.push({ ean: p.ean, slug: entry.slug, title: entry.title, data: entry.data, change, from: prev?.data ? { price: prev.data.price, grade: prev.data.grade } : null,
      ...(gate.evidenceContentHash ? { evidenceContentHash: gate.evidenceContentHash, boundApproval: gate.boundApproval } : {}) });
  }
  const by = (c) => plan.toUpsert.filter((e) => e.change === c).length;
  plan.summary = {
    products: cat.products.length, toUpsert: plan.toUpsert.length, new: by('new'), priceOnly: by('price-only'), structural: by('structural'), reputational: by('reputational'),
    rejected: plan.rejected.length, unchanged: plan.unchanged.length,
    evidenceHashMismatch: plan.rejected.filter((r) => r.code === 'EVIDENCE_HASH_MISMATCH').length,
    autoPublish: plan.toUpsert.length > 0 && plan.toUpsert.every((e) => e.change !== 'reputational'),
    needsReview: plan.toUpsert.filter((e) => e.change === 'reputational').map((e) => e.ean),
  };
  if (appArtifact != null) {
    plan.appPage = planAppSurface(appArtifact, state);
    plan.release = { atomic: true, unit: [`page:${APP_PAGE.slug}`, `collection:${COLLECTION.templateId}`], publish: 'ONE publish_changes release (app page + collection together)', readback: 'BOTH surfaces read back before commit' };
    plan.summary.appPageChange = plan.appPage.change;
    // Gate-leak guard: if the collection gate rejected entries, a CHANGED app
    // artifact (projected from the same catalogue) would show data the
    // collection refused — releasing it would leak rejected changes onto the
    // single surface. Halt the app release until the rejections are resolved.
    // FIRST PORT exception (change 'new' only): the founder explicitly
    // authorized porting the CURRENT app artifact (verbatim delegation
    // recorded); pre-existing documented carry-over rejections ride along as
    // a recorded divergence, never silently. portAuthorization must carry the
    // verbatim quote + source. The cron/refresh path NEVER passes it.
    if (plan.rejected.length > 0 && plan.appPage.change !== 'unchanged') {
      if (plan.appPage.change === 'new' && portAuthorization?.quote && portAuthorization?.source) {
        plan.appPageAuthorization = { ...portAuthorization, rejectedEans: plan.rejected.map((r) => r.ean), note: 'First native port of the founder-approved current artifact. Rejected EANs are documented carry-over (collection keeps prior data); queue approval items still required for collection catch-up. Refresh releases remain strictly halted by rejections.' };
        plan.summary.appPageAuthorized = true;
      } else {
        plan.appPageBlocked = { reason: 'collection approval gate rejected entries — app artifact would leak rejected changes; release HALTED (resolve rejections, then re-plan)', rejectedEans: plan.rejected.map((r) => r.ean) };
        plan.summary.appPageBlocked = true;
      }
    }
  }
  return plan;
}

// ---------- commit (state write ONLY after confirmed MCP writes) ----------

export function commitPlan(plan, { statePath = STATE_PATH, sheetPath = SHEET_PATH, catPath = CAT_PATH, runsDir = resolve(ROOT, 'runs'), writtenEans = null, publish = null, appReadback = null, collectionReadback = null, now = new Date().toISOString() } = {}) {
  if (plan.frozen) throw new Error('COMMIT REFUSED: plan is frozen (stale-state) — no writes.');
  if (plan.canary.catalogue !== 'PASS' || plan.canary.schema !== 'PASS') throw new Error('COMMIT REFUSED: canary did not pass.');
  if (plan.appPageBlocked) throw new Error(`COMMIT REFUSED: app release halted — ${plan.appPageBlocked.reason}`);
  if (plan.appPage) {
    // P2-06: both-surface readback is mandatory before the state commit.
    const vr = verifyReadback({ plan, appReadback, collectionReadback });
    if (!vr.ok) throw new Error(`READBACK FAIL — commit refused (live/state dirty; re-verify both surfaces): ${vr.problems.join('; ')}`);
  }
  if (plan.sheetSha256) {
    // Deletion is not approval (review #4): a missing sheet aborts too.
    if (!existsSync(sheetPath)) throw new Error('SHEET PROTECTION FAIL: human-classified sheet missing at commit — aborted (deletion is not approval).');
    const nowSha = sha256(readFileSync(sheetPath, 'utf8'));
    if (nowSha !== plan.sheetSha256) throw new Error('SHEET PROTECTION FAIL: human-classified sheet changed since plan — commit aborted.');
  }
  if (plan.catalogueSha256) {
    // Re-verify the catalogue at commit (review #8b): content changed since
    // plan (e.g. a mid-flight refresh) -> re-plan instead of committing a
    // stale diff. Compared on canonical content, not file formatting.
    if (!existsSync(catPath)) throw new Error('CATALOGUE DRIFT FAIL: catalogue missing at commit — aborted.');
    const nowCatSha = sha256(JSON.stringify(JSON.parse(readFileSync(catPath, 'utf8'))));
    if (nowCatSha !== plan.catalogueSha256) throw new Error('CATALOGUE DRIFT FAIL: catalogue changed since plan — re-plan before commit.');
  }
  const state = loadState(statePath);
  const written = [];
  for (const e of plan.toUpsert) {
    if (writtenEans && !writtenEans.includes(e.ean)) continue;
    state.entries[e.ean] = { sha256: dataHash(e.data), data: e.data, syncedAt: now };
    written.push(e.ean);
  }
  if (plan.appPage) {
    state.appPage = {
      pageId: plan.appPage.pageId, slug: plan.appPage.slug, path: plan.appPage.path,
      sha256: plan.appPage.sha256, bytes: plan.appPage.bytes, change: plan.appPage.change, syncedAt: now,
      authorization: plan.appPageAuthorization ?? null,
      readback: {
        app: { url: appReadback.url, status: appReadback.status, fetchedAt: appReadback.fetchedAt, servedDiff: appReadback.servedDiff ?? null },
        collection: { pages: (collectionReadback.pages ?? []).map((p) => ({ url: p.url, status: p.status, checks: (p.checks ?? []).length })), fetchedAt: collectionReadback.fetchedAt },
      },
    };
  }
  state.version = 1;
  state.syncedAt = now;
  state.lastPlan = { createdAt: plan.createdAt, summary: plan.summary };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  const runPath = resolve(runsDir, `12-sync-${compact(now)}.json`);
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(runPath, JSON.stringify({ runAt: now, stage: '12-sync-commit', agent: plan.agent, written, writtenCount: written.length, rejected: plan.rejected, unchangedCount: plan.unchanged.length, summary: plan.summary, publish, sheetSha256: plan.sheetSha256, statePath, appPage: plan.appPage ?? null, release: plan.release ?? null, readback: plan.appPage ? { app: appReadback, collection: collectionReadback } : null }, null, 2) + '\n');
  return { statePath, runPath, written };
}

// ---------- CLI ----------

function latest(runsDir, prefix) {
  if (!existsSync(runsDir)) return null;
  const f = readdirSync(runsDir).sort().filter((x) => x.startsWith(prefix) && x.endsWith('.json')).pop();
  return f ? resolve(runsDir, f) : null;
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const runsDir = resolve(ROOT, 'runs');
  // Slice 15 freeze guard: write commands refuse while frozen; status stays
  // readable (observability without writes).
  if (cmd === 'seed' || cmd === 'plan' || cmd === 'commit') {
    const freeze = readFreeze();
    if (freeze.frozen) {
      const note = freezeRefusal(cmd, freeze, runsDir);
      console.log(`FROZEN — no writes (${cmd}). ${note.message}`);
      // Exit 2 for plan matches the daily cron's frozen/halt contract (review
      // report + finish, no Hashmeta writes); seed/commit refuse with 1.
      process.exit(cmd === 'plan' ? 2 : 1);
    }
  }
  if (cmd === 'seed') {
    const dumpPath = arg('--entries');
    if (!dumpPath) { console.error('usage: seed --entries <dump.json>'); process.exit(1); }
    const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
    const rows = dump.rows ?? dump;
    const state = loadState();
    let seeded = 0;
    for (const row of rows) {
      const data = row.data ?? row;
      if (!data.ean) continue;
      state.entries[String(data.ean)] = { sha256: dataHash(data), data, syncedAt: new Date().toISOString(), seededFrom: 'live collection' };
      seeded++;
    }
    state.version = 1;
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
    console.log(`seeded ${seeded} live entr${seeded === 1 ? 'y' : 'ies'} into ${STATE_PATH}`);
    return;
  }
  if (cmd === 'plan') {
    const cat = JSON.parse(readFileSync(CAT_PATH, 'utf8'));
    const queue = readPendingQueue();
    const state = loadState();
    const stale = readStale();
    const schemaPath = arg('--schema') ?? resolve(runsDir, '12-collection-schema.json');
    const schema = existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, 'utf8')).variableSchema ?? JSON.parse(readFileSync(schemaPath, 'utf8')) : null;
    const sheetSha256 = existsSync(SHEET_PATH) ? sha256(readFileSync(SHEET_PATH, 'utf8')) : null;
    // 11b evidence (read-only curated artifacts + APPROVED claim flags only).
    const occPath = resolve(ROOT, 'data', 'additives', 'occurrences.json');
    const verdictsPath = resolve(ROOT, 'data', 'additives', 'verdicts.json');
    const additiveEvidencePath = resolve(ROOT, 'data', 'additives', 'evidence.json');
    const findingsPath = resolve(ROOT, 'data', 'claims', 'findings.json');
    const findingsDoc = existsSync(findingsPath) ? JSON.parse(readFileSync(findingsPath, 'utf8')) : {};
    const evidence = {
      occurrences: existsSync(occPath) ? JSON.parse(readFileSync(occPath, 'utf8')).occurrences ?? null : null,
      verdicts: existsSync(verdictsPath) ? JSON.parse(readFileSync(verdictsPath, 'utf8')).verdicts ?? null : null,
      additiveEvidence: existsSync(additiveEvidencePath) ? JSON.parse(readFileSync(additiveEvidencePath, 'utf8')).evidence ?? null : null,
      findings: [...(findingsDoc.findings ?? []), ...(findingsDoc.sweep7b?.findings ?? [])],
      approvedFlags: queue.filter((i) => i.kind === 'claim-flag' && i.status === 'approved' && i.review != null),
    };
    // P2-06 app surface: assemble the standalone port artifact from the
    // CURRENT app/ (read-only; never rebuilds). Drift-canary failure =
    // fail-closed plan (exit 2), never a half-surface release.
    let appArtifact = null;
    try { appArtifact = buildPortArtifact().html; }
    catch (e) {
      const failPlan = { createdAt: new Date().toISOString(), agent: 'script:12-sync.mjs', frozen: false, canary: { catalogue: 'skipped', schema: 'skipped', appArtifact: 'FAIL', error: String(e?.message ?? e) }, toUpsert: [], rejected: [], unchanged: [], summary: { canaryFail: true, toUpsert: 0 }, appPage: null, release: null };
      mkdirSync(runsDir, { recursive: true });
      const failPath = resolve(runsDir, `12-sync-plan-${compact(failPlan.createdAt)}.json`);
      writeFileSync(failPath, JSON.stringify(failPlan, null, 2) + '\n');
      console.log(JSON.stringify({ planPath: failPath, canary: failPlan.canary }, null, 2));
      process.exit(2);
    }
    const plan = planSync(cat, { queue, state, schema, stale, sheetSha256, evidence, appArtifact });
    mkdirSync(runsDir, { recursive: true });
    const planPath = resolve(runsDir, `12-sync-plan-${compact(plan.createdAt)}.json`);
    writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
    console.log(JSON.stringify({ planPath, frozen: plan.frozen, canary: plan.canary, summary: plan.summary, rejected: plan.rejected, appPage: plan.appPage, appPageBlocked: plan.appPageBlocked ?? null, release: plan.release }, null, 2));
    if (plan.frozen || plan.canary.catalogue === 'FAIL' || plan.canary.schema === 'FAIL' || plan.canary.appArtifact === 'FAIL') process.exit(2);
    return;
  }
  if (cmd === 'commit') {
    const planPath = arg('--plan') ?? latest(runsDir, '12-sync-plan-');
    if (!planPath) { console.error('no plan found — run plan first'); process.exit(1); }
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const writtenArg = arg('--written');
    const publishPath = arg('--publish');
    const publish = publishPath && existsSync(publishPath) ? JSON.parse(readFileSync(publishPath, 'utf8')) : null;
    const appReadbackPath = arg('--app-readback');
    const collectionReadbackPath = arg('--collection-readback');
    const appReadback = appReadbackPath && existsSync(appReadbackPath) ? JSON.parse(readFileSync(appReadbackPath, 'utf8')) : null;
    const collectionReadback = collectionReadbackPath && existsSync(collectionReadbackPath) ? JSON.parse(readFileSync(collectionReadbackPath, 'utf8')) : null;
    const res = commitPlan(plan, { writtenEans: writtenArg ? writtenArg.split(',') : null, publish, appReadback, collectionReadback });
    console.log(JSON.stringify({ committed: res.written.length, statePath: res.statePath, runPath: res.runPath }, null, 2));
    return;
  }
  if (cmd === 'status') {
    const state = loadState();
    const stale = readStale();
    console.log(JSON.stringify({ syncedAt: state.syncedAt, entries: Object.keys(state.entries).length, appPage: state.appPage ?? null, stale, lastPlan: state.lastPlan ?? null }, null, 2));
    return;
  }
  console.error('usage: 12-sync.mjs seed|plan|commit|status');
  process.exit(1);
}

if (isMain(import.meta.url)) main();