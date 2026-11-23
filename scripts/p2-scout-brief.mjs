#!/usr/bin/env node
// HealthHawk Founder-OS slice 07 — market-scout brief assembler/validator
// (deterministic, ZERO network). Takes the agent-collected inputs JSON
// (schema healthhawk-scout-inputs-v1: cited web context, 14-learn output
// reference, P3 demand readout via the committed builder contract OR a
// committed artifact WITH an explicit staleness label, feasibility-from-
// cache/web scores) and produces:
//   runs/reports/aisle-brief-<date>.md
//   ONE pending/<UTCcompact>-structural-aisle-brief-<date>.json
//     {kind:'structural', status:'pending', review:null, ean omitted,
//      summary, evidence:{report:...}, createdBy:'agent:healthhawk-market-scout',
//      confidence}
// Supersede (addendum §B1): scout sets ONLY its OWN prior OPEN aisle-brief
// items status:'superseded' — never other kinds, never other agents' items,
// never the review field.
//
// Honesty rules (v3.1 §A): empty own demand → "feasibility-led HYPOTHESIS —
// not demand-validated" banner + confidence forced low; PII counts-only
// (planted email → exit≠0); missing citation → fail; freeze-mode feasibility
// must be cache/web (live retailer/OFF probes gated on unfreeze). Demand
// readouts (inline AND artifact) pass producer verification against the
// committed builder fingerprint — hand-keyed/foreign readouts are refused.
//
// ALL writes are relative to --root (fixture roots in tests) and go through
// the machine write-scope guard (role 'scout': runs/ + pending/ only).
//
// Usage:
//   node scripts/p2-scout-brief.mjs --inputs <inputs.json> [--root <dir>] [--now <ISO>]

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { guardedWrite } from './p2-skill-scope.mjs';
import { READOUT_SCHEMA, buildReadout } from './p3-demand-readout.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCOUT_INPUTS_SCHEMA = 'healthhawk-scout-inputs-v1';
export const HYPOTHESIS_BANNER = 'feasibility-led HYPOTHESIS — not demand-validated';
export const SCOUT_AGENT = 'agent:healthhawk-market-scout';
// Founder Q5 delegation → orchestrator decision: baseline shortlist is
// kids' snacks + milk. Demand OVERRULES the shortlist ordering (and may add
// candidates); the scout never picks the aisle — the founder does.
export const SHORTLIST = Object.freeze([
  Object.freeze({ aisle: 'kids-snacks', name: "Kids' snacks" }),
  Object.freeze({ aisle: 'milk', name: 'Milk' }),
]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const AISLE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FEASIBILITY_BASES = ['cache', 'web', 'live-probe'];

export function utcCompact(nowIso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(nowIso);
  if (!m) throw new Error(`now must be ISO-8601 UTC: ${nowIso}`);
  return `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}Z`;
}

function isInt0to2(v) { return Number.isInteger(v) && v >= 0 && v <= 2; }
function nonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function citedArray(v) { return Array.isArray(v) && v.length > 0 && v.every(nonEmptyString); }

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

export function findPii(value) {
  return collectStrings(value).filter((s) => EMAIL_RE.test(s));
}

// Producer verification (wave-1 merge review M2): the committed builder emits
// no generatedBy field, so the fingerprint is the builder's OWN canonical
// honestyNote (derived here from a pure empty build of the COMMITTED
// p3-demand-readout.mjs — never a copied string) plus source/count
// consistency. A hand-keyed or foreign readout with the right schema id is
// REFUSED, never silently trusted. Applies to inline AND artifact modes.
const BUILDER_FINGERPRINT = buildReadout({ now: '', sources: {} });

export function verifyReadoutProducer(readoutDoc) {
  const errors = [];
  const at = 'demand readout producer verification';
  if (!readoutDoc || typeof readoutDoc !== 'object') return [`${at}: document missing`];
  if (readoutDoc.honestyNote !== BUILDER_FINGERPRINT.honestyNote) errors.push(`${at}: honestyNote is not the committed p3-demand-readout.mjs builder fingerprint (hand-keyed/foreign readout refused)`);
  if (!nonEmptyString(readoutDoc.recommendation)) errors.push(`${at}: recommendation missing (builder always emits one)`);
  const s = readoutDoc.sources;
  const t = readoutDoc.totals;
  if (!s || typeof s !== 'object') errors.push(`${at}: sources missing`);
  else {
    if (!nonEmptyString(s.queue)) errors.push(`${at}: sources.queue must cite the demand queue path`);
    if (!Array.isArray(s.zeroResultFiles)) errors.push(`${at}: sources.zeroResultFiles must be an array`);
    if (!t || typeof t !== 'object') errors.push(`${at}: totals missing`);
    else {
      if (s.queueEntries !== t.requests) errors.push(`${at}: sources.queueEntries != totals.requests (inconsistent counts)`);
      if (s.zeroResultEntries !== t.zeroResultSearches) errors.push(`${at}: sources.zeroResultEntries != totals.zeroResultSearches (inconsistent counts)`);
    }
  }
  if (t && typeof t === 'object') {
    if (t.combined !== (t.requests ?? 0) + (t.zeroResultSearches ?? 0)) errors.push(`${at}: totals.combined != requests + zeroResultSearches`);
    if (Array.isArray(readoutDoc.departments)) {
      const sum = readoutDoc.departments.reduce((n, d) => n + (d?.total ?? 0), 0);
      if (sum !== t.combined) errors.push(`${at}: department totals do not sum to totals.combined (builder buckets every signal)`);
      for (const [i, d] of readoutDoc.departments.entries()) {
        if (!d || d.rank !== i + 1 || !nonEmptyString(d.label) || typeof d.total !== 'number') {
          errors.push(`${at}: departments[${i}] missing builder shape (sequential rank/label/total)`);
          break;
        }
      }
    }
  }
  return errors;
}

// Read the freeze state from the (fixture) root. Fail CLOSED on missing /
// corrupt / non-boolean state — scout never guesses the freeze mode.
export function readFreezeState(root) {
  const p = resolve(root, 'runs/freeze-state.json');
  if (!existsSync(p)) return { ok: false, error: 'runs/freeze-state.json missing — fail CLOSED' };
  let doc;
  try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch { return { ok: false, error: 'runs/freeze-state.json unparseable — fail CLOSED' }; }
  if (typeof doc?.frozen !== 'boolean') return { ok: false, error: 'runs/freeze-state.json frozen flag missing/not boolean — fail CLOSED' };
  return { ok: true, frozen: doc.frozen };
}

// Validate the agent-collected inputs document. `learnDoc` / `readoutDoc`
// are the resolved artifacts (read from the root by the caller).
export function validateScoutInputs(inputs, { frozen, learnDoc, readoutDoc, demandMode }) {
  const errors = [];
  if (!inputs || typeof inputs !== 'object') return ['inputs document missing/not an object'];
  if (inputs.schema !== SCOUT_INPUTS_SCHEMA) errors.push(`schema must be ${SCOUT_INPUTS_SCHEMA}`);
  if (!DATE_RE.test(inputs.date ?? '')) errors.push('date must be YYYY-MM-DD');
  if (!nonEmptyString(inputs.collectedAt)) errors.push('collectedAt required (ISO timestamp)');
  if (!['low', 'medium'].includes(inputs.confidence)) errors.push('confidence must be low or medium (scout never claims high)');

  if (!Array.isArray(inputs.webContext) || inputs.webContext.length === 0) errors.push('webContext must be a non-empty array of cited research');
  else for (const [i, w] of inputs.webContext.entries()) {
    if (!nonEmptyString(w?.claim)) errors.push(`webContext[${i}].claim required`);
    if (!nonEmptyString(w?.url) || !/^https?:\/\//.test(w.url)) errors.push(`webContext[${i}].url required (http(s) citation) — missing citation`);
    if (!nonEmptyString(w?.retrievedAt)) errors.push(`webContext[${i}].retrievedAt required`);
  }

  if (!learnDoc) errors.push('LEARN output missing: inputs.learn.path must point at a committed 14-learn.mjs output under the root');
  else {
    if (learnDoc.generatedBy !== 'script:14-learn.mjs') errors.push('LEARN output not produced by script:14-learn.mjs (committed demand layer only)');
    if (!learnDoc.sourceCounts || typeof learnDoc.sourceCounts !== 'object') errors.push('LEARN output missing sourceCounts');
    if (!DATE_RE.test(learnDoc.date ?? '')) errors.push('LEARN output missing date');
  }

  if (!readoutDoc) errors.push('demand readout missing: provide demand.readout (builder contract) or demand.artifact (committed artifact)');
  else {
    if (readoutDoc.schema !== READOUT_SCHEMA) errors.push(`demand readout schema must be ${READOUT_SCHEMA}`);
    else errors.push(...verifyReadoutProducer(readoutDoc));
    if (!readoutDoc.totals || typeof readoutDoc.totals.combined !== 'number') errors.push('demand readout missing totals.combined');
    if (!Array.isArray(readoutDoc.departments)) errors.push('demand readout missing departments ranking');
    if (!nonEmptyString(readoutDoc.generatedAt)) errors.push('demand readout missing generatedAt');
    if (!readoutDoc.sources || typeof readoutDoc.sources !== 'object') errors.push('demand readout missing sources');
    if (demandMode === 'artifact' && !nonEmptyString(inputs.demand?.stalenessNote)) errors.push('demand.artifact requires an explicit stalenessNote (staleness label)');
  }

  if (!Array.isArray(inputs.candidates) || inputs.candidates.length === 0) errors.push('candidates must be a non-empty array');
  else {
    for (const s of SHORTLIST) {
      if (!inputs.candidates.some((c) => c?.aisle === s.aisle)) errors.push(`shortlist aisle missing: ${s.aisle} (founder Q5 delegation baseline; demand may add candidates, never drop the baseline)`);
    }
    for (const [i, c] of inputs.candidates.entries()) {
      const at = `candidates[${i}]`;
      if (!AISLE_RE.test(c?.aisle ?? '')) errors.push(`${at}.aisle must be a lowercase slug`);
      if (!nonEmptyString(c?.name)) errors.push(`${at}.name required`);
      if (c?.department != null && !nonEmptyString(c.department)) errors.push(`${at}.department must be a non-empty string when present`);
      const f = c?.feasibility;
      if (!f || !isInt0to2(f.score)) errors.push(`${at}.feasibility.score must be integer 0..2`);
      if (!FEASIBILITY_BASES.includes(f?.basis)) errors.push(`${at}.feasibility.basis must be cache|web|live-probe`);
      if (frozen && f?.basis === 'live-probe') errors.push(`${at}.feasibility.basis live-probe is GATED ON UNFREEZE (freeze-mode: cache/web only)`);
      if (!nonEmptyString(f?.detail)) errors.push(`${at}.feasibility.detail required`);
      if (!citedArray(f?.citations)) errors.push(`${at}.feasibility.citations required — missing citation`);
      for (const axis of ['personaFit', 'monetization']) {
        const a = c?.[axis];
        if (!a || !isInt0to2(a.score)) errors.push(`${at}.${axis}.score must be integer 0..2`);
        if (!nonEmptyString(a?.rationale)) errors.push(`${at}.${axis}.rationale required`);
        if (!citedArray(a?.citations)) errors.push(`${at}.${axis}.citations required — missing citation`);
      }
    }
  }

  const pii = findPii(inputs);
  if (pii.length) errors.push(`PII detected in inputs (counts-only contract): ${pii.length} email-like string(s)`);
  return errors;
}

// Deterministic ranking. Demand is the strongest axis and OVERRULES the
// shortlist order; ties break on feasibility, persona fit, monetization,
// then the encoded shortlist order, then slug. Every number is cited in md.
export function rankCandidates(candidates, readoutDoc) {
  const deptTotal = new Map((readoutDoc?.departments ?? []).map((d) => [d.department, d.total ?? 0]));
  const shortlistIndex = new Map(SHORTLIST.map((s, i) => [s.aisle, i]));
  const rows = candidates.map((c) => ({
    aisle: c.aisle,
    name: c.name,
    department: c.department ?? c.aisle,
    demand: deptTotal.get(c.department ?? c.aisle) ?? 0,
    feasibility: c.feasibility.score,
    personaFit: c.personaFit.score,
    monetization: c.monetization.score,
    candidate: c,
  }));
  rows.sort((a, b) =>
    (b.demand - a.demand)
    || (b.feasibility - a.feasibility)
    || (b.personaFit - a.personaFit)
    || (b.monetization - a.monetization)
    || ((shortlistIndex.get(a.aisle) ?? 99) - (shortlistIndex.get(b.aisle) ?? 99))
    || a.aisle.localeCompare(b.aisle));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

const COMPLIANCE_LINE = (label) =>
  `- **${label} — compliance:** picking this aisle explicitly ratifies that aisle's FairPrice ToS acceptance (the accepted-risk surface EXPANDS with each aisle); the affiliate route carries the disclosure prerequisite (ASAS disclosure before the first tagged link, D7/Q13).`;

// Pure brief builder — no writes, no network. Returns md + the pinned
// structural item + ranking + honesty metadata.
export function buildBrief({ inputs, learnDoc, readoutDoc, demandMode, frozen, now, priorBriefDate = null }) {
  const date = inputs.date;
  const ranking = rankCandidates(inputs.candidates, readoutDoc);
  const demandEmpty = (readoutDoc.totals.combined ?? 0) === 0;
  const confidence = demandEmpty ? 'low' : inputs.confidence;
  const top = ranking[0];
  const reportRel = `runs/reports/aisle-brief-${date}.md`;
  const unclassified = (readoutDoc.departments ?? []).find((d) => d.department === 'unclassified');

  const lines = [];
  lines.push(`# Aisle brief — ${date}`);
  lines.push('');
  lines.push(`Generated: ${now} · ${SCOUT_AGENT} · deterministic assembly (scripts/p2-scout-brief.mjs). The scout NEVER picks the aisle — the founder decides; this brief makes that a 5-minute yes/no.`);
  lines.push('');
  if (demandEmpty) {
    lines.push(`> **${HYPOTHESIS_BANNER}** — own demand signals are empty (${readoutDoc.totals.requests} requests, ${readoutDoc.totals.zeroResultSearches} zero-result searches). The ranking below is feasibility-led; external market context is cited research, NEVER implied as own demand. Confidence: low.`);
    lines.push('');
    if (priorBriefDate) lines.push(`No new demand signals since ${priorBriefDate} (last brief) — no manufactured novelty.`);
    if (priorBriefDate) lines.push('');
  }
  lines.push(`Mode: ${frozen ? 'FREEZE — feasibility from cache/web context; live retailer/OFF probes pending unfreeze' : 'UNFROZEN — live probes permitted (agent-collected, cited)'}.`);
  lines.push('');
  lines.push('## Shortlist + delegation');
  lines.push('');
  lines.push(`Baseline shortlist (orchestrator decision under founder Q5 delegation): ${SHORTLIST.map((s) => s.name).join(' + ')}. Demand OVERRULES this ordering — real own-demand signals always outrank feasibility hypotheses.`);
  lines.push('');
  lines.push('## Ranking (demand strongest; every number cited)');
  lines.push('');
  lines.push('| Rank | Aisle | Own demand signals | Feasibility (0–2) | Persona fit (0–2) | Monetization (0–2) |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of ranking) {
    lines.push(`| ${r.rank} | ${r.name} | ${r.demand} | ${r.feasibility} | ${r.personaFit} | ${r.monetization} |`);
  }
  lines.push('');
  lines.push(`Demand source: ${demandMode === 'artifact' ? `committed artifact ${inputs.demand.artifact}` : 'committed P3-10 builder contract (healthhawk-demand-readout-v1)'} · generatedAt ${readoutDoc.generatedAt} · queue ${readoutDoc.sources.queue ?? '—'}.`);
  if (demandMode === 'artifact') lines.push(`**Demand readout staleness:** ${inputs.demand.stalenessNote}`);
  if (unclassified && (unclassified.total ?? 0) > 0) lines.push(`Unclassified demand: ${unclassified.total} signal(s) need manual review — never guessed into an aisle.`);
  lines.push('');
  lines.push('## Per-aisle evidence');
  lines.push('');
  for (const r of ranking) {
    const c = r.candidate;
    lines.push(`### ${r.rank}. ${r.name}`);
    lines.push('');
    lines.push(`- **Demand:** ${r.demand} own signal(s) for department \`${r.department}\` (demand readout, generatedAt ${readoutDoc.generatedAt}).${r.demand === 0 ? ' No data — honest zero, never invented.' : ''}`);
    lines.push(`- **Feasibility (${r.feasibility}/2, ${c.feasibility.basis}${frozen ? ' — from cache/web context, live probes pending unfreeze' : ''}):** ${c.feasibility.detail} Sources: ${c.feasibility.citations.join(' ; ')}`);
    lines.push(`- **Persona fit (${r.personaFit}/2):** ${c.personaFit.rationale} Sources: ${c.personaFit.citations.join(' ; ')}`);
    lines.push(`- **Monetization (${r.monetization}/2):** ${c.monetization.rationale} Sources: ${c.monetization.citations.join(' ; ')}`);
    lines.push(COMPLIANCE_LINE(r.name));
    lines.push('');
  }
  lines.push('## Market context (cited research — NOT own demand)');
  lines.push('');
  for (const w of inputs.webContext) lines.push(`- ${w.claim} — ${w.url} (retrieved ${w.retrievedAt})`);
  lines.push('');
  lines.push('## Own demand layer (LEARN, counts-only)');
  lines.push('');
  lines.push(`LEARN ${learnDoc.date} (${inputs.learn.path}): traffic ${learnDoc.sourceCounts.trafficViews30d ?? 0} views/30d · search queries ${learnDoc.sourceCounts.searchQueries ?? 0} · request submissions ${learnDoc.sourceCounts.requestSubmissions ?? 0} · newsletter submissions ${learnDoc.sourceCounts.newsletterSubmissions ?? 0} · local log files ${learnDoc.sourceCounts.localLogFiles ?? 0}. COUNTS ONLY — never emails, never raw answers (F18 boundary).`);
  lines.push('');
  lines.push('## Founder decision');
  lines.push('');
  lines.push(`Pick aisle #1 (or "no change this week") via the structural queue item. Confidence: **${confidence}**${demandEmpty ? ' (forced low: empty own demand)' : ''}. The scout never picks, never writes catalogue, never self-approves, never unfreezes.`);
  lines.push('');
  const md = lines.join('\n');

  const item = {
    id: null, // set by the writer from the filename stem
    kind: 'structural',
    status: 'pending',
    review: null,
    createdAt: now,
    createdBy: SCOUT_AGENT,
    confidence,
    summary: `Aisle brief ${date}: ${top.name} leads — ${demandEmpty ? HYPOTHESIS_BANNER : `${top.demand} own demand signal(s)`}. Founder picks the aisle; scout never decides.`,
    evidence: {
      report: reportRel,
      demandReadout: demandMode === 'artifact' ? inputs.demand.artifact : `inline:${READOUT_SCHEMA}`,
      demandStalenessNote: demandMode === 'artifact' ? inputs.demand.stalenessNote : null,
      learn: inputs.learn.path,
      webContext: inputs.webContext.map((w) => w.url),
    },
  };
  return { md, item, ranking, confidence, demandEmpty, reportRel };
}

// Own prior aisle-brief items ONLY: kind structural + createdBy scout +
// aisle-brief filename. Never other kinds, never other agents.
export function findOwnBriefItems(root) {
  const dir = resolve(root, 'pending');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    if (!/^\d{8}-\d{6}Z-structural-aisle-brief-\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
    let doc;
    try { doc = JSON.parse(readFileSync(resolve(dir, f), 'utf8')); } catch { continue; }
    if (doc?.kind !== 'structural' || doc?.createdBy !== SCOUT_AGENT) continue;
    out.push({ file: f, rel: `pending/${f}`, doc });
  }
  return out;
}

// Full run: validate → build → PII re-check on outputs → write report,
// supersede OWN prior OPEN brief items, write ONE new item. Any validation
// failure leaves the disk untouched. All paths relative to `root`.
export function runScoutBrief({ root, inputs = null, inputsPath = null, now = new Date().toISOString() }) {
  const fail = (errors) => ({ ok: false, errors, writes: [] });
  const freeze = readFreezeState(root);
  if (!freeze.ok) return fail([freeze.error]);
  if (inputsPath && !inputs) {
    try { inputs = JSON.parse(readFileSync(resolve(root, inputsPath), 'utf8')); }
    catch (e) { return fail([`inputs unreadable: ${e.message}`]); }
  }
  if (!inputs || typeof inputs !== 'object') return fail(['inputs document missing/not an object']);

  let learnDoc = null;
  if (nonEmptyString(inputs.learn?.path)) {
    const lp = resolve(root, inputs.learn.path);
    if (existsSync(lp)) { try { learnDoc = JSON.parse(readFileSync(lp, 'utf8')); } catch { learnDoc = null; } }
  }
  let readoutDoc = null;
  let demandMode = null;
  if (inputs.demand?.readout && typeof inputs.demand.readout === 'object') {
    readoutDoc = inputs.demand.readout; demandMode = 'builder';
  } else if (nonEmptyString(inputs.demand?.artifact)) {
    demandMode = 'artifact';
    const rp = resolve(root, inputs.demand.artifact);
    if (existsSync(rp)) { try { readoutDoc = JSON.parse(readFileSync(rp, 'utf8')); } catch { readoutDoc = null; } }
  }

  const errors = validateScoutInputs(inputs, { frozen: freeze.frozen, learnDoc, readoutDoc, demandMode });
  if (errors.length) return fail(errors);

  const own = findOwnBriefItems(root);
  const priorDates = own.map((o) => String(o.doc.createdAt ?? '').slice(0, 10)).filter((d) => DATE_RE.test(d)).sort();
  const priorBriefDate = priorDates.length ? priorDates[priorDates.length - 1] : null;

  const brief = buildBrief({ inputs, learnDoc, readoutDoc, demandMode, frozen: freeze.frozen, now, priorBriefDate });
  const outPii = findPii([brief.md, brief.item]);
  if (outPii.length) return fail([`PII detected in generated brief/item (counts-only contract): ${outPii.length} email-like string(s)`]);

  const compact = utcCompact(now);
  const itemFile = `${compact}-structural-aisle-brief-${inputs.date}.json`;
  const itemRel = `pending/${itemFile}`;
  const item = { ...brief.item, id: itemFile.replace(/\.json$/, '') };

  const writes = [];
  writes.push(guardedWrite('scout', brief.reportRel, brief.md, { root }));
  const superseded = [];
  for (const o of own) {
    if (o.doc.status !== 'pending') continue; // actioned items never touched
    const updated = { ...o.doc, status: 'superseded', supersededAt: now, supersededBy: SCOUT_AGENT };
    writes.push(guardedWrite('scout', o.rel, JSON.stringify(updated, null, 2) + '\n', { root }));
    superseded.push(o.rel);
  }
  writes.push(guardedWrite('scout', itemRel, JSON.stringify(item, null, 2) + '\n', { root }));
  return { ok: true, errors: [], report: brief.reportRel, item: itemRel, confidence: brief.confidence, demandEmpty: brief.demandEmpty, ranking: brief.ranking.map(({ candidate, ...r }) => r), superseded, writes };
}

function main() {
  const args = process.argv.slice(2);
  const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const inputsPath = arg('--inputs');
  if (!inputsPath) { console.error('usage: p2-scout-brief.mjs --inputs <inputs.json> [--root <dir>] [--now <ISO>]'); process.exit(1); }
  const root = resolve(arg('--root') ?? ROOT);
  const now = arg('--now') ?? new Date().toISOString();
  const r = runScoutBrief({ root, inputsPath, now });
  if (!r.ok) { console.error(`SCOUT BRIEF REFUSED:\n- ${r.errors.join('\n- ')}`); process.exit(1); }
  console.log(JSON.stringify({ report: r.report, item: r.item, confidence: r.confidence, demandEmpty: r.demandEmpty, superseded: r.superseded, ranking: r.ranking }, null, 2));
}

if (isMain(import.meta.url)) main();