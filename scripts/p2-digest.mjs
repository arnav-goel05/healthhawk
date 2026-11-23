#!/usr/bin/env node
// HealthHawk P2-18 — founder digest aggregate builder (ONE aggregate, BOTH surfaces).
// Read-only toward every live surface and every committed data file. Writes ONLY:
//   runs/p2-18/aggregate.json, runs/p2-18/archive/digest-<SGT date>.json,
//   runs/reports/digest-<SGT date>.md, dashboard/index.html (LOCAL-ONLY).
// Committed-state reads only: data/catalogue.json, runs/12-sync-state.json (the
// atomic commit artifact), the append-only audit log pending/p2-audit/*.json,
// merge gate-outcomes, freeze-state, and agent-fetched input snapshots. Mid-run
// artifacts (12-sync-plan-*.json, session-state.json) are NEVER read.
// Partial-digest contract: any source failure -> that section is labelled
// unavailable with a reason; nothing is fabricated.
// Usage:
//   node scripts/p2-digest.mjs build [--root R] [--now ISO]
//   node scripts/p2-digest.mjs dashboard [--root R]
//   node scripts/p2-digest.mjs prune [--root R] [--now ISO]

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyConsensus, AUDIT_DIR } from './p2-gate-lib.mjs';
// Founder OS slice 05: the ONE shared derivation module (Agent X owns it).
// Y only imports + embeds — derivation is NEVER reimplemented here.
import { deriveQueue, deriveAlerts, deriveWeekly, deriveRevenueReadiness, deriveLoop } from './founder-queue.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RETENTION_DAYS = 30;
export const SITE_URL = 'https://healthhawk.geo.hashmeta.tech';
// Slice 11 (Layer 2, addendum §C3): the dashboard EMBED is windowed to the
// last N decisions under a payload budget; the audit log stays append-only,
// aggregate.json + the daily archive keep the FULL record, and cumulative
// funnel counts + reconciliation are driven by the audit log, never the embed.
// N=200 ≈ 2+ days at the current ~80-decisions/day cadence; 300 KiB budget ≈
// 2× the measured 2,000-decision windowed page (~150 KB) — instant local open.
export const DECISIONS_WINDOW_N = 200;
export const DASHBOARD_PAYLOAD_BUDGET_BYTES = 300 * 1024;
const SGT_OFFSET_MS = 8 * 3600 * 1000;

// ---------------------------------------------------------------------------
// Window labels — SGT is UTC+8 (Asia/Singapore, no DST). Every timestamp the
// digest shows carries both an explicit UTC and SGT label.
// ---------------------------------------------------------------------------
export const sgtIso = (iso) => new Date(new Date(iso).getTime() + SGT_OFFSET_MS).toISOString();
export const sgtDate = (iso) => sgtIso(iso).slice(0, 10);
export const sgtLabel = (iso) => sgtIso(iso).replace('Z', '+08:00');
export const windowFor = (nowIso, hours = 24) => {
  const end = new Date(nowIso);
  const start = new Date(end.getTime() - hours * 3600 * 1000);
  return {
    hours,
    utc: { start: start.toISOString(), end: end.toISOString() },
    sgt: { start: sgtLabel(start.toISOString()), end: sgtLabel(end.toISOString()) },
    note: 'SGT = UTC+8 (Asia/Singapore, no DST). Window is the 24h ending at digest build time; cumulative funnel is all-time.',
  };
};

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const tryReadJson = (p) => { try { return readJson(p); } catch { return null; } };
// F18 counts-only guard for the weekly rollup (same shape as the module's guard).
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// ---------------------------------------------------------------------------
// Funnel — derived ONLY from the append-only audit log. Guards order in
// p2-gate-lib.gateDecide is authority -> evidence -> consensus, so a rejected
// record whose reasons are all consensus-type passed the machine guards.
// Grey-zone records resolve to unverified (evidence ok) / withheld (evidence
// failed) and NEVER publish as accusations.
// ---------------------------------------------------------------------------
const CONSENSUS_REASON = /^(single-reviewer|non-consensus|non-independent|malformed|verdict )/;
export const guardsPass = (d) => {
  if (d.outcome === 'publish' || d.outcome === 'unverified') return true;
  if (d.outcome === 'withheld') return false;
  if (d.outcome === 'rejected') return Array.isArray(d.reasons) && d.reasons.length > 0 && d.reasons.every((r) => CONSENSUS_REASON.test(String(r)));
  return false;
};
export const consensusOk = (d) => verifyConsensus(d.reviewerVerdicts, { itemId: d.item?.id, evidenceHash: d.evidenceHash }).ok;

export function computeFunnel(decisions, overrules) {
  const overruledIds = new Set(overrules.map((r) => r.overrules));
  const outcomes = { publish: 0, unverified: 0, withheld: 0, rejected: 0 };
  for (const d of decisions) if (d.outcome in outcomes) outcomes[d.outcome] += 1;
  return {
    proposed: decisions.length,
    guardsPassed: decisions.filter(guardsPass).length,
    consensus: decisions.filter(consensusOk).length,
    published: decisions.filter((d) => d.outcome === 'publish' && !overruledIds.has(d.id)).length,
    overruled: decisions.filter((d) => overruledIds.has(d.id)).length,
    overruleRecords: overrules.length,
    greyZone: decisions.filter((d) => d.greyZone === true).length,
    outcomes,
  };
}

export function readAudit(root) {
  const dir = resolve(root, AUDIT_DIR);
  const out = { decisions: [], overrules: [], plans: [], evidence: [], parseErrors: [] };
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let j;
    try { j = readJson(join(dir, f)); } catch (e) { out.parseErrors.push({ file: f, error: String(e.message ?? e) }); continue; }
    if (!j || typeof j !== 'object') { out.parseErrors.push({ file: f, error: 'not an object' }); continue; }
    if (j.kind === 'p2-auto-decision') out.decisions.push(j);
    else if (j.kind === 'p2-overrule') out.overrules.push(j);
    else if (j.kind === 'p2-publish-plan') out.plans.push(j);
    else if (j.kind === 'p2-publish-evidence') out.evidence.push(j);
  }
  return out;
}

// Reconcile EXACTLY against the audit records: every merge-batch gate outcome
// must bind to an audit record with identical outcome + evidence hash, and
// every publish plan must reference a publish decision.
export function reconcileFunnel(root, audit) {
  const byId = new Map(audit.decisions.map((d) => [d.id, d]));
  const mismatches = [];
  let checked = 0;
  const batches = [];
  for (const batch of ['p2-merge-02', 'p2-merge-03', 'p2-merge-04']) {
    const p = resolve(root, 'runs', batch, 'gate-outcomes.json');
    if (!existsSync(p)) { batches.push({ batch, present: false }); continue; }
    let go;
    try { go = readJson(p); } catch (e) { mismatches.push({ batch, field: 'gate-outcomes.json', reason: String(e.message ?? e) }); batches.push({ batch, present: true, reconciled: false }); continue; }
    const results = go.results ?? [];
    let batchChecked = 0;
    const tally = {};
    for (const r of results) {
      tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
      if (!r.decisionId) continue;
      checked += 1; batchChecked += 1;
      const d = byId.get(r.decisionId);
      if (!d) { mismatches.push({ batch, decisionId: r.decisionId, field: 'audit-record', reason: 'missing' }); continue; }
      if (d.outcome !== r.outcome) mismatches.push({ batch, decisionId: r.decisionId, field: 'outcome', audit: d.outcome, gateOutcomes: r.outcome });
      if (r.evidenceHash && d.evidenceHash && r.evidenceHash !== d.evidenceHash) mismatches.push({ batch, decisionId: r.decisionId, field: 'evidenceHash', audit: d.evidenceHash, gateOutcomes: r.evidenceHash });
      if (typeof r.publish === 'boolean' && r.publish !== (d.outcome === 'publish')) mismatches.push({ batch, decisionId: r.decisionId, field: 'publish', audit: d.outcome === 'publish', gateOutcomes: r.publish });
    }
    batches.push({ batch, present: true, count: results.length, tally, checked: batchChecked, reconciled: !mismatches.some((m) => m.batch === batch) });
  }
  for (const plan of audit.plans) {
    checked += 1;
    const d = byId.get(plan.decisionId);
    if (!d) mismatches.push({ batch: 'publish-plans', decisionId: plan.decisionId, field: 'audit-record', reason: 'missing' });
    else if (d.outcome !== 'publish') mismatches.push({ batch: 'publish-plans', decisionId: plan.decisionId, field: 'outcome', audit: d.outcome, expected: 'publish' });
  }
  return { ok: mismatches.length === 0 && audit.parseErrors.length === 0, checked, mismatches, batches, publishPlans: audit.plans.length, publishEvidence: audit.evidence.length };
}

const decisionRow = (d, overruledIds) => ({
  id: d.id,
  at: d.at,
  atSGT: sgtLabel(d.at),
  ean: d.item?.ean ?? null,
  name: d.item?.name ?? null,
  kind: d.item?.kind ?? null,
  outcome: d.outcome,
  effective: overruledIds.has(d.id) ? 'overruled' : d.outcome,
  greyZone: d.greyZone === true,
  guardsPassed: guardsPass(d),
  consensus: consensusOk(d),
  reasons: d.reasons ?? [],
});

// ---------------------------------------------------------------------------
// Input snapshots (agent-fetched; the builder itself never calls MCP/network).
// ---------------------------------------------------------------------------
function latestInput(root, prefix) {
  const dir = resolve(root, 'runs', 'p2-18', 'inputs');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();
  if (!files.length) return null;
  const path = join(dir, files[files.length - 1]);
  try { return { path, file: files[files.length - 1], json: readJson(path) }; }
  catch (e) { return { path, file: files[files.length - 1], json: null, error: String(e.message ?? e) }; }
}

function trafficSection(root, now) {
  const source = 'runs/p2-18/inputs/hashmeta-<date>.json (agent MCP read of mcp__hashmeta__get_site_traffic, READ-ONLY)';
  const snap = latestInput(root, 'hashmeta-');
  if (!snap) return { status: 'unavailable', source, reason: 'no Hashmeta snapshot input — MCP unreachable or not fetched this run' };
  if (!snap.json) return { status: 'unavailable', source, reason: `snapshot unreadable: ${snap.error}` };
  if (snap.json.unavailable) return { status: 'unavailable', source, reason: String(snap.json.reason ?? 'snapshot marked unavailable') };
  const t = snap.json.traffic;
  if (!t || typeof t !== 'object' || !t.totals) return { status: 'unavailable', source, reason: 'snapshot has no traffic payload' };
  const ageH = (new Date(now).getTime() - new Date(snap.json.fetchedAt).getTime()) / 3600000;
  return {
    status: Number.isFinite(ageH) && ageH > 26 ? 'stale' : 'ok',
    source, snapshotFile: snap.file, fetchedAt: snap.json.fetchedAt, fetchedAtSGT: sgtLabel(snap.json.fetchedAt),
    computedAt: t.computedAt, range: t.range, totals: t.totals, previous: t.previous ?? null,
    dailyNonZero: t.dailyNonZero ?? [], today: t.today ?? null, topPages: t.topPages ?? [],
    devices: t.devices ?? [], countries: t.countries ?? [], channels: t.channels ?? [],
    aiBots: t.aiBots ?? null, aiReferrals: t.aiReferrals ?? null,
  };
}

function formsSection(root) {
  const source = 'runs/p2-18/inputs/hashmeta-<date>.json (agent MCP reads of mcp__hashmeta__list_forms + list_form_submissions, READ-ONLY)';
  const snap = latestInput(root, 'hashmeta-');
  if (!snap) return { status: 'unavailable', source, reason: 'no Hashmeta snapshot input' };
  if (!snap.json) return { status: 'unavailable', source, reason: `snapshot unreadable: ${snap.error}` };
  const f = snap.json.forms;
  if (!f || !Array.isArray(f.forms)) return { status: 'unavailable', source, reason: 'snapshot has no forms payload' };
  return {
    status: 'ok', source, snapshotFile: snap.file, syncedAt: f.syncedAt ?? null,
    submissionsSync: f.submissionsSync ?? null,
    forms: f.forms.map((x) => ({ id: x.id, title: x.title, fields: x.fields ?? [], totalDocs: x.totalDocs ?? 0, docs: x.docs ?? [], note: x.note ?? null })),
    privacy: 'Form submissions may contain visitor emails — LOCAL-ONLY surface, never public-bound (F18).',
  };
}

function agentsSection(root) {
  const freeze = tryReadJson(resolve(root, 'runs', 'freeze-state.json'));
  const reportsDir = resolve(root, 'runs', 'reports');
  const recentReports = existsSync(reportsDir)
    ? readdirSync(reportsDir).filter((f) => f.endsWith('.md')).sort().slice(-8).map((f) => ({ file: `runs/reports/${f}`, bytes: statSync(join(reportsDir, f)).size }))
    : [];
  const snapPath = resolve(root, 'runs', 'p2-18', 'inputs', 'crons-snapshot.json');
  let crons;
  if (existsSync(snapPath)) {
    const j = tryReadJson(snapPath);
    if (j && Array.isArray(j.crons)) {
      crons = { status: 'ok', liveSnapshot: true, source: 'runs/p2-18/inputs/crons-snapshot.json (orchestrator-refreshed Connector snapshot)', refreshedAt: j.refreshedAt ?? null, crons: j.crons };
    } else {
      crons = { status: 'unavailable', liveSnapshot: false, source: 'runs/p2-18/inputs/crons-snapshot.json', reason: 'snapshot unreadable or malformed' };
    }
  } else {
    crons = { status: 'unavailable', liveSnapshot: false, source: 'runs/p2-18/inputs/crons-snapshot.json (orchestrator-refreshed Connector snapshot)', reason: 'no live Connector snapshot — orchestrator owns the cron tool and has not refreshed the snapshot file' };
  }
  if (!crons.crons) {
    const evidence = [];
    for (const p of ['runs/p2-06/cron-run-evidence.json', 'runs/p2-06/cron-update-evidence.json', 'runs/p2-17/cron-registration-evidence.json']) {
      const j = tryReadJson(resolve(root, p));
      if (j) evidence.push({ file: p, taskId: j.taskId ?? j.trigger?.jobId ?? null, name: j.name ?? null, schedule: j.schedule ?? null, enabled: j.enabled ?? null, nextRunSGT: j.nextRunSGT ?? null });
    }
    crons.committedEvidence = evidence;
    crons.committedEvidenceLabel = 'committed registration/run evidence files (NOT a live status read)';
  }
  const fireEvidence = [];
  for (const p of ['runs/reports/refresh-2026-11-22.md', 'runs/reports/reenrich-2026-11-22.md']) {
    if (existsSync(resolve(root, p))) fireEvidence.push(p);
  }
  return {
    status: crons.status === 'ok' ? 'ok' : 'partial',
    crons,
    freeze: freeze ? { status: 'ok', source: 'runs/freeze-state.json (committed)', frozen: freeze.frozen === true, frozenAt: freeze.frozenAt ?? null, frozenAtSGT: freeze.frozenAt ? sgtLabel(freeze.frozenAt) : null, reason: freeze.reason ?? null, unfreeze: 'founder-only' } : { status: 'unavailable', source: 'runs/freeze-state.json', reason: 'missing or unreadable' },
    recentReports,
    realCronFireEvidence: fireEvidence,
    note: 'Digest is read-only: it runs under freeze and reports the locked state honestly.',
  };
}

// ---------------------------------------------------------------------------
// Archive — daily entries under runs/p2-18/archive/, 30-day retention.
// ---------------------------------------------------------------------------
const ARCHIVE_RE = /^digest-(\d{4}-\d{2}-\d{2})\.json$/;
export function pruneArchive(root, nowIso) {
  const dir = resolve(root, 'runs', 'p2-18', 'archive');
  const removed = [], kept = [];
  if (!existsSync(dir)) return { removed, kept };
  const today = sgtDate(nowIso);
  const cutoff = sgtDate(new Date(new Date(today + 'T00:00:00Z').getTime() - (RETENTION_DAYS - 1) * 86400000).toISOString());
  for (const f of readdirSync(dir).sort()) {
    const m = ARCHIVE_RE.exec(f);
    if (!m) continue;
    if (m[1] < cutoff) { unlinkSync(join(dir, f)); removed.push(f); } else kept.push(f);
  }
  return { removed, kept, cutoff };
}

export function archiveIndex(root) {
  const dir = resolve(root, 'runs', 'p2-18', 'archive');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).sort().reverse()) {
    const m = ARCHIVE_RE.exec(f);
    if (!m) continue;
    const j = tryReadJson(join(dir, f));
    if (!j) { out.push({ date: m[1], file: f, status: 'unreadable' }); continue; }
    out.push({
      date: m[1], file: f, href: `../runs/p2-18/archive/${f}`,
      generatedAt: j.generatedAt ?? null,
      funnel: j.funnel?.cumulative ? { proposed: j.funnel.cumulative.proposed, published: j.funnel.cumulative.published, unverified: j.funnel.cumulative.outcomes?.unverified ?? null, rejected: j.funnel.cumulative.outcomes?.rejected ?? null } : null,
      coverage: j.coverage?.status === 'ok' ? { rated: j.coverage.rated, per100g: j.coverage.per100g } : null,
      degraded: j.partial?.degraded ?? [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The aggregate.
// ---------------------------------------------------------------------------
export function buildAggregate(root, { now = new Date().toISOString() } = {}) {
  const window = windowFor(now);
  const agg = {
    schema: 'p2-18-digest/1',
    generatedAt: now,
    generatedAtSGT: sgtLabel(now),
    digestDateSGT: sgtDate(now),
    site: SITE_URL,
    window,
    committedState: { reads: 'committed files only: data/catalogue.json, runs/12-sync-state.json (atomic commit artifact), append-only pending/p2-audit/*.json, merge gate-outcomes, runs/freeze-state.json, agent input snapshots. Mid-run 12-sync-plan-*.json / session-state.json are NEVER read.' },
  };

  // Funnel
  try {
    const audit = readAudit(root);
    const recon = reconcileFunnel(root, audit);
    if (audit.parseErrors.length || !recon.ok) {
      agg.funnel = { status: 'unavailable', source: 'pending/p2-audit (append-only audit log) + runs/p2-merge-0*/gate-outcomes.json', reason: audit.parseErrors.length ? `audit parse errors: ${JSON.stringify(audit.parseErrors)}` : 'audit reconciliation failed — refusing to publish unreconciled numbers', reconciliation: recon };
    } else {
      const overruledIds = new Set(audit.overrules.map((r) => r.overrules));
      const inWindow = audit.decisions.filter((d) => d.at >= window.utc.start && d.at < window.utc.end);
      agg.funnel = {
        status: 'ok',
        source: 'pending/p2-audit (append-only audit log), reconciled against runs/p2-merge-02/03/04 gate-outcomes + publish plans',
        cumulative: computeFunnel(audit.decisions, audit.overrules),
        last24h: computeFunnel(inWindow, audit.overrules.filter((r) => r.at >= window.utc.start && r.at < window.utc.end)),
        reconciliation: recon,
        decisions: audit.decisions.map((d) => decisionRow(d, overruledIds)),
        decisionsWindow: {
          policy: 'last-N', windowSize: DECISIONS_WINDOW_N, total: audit.decisions.length,
          shown: Math.min(DECISIONS_WINDOW_N, audit.decisions.length),
          budgetBytes: DASHBOARD_PAYLOAD_BUDGET_BYTES,
          fullRecord: 'pending/p2-audit/*.json (append-only audit log) + runs/p2-18/archive/digest-<date>.json (full decisions); this aggregate keeps ALL decisions — only the dashboard embed is windowed',
        },
        overrules: audit.overrules.map((r) => ({ id: r.id, at: r.at, overrules: r.overrules, by: r.by, quote: r.quote, fixture: r.fixture === true })),
      };
      agg.committedState.auditRecords = audit.decisions.length;
    }
  } catch (e) {
    agg.funnel = { status: 'unavailable', source: 'pending/p2-audit', reason: String(e.message ?? e) };
  }

  // Coverage
  try {
    const cat = readJson(resolve(root, 'data', 'catalogue.json'));
    const products = cat.products ?? [];
    const grades = {};
    let rated = 0, per100g = 0;
    for (const p of products) {
      if (p.rated === true) rated += 1;
      if (p.nutrition && p.nutrition.per100g && Object.keys(p.nutrition.per100g).length) per100g += 1;
      const g = p.score?.grade;
      if (g) grades[g] = (grades[g] ?? 0) + 1;
    }
    const prev = archiveIndex(root).find((a) => a.date < agg.digestDateSGT && a.coverage);
    agg.coverage = {
      status: 'ok', source: 'data/catalogue.json (committed)', catalogueUpdatedAt: cat.updatedAt,
      total: products.length, rated, ratedPct: products.length ? Math.round((rated / products.length) * 1000) / 10 : null,
      per100g, grades, target: { min: 60, max: 65, note: 'PRD Q8 coverage target' },
      growth: prev
        ? { vsArchiveDate: prev.date, ratedDelta: rated - prev.coverage.rated, per100gDelta: per100g - prev.coverage.per100g }
        : { vsArchiveDate: null, note: 'first digest — this is the baseline archive; day-over-day growth starts with the next daily archive' },
    };
    agg.committedState.catalogueUpdatedAt = cat.updatedAt;
  } catch (e) {
    agg.coverage = { status: 'unavailable', source: 'data/catalogue.json', reason: String(e.message ?? e) };
  }

  // Sync health — committed state ONLY (12-sync-state.json is written atomically at commit).
  try {
    const s = readJson(resolve(root, 'runs', '12-sync-state.json'));
    agg.sync = {
      status: 'ok', source: 'runs/12-sync-state.json (committed at last sync; mid-run plans never read)',
      syncedAt: s.syncedAt, syncedAtSGT: sgtLabel(s.syncedAt),
      entries: Object.keys(s.entries ?? {}).length,
      lastPlan: s.lastPlan ? { createdAt: s.lastPlan.createdAt, summary: s.lastPlan.summary } : null,
      appPage: s.appPage ? { slug: s.appPage.slug, change: s.appPage.change, sha256: s.appPage.sha256, syncedAt: s.appPage.syncedAt, readbackStatus: s.appPage.readback?.app?.status ?? null } : null,
      retired: s.retired ? { count: s.retired.count, at: s.retired.at } : null,
    };
    agg.committedState.syncSyncedAt = s.syncedAt;
  } catch (e) {
    agg.sync = { status: 'unavailable', source: 'runs/12-sync-state.json', reason: String(e.message ?? e) };
  }

  agg.traffic = trafficSection(root, now);
  agg.forms = formsSection(root);
  agg.agents = agentsSection(root);
  agg.affiliate = { status: 'not-live', note: 'Affiliate performance is POST-P2 gated (PRD D7: Involve Asia route, four revival conditions). No clicks/conversions data exists yet — honest placeholder, nothing fabricated.' };

  // Founder OS (slice 05) — additive aggregate fields from the shared module.
  // Each derivation is wrapped: a failure labels ONLY that field unavailable
  // with a reason; the build never throws (partial-digest contract).
  const founderDerivations = [
    ['founderQueue', deriveQueue],
    ['alerts', deriveAlerts],
    ['weekly', deriveWeekly],
    ['revenueReadiness', deriveRevenueReadiness],
    ['loop', deriveLoop],
  ];
  for (const [key, derive] of founderDerivations) {
    try {
      const v = derive(root, now);
      if (key === 'weekly' && EMAIL_RE.test(JSON.stringify(v))) {
        throw new Error('weekly PII guard: email-like text in the weekly rollup — counts-only contract (F18)');
      }
      agg[key] = v;
    } catch (e) {
      agg[key] = { status: 'unavailable', reason: String(e.message ?? e) };
    }
  }

  const degraded = [];
  for (const k of ['funnel', 'coverage', 'sync', 'traffic', 'forms', 'agents']) {
    if (agg[k].status === 'unavailable' || agg[k].status === 'partial' || agg[k].status === 'stale') degraded.push(`${k}:${agg[k].status}`);
  }
  for (const k of ['founderQueue', 'alerts', 'weekly', 'revenueReadiness', 'loop']) {
    if (agg[k] && agg[k].status === 'unavailable') degraded.push(`${k}:unavailable`);
  }
  agg.partial = { degraded, contract: 'Any source failure labels that section unavailable (or partial/stale) with a reason; no metric is fabricated. The digest still delivers.' };
  agg.archive = { dir: 'runs/p2-18/archive/', retentionDays: RETENTION_DAYS, file: `runs/p2-18/archive/digest-${agg.digestDateSGT}.json` };
  // Submission-review C r2-M1: the email-count parenthetical is COMPUTED from
  // the forms snapshot, never hardcoded — it stays honest when the first
  // visitor email is collected (or when the snapshot is unavailable).
  const formsUsable = agg.forms && agg.forms.status !== 'unavailable' && Array.isArray(agg.forms.forms);
  const submissionCount = formsUsable ? agg.forms.forms.reduce((n, x) => n + (x.totalDocs ?? 0), 0) : null;
  const emailNote = submissionCount == null ? 'collection status unavailable' : submissionCount === 0 ? 'none collected yet' : `${submissionCount} submission${submissionCount === 1 ? '' : 's'} collected`;
  agg.dashboard = { path: 'dashboard/index.html', localOnly: true, emailNote, warning: `LOCAL-ONLY — may contain visitor emails (${emailNote}) and other form/visitor data; never public-bound, never uploaded (F18).` };
  return agg;
}

// ---------------------------------------------------------------------------
// Report (markdown) — the founder file delivery.
// ---------------------------------------------------------------------------
const fmtFunnel = (f) => `proposed ${f.proposed} → guards ${f.guardsPassed} → consensus ${f.consensus} → published ${f.published} (overruled ${f.overruled}; unverified ${f.outcomes.unverified}, withheld ${f.outcomes.withheld}, rejected ${f.outcomes.rejected}; grey-zone ${f.greyZone})`;

export function renderReport(agg) {
  const L = [];
  L.push(`# HealthHawk founder digest — ${agg.digestDateSGT} (SGT)`);
  L.push('');
  L.push(`Generated: ${agg.generatedAt} (UTC) / ${agg.generatedAtSGT} (SGT) · Site: ${agg.site}`);
  L.push(`Window (last ${agg.window.hours}h): UTC ${agg.window.utc.start} → ${agg.window.utc.end} · SGT ${agg.window.sgt.start} → ${agg.window.sgt.end}`);
  L.push(`Cumulative funnel is all-time. ${agg.window.note}`);
  L.push('');
  L.push(`**Delivery:** this file is the founder delivery (no IM channels connected — honest file delivery). Local dashboard: \`${agg.dashboard.path}\` — ${agg.dashboard.warning}`);
  L.push('');
  L.push(`Founder loop: \`docs/FOUNDER-OS.md\` · read-time check: \`node scripts/founder.mjs status\` · local dashboard: \`${agg.dashboard.path}\` (LOCAL-ONLY).`);
  L.push('');
  L.push('## Auto-gate funnel (D9)');
  if (agg.funnel.status === 'ok') {
    L.push(`Source: ${agg.funnel.source}`);
    L.push(`- Cumulative: ${fmtFunnel(agg.funnel.cumulative)}`);
    L.push(`- Last 24h: ${fmtFunnel(agg.funnel.last24h)}`);
    L.push(`- Reconciliation vs audit log: ${agg.funnel.reconciliation.ok ? 'EXACT' : 'FAILED'} (${agg.funnel.reconciliation.checked} bindings checked; publish plans ${agg.funnel.reconciliation.publishPlans}, publish evidence ${agg.funnel.reconciliation.publishEvidence})`);
    for (const b of agg.funnel.reconciliation.batches) {
      L.push(b.present ? `  - ${b.batch}: ${b.count} outcomes ${JSON.stringify(b.tally)} — ${b.reconciled ? 'reconciled' : 'MISMATCH'}` : `  - ${b.batch}: gate-outcomes not present (skipped)`);
    }
    L.push(`- Overrule records: ${agg.funnel.cumulative.overruleRecords}${agg.funnel.cumulative.overruleRecords === 0 ? ' — no founder overrules to date (honest)' : ''}`);
  } else {
    L.push(`**UNAVAILABLE** — ${agg.funnel.reason}`);
  }
  L.push('');
  L.push('## Coverage');
  if (agg.coverage.status === 'ok') {
    const c = agg.coverage;
    L.push(`Source: ${c.source} · catalogue updatedAt ${c.catalogueUpdatedAt}`);
    L.push(`- Rated ${c.rated}/${c.total} (${c.ratedPct}%) · per-100g complete ${c.per100g}/${c.total} · grades ${JSON.stringify(c.grades)}`);
    L.push(`- Target (PRD Q8): ${c.target.min}–${c.target.max} rated`);
    L.push(c.growth.vsArchiveDate ? `- Growth vs ${c.growth.vsArchiveDate} archive: rated ${c.growth.ratedDelta >= 0 ? '+' : ''}${c.growth.ratedDelta}, per-100g ${c.growth.per100gDelta >= 0 ? '+' : ''}${c.growth.per100gDelta}` : `- Growth: ${c.growth.note}`);
  } else L.push(`**UNAVAILABLE** — ${agg.coverage.reason}`);
  L.push('');
  L.push('## Sync health');
  if (agg.sync.status === 'ok') {
    const s = agg.sync;
    L.push(`Source: ${s.source}`);
    L.push(`- Committed sync at ${s.syncedAt} (UTC) / ${s.syncedAtSGT} (SGT) · ${s.entries} entries in last-sync state`);
    if (s.lastPlan) L.push(`- Last plan ${s.lastPlan.createdAt}: ${JSON.stringify(s.lastPlan.summary)}`);
    if (s.appPage) L.push(`- App page /${s.appPage.slug}: ${s.appPage.change}, readback HTTP ${s.appPage.readbackStatus}`);
    if (s.retired) L.push(`- Retired (D10 cutover): ${s.retired.count} entries at ${s.retired.at}`);
  } else L.push(`**UNAVAILABLE** — ${agg.sync.reason}`);
  L.push('');
  L.push('## Traffic (Hashmeta site tracking)');
  if (agg.traffic.status === 'ok' || agg.traffic.status === 'stale') {
    const t = agg.traffic;
    L.push(`Source: ${t.source}${t.status === 'stale' ? ' — **STALE snapshot** (fetched >26h ago)' : ''}`);
    L.push(`- Snapshot fetched ${t.fetchedAt} (UTC) / ${t.fetchedAtSGT} (SGT) · nightly counts computedAt ${t.computedAt} · range ${t.range?.start} → ${t.range?.end}`);
    L.push(`- 30-day totals: ${t.totals.views} views, ${t.totals.visitors} visitors, ${t.totals.sessions} sessions (bounce ${t.totals.bounceRate}%)`);
    if (t.today) L.push(`- Today (${t.today.date} UTC so far): ${t.today.views} views, ${t.today.visitors} visitors`);
    L.push(`- Top pages: ${t.topPages.map((p) => `${p.path} (${p.views})`).join(', ')}`);
    if (t.aiBots) L.push(`- AI bots: ${t.aiBots.fetches} fetches (${t.aiBots.bots.map((b) => `${b.bot}×${b.fetches}`).join(', ')}) — robots.txt only`);
    L.push(`- AI referrals: ${t.aiReferrals ? t.aiReferrals.sessions : 0} sessions`);
  } else L.push(`**UNAVAILABLE** — ${agg.traffic.reason}`);
  L.push('');
  L.push('## Forms');
  if (agg.forms.status === 'ok') {
    const f = agg.forms;
    L.push(`Source: ${f.source}`);
    for (const form of f.forms) L.push(`- ${form.title} (id ${form.id}): ${form.totalDocs} submissions${form.note ? ` — ${form.note}` : ''}`);
    L.push(`- ${f.privacy}`);
  } else L.push(`**UNAVAILABLE** — ${agg.forms.reason}`);
  L.push('');
  L.push('## Agents / crons');
  const a = agg.agents;
  if (a.crons.liveSnapshot) {
    L.push(`Source: ${a.crons.source} (refreshed ${a.crons.refreshedAt})`);
    for (const c of a.crons.crons) L.push(`- ${c.name ?? c.id}: enabled=${c.enabled} schedule=${JSON.stringify(c.schedule ?? null)} next=${c.nextRunAt ?? c.nextRunSGT ?? '?'}`);
  } else {
    L.push(`**Live Connector snapshot UNAVAILABLE** — ${a.crons.reason}. Falling back to ${a.crons.committedEvidenceLabel}:`);
    for (const e of a.crons.committedEvidence ?? []) L.push(`- ${e.file}: ${e.name ?? e.taskId ?? '?'} ${e.schedule ? JSON.stringify(e.schedule) : ''} enabled=${e.enabled ?? '?'}`);
  }
  if (a.freeze.status === 'ok') L.push(`- Freeze: ${a.freeze.frozen ? `FROZEN since ${a.freeze.frozenAt} (UTC) / ${a.freeze.frozenAtSGT} (SGT) — "${a.freeze.reason}" (founder-only unfreeze; crons run guarded, write nothing)` : 'not frozen'}`);
  else L.push(`- Freeze: **UNAVAILABLE** — ${a.freeze.reason}`);
  if (a.realCronFireEvidence.length) L.push(`- Real cron fire evidence (F13): ${a.realCronFireEvidence.join(', ')}`);
  L.push(`- Recent report files: ${a.recentReports.map((r) => r.file).join(', ')}`);
  L.push('');
  L.push('## Affiliate');
  L.push(`**NOT LIVE** — ${agg.affiliate.note}`);
  L.push('');
  L.push('## Founder OS — needs you');
  if (agg.founderQueue && Array.isArray(agg.founderQueue.items)) {
    if (!agg.founderQueue.items.length) L.push('- Nothing needs you right now (honest empty queue).');
    for (const it of agg.founderQueue.items) {
      L.push(`- [${it.priority}] ${it.title} (${it.kind}, ${it.status}) — ${it.why}`);
      if (it.nextStep && it.nextStep.command) L.push(`  - Next: \`${it.nextStep.command}\``);
      else if (it.nextStep && it.nextStep.instructions) L.push(`  - Next: ${it.nextStep.instructions}`);
      L.push(`  - Source: ${it.source.path}${it.source.section ? ` · ${it.source.section}` : ''}`);
    }
  } else {
    L.push(`**UNAVAILABLE** — ${agg.founderQueue && agg.founderQueue.reason ? agg.founderQueue.reason : 'founder queue not embedded in this build'}. Run \`node scripts/founder.mjs status\` for a read-time check.`);
  }
  L.push('');
  L.push('## Partial-digest status');
  L.push(agg.partial.degraded.length ? `Degraded sections: ${agg.partial.degraded.join(', ')}. ${agg.partial.contract}` : `All sources ok. ${agg.partial.contract}`);
  L.push('');
  L.push('## Archive');
  L.push(`Daily archive: \`${agg.archive.file}\` · retention ${agg.archive.retentionDays} days under \`${agg.archive.dir}\` · committed-state reads only (${agg.committedState.reads})`);
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Dashboard (LOCAL-ONLY) — regenerated from the SAME aggregate JSON. Vanilla
// JS, zero external dependencies. Interactive funnel exploration + archive nav.
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const jsonEmbed = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

// Slice 11: the dashboard embed carries the LAST-N decisions only (payload
// budget). Everything else — cumulative counts, reconciliation, window meta —
// is embedded verbatim; aggregate.json and the daily archive keep the full
// decisions array. Exported so tests pin the exact embed shape.
export function windowedEmbed(agg) {
  if (!agg || !agg.funnel || agg.funnel.status !== 'ok' || !Array.isArray(agg.funnel.decisions)) return agg;
  if (agg.funnel.decisions.length <= DECISIONS_WINDOW_N) return agg;
  return { ...agg, funnel: { ...agg.funnel, decisions: agg.funnel.decisions.slice(-DECISIONS_WINDOW_N) } };
}

// ---------------------------------------------------------------------------
// Founder OS panels (slice 05, additive). Runs INSIDE the existing IIFE,
// reusing el()/esc(); existing markup, ids and code are byte-untouched.
// Plain English (≤ grade 6); a "what it means" line under every number;
// color + word + icon, never color alone. Honest unavailable states when a
// founder field is missing (old aggregates) or failed at build time.
// The age banner renders FIRST, in its own guard, independent of the funnel
// render path. Zero external loads; no PII beyond the LOCAL-ONLY surface.
// ---------------------------------------------------------------------------
export const FOUNDER_PANELS_JS = `// --- Founder OS panels (slice 05, additive; existing code above untouched) ---
  // Slice 06: status colors restyled to the canonical token set (style only;
  // words/icons/text unchanged). Small text = ink/ink-soft/teal/flag-red, all
  // AA on paper+card; grey never used for small text.
  var fstate = { focusCron: null, focusLoop: null };
  function statusMark(kind) {
    if (kind === 'ok') return '<span style="color:#0F766E">✓ ok</span>';
    if (kind === 'error') return '<span style="color:#B91C1C">✗ error</span>';
    if (kind === 'warn') return '<span style="color:#1B1917">⚠ check</span>';
    if (kind === 'frozen') return '<span style="color:#57534E">❄ frozen — expected</span>';
    return '<span style="color:#57534E">? no status</span>';
  }
  function shortCronName(c) {
    var names = { refresh: 'Price refresh (daily)', reenrich: 'Re-enrich (weekly)', digest: 'This digest (daily)', blog: 'Blog draft (weekly)', basket: 'Basket report (weekly)', scout: 'Market scout (weekly)', 'founder-report': 'Founder report (weekly)' };
    return names[c.key] || c.name || c.id;
  }
  function ageBannerHtml() {
    var gen = agg && agg.generatedAt ? Date.parse(agg.generatedAt) : NaN;
    if (!isFinite(gen)) return '<div class="banner" role="alert">⚠ Build time unknown — cannot tell how old this page is. Run <code>node scripts/founder.mjs status</code> for a fresh check.</div>';
    var ageH = (Date.now() - gen) / 3600000;
    if (ageH <= 26) return '<p class="meta">✓ Fresh: built ' + Math.max(0, Math.round(ageH)) + ' hours ago. What it means: the numbers below are recent.</p>';
    var days = Math.floor(ageH / 24);
    return '<div class="banner" role="alert" style="border-width:3px">⚠ THIS DASHBOARD IS ' + days + ' DAY' + (days === 1 ? '' : 'S') + ' OLD — the digest job may not have run. What it means: do not trust these numbers as today\\'s. Run <code>node scripts/founder.mjs status</code> in a terminal for a read-time check.</div>';
  }
  function needsYouHtml() {
    var h = '<h2>NEEDS YOU — do these first</h2>';
    var q = agg.founderQueue;
    if (!q || q.status === 'unavailable' || !Array.isArray(q.items)) {
      return h + '<p class="unavail">⚠ UNAVAILABLE — ' + esc(q && q.reason ? q.reason : 'the founder queue was not embedded in this build') + '. What it means: this list may be incomplete. Run <code>node scripts/founder.mjs status</code> for a read-time check.</p>';
    }
    if (!q.items.length) return h + '<p>✓ Nothing needs you right now. What it means: the queue is clear.</p>';
    h += '<p class="meta">' + q.items.length + ' thing(s) need you, in priority order. What it means: start at 1 and work down.</p>';
    q.items.forEach(function (it) {
      var mark = it.status === 'expired' ? '<span style="color:#1B1917">⚠ expired</span>' : (it.stale ? '<span style="color:#1B1917">⚠ possibly stale</span>' : '<span style="color:#0F766E">● open</span>');
      h += '<div class="banner" style="font-weight:400;border-width:1px" data-queue-item="' + esc(it.id) + '">';
      h += '<b>' + it.priority + '. ' + esc(it.title) + '</b> ' + mark + ' <span class="tag">' + esc(it.kind) + '</span>';
      h += '<p class="meta">' + esc(it.why) + '</p>';
      if (it.nextStep && it.nextStep.command) h += '<p class="meta">Next step: <code>' + esc(it.nextStep.command) + '</code></p>';
      if (it.nextStep && it.nextStep.instructions) h += '<p class="meta">' + esc(it.nextStep.instructions) + '</p>';
      h += '<p class="meta">Source: ' + esc(it.source && it.source.path) + (it.source && it.source.section ? ' · ' + esc(it.source.section) : '') + '</p>';
      h += '</div>';
    });
    return h;
  }
  function machineHealthHtml() {
    var a = agg.alerts;
    var nCrons = a && Array.isArray(a.crons) ? a.crons.length : null;
    var h = '<h2>Machine health — ' + (nCrons != null ? 'the ' + nCrons + ' scheduled jobs' : 'the scheduled jobs') + '</h2>';
    var freeze = agg.agents && agg.agents.freeze;
    if (freeze && freeze.status === 'ok') {
      h += '<p>' + (freeze.frozen ? statusMark('frozen') + ' since ' + esc(freeze.frozenAtSGT) + '. What it means: the site is locked on purpose; jobs run but change nothing live.' : statusMark('ok') + ' — the site is not frozen. What it means: jobs may change the live site.') + '</p>';
    } else {
      h += '<p>' + statusMark('warn') + ' — freeze state unknown. What it means: treat the site as locked until this is fixed.</p>';
    }
    if (!a || a.status === 'unavailable' || !Array.isArray(a.crons)) {
      return h + '<p class="unavail">⚠ Job status UNAVAILABLE — ' + esc(a && a.reason ? a.reason : 'alerts were not embedded in this build') + '. What it means: we cannot show if the jobs ran. Run <code>node scripts/founder.mjs status</code>.</p>';
    }
    h += '<div class="stages" role="group" aria-label="Scheduled jobs">';
    a.crons.forEach(function (c) {
      var mark = c.lastRunStatus === 'ok' ? statusMark('ok') : (c.lastRunStatus === 'error' ? statusMark('error') : statusMark('no-status'));
      h += '<button class="stage" data-cron="' + esc(c.key || c.id) + '" aria-pressed="' + (fstate.focusCron === (c.key || c.id)) + '">' + mark + '<br>' + esc(shortCronName(c)) + '</button>';
    });
    h += '</div>';
    var snap = a.snapshot || {};
    h += '<p class="meta">Job status is ' + (snap.ageHours == null ? 'of unknown age' : snap.ageHours + ' hours old') + (snap.stale ? ' (⚠ stale — more than 26h)' : '') + '. What it means: ' + (snap.stale ? 'a job may have failed without us seeing it; check the alerts inbox below.' : 'the job picture is recent.') + ' Click a job for detail.</p>';
    return h;
  }
  function alertsInboxHtml() {
    var h = '<h2>Alerts inbox — what the machine noticed</h2>';
    var a = agg.alerts;
    if (!a || a.status === 'unavailable') {
      return h + '<p class="unavail">⚠ UNAVAILABLE — ' + esc(a && a.reason ? a.reason : 'alerts were not embedded in this build') + '. What it means: silence here is NOT an all-clear. Run <code>node scripts/founder.mjs status</code>.</p>';
    }
    if (fstate.focusCron) {
      var c = (a.crons || []).filter(function (x) { return (x.key || x.id) === fstate.focusCron; })[0];
      if (c) {
        h += '<div class="banner" style="font-weight:400;border-width:1px" data-cron-detail="' + esc(fstate.focusCron) + '">';
        h += '<b>' + esc(c.name) + '</b> — ' + (c.lastRunStatus === 'ok' ? statusMark('ok') : (c.lastRunStatus === 'error' ? statusMark('error') : statusMark('no-status')));
        h += '<p class="meta">Schedule: ' + esc(c.schedule || 'unknown') + ' · next run: ' + esc(c.nextRunAt || 'unknown') + '</p>';
        h += '<p class="meta">Status source: ' + esc(c.statusSource) + ' · as of ' + esc(c.asOf || 'unknown') + '</p>';
        var mine = (a.missingReports || []).filter(function (m) { return m.cron === fstate.focusCron || m.cronId === c.id; });
        if (mine.length) {
          h += '<p class="meta">Expected reports (' + mine.length + '). What it means: each row is one day we checked for this job\\'s report.</p><table><thead><tr><th>Date</th><th>State</th><th>What it means</th></tr></thead><tbody>';
          mine.forEach(function (m) { h += '<tr><td>' + esc(m.date || '?') + '</td><td>' + esc(m.state) + '</td><td>' + esc(m.detail) + '</td></tr>'; });
          h += '</tbody></table>';
        } else {
          h += '<p class="meta">No missing-report entries for this job in the scan window. What it means: nothing to chase here.</p>';
        }
        h += '</div>';
      }
    }
    var items = a.items || [];
    if (!items.length) {
      h += '<p>✓ No alerts right now. What it means: nothing the machine saw needs attention — still check the job chips above for missing reports.</p>';
    } else {
      h += '<p class="meta">' + items.length + ' alert(s). What it means: read the high ones first.</p>';
      items.forEach(function (it) {
        var mark = it.severity === 'high' ? '<span style="color:#B91C1C">✗ high</span>' : (it.severity === 'medium' ? '<span style="color:#1B1917">⚠ medium</span>' : '<span style="color:#57534E">● ' + esc(it.severity) + '</span>');
        h += '<div data-alert-item="' + esc(it.id) + '"><p>' + mark + ' <b>' + esc(it.title) + '</b></p><p class="meta">' + esc(it.detail) + '</p><p class="meta">Source: ' + esc(it.source && it.source.path) + (it.source && it.source.section ? ' · ' + esc(it.source.section) : '') + '</p></div>';
      });
    }
    var mr = a.missingReports || [];
    var silence = mr.filter(function (m) { return m.state === 'expected-silence-under-freeze'; });
    if (silence.length) h += '<p class="meta">❄ ' + silence.length + ' expected-silence report(s) under freeze (blog/basket). What it means: these jobs stay quiet while the site is locked — UNVERIFIED, not an accusation.</p>';
    if (a.missingReportsScan && a.missingReportsScan.status === 'unavailable') h += '<p class="unavail">⚠ Cannot check expected reports — ' + esc(a.missingReportsScan.reason) + '. What it means: an honest gap, not an all-clear.</p>';
    var acts = a.founderActs || [];
    if (acts.length) {
      h += '<p class="meta">Recent founder acts (' + acts.length + '). What it means: things you did in the terminal, newest first.</p>';
      acts.forEach(function (act) { h += '<p class="meta" data-founder-act="' + esc(act.id || act.file) + '">' + esc(act.at || '?') + ' · ' + esc(act.verb) + (act.itemId ? ' · ' + esc(act.itemId) : '') + (act.verb === 'unfreeze' && !act.ackedAt ? ' · ⚠ acknowledge with the done command' : '') + '</p>'; });
    }
    return h;
  }
  function loopMark(state) {
    if (state === 'ok') return '<span style="color:#0F766E">✓ ok</span>';
    if (state === 'frozen-expected') return '<span style="color:#57534E">❄ frozen — expected</span>';
    if (state === 'static-proof') return '<span style="color:#57534E">◐ static proof</span>';
    if (state === 'not-built') return '<span style="color:#57534E">– not built</span>';
    return '<span style="color:#57534E">? unverified</span>';
  }
  function loopStripHtml() {
    var h = '<h2>The business loop — 7 stages at a glance</h2>';
    var lp = agg.loop;
    if (!lp || lp.status === 'unavailable' || !Array.isArray(lp.stages)) {
      return h + '<p class="unavail">⚠ UNAVAILABLE — ' + esc(lp && lp.reason ? lp.reason : 'the loop was not embedded in this build') + '. What it means: we cannot show the loop today. Run <code>node scripts/founder.mjs status</code>.</p>';
    }
    h += '<div class="stages" role="group" aria-label="Business loop stages">';
    lp.stages.forEach(function (s) {
      var num = typeof s.value === 'number' ? s.value : '–';
      h += '<button class="stage" data-loop="' + esc(s.id) + '" aria-pressed="' + (fstate.focusLoop === s.id) + '"><span class="n">' + num + '</span>' + esc(s.name) + '<br>' + loopMark(s.state) + '</button>';
    });
    h += '</div>';
    h += '<p class="meta">What it means: each chip is one stage of the business. ❄ frozen stages are paused on purpose — not broken. ◐ static proof is an old test result, never a live pass. Click a stage for its source and date.</p>';
    if (fstate.focusLoop) {
      var s = lp.stages.filter(function (x) { return x.id === fstate.focusLoop; })[0];
      if (s) {
        h += '<div class="banner" style="font-weight:400;border-width:1px" data-loop-detail="' + esc(s.id) + '">';
        h += '<b>' + esc(s.name) + ': ' + esc(s.label) + '</b> ' + loopMark(s.state);
        if (s.detail) h += '<p class="meta">' + esc(s.detail) + '</p>';
        h += '<p class="meta">Source: ' + esc(s.source) + ' · as of ' + esc(s.asOf || 'unknown') + (s.valueSource ? ' · number from ' + esc(s.valueSource) : '') + '</p>';
        h += '</div>';
      }
    }
    return h;
  }
  function condMark(st) {
    if (st === 'met') return '<span style="color:#0F766E">✓ met</span>';
    if (st === 'unmet') return '<span style="color:#1B1917">✗ not met yet</span>';
    if (st === 'insufficient-data') return '<span style="color:#57534E">– not enough history</span>';
    return '<span style="color:#57534E">? unverified</span>';
  }
  function weekRevenueHtml() {
    var h = '<h2>This week + revenue — one honest picture</h2>';
    var w = agg.weekly;
    if (!w || w.status === 'unavailable') {
      h += '<p class="unavail">⚠ Week rollup UNAVAILABLE — ' + esc(w && w.reason ? w.reason : 'not embedded in this build') + '. What it means: no weekly numbers today; run <code>node scripts/founder.mjs weekly</code>.</p>';
    } else {
      h += '<p class="meta">Window ' + esc(w.windowSGT.start) + ' → ' + esc(w.windowSGT.end) + ' (SGT). What it means: the last 7 days, Singapore time.</p>';
      var t = w.traffic || {};
      if (t.status === 'unavailable' || t.views == null) h += '<p class="unavail">⚠ Traffic UNAVAILABLE — ' + esc(t.reason || 'no snapshot') + '. What it means: visitor numbers are missing, not zero.</p>';
      else h += '<p><b>' + t.views + '</b> views · <b>' + t.visitors + '</b> visitors · ' + t.sessions + ' sessions. What it means: how many people came, and how often.</p><p class="meta">As of ' + esc(t.asOf || 'unknown') + ' · source ' + esc(t.source) + '</p>';
      var days = w.decisionsByDaySGT || [];
      h += '<table><thead><tr><th>Day (SGT)</th><th>Proposed</th><th>Published</th><th>Unverified</th><th>Rejected</th></tr></thead><tbody>';
      days.forEach(function (d) { h += '<tr><td>' + esc(d.dateSGT) + '</td><td>' + d.proposed + '</td><td>' + d.published + '</td><td>' + d.unverified + '</td><td>' + d.rejected + '</td></tr>'; });
      h += '</tbody></table>';
      h += '<p class="meta">What it means: proposed = machine ideas; published = went live after all checks; unverified = held back honestly; rejected = failed a check.</p>';
      var cov = w.coverage || {};
      h += '<p>Coverage: <b>' + (cov.rated == null ? '?' : cov.rated) + '/' + (cov.total == null ? '?' : cov.total) + '</b> products rated.' + (cov.deltaVsPriorArchive ? ' Change vs ' + esc(cov.deltaVsPriorArchive.vsArchiveDate) + ': ' + cov.deltaVsPriorArchive.ratedDelta + '.' : '') + ' What it means: how much of the shop has a health grade.</p>';
      var sy = w.sync || {};
      h += '<p class="meta">Last shop sync: ' + esc(sy.lastSyncedAtSGT || 'unknown') + ' · readback ' + esc(sy.readbackStatus == null ? 'unknown' : sy.readbackStatus) + (sy.status === 'unavailable' ? ' (UNAVAILABLE — ' + esc(sy.reason) + ')' : '') + '</p>';
      h += '<p class="meta">Reports produced: ' + (w.reportsProduced || []).length + '. What it means: files the machine wrote this week.</p>';
      var fc = w.forms && w.forms.count != null ? w.forms.count : null;
      h += '<p class="meta">Form submissions: ' + (fc == null ? 'UNAVAILABLE' : fc) + ' (count only — never emails here).</p>';
      if (w.historyNote) h += '<p class="meta">⚠ ' + esc(w.historyNote) + '. What it means: too little history for trends yet — honest baseline.</p>';
      h += '<p class="meta">Exceptions this week: ' + (w.exceptions || []).length + ' — see the alerts inbox above. Full export: run <code>node scripts/founder.mjs weekly</code> → <code>runs/reports/WEEKLY-' + esc(w.windowSGT.end) + '.md</code> (created by the Monday report job or on demand).</p>';
    }
    var r = agg.revenueReadiness;
    h += '<h3>Revenue readiness</h3>';
    if (!r || r.status === 'unavailable' || !Array.isArray(r.conditions)) {
      return h + '<p class="unavail">⚠ UNAVAILABLE — ' + esc(r && r.reason ? r.reason : 'not embedded in this build') + '. What it means: no revenue picture today.</p>';
    }
    h += '<p><b>NOT LIVE</b> — revenue is S$0 today, honestly. What it means: the affiliate build stays gated until the conditions below are met.</p>';
    var td = r.trafficDaily || {};
    if (td.status === 'ok') h += '<p class="meta">Traffic math: ' + td.totalVisitors + ' visitors over ' + td.rangeDays + ' days ≈ <b>' + td.perDay + '/day</b> (' + td.nonZeroDays + ' non-zero days). What it means: the bar is 50 visitors EVERY day for 14 days.</p>';
    else h += '<p class="meta">Traffic math UNAVAILABLE — ' + esc(td.reason || 'no snapshot') + '. What it means: not enough data to judge the traffic condition.</p>';
    h += '<table><thead><tr><th>Condition (D7)</th><th>State</th><th>What it means</th><th>Source</th></tr></thead><tbody>';
    r.conditions.forEach(function (cnd) {
      h += '<tr data-condition="' + esc(cnd.id) + '"><td>' + esc(cnd.label) + '</td><td>' + condMark(cnd.status) + '</td><td>' + esc(cnd.detail) + '</td><td class="meta">' + esc(cnd.source) + '</td></tr>';
    });
    h += '</tbody></table>';
    h += '<p class="meta">What it means: condition (a) has two ways to pass — steady traffic OR first Google clicks. No progress bar by design — the four conditions are the honest picture.</p>';
    return h;
  }
  function renderFounderPanels() {
    try { el('age-banner').innerHTML = ageBannerHtml(); } catch (e) { try { el('age-banner').innerHTML = '<div class="banner" role="alert">⚠ Age check failed — run node scripts/founder.mjs status.</div>'; } catch (e2) {} }
    try { el('needs-you').innerHTML = needsYouHtml(); } catch (e) { el('needs-you').innerHTML = '<h2>NEEDS YOU</h2><p class="unavail">⚠ UNAVAILABLE — ' + esc(e && e.message) + '</p>'; }
    try { el('machine-health').innerHTML = machineHealthHtml(); } catch (e) { el('machine-health').innerHTML = '<h2>Machine health</h2><p class="unavail">⚠ UNAVAILABLE — ' + esc(e && e.message) + '</p>'; }
    try { el('alerts-inbox').innerHTML = alertsInboxHtml(); } catch (e) { el('alerts-inbox').innerHTML = '<h2>Alerts inbox</h2><p class="unavail">⚠ UNAVAILABLE — ' + esc(e && e.message) + '</p>'; }
    try { el('loop-strip').innerHTML = loopStripHtml(); } catch (e) { el('loop-strip').innerHTML = '<h2>The business loop</h2><p class="unavail">⚠ UNAVAILABLE — ' + esc(e && e.message) + '</p>'; }
    try { el('week-revenue').innerHTML = weekRevenueHtml(); } catch (e) { el('week-revenue').innerHTML = '<h2>This week + revenue</h2><p class="unavail">⚠ UNAVAILABLE — ' + esc(e && e.message) + '</p>'; }
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    // m-2 (final fix): clicking a child span (number/status mark) inside a
    // chip must work — resolve to the nearest chip button. The DOM-stub
    // targets in tests are plain objects without closest → fall back to the
    // target itself (existing harness semantics unchanged).
    if (t && typeof t.closest === 'function') t = t.closest('[data-loop],[data-cron]');
    if (!t || !t.dataset) return;
    if (t.dataset.cron) {
      fstate.focusCron = fstate.focusCron === t.dataset.cron ? null : t.dataset.cron;
      renderFounderPanels();
      var inbox = el('alerts-inbox');
      if (inbox && typeof inbox.scrollIntoView === 'function') inbox.scrollIntoView();
    }
    if (t.dataset.loop) {
      fstate.focusLoop = fstate.focusLoop === t.dataset.loop ? null : t.dataset.loop;
      renderFounderPanels();
    }
  });
  renderFounderPanels();`;

export function renderDashboard(agg, arch) {
  // Honest Label restyle (slice 06, A2): CSS-only token restyle from the
  // COMMITTED canonical set (docs/design-tokens.md, read-only). Offline
  // Georgia (display) / Verdana (body) — the tokens' own fallbacks; NEVER
  // Google Fonts (F18 zero-external, v3.1 §E). Flat: no gradients/shadows/
  // blur; 2–3px ink rules; small status text = ink soft #57534E (AA on paper
  // and card); honest grey #6B7280 is defined but reserved for non-text use.
  // Existing markup/ids/text are byte-untouched; only CSS + new panels change.
  const css = `
:root{color-scheme:light;--paper:#F6F0E4;--card:#FFFDF8;--ink:#1B1917;--teal:#0F766E;--teal-deep:#0B5D57;--ink-soft:#57534E;--line:#D8CFBC;--paper-2:#EFE7D6;--teal-tint:#E3EEEC;--flag-red:#B91C1C;--flag-bg:#FBEAE9;--amber:#B45309;--amber-bg:#FBF3E4;--grey:#6B7280;--grade-a:#15803D;--grade-b:#65A30D;--grade-c:#CA8A04;--grade-d:#EA580C;--grade-e:#DC2626}
body{font-family:Verdana,sans-serif;background:var(--paper);color:var(--ink);margin:0;padding:24px 16px;max-width:1080px;margin-inline:auto;line-height:1.6;font-size:16px}
h1{font-family:Georgia,serif;font-size:1.9rem;font-weight:700;line-height:1.15;margin:0 0 8px}
h2{font-family:Georgia,serif;font-size:1.35rem;font-weight:700;margin-top:1.6em;border-bottom:3px solid var(--ink);padding-bottom:4px}
h3{font-family:Georgia,serif;font-size:1.05rem;font-weight:700;margin-top:1.2em}
.banner{border:2px solid var(--ink);background:var(--card);border-radius:10px;padding:8px 12px;font-weight:600;margin-bottom:12px}
.meta{font-size:.85rem;color:var(--ink-soft)}
.stages{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.stage{border:2px solid var(--ink);background:var(--card);color:var(--ink);border-radius:10px;padding:8px 12px;min-height:44px;cursor:pointer;font:inherit;text-align:left}
.stage:hover{background:var(--teal-tint)}
.stage:focus-visible{outline:3px solid var(--teal);outline-offset:2px}
.stage[aria-pressed="true"]{outline:3px solid var(--ink);font-weight:700;background:var(--teal-tint)}
.stage .n{display:block;font-family:Georgia,serif;font-size:1.25rem;font-weight:700}
.bar{height:10px;border:2px solid var(--ink);margin:2px 0 8px;background:var(--card)}.bar>span{display:block;height:100%;background:var(--teal)}
table{border-collapse:collapse;width:100%;font-size:.85rem;background:var(--card)}
td,th{border:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
th{border-bottom:2px solid var(--ink)}
input[type="search"]{font:inherit;padding:8px;width:min(420px,100%);margin:6px 0;border:2px solid var(--ink);border-radius:8px;background:var(--card);color:var(--ink);min-height:44px}
input[type="search"]:focus-visible{outline:3px solid var(--teal);outline-offset:2px}
.tag{border:1px solid var(--ink);border-radius:999px;padding:0 6px;font-size:.75rem;white-space:nowrap;color:var(--ink-soft);background:var(--paper-2)}
.unavail{font-weight:700;color:var(--ink)}
.arch{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.arch button{border:2px solid var(--ink);background:var(--card);color:var(--ink);border-radius:8px;padding:8px;min-height:44px;cursor:pointer;font:inherit}
.arch button:focus-visible{outline:3px solid var(--teal);outline-offset:2px}
.arch button[aria-pressed="true"]{outline:2px solid var(--ink);font-weight:700;background:var(--teal-tint)}
a{color:var(--teal)}
code{font-family:Courier New,monospace;background:var(--paper-2);border-radius:4px;padding:0 4px}
`;
  const app = `
(function () {
  var agg = window.__AGGREGATE__;
  var arch = window.__ARCHIVE__ || [];
  var state = { stage: 'all', q: '', archive: null };
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function rows() {
    var ds = (agg.funnel && agg.funnel.decisions) || [];
    var q = state.q.trim().toLowerCase();
    return ds.filter(function (d) {
      if (state.stage === 'guards' && !d.guardsPassed) return false;
      if (state.stage === 'consensus' && !d.consensus) return false;
      if (state.stage === 'published' && d.effective !== 'publish') return false;
      if (state.stage === 'overruled' && d.effective !== 'overruled') return false;
      if (state.stage === 'unverified' && d.outcome !== 'unverified') return false;
      if (state.stage === 'rejected' && d.outcome !== 'rejected') return false;
      if (q && ((d.ean || '') + ' ' + (d.name || '') + ' ' + d.id + ' ' + (d.kind || '')).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }
  function funnelHtml() {
    if (!agg.funnel || agg.funnel.status !== 'ok') return '<p class="unavail">Funnel UNAVAILABLE — ' + esc(agg.funnel && agg.funnel.reason) + '</p>';
    var c = agg.funnel.cumulative;
    var stages = [
      ['all', 'Proposed', c.proposed], ['guards', 'Guards passed', c.guardsPassed],
      ['consensus', 'Consensus', c.consensus], ['published', 'Published', c.published],
      ['overruled', 'Overruled', c.overruled], ['unverified', 'Unverified', c.outcomes.unverified],
      ['rejected', 'Rejected', c.outcomes.rejected]
    ];
    var h = '<div class="stages" role="group" aria-label="Funnel stages">';
    stages.forEach(function (s) {
      h += '<button class="stage" data-stage="' + s[0] + '" aria-pressed="' + (state.stage === s[0]) + '"><span class="n">' + s[2] + '</span>' + s[1] + '</button>';
    });
    h += '</div>';
    var max = c.proposed || 1;
    [['Guards', c.guardsPassed], ['Consensus', c.consensus], ['Published', c.published]].forEach(function (b) {
      h += '<div class="meta">' + b[0] + ' ' + b[1] + '/' + c.proposed + '</div><div class="bar"><span style="width:' + Math.round(b[1] / max * 100) + '%"></span></div>';
    });
    h += '<p class="meta">Last 24h: proposed ' + agg.funnel.last24h.proposed + ' · published ' + agg.funnel.last24h.published + ' · reconciliation ' + (agg.funnel.reconciliation.ok ? 'EXACT vs audit log (' + agg.funnel.reconciliation.checked + ' bindings)' : 'FAILED') + '</p>';
    return h;
  }
  function decisionsHtml() {
    var rs = rows();
    var h = '<p class="meta">' + rs.length + ' decision(s) · stage=' + esc(state.stage) + (state.q ? ' · search="' + esc(state.q) + '"' : '') + '</p>';
    var w = agg.funnel && agg.funnel.decisionsWindow;
    if (w && w.total > w.shown) {
      h += '<p class="meta" id="window-note">Showing last ' + w.shown + ' of ' + w.total + ' decisions — full record in the daily archive: <a href="../' + esc(agg.archive.file) + '">archive JSON (all ' + w.total + ')</a>. What it means: the funnel counts above cover ALL ' + w.total + ' decisions; this table and the search cover the last ' + w.shown + ' only.</p>';
    }
    h += '<table><thead><tr><th>Decision (SGT)</th><th>EAN / product</th><th>Kind</th><th>Outcome</th><th>Guards</th><th>Consensus</th><th>Reasons</th></tr></thead><tbody>';
    rs.forEach(function (d) {
      h += '<tr data-decision="' + esc(d.id) + '"><td>' + esc(d.atSGT) + '<br><span class="meta">' + esc(d.id) + '</span></td><td>' + esc(d.ean) + '<br>' + esc(d.name) + '</td><td>' + esc(d.kind) + (d.greyZone ? ' <span class="tag">grey</span>' : '') + '</td><td>' + esc(d.effective) + '</td><td>' + (d.guardsPassed ? 'pass' : 'FAIL') + '</td><td>' + (d.consensus ? 'yes' : 'no') + '</td><td>' + esc((d.reasons || []).join('; ')) + '</td></tr>';
    });
    h += '</tbody></table>';
    return h;
  }
  function sectionHtml(title, sec, bodyFn) {
    var h = '<h2>' + title + '</h2>';
    if (!sec || sec.status === 'unavailable') return h + '<p class="unavail">UNAVAILABLE — ' + esc(sec && sec.reason) + '</p><p class="meta">Source: ' + esc(sec && sec.source) + '</p>';
    if (sec.status === 'stale') h += '<p class="unavail">STALE snapshot — labelled honestly</p>';
    if (sec.status === 'partial') h += '<p class="unavail">PARTIAL — live snapshot unavailable, committed fallback labelled below</p>';
    h += bodyFn(sec);
    h += '<p class="meta">Source: ' + esc(sec.source || '') + '</p>';
    return h;
  }
  function sectionsHtml() {
    var h = '';
    h += sectionHtml('Coverage', agg.coverage, function (c) {
      var g = c.growth && c.growth.vsArchiveDate ? 'growth vs ' + c.growth.vsArchiveDate + ': rated ' + c.growth.ratedDelta + ', per-100g ' + c.growth.per100gDelta : (c.growth && c.growth.note) || '';
      return '<p>Rated <b>' + c.rated + '/' + c.total + '</b> (' + c.ratedPct + '%) · per-100g complete ' + c.per100g + '/' + c.total + ' · target ' + c.target.min + '–' + c.target.max + '</p><p class="meta">Grades: ' + esc(JSON.stringify(c.grades)) + ' · ' + esc(g) + '</p>';
    });
    h += sectionHtml('Sync health', agg.sync, function (s) {
      return '<p>Committed sync ' + esc(s.syncedAtSGT) + ' (SGT) · ' + s.entries + ' entries · app page /' + esc(s.appPage && s.appPage.slug) + ' readback HTTP ' + esc(s.appPage && s.appPage.readbackStatus) + '</p><p class="meta">Last plan: ' + esc(JSON.stringify(s.lastPlan && s.lastPlan.summary)) + '</p>';
    });
    h += sectionHtml('Traffic', agg.traffic, function (t) {
      var h2 = '<p>30-day: <b>' + t.totals.views + '</b> views · <b>' + t.totals.visitors + '</b> visitors · ' + t.totals.sessions + ' sessions · range ' + esc(t.range && t.range.start) + ' → ' + esc(t.range && t.range.end) + '</p>';
      if (t.today) h2 += '<p class="meta">Today (' + esc(t.today.date) + ' UTC so far): ' + t.today.views + ' views, ' + t.today.visitors + ' visitors · snapshot fetched ' + esc(t.fetchedAtSGT) + '</p>';
      h2 += '<table><thead><tr><th>Top page</th><th>Views</th><th>Visitors</th></tr></thead><tbody>';
      (t.topPages || []).forEach(function (p) { h2 += '<tr><td>' + esc(p.path) + '</td><td>' + p.views + '</td><td>' + p.visitors + '</td></tr>'; });
      h2 += '</tbody></table>';
      if (t.aiBots) h2 += '<p class="meta">AI bots: ' + t.aiBots.fetches + ' fetches (robots.txt) · AI referrals: ' + esc(t.aiReferrals && t.aiReferrals.sessions) + ' sessions</p>';
      return h2;
    });
    h += sectionHtml('Forms (visitor data — LOCAL-ONLY)', agg.forms, function (f) {
      var h2 = '<table><thead><tr><th>Form</th><th>Submissions</th><th>Detail</th></tr></thead><tbody>';
      f.forms.forEach(function (form) {
        var det = (form.docs || []).map(function (d) { return esc(JSON.stringify(d.answers || d)); }).join('<br>') || esc(form.note || 'none');
        h2 += '<tr><td>' + esc(form.title) + '</td><td>' + form.totalDocs + '</td><td>' + det + '</td></tr>';
      });
      h2 += '</tbody></table><p class="meta">' + esc(f.privacy) + '</p>';
      return h2;
    });
    h += sectionHtml('Agents / crons', agg.agents, function (a) {
      var h2 = '';
      if (a.crons.liveSnapshot) {
        h2 += '<p class="meta">Live Connector snapshot (orchestrator-refreshed ' + esc(a.crons.refreshedAt) + ')</p>';
        (a.crons.crons || []).forEach(function (c) { h2 += '<p>' + esc(c.name || c.id) + ' — enabled=' + esc(c.enabled) + ' · ' + esc(JSON.stringify(c.schedule || null)) + '</p>'; });
      } else {
        h2 += '<p class="unavail">Live Connector snapshot UNAVAILABLE — ' + esc(a.crons.reason) + '</p><p class="meta">Fallback: ' + esc(a.crons.committedEvidenceLabel) + '</p>';
        (a.crons.committedEvidence || []).forEach(function (e) { h2 += '<p class="meta">' + esc(e.file) + ': ' + esc(e.name || e.taskId) + ' ' + esc(JSON.stringify(e.schedule || null)) + ' enabled=' + esc(e.enabled) + '</p>'; });
      }
      if (a.freeze && a.freeze.status === 'ok') h2 += '<p>Freeze: ' + (a.freeze.frozen ? 'FROZEN since ' + esc(a.freeze.frozenAtSGT) + ' — ' + esc(a.freeze.reason) + ' (founder-only unfreeze)' : 'not frozen') + '</p>';
      if (a.realCronFireEvidence && a.realCronFireEvidence.length) h2 += '<p class="meta">Real cron fire evidence (F13): ' + a.realCronFireEvidence.map(esc).join(', ') + '</p>';
      return h2;
    });
    h += '<h2>Affiliate</h2><p class="unavail">NOT LIVE — post-P2 gated</p><p class="meta">' + esc(agg.affiliate.note) + '</p>';
    return h;
  }
  function archiveHtml() {
    var h = '<div class="arch" role="group" aria-label="Archive dates">';
    arch.forEach(function (a) {
      h += '<button data-archive="' + esc(a.date) + '" aria-pressed="' + (state.archive === a.date) + '">' + esc(a.date) + '</button>';
    });
    h += '</div>';
    if (state.archive) {
      var a = arch.filter(function (x) { return x.date === state.archive; })[0];
      if (a) {
        h += '<p class="meta">' + esc(a.date) + ': ' + (a.funnel ? 'proposed ' + a.funnel.proposed + ' · published ' + a.funnel.published : 'funnel n/a') + (a.coverage ? ' · rated ' + a.coverage.rated : '') + (a.degraded && a.degraded.length ? ' · degraded: ' + esc(a.degraded.join(', ')) : '') + ' · <a href="' + esc(a.href) + '">full aggregate JSON</a></p>';
      }
    } else {
      h += '<p class="meta">Select a date to view its archived summary; the full JSON opens locally. Retention: ' + agg.archive.retentionDays + ' days.</p>';
    }
    return h;
  }
  function render() {
    el('funnel').innerHTML = funnelHtml();
    el('decisions').innerHTML = decisionsHtml();
    el('sections').innerHTML = sectionsHtml();
    el('archive').innerHTML = archiveHtml();
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    // m-2 (final fix): same child-span resolution for funnel/archive chips.
    if (t && typeof t.closest === 'function') t = t.closest('[data-stage],[data-archive]');
    if (!t || !t.dataset) return;
    if (t.dataset.stage) { state.stage = t.dataset.stage; render(); }
    if (t.dataset.archive) { state.archive = state.archive === t.dataset.archive ? null : t.dataset.archive; render(); }
  });
  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (t && t.id === 'q') { state.q = t.value || ''; render(); }
  });
  ${FOUNDER_PANELS_JS}
  render();
})();
`;
  const f = agg.funnel;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>HealthHawk founder dashboard — ${esc(agg.digestDateSGT)} (SGT) — LOCAL-ONLY</title>
<style>${css}</style>
</head>
<body>
<div class="banner">LOCAL-ONLY DASHBOARD — may contain visitor emails (${esc(agg.dashboard.emailNote)}) and other form/visitor data. Never publish, upload, or copy under app/ or any public-bound path (F18).</div>
<div id="age-banner"></div>
<h1>HealthHawk founder dashboard — ${esc(agg.digestDateSGT)} (SGT)</h1>
<p class="meta" id="window-labels">Generated ${esc(agg.generatedAt)} (UTC) / ${esc(agg.generatedAtSGT)} (SGT) · Window (last ${agg.window.hours}h): UTC ${esc(agg.window.utc.start)} → ${esc(agg.window.utc.end)} · SGT ${esc(agg.window.sgt.start)} → ${esc(agg.window.sgt.end)} · ${esc(agg.window.note)}</p>
<p class="meta">Site: ${esc(agg.site)} · Aggregate: runs/p2-18/aggregate.json (same JSON feeds the digest report) · Partial-digest: ${agg.partial.degraded.length ? esc(agg.partial.degraded.join(', ')) : 'all sources ok'}</p>
<div id="needs-you"></div>
<div id="machine-health"></div>
<div id="alerts-inbox"></div>
<div id="loop-strip"></div>
<div id="week-revenue"></div>
<h2>Auto-gate funnel — click a stage to explore decisions</h2>
<div id="funnel"></div>
<label class="meta" for="q">Search decisions (EAN, product, id, kind)</label><br>
<input type="search" id="q" placeholder="e.g. 8888030315033">
<div id="decisions"></div>
<div id="sections"></div>
<h2>Daily archive (${agg.archive.retentionDays}-day retention)</h2>
<div id="archive"></div>
<p class="meta">Committed-state reads only — ${esc(agg.committedState.reads)}</p>
<script>window.__AGGREGATE__ = ${jsonEmbed(windowedEmbed(agg))}; window.__ARCHIVE__ = ${jsonEmbed(arch)};</script>
<script>${app}</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// F18 — the dashboard path/content must NEVER appear in public-bound
// directories or uploads: app/, port artifacts, publish plans/evidence.
// ---------------------------------------------------------------------------
const DASHBOARD_MARKERS = ['dashboard/index.html', 'dashboard/', 'runs/p2-18', '__AGGREGATE__', 'p2-18-digest'];
function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}
export function publicBoundViolations(root) {
  const targets = [];
  targets.push(...walk(resolve(root, 'app')));
  for (const d of ['runs/p2-06', 'runs/p2-merge-02', 'runs/p2-merge-03', 'runs/p2-merge-04']) {
    const dir = resolve(root, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.startsWith('port-artifact')) targets.push(join(dir, f));
      if (f.startsWith('release-plan-') && f.endsWith('.json')) targets.push(join(dir, f));
    }
    targets.push(...walk(join(dir, 'publish-evidence')));
  }
  const auditDir = resolve(root, AUDIT_DIR);
  if (existsSync(auditDir)) {
    for (const f of readdirSync(auditDir)) {
      if ((f.includes('publish-plan') || f.includes('publish-evidence')) && f.endsWith('.json')) targets.push(join(auditDir, f));
    }
  }
  for (const p of ['runs/p2-merge-02/publish-plans.json', 'runs/p2-merge-02/full-surface-plan.json']) {
    if (existsSync(resolve(root, p))) targets.push(resolve(root, p));
  }
  const violations = [];
  for (const p of targets) {
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    for (const m of DASHBOARD_MARKERS) {
      if (text.includes(m)) violations.push({ path: p.slice(root.length + 1), marker: m });
    }
  }
  const dash = resolve(root, 'dashboard');
  const app = resolve(root, 'app');
  if (dash === app || dash.startsWith(app + '/')) violations.push({ path: 'dashboard/', marker: 'dashboard directory under app/ (public-bound)' });
  return violations;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Atomic writes (slice 05 / v2.1 §C): temps ONLY under runs/p2-18/.tmp/
// (inside the pinned cron write scope), same-volume rename to targets.
// Stale temps are cleaned at build start. The pinned cron-time write set is
// {runs/p2-18/**, runs/reports/digest-*.md, dashboard/index.html} — the scope
// assertion below makes any out-of-scope target (or temp) fail loudly.
// ---------------------------------------------------------------------------
export const TMP_REL = join('runs', 'p2-18', '.tmp');
export function assertWriteScope(root, targetPath) {
  const rel = relative(resolve(root), resolve(targetPath)).split('\\').join('/');
  const inScope = rel.startsWith('runs/p2-18/') || /^runs\/reports\/digest-\d{4}-\d{2}-\d{2}\.md$/.test(rel) || rel === 'dashboard/index.html';
  if (!inScope) throw new Error(`write outside the pinned cron scope: ${rel}`);
  return rel;
}
export function tmpPathFor(root, targetPath) {
  const tmpDir = resolve(root, TMP_REL);
  const rel = relative(resolve(root), resolve(targetPath));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`atomic-write target outside root: ${targetPath}`);
  const p = join(tmpDir, rel.split(/[\\/]/).join('__') + `.tmp-${process.pid}`);
  if (!p.startsWith(tmpDir + sep)) throw new Error(`temp path escaped the pinned temp dir: ${p}`);
  return p;
}
export function cleanStaleTmp(root) {
  const dir = resolve(root, TMP_REL);
  if (!existsSync(dir)) return [];
  const removed = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try { if (statSync(p).isFile()) { unlinkSync(p); removed.push(f); } } catch { /* honest: leave unreadable entries */ }
  }
  return removed;
}
export function atomicWrite(root, targetPath, content) {
  assertWriteScope(root, targetPath);
  const tmp = tmpPathFor(root, targetPath);
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, content);
  renameSync(tmp, resolve(targetPath));
}

function writeAll(root, agg) {
  const runDir = resolve(root, 'runs', 'p2-18');
  mkdirSync(join(runDir, 'archive'), { recursive: true });
  cleanStaleTmp(root);
  atomicWrite(root, join(runDir, 'aggregate.json'), JSON.stringify(agg, null, 1) + '\n');
  atomicWrite(root, join(runDir, 'archive', `digest-${agg.digestDateSGT}.json`), JSON.stringify(agg, null, 1) + '\n');
  const pruned = pruneArchive(root, agg.generatedAt);
  mkdirSync(resolve(root, 'runs', 'reports'), { recursive: true });
  const reportPath = resolve(root, 'runs', 'reports', `digest-${agg.digestDateSGT}.md`);
  atomicWrite(root, reportPath, renderReport(agg));
  mkdirSync(resolve(root, 'dashboard'), { recursive: true });
  const dashPath = resolve(root, 'dashboard', 'index.html');
  atomicWrite(root, dashPath, renderDashboard(agg, archiveIndex(root)));
  return { reportPath, dashPath, pruned };
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const root = resolve(arg('--root') ?? ROOT);
  const now = arg('--now') ?? new Date().toISOString();
  if (cmd === 'build') {
    const agg = buildAggregate(root, { now });
    const { reportPath, dashPath, pruned } = writeAll(root, agg);
    const violations = publicBoundViolations(root);
    console.log(JSON.stringify({
      ok: true, digestDateSGT: agg.digestDateSGT, generatedAt: agg.generatedAt,
      funnel: agg.funnel.status === 'ok' ? agg.funnel.cumulative : { status: agg.funnel.status, reason: agg.funnel.reason },
      coverage: agg.coverage.status === 'ok' ? { rated: agg.coverage.rated, total: agg.coverage.total, per100g: agg.coverage.per100g } : { status: agg.coverage.status },
      partial: agg.partial.degraded,
      reconciliation: agg.funnel.reconciliation ? { ok: agg.funnel.reconciliation.ok, checked: agg.funnel.reconciliation.checked } : null,
      archivePruned: pruned.removed, f18Violations: violations,
      files: { aggregate: 'runs/p2-18/aggregate.json', archive: agg.archive.file, report: reportPath.slice(root.length + 1), dashboard: dashPath.slice(root.length + 1) },
    }, null, 2));
    if (violations.length) { console.error('F18 VIOLATION — dashboard markers found in public-bound paths'); process.exit(2); }
    if (agg.weekly && agg.weekly.status === 'unavailable' && /weekly PII guard/.test(String(agg.weekly.reason ?? ''))) { console.error('WEEKLY PII VIOLATION — counts-only contract breached (F18)'); process.exit(2); }
    return;
  }
  if (cmd === 'dashboard') {
    const agg = readJson(resolve(root, 'runs', 'p2-18', 'aggregate.json'));
    mkdirSync(resolve(root, 'dashboard'), { recursive: true });
    atomicWrite(root, resolve(root, 'dashboard', 'index.html'), renderDashboard(agg, archiveIndex(root)));
    console.log(JSON.stringify({ ok: true, dashboard: 'dashboard/index.html', from: 'runs/p2-18/aggregate.json' }));
    return;
  }
  if (cmd === 'prune') {
    console.log(JSON.stringify(pruneArchive(root, now), null, 2));
    return;
  }
  console.error('usage: p2-digest.mjs build|dashboard|prune [--root R] [--now ISO]');
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();