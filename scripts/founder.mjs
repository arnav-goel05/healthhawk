#!/usr/bin/env node
// HealthHawk Founder OS — founder CLI (Agent X owns; slices 01→02→03→04 add
// verbs SEQUENTIALLY to this same file).
//
// HARD RULE (v2.1 §J, binding): cron-pinned sessions must NEVER invoke
// founder.mjs — ANY verb, EXCEPT the Monday founder-report job's explicitly
// authorized derived-data verbs (status/refresh/weekly, addendum §B2); the
// digest cron's prohibition stands. status/weekly materialize paths outside
// the pinned cron write scope. Derived-data verbs are otherwise safe for
// founder / orchestrator / interactive-agent invocation ONLY.
//
// Slice 01 verbs: status. Slice 02 adds: done. Slice 03 adds: approve, reject,
// overrule, unfreeze. Slice 04 adds: weekly.
//   status — derived-data verb, NON-TTY BY DESIGN. Computes at read time from
//   committed state (works even if every cron is dead): queue + alerts +
//   freeze state + snapshot age + read-time missing-report scan + dashboard
//   path. Materializes runs/founder/queue.json. No network anywhere.
//   done <id> — DECISION VERB, TTY-required. Ticks a checklist item
//   (status:'done' + doneAt; all other fields/items preserved) or acknowledges
//   an act record (`done <actId>`). Unknown / expired / already-done ids are
//   refused honestly.
//   approve <id> / reject <id> --note — DECISION VERBS, TTY-required,
//   interactive y/n with the item summary shown first. Blog-draft and
//   structural pending items only. Writes a review per
//   pending/templates/approval-record.json with reviewer
//   "Arnav (founder CLI — local terminal, identity unverified)" (honest
//   provenance: TTY is not authentication). reject REQUIRES a non-empty note.
//   overrule <decisionId> --quote — PURE DELEGATION to the sanctioned gate CLI
//   (scripts/p2-gate.mjs overrule). NON-TTY ok (existing sanctioned path). No
//   new write path: the gate appends the audit record itself. Quote limit:
//   non-empty verbatim founder words (the gate's applyOverrule refuses empty
//   quotes; we pre-check honestly, the gate stays the enforcer).
//   unfreeze — DECISION VERB, TTY-required. MECHANICAL pre-unfreeze gate
//   (submission-review MAJOR-1): runs/founder/checklist.json item 'g4-rollout'
//   must be status:'done' BEFORE the challenge — missing/corrupt checklist,
//   absent item, or any other status → refuse (fail-closed, no override flag).
//   Then crypto.randomBytes challenge printed to the terminal and retyped
//   interactively. The challenge NEVER appears in argv, queue, dashboard,
//   logs, or act records (the act records "challenge passed" only). Fail-CLOSED
//   on missing/unparseable freeze-state; refuses frozen !== true; preserves ALL
//   freeze fields; sets frozen:false + unfrozenAt + actRef. NEVER run against
//   the real freeze file in tests.
//
//   weekly — DERIVED-DATA verb, NON-TTY BY DESIGN. Renders deriveWeekly (the
//   SAME object the dashboard panel embeds — one rollup source) into
//   runs/reports/WEEKLY-<SGT date>.md: SGT-bucketed decisions, traffic from
//   the latest snapshot, coverage delta, sync, reports produced, exceptions,
//   form COUNTS ONLY. Header carries the three entry points (status command,
//   dashboard path, manual path). Sparse history gets an honest note, never a
//   fabricated trend. PII guard: any email-like text in the rendered content
//   → exit≠0, nothing written.
//
//   refresh — DERIVED-DATA verb, NON-TTY BY DESIGN. Runs the digest build via
//   child process: node scripts/p2-digest.mjs build --root R --now ISO (the
//   digest's OWN pinned write scope does all writing; refresh itself writes
//   NOTHING). Child exit code propagated verbatim (0 ok · 2 F18/PII violation
//   · 1 usage). Respects the OPTIONAL runs/p2-18/.build-lock (design v2.1:
//   pid + stale timeout; p2-digest itself does not write it — orchestrator/
//   agent serialization convention): lock present and FRESH (<30m, by lock.at
//   or file mtime fallback; unparseable age = fail closed) → honest refusal,
//   child never spawned, never clobbers a running build. Stale lock (≥30m) →
//   proceed with an honest note; the lock file is never edited or deleted.
//   For founder / Monday-report-job use — the digest CRON still never invokes
//   founder.mjs (the prohibition above stands).
//
// TTY gate: INJECTABLE test seam — each decision verb's opts.isTTY defaults to
// the REAL process.stdin.isTTY && stdout.isTTY. argv can NEVER set it; there
// is NO runtime bypass flag — unknown flags are refused outright. Interactive
// answers use import-only seams (opts.answer / opts.challengeAnswer) that are
// likewise never parsed from argv and only reachable AFTER the TTY gate.
//
// Acts (append-only, runs/founder/acts/<UTCcompact>-<verb>.json):
//   {id, verb, itemId?, at, atSGT, note?}. The id is the filename stem.
//   ACK DESIGN (append-only): `done <actId>` NEVER edits the target act file.
//   It appends a NEW act record {id, verb:'done', itemId:<actId>, acks:<actId>,
//   at, atSGT, note?}. founder-queue.mjs merges ackedAt onto the target act at
//   READ time (earliest ack wins), so the pinned founderActs shape is
//   unchanged and the acts directory stays strictly append-only. The unfreeze
//   act is a high-priority inbox exception until acked via `done <actId>`.
//
// CLI write space: runs/founder/** (queue.json, checklist ticks, acts/),
// runs/reports/WEEKLY-*.md (weekly), pending blog-draft/structural review
// fields (founder act: status + review only, all other fields preserved),
// runs/freeze-state.json (unfreeze ONLY). Never data/, never
// pending/p2-audit/ (the gate owns that), never app/.
//
// Not implemented: nothing — the full contract §3 verb surface is present
// (the `refresh` gap was closed by orchestrator assignment, see
// docs/reports/fos-refresh-impl.md).
//
// Usage: node scripts/founder.mjs status [--root R] [--now ISO] [--json]
//        node scripts/founder.mjs done <id> [--note "..."]
//        node scripts/founder.mjs approve <id> [--note "..."]
//        node scripts/founder.mjs reject <id> --note "..."
//        node scripts/founder.mjs overrule <decisionId> --quote "..."
//        node scripts/founder.mjs unfreeze
//        node scripts/founder.mjs weekly [--root R] [--now ISO] [--json]
//        node scripts/founder.mjs refresh [--root R] [--now ISO]
//        (decision verbs require a REAL interactive terminal — never agent/cron)

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { deriveQueue, deriveAlerts, deriveMissingReports, deriveWeekly } from './founder-queue.mjs';
import { readAudit, reconcileFunnel, sgtDate, sgtLabel } from './p2-digest.mjs';
import { isExpired } from './founder-checklist-encode.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_PATH = 'dashboard/index.html';
const MANUAL_PATH = 'docs/FOUNDER-OS.md';

function readJsonSafe(root, rel) {
  try { return JSON.parse(readFileSync(resolve(root, rel), 'utf8')); } catch { return null; }
}

// Atomic-ish materialization: temp + rename, BOTH inside runs/founder/**.
function writeQueueFile(root, queue) {
  const dir = resolve(root, 'runs', 'founder');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'queue.json');
  const tmp = join(dir, `.queue.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(queue, null, 1) + '\n');
  try {
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  return 'runs/founder/queue.json';
}

function runStatus(root, now, opts) {
  const queue = deriveQueue(root, now);
  const alerts = deriveAlerts(root, now);
  const scan = deriveMissingReports(root, now);
  const freeze = readJsonSafe(root, 'runs/freeze-state.json');
  const audit = readAudit(root);
  const recon = reconcileFunnel(root, audit);
  const queueFile = writeQueueFile(root, queue);

  if (opts.json) {
    console.log(JSON.stringify({
      ok: true, at: now, queueFile, dashboard: DASHBOARD_PATH,
      freeze: freeze ? { frozen: freeze.frozen === true, frozenAt: freeze.frozenAt ?? null } : { frozen: null, reason: 'missing or unreadable — fail closed' },
      snapshot: alerts.snapshot,
      audit: { decisions: audit.decisions.length, overrules: audit.overrules.length, reconciliation: { ok: recon.ok, checked: recon.checked } },
      queue, alerts, missingReportsScan: scan,
    }, null, 2));
    return 0;
  }

  const L = [];
  L.push('HealthHawk — what needs you');
  L.push(`Read at ${now} (UTC) / ${sgtLabel(now)} (SGT). Computed live from committed files — no cron needed.`);
  L.push('');
  if (freeze && typeof freeze.frozen === 'boolean') {
    L.push(freeze.frozen
      ? `Freeze: ON since ${freeze.frozenAt ?? '?'} — live writes are blocked. Only you can turn it off.`
      : 'Freeze: OFF — live updates can run.');
  } else {
    L.push('Freeze: UNREADABLE — fail closed. Treat the site as frozen until the file is fixed.');
  }
  const snap = alerts.snapshot;
  L.push(snap.refreshedAt == null
    ? 'Job status snapshot: none on disk — job status comes from committed evidence only.'
    : `Job status snapshot: ${snap.ageHours}h old${snap.stale ? ' (STALE — may be out of date)' : ''}, refreshed ${snap.refreshedAt}.`);
  L.push(`Audit log: ${audit.decisions.length} decisions, ${audit.overrules.length} overrules — reconciliation ${recon.ok ? 'EXACT' : 'FAILED (numbers withheld until fixed)'}.`);
  L.push('');
  L.push(`NEEDS YOU (${queue.items.length} item${queue.items.length === 1 ? '' : 's'}, in priority order):`);
  if (!queue.items.length) L.push('  Nothing waits on you right now.');
  for (const it of queue.items) {
    const flags = [it.status !== 'open' ? it.status.toUpperCase() : null, it.stale ? 'STALE' : null].filter(Boolean).join(' · ');
    L.push(`  ${it.priority}. [${it.kind}${flags ? ` · ${flags}` : ''}] ${it.title}`);
    L.push(`     Why: ${it.why}`);
    if (it.nextStep?.command) L.push(`     Next: ${it.nextStep.command}`);
    if (it.nextStep?.instructions) L.push(`     How: ${it.nextStep.instructions}`);
    L.push(`     Source: ${it.source.path}${it.source.section ? ` (§${it.source.section})` : ''}`);
  }
  L.push('');
  L.push('MACHINE HEALTH (as of the snapshot above — not a live read):');
  for (const c of alerts.crons) {
    const word = c.lastRunStatus === 'ok' ? 'ok' : c.lastRunStatus === 'error' ? 'ERROR' : 'no status reported';
    L.push(`  - ${c.name}: ${word} (as of ${c.asOf ?? 'unknown'})`);
  }
  if (alerts.alertFiles.length) {
    L.push(`  Block alerts: ${alerts.alertFiles.length}`);
    for (const a of alerts.alertFiles) L.push(`    - ${a.path}: ${a.summary}`);
  }
  if (alerts.degraded.length) L.push(`  Degraded digest sections: ${alerts.degraded.join(', ')}`);
  if (alerts.items.length) {
    L.push(`  Alerts inbox (${alerts.items.length}):`);
    for (const a of alerts.items) L.push(`    - [${a.severity}] ${a.title} — ${a.detail} (source: ${a.source.path})`);
  } else {
    L.push('  Alerts inbox: empty.');
  }
  if (alerts.founderActs.length) {
    L.push(`  Your recent acts (last ${alerts.founderActs.length}):`);
    for (const a of alerts.founderActs) L.push(`    - ${a.verb ?? '?'} ${a.itemId ?? ''} at ${a.at ?? '?'}${a.verb === 'unfreeze' && !a.ackedAt ? ' — NOT acknowledged yet' : ''}`);
  }
  L.push('');
  L.push('EXPECTED REPORTS (read-time scan, past 14 days; schedules from runs/p2-20/cron-health.json):');
  if (scan.status !== 'ok') {
    L.push(`  UNAVAILABLE — ${scan.reason}. This is an honest gap, not an all-clear.`);
  } else {
    const counts = {};
    for (const e of scan.entries) counts[e.state] = (counts[e.state] ?? 0) + 1;
    L.push(`  ${scan.entries.length} expected fires checked: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none in window'}.`);
    for (const e of scan.entries) {
      if (e.state === 'present') continue;
      L.push(`  - ${e.cron} ${e.date ?? '?'}: ${e.state.toUpperCase()} — ${e.detail}`);
    }
    const silence = scan.entries.filter((e) => e.state === 'expected-silence-under-freeze');
    if (silence.length) L.push(`  (${silence.length} basket/blog fires are expected silence under freeze — unverified, not an alarm.)`);
  }
  L.push('');
  L.push(`Dashboard: ${DASHBOARD_PATH} (open locally; never upload — it holds visitor data).`);
  L.push(`Manual: ${MANUAL_PATH} · Queue file: ${queueFile} · One command: node scripts/founder.mjs status`);
  console.log(L.join('\n'));
  return 0;
}

// ---------------------------------------------------------------------------
// done (slice 02) — DECISION VERB. TTY-gated via an injectable seam; argv can
// never set isTTY and no bypass flag exists. Writes ONLY runs/founder/**.
// ---------------------------------------------------------------------------
const CHECKLIST_REL = 'runs/founder/checklist.json';
const ACTS_REL = 'runs/founder/acts';

function utcCompact(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

// Append-only act write: 'wx' flag + collision suffix — an existing act file
// is NEVER overwritten or edited.
function writeActRecord(root, now, act) {
  const dir = resolve(root, ACTS_REL);
  mkdirSync(dir, { recursive: true });
  const base = `${utcCompact(now)}-${act.verb}`;
  let stem = base;
  let n = 2;
  while (existsSync(join(dir, `${stem}.json`))) stem = `${base}-${n++}`;
  const file = join(ACTS_REL, `${stem}.json`);
  const record = { id: stem, ...act };
  writeFileSync(resolve(root, file), JSON.stringify(record, null, 1) + '\n', { flag: 'wx' });
  return { id: stem, file, record };
}

function readActs(root) {
  const dir = resolve(root, ACTS_REL);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    let json = null;
    try { json = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    if (json && typeof json === 'object') out.push({ json, file: join(ACTS_REL, f), stem: f.replace(/\.json$/, '') });
  }
  return out;
}

// Fail-CLOSED checklist read: absent = null (honest), corrupt/unknown schema
// = throw (never risk losing done ticks by acting on a file we cannot trust).
function readChecklistStrict(root) {
  const p = resolve(root, CHECKLIST_REL);
  if (!existsSync(p)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(p, 'utf8')); } catch {
    throw new Error(`${CHECKLIST_REL} is not valid JSON — refusing to act (fail closed; fix it deliberately)`);
  }
  if (!parsed || parsed.schema !== 'founder-checklist/1' || !Array.isArray(parsed.items)) {
    throw new Error(`${CHECKLIST_REL} has an unknown schema — refusing to act (fail closed)`);
  }
  return parsed;
}

function writeChecklistTick(root, checklist) {
  const dir = resolve(root, 'runs', 'founder');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'checklist.json');
  const tmp = join(dir, `.checklist.json.tmp-done-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(checklist, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function runDone(root, now, opts = {}) {
  // Injectable test seam ONLY. Default = the real terminal. main() passes the
  // real value explicitly; argv is never consulted for this.
  const isTTY = opts.isTTY === undefined
    ? Boolean(process.stdin.isTTY && process.stdout.isTTY)
    : opts.isTTY === true;
  if (!isTTY) {
    throw new Error('done is a decision verb — decision verbs need a real interactive terminal (TTY). Agents and scheduled jobs cannot act for the founder; no bypass flag exists.');
  }
  const id = opts.id;
  if (!id || typeof id !== 'string' || id.startsWith('--')) {
    throw new Error('usage: node scripts/founder.mjs done <id> [--note "..."] — id = a checklist item id or an act id');
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error(`invalid now timestamp: ${now}`);
  const note = typeof opts.note === 'string' && opts.note.trim() ? opts.note.trim() : null;

  // 1. Checklist item tick.
  const checklist = readChecklistStrict(root);
  const item = checklist ? checklist.items.find((i) => i && i.id === id) : null;
  if (item) {
    if (item.status === 'done') {
      throw new Error(`checklist item "${id}" is already done (doneAt ${item.doneAt ?? 'not recorded'}) — nothing to tick`);
    }
    if (isExpired(item, new Date(nowMs))) {
      throw new Error(`checklist item "${id}" expired at ${item.expiresWhen} — an expired item is refused honestly, never ticked; it stays visible as expired (ask for a re-encode if the deadline is wrong)`);
    }
    const act = writeActRecord(root, now, { verb: 'done', itemId: id, at: now, atSGT: sgtLabel(now), ...(note ? { note } : {}) });
    const updated = {
      ...checklist,
      items: checklist.items.map((i) => (i && i.id === id ? { ...i, status: 'done', doneAt: now, ...(note ? { note } : {}) } : i)),
    };
    try {
      writeChecklistTick(root, updated);
    } catch (e) {
      throw new Error(`act recorded (${act.file}) but the checklist tick FAILED: ${String(e.message ?? e)} — the act log is append-only; fix the checklist and re-run`);
    }
    console.log(`DONE: ${id} ticked at ${now} (UTC) / ${sgtLabel(now)} (SGT). Act: ${act.file}. Re-encoding the checklist preserves this tick.`);
    return 0;
  }

  // 2. Act acknowledgement (`done <actId>`) — append-only ack record; the
  // target act file is never edited. founder-queue merges ackedAt at read time.
  const acts = readActs(root);
  const target = acts.find((a) => (a.json.id ?? a.stem) === id);
  if (target) {
    if (target.json.acks) throw new Error(`"${id}" is itself an acknowledgement record — nothing to acknowledge`);
    const priorAck = acts.find((a) => a.json.acks === id && a.json.at != null);
    if (target.json.ackedAt || priorAck) {
      throw new Error(`act "${id}" was already acknowledged at ${target.json.ackedAt ?? priorAck.json.at} — nothing to do`);
    }
    const ack = writeActRecord(root, now, { verb: 'done', itemId: id, acks: id, at: now, atSGT: sgtLabel(now), ...(note ? { note } : {}) });
    console.log(`ACKNOWLEDGED: act ${id} (${target.json.verb ?? '?'}) at ${now} (UTC) / ${sgtLabel(now)} (SGT). Ack record: ${ack.file}. The original act file is untouched (append-only).`);
    return 0;
  }

  // 3. Unknown id — refuse honestly.
  throw new Error(`unknown id "${id}" — not a checklist item${checklist ? '' : ' (checklist not encoded yet)'} and not an act record. Run "node scripts/founder.mjs status" to see current ids.`);
}

// ---------------------------------------------------------------------------
// Slice 03 — decision verbs. Same injectable TTY seam as done; interactive
// answers use import-only seams (opts.answer / opts.challengeAnswer), never
// argv, only reachable AFTER the TTY gate.
// ---------------------------------------------------------------------------
const REVIEWER = 'Arnav (founder CLI — local terminal, identity unverified)';
const oneLine = (s, cap = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
};

function requireTTY(verb, opts) {
  const isTTY = opts.isTTY === undefined
    ? Boolean(process.stdin.isTTY && process.stdout.isTTY)
    : opts.isTTY === true;
  if (!isTTY) {
    throw new Error(`${verb} is a decision verb — decision verbs need a real interactive terminal (TTY). Agents and scheduled jobs cannot act for the founder; no bypass flag exists.`);
  }
}

// Import-only interactive seams. main() NEVER passes these from argv.
async function askYesNo(question, opts) {
  if (opts.answer !== undefined) return /^(y|yes)$/i.test(String(opts.answer).trim());
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^(y|yes)$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
}
async function askText(question, injected) {
  if (injected !== undefined) return String(injected).trim();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

// Reviewable = the pending items the queue surfaces: blog-draft (review:null)
// and structural (status pending + review:null). Same filename discipline as
// deriveQueue; anything else is refused honestly.
function findReviewable(root, id) {
  const dir = resolve(root, 'pending');
  if (!existsSync(dir)) return { item: null, rel: null };
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    const isBlog = /blog-draft/.test(f);
    const isStructural = /structural/.test(f);
    if (!isBlog && !isStructural) continue;
    let j = null;
    try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    if ((j.id ?? f.replace(/\.json$/, '')) !== id) continue;
    return { item: j, rel: join('pending', f), isBlog, isStructural };
  }
  return { item: null, rel: null };
}

// Founder-act write on a pending item: status + review ONLY, every other
// field preserved. Atomic temp+rename beside the target; temp cleaned on fail.
function writePendingReview(root, rel, updated) {
  const target = resolve(root, rel);
  const tmp = join(dirname(target), `.${basename(target)}.tmp-founder-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

async function runReviewVerb(verb, root, now, opts) {
  requireTTY(verb, opts);
  const id = opts.id;
  if (!id || typeof id !== 'string' || id.startsWith('--')) {
    throw new Error(`usage: node scripts/founder.mjs ${verb} <id>${verb === 'reject' ? ' --note "..."' : ' [--note "..."]'} — id = a pending blog-draft or structural item`);
  }
  if (!Number.isFinite(Date.parse(now))) throw new Error(`invalid now timestamp: ${now}`);
  const note = typeof opts.note === 'string' && opts.note.trim() ? opts.note.trim() : null;
  if (verb === 'reject' && !note) {
    throw new Error('reject requires --note — a rejection must record why (honest context, never empty)');
  }
  const found = findReviewable(root, id);
  if (!found.item) {
    throw new Error(`unknown id "${id}" — no reviewable blog-draft/structural item in pending/. Run "node scripts/founder.mjs status" to see ids.`);
  }
  const j = found.item;
  if (j.status === 'superseded') throw new Error(`item "${id}" is superseded — nothing to review`);
  // m-7 (final fix): status is checked for BLOG items too — a hand-edited blog
  // with status approved/rejected but review:null is still already-decided and
  // must never be re-reviewed (structural keeps its stricter pending-only rule).
  if (j.review != null || j.status === 'approved' || j.status === 'rejected' || (found.isStructural && j.status !== 'pending')) {
    throw new Error(`item "${id}" was already reviewed (${j.review?.decision ?? j.status} at ${j.review?.reviewedAt ?? '?'}) — a review record is never rewritten`);
  }
  const kindLabel = found.isBlog ? 'blog draft' : 'structural change';
  const L = [];
  L.push(`${verb.toUpperCase()} — ${kindLabel} ${id}`);
  L.push(`Summary: ${oneLine(j.summary ?? '(no summary)')}`);
  if (j.ean) L.push(`EAN: ${j.ean}`);
  if (j.evidence?.report) L.push(`Evidence report: ${j.evidence.report} — read it before deciding.`);
  L.push(`Proposed by: ${j.createdBy ?? '?'} (confidence ${j.confidence ?? '?'}) at ${j.createdAt ?? '?'}`);
  L.push(`Source: ${found.rel}`);
  if (note) L.push(`Your note: ${note}`);
  L.push('Provenance: reviewer will be recorded as "' + REVIEWER + '" — a terminal is not authentication.');
  console.log(L.join('\n'));
  const yes = await askYesNo(`${verb === 'approve' ? 'Approve' : 'Reject'} this item? [y/N] `, opts);
  if (!yes) {
    console.log('DECLINED — nothing written.');
    return 0;
  }
  const decision = verb === 'approve' ? 'approved' : 'rejected';
  const review = {
    itemId: id,
    decision,
    reviewer: REVIEWER,
    reviewedAt: now,
    notes: note ?? '',
    scope: `${verb} ${kindLabel} ${id}: ${oneLine(j.summary ?? '(no summary)')}`,
  };
  writePendingReview(root, found.rel, { ...j, status: decision, review });
  const act = writeActRecord(root, now, { verb, itemId: id, at: now, atSGT: sgtLabel(now), ...(note ? { note } : {}) });
  console.log(`${decision.toUpperCase()}: ${id} at ${now} (UTC) / ${sgtLabel(now)} (SGT). Review written to ${found.rel}; act: ${act.file}.`);
  return 0;
}

export async function runApprove(root, now, opts = {}) { return runReviewVerb('approve', root, now, opts); }
export async function runReject(root, now, opts = {}) { return runReviewVerb('reject', root, now, opts); }

// overrule — PURE delegation to the sanctioned gate CLI. NON-TTY ok (existing
// sanctioned path). NO new write path: the gate appends the overrule audit
// record itself (pending/p2-audit/); this verb writes nothing on its own.
// Quote non-emptiness limit: applyOverrule refuses empty/whitespace quotes;
// we pre-check honestly and the gate stays the enforcer. Verbatim founder
// words only — never fabricated.
export function runOverrule(root, now, opts = {}) {
  const id = opts.id;
  if (!id || typeof id !== 'string' || id.startsWith('--')) {
    throw new Error('usage: node scripts/founder.mjs overrule <decisionId> --quote "<your verbatim words>"');
  }
  const quote = opts.quote;
  if (typeof quote !== 'string' || quote.trim().length === 0) {
    throw new Error('overrule requires --quote with your verbatim words (non-empty after trim; the gate refuses empty quotes — never fabricated)');
  }
  const gate = join(ROOT, 'scripts', 'p2-gate.mjs');
  const res = spawnSync(process.execPath, [gate, 'overrule', '--decision', id, '--quote', quote, '--root', root], { encoding: 'utf8', timeout: 60000 });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.error) throw new Error(`gate delegation failed: ${res.error.message}`);
  return res.status ?? 1;
}

// unfreeze — TTY + MECHANICAL g4-rollout prerequisite + crypto-random retyped
// challenge. The challenge is printed to the terminal ONLY: never argv, never
// queue/dashboard/logs, never act records (the act records "challenge passed"
// only). Fail-CLOSED on an unreadable freeze-state; refuses frozen !== true;
// preserves ALL fields. The g4-rollout gate (submission-review MAJOR-1) runs
// BEFORE the challenge: while the G4 content-hash rollout is open, unfreeze is
// mechanically refused — no override flag exists.
const G4_REFUSAL_CITES = 'See runs/founder/checklist.json (item g4-rollout), docs/FOUNDER-OS.md §unfreeze, and docs/reports/fos-10-impl.md §5.3 (DEFERRED item 3 — approval-time stamping of review.evidenceContentHash).';
const G4_REFUSAL_HOW = 'To complete it: the orchestrator sequences the approval-writer stamping rollout (founder CLI approve + gate decision path) with a fixture proving a CLI-approved item binds; the founder then ticks it via "node scripts/founder.mjs done g4-rollout". Until then, changed evidence under an old approval could still auto-publish — unfreeze stays refused.';
export async function runUnfreeze(root, now, opts = {}) {
  requireTTY('unfreeze', opts);
  if (!Number.isFinite(Date.parse(now))) throw new Error(`invalid now timestamp: ${now}`);
  const p = resolve(root, 'runs', 'freeze-state.json');
  let freeze = null;
  if (existsSync(p)) {
    try { freeze = JSON.parse(readFileSync(p, 'utf8')); } catch { freeze = null; }
  }
  if (!freeze || typeof freeze.frozen !== 'boolean') {
    throw new Error('runs/freeze-state.json is missing or unparseable — fail CLOSED: refusing to unfreeze (repair the file deliberately first)');
  }
  if (freeze.frozen !== true) {
    throw new Error('freeze is not ON (frozen !== true) — nothing to unfreeze');
  }
  // MECHANICAL pre-unfreeze gate: g4-rollout must be ticked done. Fail-closed
  // on a missing/corrupt/unknown-schema checklist, an absent item, or any
  // status other than 'done' (the same status field runDone writes).
  let checklist = null;
  try { checklist = readChecklistStrict(root); }
  catch (e) {
    throw new Error(`g4-rollout prerequisite open — refusing to unfreeze: ${String(e.message ?? e)}. ${G4_REFUSAL_CITES} ${G4_REFUSAL_HOW}`);
  }
  const g4 = checklist ? checklist.items.find((i) => i && i.id === 'g4-rollout') : null;
  if (!checklist) {
    throw new Error(`g4-rollout prerequisite open — refusing to unfreeze: runs/founder/checklist.json is missing, so the G4 content-hash rollout cannot be verified as done (fail closed). ${G4_REFUSAL_CITES} ${G4_REFUSAL_HOW}`);
  }
  if (!g4) {
    throw new Error(`g4-rollout prerequisite open — refusing to unfreeze: checklist item "g4-rollout" is absent from runs/founder/checklist.json (fail closed). ${G4_REFUSAL_CITES} ${G4_REFUSAL_HOW}`);
  }
  if (g4.status !== 'done') {
    throw new Error(`g4-rollout prerequisite open — refusing to unfreeze: checklist item "g4-rollout" is "${g4.status ?? 'unknown'}", not "done". ${G4_REFUSAL_CITES} ${G4_REFUSAL_HOW}`);
  }
  const challenge = randomBytes(4).toString('hex');
  console.log('UNFREEZE — this resumes daily auto-publish before submission. Weigh the demo-stability trade-off (queue item / manual §unfreeze).');
  console.log(`Freeze ON since ${freeze.frozenAt ?? '?'}.`);
  console.log(`Confirmation code (type it back to confirm): ${challenge}`);
  const answer = await askText('Retype the code: ', opts.challengeAnswer);
  if (answer !== challenge) {
    throw new Error('wrong confirmation code — REFUSED, nothing written (the code is never stored; run unfreeze again for a fresh one)');
  }
  const act = writeActRecord(root, now, { verb: 'unfreeze', at: now, atSGT: sgtLabel(now), note: 'challenge passed' });
  const updated = { ...freeze, frozen: false, unfrozenAt: now, actRef: act.id };
  const tmp = resolve(root, 'runs', `.freeze-state.json.tmp-unfreeze-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, p);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw new Error(`act recorded (${act.file}) but the freeze write FAILED: ${String(err.message ?? err)} — freeze state unchanged; the act log is append-only`);
  }
  console.log(`UNFROZEN at ${now} (UTC) / ${sgtLabel(now)} (SGT). Act: ${act.file}. Acknowledge it with: node scripts/founder.mjs done ${act.id}`);
  return 0;
}

// ---------------------------------------------------------------------------
// weekly (slice 04) — DERIVED-DATA verb, non-TTY by design. ONE rollup source:
// the file renders exactly the deriveWeekly object the dashboard panel embeds
// (the full object is also embedded as a JSON block for machine equality).
// COUNTS ONLY; any email-like text in the rendered content → refuse, no write.
// ---------------------------------------------------------------------------
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function renderWeeklyMd(w) {
  const L = [];
  L.push('# HealthHawk — weekly founder report');
  L.push('');
  L.push(`Window: ${w.windowSGT.start} to ${w.windowSGT.end} (SGT days). Generated ${w.generatedAt} (UTC) / ${sgtLabel(w.generatedAt)} (SGT).`);
  L.push('Entry points: one command `node scripts/founder.mjs status` · dashboard `dashboard/index.html` (open locally — never upload) · manual `docs/FOUNDER-OS.md`.');
  L.push('Counts only — this file never carries emails or raw form answers.');
  L.push('');
  L.push('## Traffic (latest snapshot)');
  if (w.traffic && w.traffic.views != null) {
    L.push(`${w.traffic.views} views, ${w.traffic.visitors} visitors, ${w.traffic.sessions} sessions — as of ${w.traffic.asOf ?? 'unknown'}, source ${w.traffic.source}.`);
  } else {
    L.push(`UNAVAILABLE — ${w.traffic?.reason ?? 'no traffic snapshot'}. No number is invented.`);
  }
  L.push('');
  L.push('## Decisions by SGT day');
  L.push('| SGT day | Proposed | Published | Unverified | Rejected |');
  L.push('|---|---|---|---|---|');
  for (const d of w.decisionsByDaySGT) {
    L.push(`| ${d.dateSGT} | ${d.proposed} | ${d.published} | ${d.unverified} | ${d.rejected} |`);
  }
  L.push('Published counts exclude overruled publishes (the audit log is the only source).');
  L.push('');
  L.push('## Coverage');
  if (w.coverage.rated != null) {
    L.push(`${w.coverage.rated}/${w.coverage.total} products rated.`);
    L.push(w.coverage.deltaVsPriorArchive
      ? `Delta vs prior archive (${w.coverage.deltaVsPriorArchive.vsArchiveDate}): ${w.coverage.deltaVsPriorArchive.ratedDelta >= 0 ? '+' : ''}${w.coverage.deltaVsPriorArchive.ratedDelta} rated.`
      : 'Delta vs prior archive: none yet — no prior archive to compare (honest gap).');
  } else {
    L.push('UNAVAILABLE — no catalogue on disk. No number is invented.');
  }
  L.push('');
  L.push('## Sync');
  L.push(w.sync.lastSyncedAtSGT
    ? `Last sync: ${w.sync.lastSyncedAtSGT} (SGT); readback status ${w.sync.readbackStatus ?? 'unknown'}.`
    : `UNAVAILABLE — ${w.sync.reason ?? 'no sync state on disk'}.`);
  L.push('');
  L.push('## Reports produced in this window');
  if (w.reportsProduced.length) for (const r of w.reportsProduced) L.push(`- ${r}`);
  else L.push('No dated reports in this window.');
  L.push('');
  L.push('## Exceptions (alerts inbox, high/medium)');
  if (w.exceptions.length) {
    for (const e of w.exceptions) L.push(`- [${e.severity}] ${e.title} — ${e.detail} (source: ${e.source.path})`);
  } else {
    L.push('No exceptions this week.');
  }
  L.push('');
  L.push('## Forms');
  L.push(w.forms.count != null
    ? `Form submissions: ${w.forms.count} (COUNTS ONLY — never emails or answers).`
    : `UNAVAILABLE — ${w.forms.reason ?? 'no forms payload'}.`);
  if (w.historyNote) {
    L.push('');
    L.push(`History note: ${w.historyNote}. No trend is claimed from a sparse archive.`);
  }
  L.push('');
  L.push('## Machine-readable rollup');
  L.push('The same deriveWeekly object the dashboard panel embeds — one rollup source.');
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(w, null, 2));
  L.push('```');
  L.push('');
  return L.join('\n');
}

export function runWeekly(root, now, opts = {}) {
  const w = deriveWeekly(root, now);
  const md = renderWeeklyMd(w);
  if (EMAIL_RE.test(md)) {
    throw new Error('PII (email-like text) in the weekly rollup — refusing to write (counts only; fix the source evidence first)');
  }
  const date = sgtDate(now);
  const dir = resolve(root, 'runs', 'reports');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `WEEKLY-${date}.md`);
  const tmp = join(dir, `.WEEKLY-${date}.md.tmp-${process.pid}`);
  writeFileSync(tmp, md, 'utf8');
  try {
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  const rel = `runs/reports/WEEKLY-${date}.md`;
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, at: now, file: rel, weekly: w }, null, 2));
    return 0;
  }
  console.log(`WEEKLY written: ${rel} (window ${w.windowSGT.start} to ${w.windowSGT.end} SGT). Counts only. Entry points: node scripts/founder.mjs status · ${DASHBOARD_PATH} · ${MANUAL_PATH}.`);
  return 0;
}

// ---------------------------------------------------------------------------
// refresh (gap-fix, orchestrator-assigned) — DERIVED-DATA verb, non-TTY by
// design. PURE delegation to the digest build child process; refresh itself
// writes NOTHING (the digest's own pinned scope does all writing). Respects
// the optional runs/p2-18/.build-lock read-only (design v2.1: pid + stale
// timeout; p2-digest does not write it — serialization convention).
// ---------------------------------------------------------------------------
const BUILD_LOCK_REL = 'runs/p2-18/.build-lock';
const BUILD_LOCK_STALE_MS = 30 * 60 * 1000; // 30m: builds take seconds; generous

export function runRefresh(root, now, opts = {}) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error(`invalid now timestamp: ${now}`);
  const lockPath = resolve(root, BUILD_LOCK_REL);
  if (existsSync(lockPath)) {
    let lock = null;
    try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { lock = null; }
    let atMs = lock && typeof lock === 'object' ? Date.parse(lock.at ?? '') : NaN;
    if (!Number.isFinite(atMs)) {
      try { atMs = statSync(lockPath).mtimeMs; } catch { atMs = NaN; }
    }
    const ageMs = Number.isFinite(atMs) ? nowMs - atMs : null;
    // Fresh OR unknown age → fail closed: never clobber a running build.
    if (ageMs == null || ageMs < BUILD_LOCK_STALE_MS) {
      const pid = lock && typeof lock === 'object' && lock.pid != null ? ` (pid ${lock.pid})` : '';
      const ageLabel = ageMs == null ? 'age unknown' : `${Math.round(ageMs / 60000)}m old`;
      throw new Error(`a digest build appears to be running: ${BUILD_LOCK_REL} present${pid}, ${ageLabel} — refusing to clobber it (a lock is stale after 30m; retry then)`);
    }
    console.log(`NOTE: ${BUILD_LOCK_REL} is stale (${Math.round(ageMs / 60000)}m old, ≥30m) — proceeding; the lock file is left untouched.`);
  }
  const digest = join(ROOT, 'scripts', 'p2-digest.mjs');
  const spawn = opts.spawn ?? spawnSync; // import-only test seam, never argv
  const res = spawn(process.execPath, [digest, 'build', '--root', root, '--now', now], { encoding: 'utf8', timeout: 120000 });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.error) throw new Error(`digest build delegation failed: ${res.error.message}`);
  return res.status ?? 1;
}

// Verb registry — later slices add entries here (sequential, same file).
// tty:true marks decision verbs; status/weekly/refresh are non-TTY by design;
// overrule is non-TTY (pure delegation to the existing sanctioned gate path).
const VERBS = {
  status: { run: runStatus, tty: false, help: 'show the queue, alerts, freeze, snapshot age, and missing-report scan' },
  done: { run: runDone, tty: true, positional: true, help: 'tick a checklist item or acknowledge an act record (decision verb — real terminal only)' },
  approve: { run: runApprove, tty: true, positional: true, help: 'approve a pending blog/structural item after interactive y/n (decision verb — real terminal only)' },
  reject: { run: runReject, tty: true, positional: true, help: 'reject a pending blog/structural item with a required note (decision verb — real terminal only)' },
  overrule: { run: runOverrule, tty: false, positional: true, help: 'overrule an auto-decision with your verbatim quote (delegates to the sanctioned gate CLI)' },
  unfreeze: { run: runUnfreeze, tty: true, help: 'turn the freeze OFF after retyping a random code (decision verb — real terminal only; requires checklist g4-rollout done)' },
  weekly: { run: runWeekly, tty: false, help: 'write runs/reports/WEEKLY-<SGT date>.md from deriveWeekly (counts only; derived-data, any shell)' },
  refresh: { run: runRefresh, tty: false, help: 'rebuild the digest/dashboard via the pinned p2-digest build (derived-data, any shell; respects .build-lock)' },
};

function main() {
  const args = process.argv.slice(2);
  const verb = args[0];
  const entry = VERBS[verb];
  if (!entry) {
    console.error(`usage: node scripts/founder.mjs <verb> [--root R] [--now ISO] [--json]\nverbs: ${Object.keys(VERBS).join(', ')}`);
    process.exit(1);
  }
  const opts = { json: false };
  const positional = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--root' || a === '--now' || a === '--note' || a === '--quote') {
      const v = args[++i];
      if (v === undefined) { console.error(`REFUSED: ${a} needs a value`); process.exit(1); }
      opts[a.slice(2)] = v;
    } else if (a.startsWith('--')) {
      console.error(`REFUSED: unknown argument "${a}". No runtime bypass flags exist — decision verbs are gated on the real terminal only.`);
      process.exit(1);
    } else positional.push(a);
  }
  const root = resolve(opts.root ?? ROOT);
  const now = opts.now ?? new Date().toISOString();
  const realTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (entry.tty && !realTTY) {
    console.error(`REFUSED: ${verb} is a decision verb — decision verbs need a real interactive terminal (TTY). Agents and scheduled jobs cannot act for the founder.`);
    process.exit(1);
  }
  if (entry.tty) opts.isTTY = realTTY;
  if (entry.positional) opts.id = positional[0];
  if (positional.length > (entry.positional ? 1 : 0)) {
    console.error(`REFUSED: unexpected argument "${positional[entry.positional ? 1 : 0]}" — ${verb} takes ${entry.positional ? 'exactly one id' : 'no id'}`);
    process.exit(1);
  }
  try {
    const out = entry.run(root, now, opts);
    if (out && typeof out.then === 'function') {
      out.then(
        (code) => process.exit(code ?? 0),
        (e) => { console.error(`REFUSED: ${String(e.message ?? e)}`); process.exit(1); },
      );
    } else {
      process.exit(out ?? 0);
    }
  } catch (e) {
    console.error(`REFUSED: ${String(e.message ?? e)}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();