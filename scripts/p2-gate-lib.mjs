// HealthHawk P2-01 — D9 auto-gate engine (pure library).
// Governance: docs/README-PROTOTYPE2.md D9 (founder approval removed as a
// blocker; hardened machine gates + dual-independent-reviewer consensus +
// verbatim hashed evidence + grey-zone->unverified + audit record + rollback).
// The pending/ queue survives as the audit log: this engine never requires a
// founder-approved queue item, and never edits existing queue files. New audit
// records live ONLY under pending/p2-audit/ (a subdirectory, invisible to the
// P1 top-level queue readers, so the frozen P1 contract tests stay green).
//
// LLMs never compute verdicts/thresholds/grades here: every check below is
// deterministic code over hashed source text and reviewer verdict FILES.

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const AUDIT_DIR = 'pending/p2-audit';

// Founder delegation for the P2 build — Arnav's exact words, relayed by the
// orchestrator 2026-11-21 (verbatim, including the founder's spelling).
export const DELEGATION = Object.freeze({
  quote: 'You have my approval for everrything.',
  givenAt: '2026-11-21',
  by: 'Arnav (founder)',
  channel: 'orchestrator relay — P2 build delegation, 2026-11-21',
});

// D9 ratification quotes — code-verified verbatim against the hashed README.
export const D9_SOURCE = 'docs/README-PROTOTYPE2.md';
export const D9_QUOTES = Object.freeze([
  'remove my approval, its not needed',
  'Fully automated, hardened gates',
]);

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const stable = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, stable(o[k])])) : o);
export const canon = (o) => JSON.stringify(stable(o));

// ---------------------------------------------------------------------------
// Source extraction (deterministic locators — never trust inline source text).
// Each evidence entry names a locator; the gate re-reads the CURRENT repo
// source, hashes the extracted text, and anchors the quote inside it.
// ---------------------------------------------------------------------------

export function extractSource(root, loc) {
  if (!loc || typeof loc !== 'object') return { ok: false, reason: 'missing-source-locator' };
  if (loc.kind === 'file') {
    const p = resolve(root, loc.path);
    if (!p.startsWith(resolve(root) + '/')) return { ok: false, reason: 'source-outside-repo' };
    if (!existsSync(p)) return { ok: false, reason: 'missing-source' };
    return { ok: true, text: readFileSync(p, 'utf8') };
  }
  if (loc.kind === 'catalogue-ingredients') {
    const p = resolve(root, 'data/catalogue.json');
    if (!existsSync(p)) return { ok: false, reason: 'missing-source' };
    const cat = JSON.parse(readFileSync(p, 'utf8'));
    const prod = (cat.products ?? []).find((x) => String(x.ean) === String(loc.ean));
    if (!prod?.ingredients?.text) return { ok: false, reason: 'missing-source' };
    return { ok: true, text: prod.ingredients.text };
  }
  if (loc.kind === 'sheet-evidence') {
    const p = resolve(root, 'data/classification/sheet.json');
    if (!existsSync(p)) return { ok: false, reason: 'missing-source' };
    const sheet = JSON.parse(readFileSync(p, 'utf8'));
    const rows = Array.isArray(sheet) ? sheet : (sheet.rows ?? Object.values(sheet));
    const row = rows.find((r) => String(r.ean) === String(loc.ean));
    const ev = (row?.evidence ?? []).find((e) => e.type === loc.evidenceType && String(e.quote ?? '').includes(loc.match ?? ''));
    if (!ev?.quote) return { ok: false, reason: 'missing-source' };
    return { ok: true, text: ev.quote };
  }
  return { ok: false, reason: 'unknown-source-locator' };
}

// ---------------------------------------------------------------------------
// Guard 1 — evidence-hash matching + verbatim quote anchoring (F2/F3).
// evidence: [{ sourceId, locator, quote, sha256 }] — the sha256 is the hash the
// proposal/reviewers saw. Any drift between then and now REJECTS.
// ---------------------------------------------------------------------------

export function verifyEvidence(root, evidence) {
  const failures = [];
  const hashes = {};
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { ok: false, failures: [{ sourceId: null, reason: 'no-evidence' }], hashes };
  }
  for (const ev of evidence) {
    const src = extractSource(root, ev.locator);
    if (!src.ok) { failures.push({ sourceId: ev.sourceId ?? null, reason: src.reason }); continue; }
    const nowHash = sha256(src.text);
    hashes[ev.sourceId] = nowHash;
    if (ev.sha256 !== nowHash) {
      failures.push({ sourceId: ev.sourceId, reason: 'evidence-hash-mismatch', expected: ev.sha256 ?? null, actual: nowHash });
      continue;
    }
    if (typeof ev.quote !== 'string' || ev.quote.length === 0 || !src.text.includes(ev.quote)) {
      failures.push({ sourceId: ev.sourceId, reason: 'unanchored-quote', quote: ev.quote ?? null });
    }
  }
  return { ok: failures.length === 0, failures, hashes };
}

// Aggregate hash binding reviewer verdicts to the EXACT evidence set reviewed.
export const evidenceSetHash = (hashes) => sha256(canon(hashes));

// ---------------------------------------------------------------------------
// Guard 2 — dual-independent-reviewer consensus seam.
// Verdicts are FILES produced by reviewer agents (real sessions feed their own
// verdict records in). Requirements: >=2 verdicts, >=2 DISTINCT reviewers
// (non-empty string ids, compared trim+lowercase-normalized), every verdict
// APPROVE, each bound to this item AND the current evidence-set hash, each
// carrying execution evidence. Anything else REJECTS.
// ---------------------------------------------------------------------------

export function verifyConsensus(verdicts, { itemId, evidenceHash }) {
  if (!Array.isArray(verdicts) || verdicts.length < 2) return { ok: false, reason: 'single-reviewer (need >=2 independent verdict records)' };
  // Reviewer identity is mandatory: anonymous / empty / whitespace-only /
  // non-string ids can never count toward "two independent reviewers".
  for (const v of verdicts) {
    if (!v || typeof v !== 'object') return { ok: false, reason: 'malformed verdict record' };
    if (typeof v.reviewer !== 'string' || v.reviewer.trim().length === 0) {
      return { ok: false, reason: 'malformed-reviewer-identity (every verdict needs a non-empty reviewer id string)' };
    }
  }
  // Case/whitespace-normalized comparison: 'AGENT:X' and 'agent:x' are ONE reviewer.
  const reviewers = new Set(verdicts.map((v) => v.reviewer.trim().toLowerCase()));
  if (reviewers.size < 2) return { ok: false, reason: 'non-independent reviewers (same reviewer twice is not consensus)' };
  for (const v of verdicts) {
    if (v.verdict !== 'APPROVE') return { ok: false, reason: `non-consensus: reviewer ${v.reviewer} verdict ${v.verdict ?? '(missing)'}` };
    if (v.itemId !== itemId) return { ok: false, reason: `verdict ${v.reviewer} bound to a different item (${v.itemId ?? '(missing)'})` };
    if (v.evidenceHash !== evidenceHash) return { ok: false, reason: `verdict ${v.reviewer} bound to stale evidence (hash mismatch)` };
    if (typeof v.executionEvidence !== 'string' || v.executionEvidence.trim().length === 0) return { ok: false, reason: `verdict ${v.reviewer} has no execution evidence` };
  }
  return { ok: true, reviewers: [...reviewers] };
}

// ---------------------------------------------------------------------------
// Guard 3 — delegation + D9 ratification anchors.
// The delegation quote must be EXACTLY the recorded founder words; the D9
// ratification quotes must appear verbatim in the hashed README text.
// ---------------------------------------------------------------------------

export function verifyAuthority(root, delegationQuote) {
  if (delegationQuote !== DELEGATION.quote) {
    return { ok: false, reason: 'unanchored-delegation-quote (not the recorded founder words)' };
  }
  const p = resolve(root, D9_SOURCE);
  if (!existsSync(p)) return { ok: false, reason: 'missing-d9-source' };
  const text = readFileSync(p, 'utf8');
  for (const q of D9_QUOTES) {
    if (!text.includes(q)) return { ok: false, reason: `unanchored-d9-quote: ${q}` };
  }
  return { ok: true, d9SourceSha256: sha256(text) };
}

// ---------------------------------------------------------------------------
// The decision. Grey zones NEVER publish as accusations — they resolve to
// "unverified" (evidence exists but is inconclusive) or "withheld" (no
// publishable evidence). Rejections publish nothing. Only a full pass publishes.
// ---------------------------------------------------------------------------

export function gateDecide(root, { item, evidence, verdicts, delegationQuote, greyZone = false }) {
  const evCheck = verifyEvidence(root, evidence);
  const evidenceHash = evidenceSetHash(evCheck.hashes);
  const consensus = verifyConsensus(verdicts, { itemId: item?.id, evidenceHash });
  const authority = verifyAuthority(root, delegationQuote);
  const reasons = [];
  let outcome;
  if (greyZone === true) {
    // Grey zone wins over everything: never an accusation, even on a full pass.
    outcome = evCheck.ok ? 'unverified' : 'withheld';
    reasons.push('grey-zone: resolved to ' + outcome + ' — never published as an accusation (D9 rule 4)');
  } else if (!authority.ok) {
    outcome = 'rejected'; reasons.push(authority.reason);
  } else if (!evCheck.ok) {
    outcome = 'rejected'; reasons.push(...evCheck.failures.map((f) => `${f.sourceId ?? '?'}: ${f.reason}`));
  } else if (!consensus.ok) {
    outcome = 'rejected'; reasons.push(consensus.reason);
  } else {
    outcome = 'publish';
  }
  return {
    outcome,
    publish: outcome === 'publish',
    reasons,
    evidenceCheck: evCheck,
    evidenceHash,
    consensus,
    authority,
    greyZone: greyZone === true,
  };
}

// ---------------------------------------------------------------------------
// Audit record — written for EVERY decision (publish, unverified, withheld,
// rejected). Carries: item, evidence hashes + verbatim quotes, BOTH reviewer
// verdicts verbatim, the founder delegation quote, the D9 ratification, and
// the pre-decision snapshot used by the overrule/revert path.
// ---------------------------------------------------------------------------

export function buildAuditRecord({ item, evidence, verdicts, delegationQuote, decision, prevSnapshot = null, now = new Date().toISOString(), agent = 'script:p2-gate.mjs' }) {
  const id = `${now.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-')}-p2-auto-${item?.ean ?? 'unknown'}`;
  return {
    id,
    kind: 'p2-auto-decision',
    schema: 'p2-gate/1',
    at: now,
    agent,
    item: item ?? null,
    outcome: decision.outcome,
    publish: decision.publish,
    reasons: decision.reasons,
    greyZone: decision.greyZone,
    evidence: (evidence ?? []).map((e) => ({ sourceId: e.sourceId, locator: e.locator, quote: e.quote, sha256: decision.evidenceCheck.hashes[e.sourceId] ?? null, proposedSha256: e.sha256 ?? null })),
    evidenceHash: decision.evidenceHash,
    reviewerVerdicts: verdicts ?? [],
    delegation: { ...DELEGATION, quoteProvided: delegationQuote ?? null },
    d9Ratification: { source: D9_SOURCE, quotes: D9_QUOTES, sourceSha256: decision.authority?.d9SourceSha256 ?? null },
    prevSnapshot,
  };
}

// Write-scope guard: audit artifacts ONLY under pending/p2-audit/.
export function assertAuditWritePath(root, relPath) {
  const norm = relPath.replace(/\\/g, '/');
  if (!norm.startsWith(AUDIT_DIR + '/') || norm.includes('..')) {
    throw new Error(`WRITE SCOPE VIOLATION: p2-gate may only write under ${AUDIT_DIR}/ (got ${relPath})`);
  }
  return resolve(root, norm);
}

export function writeAuditRecord(root, record, relPath = `${AUDIT_DIR}/${record.id}.json`) {
  let p = assertAuditWritePath(root, relPath);
  // Same-second decisions must never overwrite an existing audit record:
  if (existsSync(p)) {
    const base = relPath.replace(/\.json$/, '');
    for (let n = 2; n <= 99; n++) {
      const alt = `${base}-${n}.json`;
      const ap = assertAuditWritePath(root, alt);
      if (!existsSync(ap)) { record.id = `${record.id}-${n}`; p = ap; break; }
      if (n === 99) throw new Error('AUDIT WRITE REFUSED: too many same-id records');
    }
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(record, null, 2) + '\n');
  return p;
}

export function readAuditRecords(root) {
  const dir = resolve(root, AUDIT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(readFileSync(resolve(dir, f), 'utf8')); } catch { return null; } })
    .filter((x) => x && typeof x === 'object');
}

// ---------------------------------------------------------------------------
// Founder overrule — Arnav can overrule any auto-decision at any time (D9).
// The original audit record is NEVER edited (audit trail intact); an overrule
// record is appended and the decision's effective status becomes 'overruled'.
// Revert target = the pre-decision snapshot captured in the audit record.
// ---------------------------------------------------------------------------

export function applyOverrule(root, { decisionId, quote, by = 'Arnav (founder)', now = new Date().toISOString(), fixture = false }) {
  if (typeof quote !== 'string' || quote.trim().length === 0) {
    throw new Error('OVERRULE REFUSED: the founder overrule quote is required (verbatim words, never fabricated)');
  }
  const records = readAuditRecords(root);
  const target = records.find((r) => r.kind === 'p2-auto-decision' && r.id === decisionId);
  if (!target) throw new Error(`OVERRULE REFUSED: no audit record for decision ${decisionId}`);
  const record = {
    id: `${now.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-')}-p2-overrule-${target.item?.ean ?? 'unknown'}`,
    kind: 'p2-overrule',
    schema: 'p2-gate/1',
    at: now,
    overrules: decisionId,
    by,
    quote,
    fixture: fixture === true,
    effect: 'decision reverted to pre-decision snapshot; original audit record preserved verbatim',
    revertTo: target.prevSnapshot ?? null,
    targetOutcome: target.outcome,
  };
  const p = writeAuditRecord(root, record);
  return { record, path: p };
}

export function decisionStatus(root, decisionId) {
  const records = readAuditRecords(root);
  const target = records.find((r) => r.kind === 'p2-auto-decision' && r.id === decisionId);
  if (!target) return { found: false };
  const overrules = records.filter((r) => r.kind === 'p2-overrule' && r.overrules === decisionId);
  return {
    found: true,
    outcome: target.outcome,
    overruled: overrules.length > 0,
    effective: overrules.length > 0 ? 'overruled' : target.outcome,
    overrules,
  };
}