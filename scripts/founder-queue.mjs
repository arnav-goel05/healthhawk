// HealthHawk Founder OS — slice 01: the ONE pure derivation module.
// Contract: docs/design-founder-os/interface-contract.md §1 (+ addendum v2,
// designs v2/v2.1, v3/v3.1). Agent X owns this file; Y imports it; the CLI
// imports it. PURE: zero writes, zero network inside every derivation.
// Catalogue-size-agnostic: no hardcoded catalogue size anywhere.
// Every queue item is source-cited; nothing is invented; no PII.
// Honest states everywhere: present / admission-miss-evidenced /
// unverified-missing / expected-silence-under-freeze; frozen silence is
// never an alarm; expired checklist items render honestly, never vanish.
//
// Exports (binding signatures):
//   deriveQueue(root, now) · deriveAlerts(root, now) · deriveWeekly(root, now)
//   deriveRevenueReadiness(root, now) · deriveLoop(root, now)
//   EXPECTATION_TABLE · deriveMissingReports(root, now, days=14)

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { sgtDate, sgtLabel, readAudit, archiveIndex } from './p2-digest.mjs';

const SGT_OFFSET_MS = 8 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STALE_HOURS = 26;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// ---------------------------------------------------------------------------
// Read-only helpers. Every read is guarded: a missing/corrupt source yields an
// honest null, never a throw that kills a derivation and never a fabrication.
// ---------------------------------------------------------------------------
function readJsonSafe(root, rel) {
  const p = resolve(root, rel);
  if (!existsSync(p)) return { rel, json: null, reason: 'missing' };
  try { return { rel, json: JSON.parse(readFileSync(p, 'utf8')), reason: null }; }
  catch (e) { return { rel, json: null, reason: `unreadable: ${String(e.message ?? e)}` }; }
}
function listDir(root, rel) {
  const p = resolve(root, rel);
  if (!existsSync(p)) return [];
  try { return readdirSync(p).sort(); } catch { return []; }
}
function sha256File(root, rel) {
  try { return createHash('sha256').update(readFileSync(resolve(root, rel))).digest('hex'); }
  catch { return null; }
}
function mtimeIso(root, rel) {
  try { return statSync(resolve(root, rel)).mtime.toISOString(); } catch { return null; }
}
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
// cron-health timestamps carry human annotations, e.g.
// "2026-11-21T23:00:00.000Z (Nov 22 07:00 SGT)" — parse the leading ISO only.
const leadingIsoMs = (s) => (typeof s === 'string' ? ms(s.trim().split(/\s+/)[0]) : (typeof s === 'number' ? s : null));
const ageHours = (nowMs, atMs) => (atMs == null ? null : Math.round(((nowMs - atMs) / HOUR_MS) * 10) / 10);
const oneLine = (s, cap = 220) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
};
const wordCount = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).length;

// Latest agent-fetched input snapshot (same convention as p2-digest, read-only).
function latestInput(root, prefix) {
  const files = listDir(root, join('runs', 'p2-18', 'inputs')).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
  if (!files.length) return null;
  const file = files[files.length - 1];
  const r = readJsonSafe(root, join('runs', 'p2-18', 'inputs', file));
  return { file, rel: join('runs', 'p2-18', 'inputs', file), json: r.json, reason: r.reason };
}

// ---------------------------------------------------------------------------
// EXPECTATION_TABLE — ONE shared per-cron table (contract §1).
// Schedule source of record = runs/p2-20/cron-health.json (blog/basket
// schedules are null in cron-update-evidence.json — never use that file for
// schedules). reportPattern uses the SGT date. freezeBehavior:
//   'report-expected'              → refresh/reenrich/digest write a report
//                                    even under freeze; missing = alert.
//   'expected-silence-unverified'  → basket/blog under frozen:true: absence =
//                                    expected silence, UNVERIFIED, low
//                                    priority, never an accusation.
// registrationEvidence (additive field): committed file bounding when report
// expectations honestly start (never expect reports before registration).
// Final-fix MAJOR 2: the table covers ALL registered jobs — the 5 legacy
// crons PLUS the 2 Monday jobs (addendum §B1/B2). Submission-review MAJOR-2
// back-fill: scout + founder-report were REGISTERED 2026-11-23T04:16Z (Phase 3,
// runs/fos-08/registration-evidence.json); their real cron ids are now in the
// table and id-matching is live. Their registrationEvidence is the registration
// evidence file (carries registeredAt → the horizon never expects a report
// before registration; first scheduled fire Mon 2026-11-30 per cron-health
// nextRunAt). Both run read-only under freeze and still produce reports →
// freezeBehavior 'report-expected': a dead scout or report job is flagged
// admission-miss-evidenced / unverified-missing, never hidden behind the daily
// digest's fresh dashboard.
// Merge-review B M2 (2026-11-23): the 8th live job — blog knowledge-sync
// (49fe38f2, P3-side registration, daily 07:15 SGT) — is now covered too. It
// writes ONE daily state file (runs/blog-knowledge/state.json), not per-date
// report markdown, so it carries stateFile/stateField instead of reportPattern:
// deriveMissingReports verifies the LATEST expected fire against the state
// file's appliedAt (older fires are honestly unverifiable from a single state
// file and are never emitted as noise). It runs under freeze (read-only
// derivation + KB writes) → freezeBehavior 'report-expected'.
// ---------------------------------------------------------------------------
export const EXPECTATION_TABLE = Object.freeze([
  Object.freeze({ key: 'refresh', id: 'c5105f5a-0a7d-4745-afd2-73738759c537', name: 'HealthHawk daily 07:00 price refresh + publish-sync', scheduleSource: 'runs/p2-20/cron-health.json', reportPattern: 'refresh-<SGT date>.md', freezeBehavior: 'report-expected', registrationEvidence: 'runs/p2-06/cron-update-evidence.json' }),
  Object.freeze({ key: 'reenrich', id: 'f916b2bc-45c2-480e-83ef-66dbc708aa32', name: 'HealthHawk weekly OFF re-enrichment (Mon 08:00 SGT)', scheduleSource: 'runs/p2-20/cron-health.json', reportPattern: 'reenrich-<SGT date>.md', freezeBehavior: 'report-expected', registrationEvidence: 'runs/p2-17/cron-registration-evidence.json' }),
  Object.freeze({ key: 'digest', id: 'd11f3bfe-dfb6-41c5-92d6-da4abf6c862c', name: 'HealthHawk daily founder digest (07:30 SGT)', scheduleSource: 'runs/p2-20/cron-health.json', reportPattern: 'digest-<SGT date>.md', freezeBehavior: 'report-expected', registrationEvidence: 'runs/p2-18/cron-registration-evidence.json' }),
  Object.freeze({ key: 'blog', id: 'b352dbbf-3eb6-4e65-8cb4-a69c9deae7b8', name: 'HealthHawk weekly blog draft (Mon 09:00 SGT)', scheduleSource: 'runs/p2-20/cron-health.json', reportPattern: 'blog-draft-<SGT date>.md', freezeBehavior: 'expected-silence-unverified', registrationEvidence: null }),
  Object.freeze({ key: 'basket', id: '84694ef5-0888-4623-9207-fb6e39f63ecb', name: 'HealthHawk weekly healthiest-basket report (Sun 18:00 SGT)', scheduleSource: 'runs/p2-20/cron-health.json', reportPattern: 'basket-<SGT date>.md', freezeBehavior: 'expected-silence-unverified', registrationEvidence: null }),
  Object.freeze({ key: 'scout', id: '3d231a36-686c-4026-a77e-c2254596c76c', name: 'HealthHawk weekly market-scout aisle brief (Mon 08:30 SGT)', scheduleSource: 'runs/p2-20/cron-health.json', reportPattern: 'aisle-brief-<SGT date>.md', freezeBehavior: 'report-expected', registrationEvidence: 'runs/fos-08/registration-evidence.json' }),
  Object.freeze({ key: 'founder-report', id: '0f5115fe-216f-4605-9dab-9b50b0e95b86', name: 'HealthHawk Monday founder report (Mon 09:30 SGT)', scheduleSource: 'runs/p2-20/cron-health.json', reportPattern: 'WEEKLY-<SGT date>.md', freezeBehavior: 'report-expected', registrationEvidence: 'runs/fos-08/registration-evidence.json' }),
  Object.freeze({ key: 'knowledge-sync', id: '49fe38f2-dc38-436e-bd92-251bd5e432c4', name: 'HealthHawk blog knowledge sync (daily 07:15 SGT)', scheduleSource: 'runs/p2-20/cron-health.json', reportPattern: null, stateFile: 'runs/blog-knowledge/state.json', stateField: 'appliedAt', freezeBehavior: 'report-expected', registrationEvidence: 'runs/blog-knowledge/cron-registration-evidence.json' }),
]);

// Lookup discipline: all 8 entries carry registered cron ids (the 2 Monday
// ids back-filled at Phase-3 registration, 2026-11-23T04:16Z; knowledge-sync
// id from the P3-side registration, merge-review B M2) → id-matching is
// live. The EXACT-name fallback is kept for fixture roots that plant their own
// cron-health with fixture ids (never removed — tests rely on it).
function findReg(list, exp) {
  if (!Array.isArray(list)) return null;
  if (exp.id != null) {
    const byId = list.find((c) => c && c.id === exp.id);
    if (byId) return byId;
  }
  return list.find((c) => c && c.name === exp.name) ?? null;
}

// Parse "m h * * * Asia/Singapore" / "m h * * dow Asia/Singapore".
// Anything more complex → null (honest unverified, never a guessed schedule).
function parseSchedule(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().split(/\s+/);
  if (t.length < 5) return null;
  const minute = Number(t[0]), hour = Number(t[1]);
  if (!Number.isInteger(minute) || !Number.isInteger(hour) || minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  if (t[2] !== '*' || t[3] !== '*') return null;
  let dow = null;
  if (t[4] !== '*') { dow = Number(t[4]); if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null; }
  return { minute, hour, dow };
}

function freezeRead(root) {
  const r = readJsonSafe(root, 'runs/freeze-state.json');
  if (!r.json || typeof r.json.frozen !== 'boolean') return { known: false, frozen: null, reason: r.reason ?? 'frozen flag missing', at: null };
  return { known: true, frozen: r.json.frozen === true, reason: null, at: r.json.frozenAt ?? null };
}

// ---------------------------------------------------------------------------
// deriveMissingReports — read-time scan (used by deriveAlerts AND CLI status).
// Three honest states + expected-silence-under-freeze per EXPECTATION_TABLE.
// Works with every cron dead: it reads committed evidence + report filenames,
// never a live scheduler.
// ---------------------------------------------------------------------------
export function deriveMissingReports(root, now = new Date().toISOString(), days = 14) {
  const nowMs = ms(now);
  const scheduleSource = 'runs/p2-20/cron-health.json';
  const health = readJsonSafe(root, scheduleSource);
  if (!health.json || !Array.isArray(health.json.registered)) {
    return { status: 'unavailable', scheduleSource, days, reason: health.reason ?? 'cron-health snapshot has no registered list', entries: [] };
  }
  const freeze = freezeRead(root);
  const snapMs = ms(health.json.generatedAt);
  const snapAgeH = ageHours(nowMs, snapMs);
  const snapStale = snapAgeH == null || snapAgeH > STALE_HOURS;
  const ageLabel = snapAgeH == null ? 'snapshot age unknown' : `snapshot ${snapAgeH}h old${snapStale ? ' (stale)' : ''}`;
  const entries = [];
  for (const exp of EXPECTATION_TABLE) {
    const reg = findReg(health.json.registered, exp);
    if (!reg) {
      entries.push({ cron: exp.key, cronId: exp.id, date: null, state: 'unverified-missing', detail: 'cron not found in the cron-health snapshot — registration unverified', reportFile: null });
      continue;
    }
    const sched = parseSchedule(reg.schedule);
    if (!sched) {
      entries.push({ cron: exp.key, cronId: exp.id, date: null, state: 'unverified-missing', detail: `schedule unreadable in cron-health: ${String(reg.schedule)}`, reportFile: null });
      continue;
    }
    // Honest expectation horizon: never expect a report before the cron was
    // registered (committed evidence), or before its first scheduled fire
    // when the snapshot shows it had never run.
    let horizonMs = nowMs - days * DAY_MS;
    let horizonWhy = `scan window (${days} days)`;
    const regEv = exp.registrationEvidence ? readJsonSafe(root, exp.registrationEvidence) : null;
    const regAt = regEv && regEv.json ? leadingIsoMs(regEv.json.registeredAt ?? regEv.json.verifiedAt ?? null) : null;
    if (regAt != null) { horizonMs = Math.max(horizonMs, regAt); horizonWhy = `registered ${exp.registrationEvidence}`; }
    else if (reg.lastRunAt == null) {
      const first = leadingIsoMs(reg.nextRunAt);
      if (first != null) { horizonMs = Math.max(horizonMs, first); horizonWhy = 'first scheduled fire per cron-health nextRunAt'; }
    }
    if (exp.stateFile) {
      // State-file job (merge-review B M2): ONE daily state file, not per-date
      // reports. Only the LATEST expected fire is verifiable from it; older
      // fires are honestly unverifiable and never emitted as missing noise.
      const field = exp.stateField ?? 'appliedAt';
      let latest = null;
      for (let i = 0; i < days; i++) {
        const date = sgtDate(new Date(nowMs - i * DAY_MS).toISOString());
        const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
        if (sched.dow !== null && dow !== sched.dow) continue;
        const fireMs = Date.parse(`${date}T00:00:00Z`) + (sched.hour * 60 + sched.minute) * 60000 - SGT_OFFSET_MS;
        if (fireMs < nowMs && fireMs >= horizonMs) { latest = { date, fireMs }; break; }
      }
      if (!latest) continue; // no expected fire yet (pre-registration / before first fire)
      const st = readJsonSafe(root, exp.stateFile);
      const appliedMs = ms(st.json?.[field]);
      let state, detail;
      if (appliedMs != null && appliedMs >= latest.fireMs) {
        state = 'present';
        detail = `${exp.stateFile} ${field}=${st.json[field]} verifies the ${latest.date} fire (state-file job: the latest application is the verifiable record)`;
      } else if (admissionMissEvidence(health.json, reg, exp, latest.date)) {
        state = 'admission-miss-evidenced';
        detail = `${exp.stateFile} not fresh for the ${latest.date} fire; committed run-log evidence shows the fire was missed at admission (scheduler never spawned a session)`;
      } else {
        state = 'unverified-missing';
        detail = `${exp.stateFile} ${st.json ? `not fresh (${field}=${st.json[field] ?? 'missing'})` : 'missing'} for the ${latest.date} fire; ${ageLabel} — this fire is not verified by any committed evidence`;
      }
      entries.push({ cron: exp.key, cronId: exp.id, date: latest.date, state, detail, reportFile: exp.stateFile, horizonWhy });
      continue;
    }
    for (let i = days - 1; i >= 0; i--) {
      const date = sgtDate(new Date(nowMs - i * DAY_MS).toISOString());
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (sched.dow !== null && dow !== sched.dow) continue;
      const fireMs = Date.parse(`${date}T00:00:00Z`) + (sched.hour * 60 + sched.minute) * 60000 - SGT_OFFSET_MS;
      if (fireMs >= nowMs || fireMs < horizonMs) continue;
      const file = exp.reportPattern.replace('<SGT date>', date);
      const rel = join('runs', 'reports', file);
      let state, detail;
      if (existsSync(resolve(root, rel))) {
        state = 'present'; detail = `${rel} on disk`;
      } else if (exp.freezeBehavior === 'expected-silence-unverified' && freeze.known && freeze.frozen) {
        state = 'expected-silence-under-freeze';
        detail = 'expected silence under freeze — UNVERIFIED (no halt-report contract on disk); not an accusation';
      } else if (exp.freezeBehavior === 'expected-silence-unverified' && !freeze.known) {
        state = 'unverified-missing';
        detail = `no ${file}; freeze state unreadable — cannot confirm expected silence (${ageLabel})`;
      } else if (admissionMissEvidence(health.json, reg, exp, date)) {
        state = 'admission-miss-evidenced';
        detail = `no ${file}; committed run-log evidence shows the scheduled fire was missed at admission (scheduler never spawned a session)`;
      } else {
        state = 'unverified-missing';
        detail = `no ${file}; ${ageLabel} — this fire is not verified by any committed evidence`;
      }
      entries.push({ cron: exp.key, cronId: exp.id, date, state, detail, reportFile: rel, horizonWhy });
    }
  }
  return { status: 'ok', scheduleSource, days, snapshotAgeHours: snapAgeH, snapshotStale: snapStale, entries };
}

function admissionMissEvidence(health, reg, exp, dateSGT) {
  const cronId = exp.id ?? reg?.id ?? null;
  const entry = health.dailyRefreshErrorInvestigation?.runLogEntry;
  if (entry && cronId != null && entry.taskId === cronId && entry.status === 'error') {
    const at = leadingIsoMs(entry.runAt);
    if (at != null && sgtDate(new Date(at).toISOString()) === dateSGT) return true;
  }
  if (reg.lastRunStatus === 'error') {
    const at = leadingIsoMs(reg.lastRunAt);
    if (at != null && sgtDate(new Date(at).toISOString()) === dateSGT) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// deriveAlerts — the alerts inbox derivation (contract §1 shape).
// ---------------------------------------------------------------------------
function founderActs(root) {
  const dir = join('runs', 'founder', 'acts');
  const out = [];
  for (const f of listDir(root, dir)) {
    if (!f.endsWith('.json')) continue;
    const r = readJsonSafe(root, join(dir, f));
    if (r.json && typeof r.json === 'object') out.push({ ...r.json, file: join(dir, f) });
  }
  // Append-only acknowledgements (slice 02): `done <actId>` appends a NEW act
  // record {verb:'done', acks:<actId>, at, …} — the target act file is never
  // edited. Merge ackedAt onto the target at READ time (earliest ack wins) so
  // the pinned founderActs shape stays unchanged and acts stay append-only.
  const ackAt = new Map();
  for (const a of out) {
    if (typeof a.acks !== 'string' || !a.acks || a.at == null) continue;
    const prev = ackAt.get(a.acks);
    if (prev == null || String(a.at) < prev) ackAt.set(a.acks, String(a.at));
  }
  for (const a of out) {
    if (a.ackedAt != null || typeof a.acks === 'string') continue;
    const key = typeof a.id === 'string' && a.id ? a.id : basename(a.file).replace(/\.json$/, '');
    const at = ackAt.get(key);
    if (at != null) a.ackedAt = at;
  }
  out.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return out;
}

export function deriveAlerts(root, now = new Date().toISOString()) {
  const nowMs = ms(now);
  const health = readJsonSafe(root, 'runs/p2-20/cron-health.json');
  const liveSnap = readJsonSafe(root, join('runs', 'p2-18', 'inputs', 'crons-snapshot.json'));
  const refreshedAt = liveSnap.json?.refreshedAt ?? null;
  const snapAgeH = ageHours(nowMs, ms(refreshedAt));
  const stale = snapAgeH == null || snapAgeH > STALE_HOURS;
  const liveCrons = Array.isArray(liveSnap.json?.crons) ? liveSnap.json.crons : [];
  const regCrons = Array.isArray(health.json?.registered) ? health.json.registered : [];

  const crons = EXPECTATION_TABLE.map((exp) => {
    const reg = findReg(regCrons, exp);
    const live = findReg(liveCrons, exp);
    const rawStatus = live?.lastRunStatus ?? reg?.lastRunStatus ?? null;
    const lastRunStatus = rawStatus === 'ok' || rawStatus === 'error' ? rawStatus : 'no-status';
    const nextRunAt = live?.nextRunAt != null ? new Date(live.nextRunAt).toISOString() : (reg?.nextRunAt ?? null);
    return {
      id: reg?.id ?? exp.id ?? null, key: exp.key, name: exp.name, lastRunStatus,
      schedule: reg?.schedule ?? null, nextRunAt,
      statusSource: live?.lastRunStatus != null ? 'runs/p2-18/inputs/crons-snapshot.json' : (reg?.lastRunStatus != null ? 'runs/p2-20/cron-health.json' : 'no status reported'),
      asOf: live?.lastRunStatus != null ? refreshedAt : (health.json?.generatedAt ?? null),
    };
  });

  const alertFiles = [];
  for (const f of listDir(root, 'runs')) {
    if (!/^12-alert-.*\.json$/.test(f)) continue;
    const r = readJsonSafe(root, join('runs', f));
    const j = r.json ?? {};
    alertFiles.push({ path: join('runs', f), at: j.alertAt ?? j.blockedAt ?? null, summary: oneLine(`${j.alert ?? 'alert'}${j.store ? ` (${j.store})` : ''}${j.httpStatus ? ` HTTP ${j.httpStatus}` : ''}${j.reason ? `: ${j.reason}` : ''}`) });
  }

  const agg = readJsonSafe(root, join('runs', 'p2-18', 'aggregate.json'));
  const degraded = Array.isArray(agg.json?.partial?.degraded) ? [...agg.json.partial.degraded] : [];

  const scan = deriveMissingReports(root, now);
  const missingReports = scan.entries;
  const acts = founderActs(root);
  const founderActsLast10 = acts.slice(0, 10);

  const items = [];
  const push = (id, severity, title, detail, source, at = null) => items.push({ id, severity, title, detail, source, at });

  const freeze = freezeRead(root);
  if (!freeze.known) push('freeze-unreadable', 'high', 'Freeze state unreadable', `runs/freeze-state.json is ${freeze.reason}. Fail closed: treat the site as frozen until this is fixed.`, { path: 'runs/freeze-state.json' });

  for (const a of alertFiles) push(`alertfile-${a.path}`, 'high', 'A live fetch was blocked', a.summary, { path: a.path }, a.at);
  const staleState = readJsonSafe(root, join('runs', 'stale-state.json'));
  if (staleState.json?.stale === true) push('stale-state-active', 'high', 'Live data is marked stale', oneLine(`Blocked at ${staleState.json.blockedAt ?? '?'} (${staleState.json.store ?? 'store'}): ${staleState.json.reason ?? 'no reason recorded'}`), { path: 'runs/stale-state.json' }, staleState.json.blockedAt ?? null);

  for (const c of crons) {
    if (c.lastRunStatus === 'error') push(`cron-error-${c.key}`, 'medium', 'A scheduled job reported an error', `${c.name}: last run status "error" (as of ${c.asOf ?? 'unknown'}). Under freeze a missed fire changes nothing live, but the schedule needs a check.`, { path: c.statusSource.startsWith('runs/') ? c.statusSource : 'runs/p2-20/cron-health.json', section: c.name }, c.asOf);
  }
  if (stale) push('snapshot-stale', 'medium', 'Job status snapshot is old', refreshedAt == null ? 'No live cron snapshot on disk — job status comes from committed evidence only and may be out of date.' : `The cron snapshot is ${snapAgeH}h old (more than ${STALE_HOURS}h). Job status may be out of date; run a refresh or ask the orchestrator to re-read the scheduler.`, { path: 'runs/p2-18/inputs/crons-snapshot.json' }, refreshedAt);

  // Missing reports: group per cron so 14 missing days never become 14 items.
  const byCron = new Map();
  for (const m of missingReports) {
    if (m.state === 'present' || m.state === 'expected-silence-under-freeze') continue;
    if (!byCron.has(m.cron)) byCron.set(m.cron, []);
    byCron.get(m.cron).push(m);
  }
  for (const [key, list] of byCron) {
    const exp = EXPECTATION_TABLE.find((e) => e.key === key);
    const dates = list.map((m) => m.date).filter(Boolean).join(', ');
    const anyAdmission = list.some((m) => m.state === 'admission-miss-evidenced');
    // Pre-registration entries carry date:null — no fire was expected yet;
    // say "registration unverified", never "a fire was missed".
    const detail = list.every((m) => m.date == null)
      ? `${exp?.name ?? key}: registration unverified — the cron is not in the cron-health snapshot, so no report expectation can be verified yet. State: unverified-missing.`
      : `${exp?.name ?? key}: ${exp?.stateFile ? 'no fresh state file' : 'no report'} for ${dates || 'an expected fire'}. ${anyAdmission ? 'At least one fire is evidenced as missed at admission.' : 'No committed evidence verifies these fires.'} State: ${anyAdmission ? 'admission-miss-evidenced' : 'unverified-missing'}.`;
    push(`missing-reports-${key}`, 'medium', 'Expected job reports are missing', detail, { path: 'runs/p2-20/cron-health.json', section: `missing: ${list.map((m) => m.reportFile).filter(Boolean).join(', ')}` });
  }
  if (scan.status === 'unavailable') push('missing-scan-unavailable', 'medium', 'Cannot check expected reports', `The cron-health snapshot is ${scan.reason}. Missing-report detection is unavailable — honest gap, not an all-clear.`, { path: 'runs/p2-20/cron-health.json' });

  for (const d of degraded) push(`degraded-${d}`, 'medium', 'A digest section is degraded', `The last digest labelled "${d}" — that section was unavailable, partial, or stale at build time.`, { path: 'runs/p2-18/aggregate.json', section: 'partial.degraded' });
  if (!agg.json) push('aggregate-missing', 'medium', 'No digest aggregate on disk', `runs/p2-18/aggregate.json is ${agg.reason}. The dashboard may be old or never built.`, { path: 'runs/p2-18/aggregate.json' });

  for (const act of acts) {
    if (act.verb === 'unfreeze' && !act.ackedAt) push(`unfreeze-act-${act.id ?? act.file}`, 'high', 'Unfreeze happened — acknowledge it', `An unfreeze act was recorded at ${act.at ?? '?'}. It stays high-priority until you acknowledge it with "node scripts/founder.mjs done <actId>".`, { path: act.file }, act.at ?? null);
  }

  return {
    schema: 'founder-alerts/1',
    generatedAt: now,
    snapshot: { refreshedAt, ageHours: snapAgeH, stale, source: 'runs/p2-18/inputs/crons-snapshot.json' },
    crons, alertFiles, degraded, missingReports,
    missingReportsScan: { status: scan.status, reason: scan.reason ?? null, scheduleSource: scan.scheduleSource },
    founderActs: founderActsLast10,
    items,
  };
}

// ---------------------------------------------------------------------------
// QueueItem validation — planted-error discipline. A bad item throws loudly;
// it is never silently emitted. Rules:
//  - id/title/why present; title ≤8 words; why one line; no PII anywhere.
//  - source.path non-empty. For unfreeze/blog/structural/affiliate the cited
//    file MUST exist (wrong source → throw). Exception items are machine
//    observations about possibly-absent files; they cite the evidence path
//    that was read (or found absent) — non-empty citation required, existence
//    not enforced (the absence IS the observation).
//  - checklist items with a missing source file render stale, never vanish.
// ---------------------------------------------------------------------------
function validateItem(root, item) {
  const fail = (msg) => { throw new Error(`founder-queue: invalid item ${item?.id ?? '(no id)'}: ${msg}`); };
  if (!item.id || typeof item.id !== 'string') fail('missing id');
  // Checklist titles are Z-encoded (contract §2) and surfaced VERBATIM — never
  // truncated or rewritten here. Over-length titles carry titleOver8:true and
  // are flagged in the impl report for orchestrator/Z resolution. All
  // module-generated titles are machine-held to ≤8 words.
  if (!item.title || (item.kind !== 'checklist' && wordCount(item.title) > 8)) fail('title must be plain English, 1–8 words');
  if (!item.why || /[\r\n]/.test(item.why)) fail('why must be one line');
  if (!['unfreeze', 'blog', 'structural', 'checklist', 'affiliate', 'exception'].includes(item.kind)) fail(`unknown kind ${item.kind}`);
  if (!['open', 'done', 'expired'].includes(item.status)) fail(`unknown status ${item.status}`);
  if (!item.source || typeof item.source.path !== 'string' || !item.source.path.trim()) fail('missing source citation');
  for (const v of [item.title, item.why, item.nextStep?.command, item.nextStep?.instructions]) {
    if (typeof v === 'string' && EMAIL_RE.test(v)) fail('PII (email-like text) in a queue item');
  }
  if (!['exception', 'checklist'].includes(item.kind) && !existsSync(resolve(root, item.source.path))) fail(`cited source does not exist: ${item.source.path}`);
  if (!Number.isInteger(item.priority) || item.priority < 1) fail('priority must be a positive integer');
}

function checklistItems(root, nowMs) {
  const r = readJsonSafe(root, join('runs', 'founder', 'checklist.json'));
  if (!r.json) return { status: r.reason === 'missing' ? 'absent' : 'unreadable', reason: r.reason, items: [] };
  if (!Array.isArray(r.json.items)) return { status: 'unreadable', reason: 'checklist has no items array', items: [] };
  const out = [];
  for (const it of r.json.items) {
    if (!it || typeof it !== 'object') continue;
    if (it.status === 'done') continue; // ticked = cleared; never nags again
    if (!it.source || typeof it.source.path !== 'string' || !it.source.path.trim()) {
      throw new Error(`founder-queue: checklist item ${it.id ?? '(no id)'} has no source citation — refusing to surface an uncited item`);
    }
    const currentSha = sha256File(root, it.source.path);
    const currentMtime = mtimeIso(root, it.source.path);
    const hashMismatch = currentSha == null || (it.source.sha256 != null && currentSha !== it.source.sha256);
    const stale = hashMismatch;
    const staleReason = currentSha == null ? 'source file missing' : (hashMismatch ? 'source content changed since encoding (sha256 mismatch)' : null);
    const mtimeChanged = it.source.mtime != null && currentMtime != null && it.source.mtime !== currentMtime;
    const expired = it.expiresWhen != null && ms(it.expiresWhen) != null && nowMs > ms(it.expiresWhen);
    const whyParts = [];
    if (stale) whyParts.push('CHECKLIST POSSIBLY STALE — source changed since encoding.');
    if (expired) whyParts.push(`Expired ${it.expiresWhen} — still shown honestly; tick it or ask for a re-encode.`);
    whyParts.push(oneLine(it.why ?? ''));
    out.push({
      id: it.id, kind: 'checklist', title: oneLine(it.title ?? it.id, 80),
      titleOver8: wordCount(it.title ?? it.id) > 8,
      why: whyParts.join(' '),
      nextStep: { command: it.command ?? `node scripts/founder.mjs done ${it.id}`, instructions: it.steps ? oneLine(it.steps) : undefined },
      source: { path: it.source.path, section: it.source.section, sha256: it.source.sha256 ?? null, mtime: it.source.mtime ?? null },
      status: expired ? 'expired' : 'open',
      expiresWhen: it.expiresWhen ?? null,
      stale, staleReason, mtimeChanged,
      createdAt: it.createdAt ?? null,
      optional: it.optional === true,
    });
  }
  return { status: 'ok', reason: null, items: out };
}

// ---------------------------------------------------------------------------
// deriveQueue — priority-ordered, source-cited "Needs you" (contract §1).
// ---------------------------------------------------------------------------
export function deriveQueue(root, now = new Date().toISOString()) {
  const nowMs = ms(now);
  const freeze = freezeRead(root);
  const alerts = deriveAlerts(root, now);
  const revenue = deriveRevenueReadiness(root, now);
  const ranked = [];
  const add = (rank, item) => ranked.push({ rank, item });

  // 1. Freeze → priority-1 unfreeze item while frozen (demo-stability trade-off
  //    verbatim in why; NEVER any passphrase or challenge text).
  if (freeze.known && freeze.frozen) {
    add(0, {
      id: 'unfreeze', kind: 'unfreeze', title: 'Decide when to go live',
      why: 'Unfreezing resumes daily auto-publish before submission — consider unfreezing after the demo unless you want live price updates during judging.',
      nextStep: { command: 'node scripts/founder.mjs unfreeze', instructions: 'Terminal-only. Complete the G4 content-hash rollout first (checklist g4-rollout). See docs/FOUNDER-OS.md §unfreeze; you retype a random code shown on screen.' },
      source: { path: 'runs/freeze-state.json' }, status: 'open',
    });
  } else if (!freeze.known) {
    add(0, {
      id: 'freeze-unreadable', kind: 'exception', title: 'Fix unreadable freeze state',
      why: `runs/freeze-state.json is ${freeze.reason}. Fail closed: nothing goes live until this is readable again.`,
      nextStep: { instructions: 'Check the file by hand; ask the orchestrator to repair it. Do not guess the freeze state.' },
      source: { path: 'runs/freeze-state.json' }, status: 'open',
    });
  }

  // 2. Pending blog drafts (review:null) and structural decisions.
  for (const f of listDir(root, 'pending')) {
    if (!f.endsWith('.json')) continue;
    const isBlog = /blog-draft/.test(f);
    const isStructural = /structural/.test(f);
    if (!isBlog && !isStructural) continue;
    const r = readJsonSafe(root, join('pending', f));
    if (!r.json) continue;
    const j = r.json;
    if (j.status === 'superseded') continue; // aisle-brief de-dup (slice 07)
    if (isBlog) {
      // m-7 consistency: a decided status (even with review:null, hand-edited)
      // never re-surfaces for review — same rule the CLI review verb enforces.
      if (j.review != null || j.status === 'approved' || j.status === 'rejected') continue;
      add(3, {
        id: j.id ?? f.replace(/\.json$/, ''), kind: 'blog', title: 'Review this blog draft',
        why: oneLine(j.summary ?? 'A blog draft waits for your editorial review.'),
        nextStep: { command: `node scripts/founder.mjs approve ${j.id ?? f.replace(/\.json$/, '')}`, instructions: 'Read the draft first; approve only if you are happy. Reject with a note if not.' },
        source: { path: join('pending', f) }, status: 'open', createdAt: j.createdAt ?? null,
      });
    } else if (isStructural) {
      if (!(j.status === 'pending' && j.review == null)) continue;
      const isBrief = /aisle-brief/.test(f) || /aisle-brief/.test(String(j.evidence?.report ?? ''));
      add(3, {
        id: j.id ?? f.replace(/\.json$/, ''), kind: 'structural',
        title: isBrief ? 'Pick the next aisle' : 'Rule on a structural change',
        why: oneLine(j.summary ?? 'A structural change waits for your decision.'),
        nextStep: { command: `node scripts/founder.mjs approve ${j.id ?? f.replace(/\.json$/, '')}`, instructions: isBrief ? 'Read the aisle brief, then pick one aisle or say no change.' : 'Read the evidence, then approve or reject with a note.' },
        source: { path: join('pending', f), section: j.evidence?.report ? String(j.evidence.report) : undefined }, status: 'open', createdAt: j.createdAt ?? null,
      });
    }
  }

  // 3. Checklist (open items; stale + expired render honestly).
  const checklist = checklistItems(root, nowMs);
  for (const it of checklist.items) add(it.status === 'expired' ? 5 : 4, it);

  // 4. Affiliate — low-priority tickable visibility line, ONLY when the
  //    checklist has no affiliate-signup item (dedup: founder cleanup
  //    2026-11-23) OR when ALL four D7 conditions are met (the raised
  //    "build can start" signal is distinct from the signup tick).
  const d7 = revenue.conditions;
  const cond = (id) => d7.find((c) => c.id === id)?.status;
  const allMet = (cond('a-traffic') === 'met' || cond('a-gsc') === 'met') && cond('b-signup') === 'met' && cond('c-shopee') === 'met' && cond('d-disclosure') === 'met';
  const affiliateChecklist = checklist.items.find((c) => c.id === 'affiliate-signup');
  // Dedup must see DONE ticks too (review B MAJOR-1): checklistItems filters
  // done items, so read the raw checklist for the existence check.
  const rawChecklistAff = readJsonSafe(root, join('runs', 'founder', 'checklist.json'));
  const affiliateAny = Array.isArray(rawChecklistAff.json?.items)
    ? rawChecklistAff.json.items.find((i) => i && i.id === 'affiliate-signup') : null;
  if (!affiliateAny || allMet) add(allMet ? 2 : 7, {
    id: 'affiliate-signup-visibility', kind: 'affiliate', title: 'Affiliate signup — optional, early',
    why: allMet
      ? 'All four revenue conditions are met — the affiliate build can start.'
      : 'Early signup is possible; the build stays gated on the four revenue conditions. Founder-reported underway in another session — unverified here.',
    nextStep: { command: affiliateChecklist ? 'node scripts/founder.mjs done affiliate-signup' : undefined, instructions: affiliateAny ? (affiliateAny.status === 'done' ? 'Signup ticked — dashboard verification (RedMart rate/cookie) still gates condition (b).' : 'Tick the checklist item once signup is confirmed.') : 'Sign up with Involve Asia when ready; tick the checklist item once it exists.' },
    source: { path: 'docs/README-PROTOTYPE2.md', section: 'D7' }, status: 'open',
  });

  // 5. Exceptions from the alerts inbox (freeze-silence never becomes one).
  for (const a of alerts.items) {
    if (a.severity === 'low' || a.severity === 'info') continue;
    if (a.id === 'freeze-unreadable') continue; // already surfaced at rank 0
    const rank = a.severity === 'high' ? 1 : 6;
    add(rank, {
      id: `exception-${a.id}`, kind: 'exception', title: a.title,
      why: oneLine(a.detail),
      nextStep: { instructions: 'Open the cited source; fix or acknowledge. Run "node scripts/founder.mjs status" again after.' },
      source: { path: a.source.path, section: a.source.section },
      status: 'open', at: a.at ?? null,
    });
  }

  // Stable priority order: rank, then createdAt, then id.
  ranked.sort((a, b) => a.rank - b.rank || String(a.item.createdAt ?? a.item.at ?? '').localeCompare(String(b.item.createdAt ?? b.item.at ?? '')) || String(a.item.id).localeCompare(String(b.item.id)));
  const items = ranked.map((r, i) => ({ ...r.item, priority: i + 1 }));
  for (const item of items) validateItem(root, item);
  return { schema: 'founder-queue/1', generatedAt: now, items };
}

// ---------------------------------------------------------------------------
// deriveWeekly — SGT-bucketed 7-day rollup. Form COUNTS only, never emails or
// answers. Sparse history carries an honest baseline note.
// ---------------------------------------------------------------------------
export function deriveWeekly(root, now = new Date().toISOString()) {
  const nowMs = ms(now);
  const end = sgtDate(now);
  const start = sgtDate(new Date(nowMs - 6 * DAY_MS).toISOString());
  const inWindow = (d) => d >= start && d <= end;

  // Traffic — latest snapshot totals, labelled with as-of + source.
  const snap = latestInput(root, 'hashmeta-');
  let traffic;
  if (!snap || !snap.json || !snap.json.traffic?.totals) {
    traffic = { views: null, visitors: null, sessions: null, asOf: null, source: 'runs/p2-18/inputs/hashmeta-<date>.json', status: 'unavailable', reason: snap ? (snap.reason ?? 'snapshot has no traffic totals') : 'no Hashmeta snapshot input' };
  } else {
    const t = snap.json.traffic.totals;
    traffic = { views: t.views ?? null, visitors: t.visitors ?? null, sessions: t.sessions ?? null, asOf: snap.json.fetchedAt ?? null, source: snap.rel, status: 'ok' };
  }

  // Decisions by SGT day (audit log is the only source; overruled publishes
  // do not count as published).
  const audit = readAudit(root);
  const overruledIds = new Set(audit.overrules.map((r) => r.overrules));
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(sgtDate(new Date(nowMs - i * DAY_MS).toISOString()));
  const byDay = new Map(days.map((d) => [d, { dateSGT: d, proposed: 0, published: 0, unverified: 0, rejected: 0 }]));
  for (const d of audit.decisions) {
    const day = sgtDate(d.at);
    if (!inWindow(day)) continue;
    const row = byDay.get(day);
    row.proposed += 1;
    if (d.outcome === 'publish' && !overruledIds.has(d.id)) row.published += 1;
    else if (d.outcome === 'unverified') row.unverified += 1;
    else if (d.outcome === 'rejected') row.rejected += 1;
  }

  // Coverage + delta vs the prior archive (null when there is no prior).
  const cat = readJsonSafe(root, join('data', 'catalogue.json'));
  const products = Array.isArray(cat.json?.products) ? cat.json.products : null;
  const rated = products ? products.filter((p) => p.rated === true).length : null;
  const total = products ? products.length : null;
  const arch = archiveIndex(root);
  const prior = arch.find((a) => a.date < end && a.coverage);
  const deltaVsPriorArchive = prior && rated != null ? { vsArchiveDate: prior.date, ratedDelta: rated - prior.coverage.rated } : null;

  // Sync health.
  const syncState = readJsonSafe(root, join('runs', '12-sync-state.json'));
  const sync = syncState.json
    ? { lastSyncedAtSGT: syncState.json.syncedAt ? sgtLabel(syncState.json.syncedAt) : null, readbackStatus: syncState.json.appPage?.readback?.app?.status ?? null }
    : { lastSyncedAtSGT: null, readbackStatus: null, status: 'unavailable', reason: syncState.reason };

  // Reports produced in the window (date-stamped filenames only — honest).
  // WEEKLY-*.md is the rollup itself, never a job report: excluding it keeps
  // re-runs idempotent (the file must not count itself on the next derive).
  const reportsProduced = [];
  for (const f of listDir(root, join('runs', 'reports'))) {
    if (!f.endsWith('.md') || f.startsWith('WEEKLY-')) continue;
    const m = /(\d{4}-\d{2}-\d{2})/.exec(f);
    if (m && inWindow(m[1])) reportsProduced.push(f);
  }

  // Exceptions — the alert inbox's actionable items (freeze-silence excluded).
  const alerts = deriveAlerts(root, now);
  const exceptions = alerts.items.filter((a) => a.severity === 'high' || a.severity === 'medium');

  // Forms: COUNTS ONLY. Never emails, never raw answers (F18 boundary).
  let forms;
  if (!snap || !snap.json || !Array.isArray(snap.json.forms?.forms)) {
    forms = { count: null, status: 'unavailable', reason: snap ? (snap.reason ?? 'snapshot has no forms payload') : 'no Hashmeta snapshot input' };
  } else {
    forms = { count: snap.json.forms.forms.reduce((n, f) => n + (Number(f.totalDocs) || 0), 0) };
  }

  const historyNote = arch.length < 7
    ? `baseline week — accumulating since ${arch.length ? arch[arch.length - 1].date : start}`
    : null;

  return {
    schema: 'founder-weekly/1', generatedAt: now,
    windowSGT: { start, end },
    traffic, decisionsByDaySGT: [...byDay.values()],
    coverage: { rated, total, deltaVsPriorArchive },
    sync, reportsProduced, exceptions, forms, historyNote,
  };
}

// ---------------------------------------------------------------------------
// deriveRevenueReadiness — the four D7 revival conditions, computed from the
// latest traffic snapshot fixtures. NEVER hardcoded figures. GSC branch stays
// unverified until OAuth evidence exists on disk.
// ---------------------------------------------------------------------------
export function deriveRevenueReadiness(root, now = new Date().toISOString()) {
  const snap = latestInput(root, 'hashmeta-');
  const t = snap?.json?.traffic ?? null;
  const source = snap ? snap.rel : 'runs/p2-18/inputs/hashmeta-<date>.json';
  const d7Source = { path: 'docs/README-PROTOTYPE2.md', section: 'D7' };

  let trafficDaily;
  if (!t || !t.totals || !t.range) {
    trafficDaily = { nonZeroDays: null, totalVisitors: null, rangeDays: null, perDay: null, status: 'unavailable', reason: snap ? (snap.reason ?? 'snapshot has no traffic payload') : 'no Hashmeta snapshot input' };
  } else {
    const startMs = Date.parse(`${t.range.start}T00:00:00Z`);
    const endMs = Date.parse(`${t.range.end}T00:00:00Z`);
    const rangeDays = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.round((endMs - startMs) / DAY_MS) + 1 : null;
    const totalVisitors = t.totals.visitors ?? null;
    const nonZeroDays = Array.isArray(t.dailyNonZero) ? t.dailyNonZero.length : null;
    const perDay = rangeDays && totalVisitors != null ? Math.round((totalVisitors / rangeDays) * 100) / 100 : null;
    trafficDaily = { nonZeroDays, totalVisitors, rangeDays, perDay, status: 'ok', asOf: snap.json.fetchedAt ?? null, source };
  }

  // (a) traffic branch: ≥50 visitors/day sustained for 14 days.
  let aTraffic;
  if (trafficDaily.status !== 'ok') {
    aTraffic = { status: 'insufficient-data', detail: `No usable traffic snapshot — ${trafficDaily.reason}.` };
  } else {
    const { nonZeroDays, totalVisitors, rangeDays, perDay } = trafficDaily;
    const daily = new Map((t.dailyNonZero ?? []).map((d) => [d.date, d.visitors ?? 0]));
    const last14 = [];
    const endMs = Date.parse(`${t.range.end}T00:00:00Z`);
    for (let i = 13; i >= 0; i--) last14.push(new Date(endMs - i * DAY_MS).toISOString().slice(0, 10));
    const enoughHistory = rangeDays != null && rangeDays >= 14 && nonZeroDays != null && nonZeroDays >= 14;
    if (!enoughHistory) {
      aTraffic = { status: 'insufficient-data', detail: `Insufficient history — ${nonZeroDays} non-zero days, ${rangeDays}-day total ${totalVisitors} visitors ≈ ${perDay}/day vs 50/day required.` };
    } else {
      const met = last14.every((d) => (daily.get(d) ?? 0) >= 50);
      aTraffic = { status: met ? 'met' : 'unmet', detail: met ? 'At least 50 visitors every day for the last 14 days.' : `Last 14 days did not hold 50 visitors/day (range total ${totalVisitors} ≈ ${perDay}/day).` };
    }
  }

  // (a) GSC branch: unverified until OAuth evidence exists on disk.
  const gscFiles = listDir(root, join('runs', 'p2-18', 'inputs')).filter((f) => /^gsc-.*\.json$/.test(f));
  let aGsc = { status: 'unverified', detail: 'UNVERIFIED — GSC OAuth not connected; no organic-clicks evidence in the repo.' };
  if (gscFiles.length) {
    const g = readJsonSafe(root, join('runs', 'p2-18', 'inputs', gscFiles[gscFiles.length - 1]));
    const clicks = g.json?.organicClicks ?? g.json?.clicks ?? null;
    if (g.json && Number(clicks) > 0) aGsc = { status: 'met', detail: `First organic GSC clicks evidenced (${clicks}) in ${g.rel}.`, source: g.rel };
    else if (g.json) aGsc = { status: 'unverified', detail: `GSC snapshot present but no organic clicks evidenced yet (${g.rel}).`, source: g.rel };
  }

  // (b) signup + in-dashboard verification. Founder tick confirms signup intent
  // only; the RedMart rate/cookie verification still needs dashboard evidence.
  const checklist = readJsonSafe(root, join('runs', 'founder', 'checklist.json'));
  const affiliateItem = Array.isArray(checklist.json?.items) ? checklist.json.items.find((i) => i && i.id === 'affiliate-signup') : null;
  const signupEvidence = readJsonSafe(root, join('runs', 'founder', 'affiliate-verification.json'));
  let bSignup;
  if (signupEvidence.json?.verified === true) bSignup = { status: 'met', detail: 'Signup verified in-dashboard (RedMart rate/cookie evidence on disk).', source: 'runs/founder/affiliate-verification.json' };
  else if (affiliateItem?.status === 'done') bSignup = { status: 'unverified', detail: 'Founder ticked signup — in-dashboard verification (RedMart rate/cookie) still pending.', source: 'runs/founder/checklist.json' };
  else bSignup = { status: 'unverified', detail: 'Founder-reported underway in a separate session — UNVERIFIED in repo; no signup or dashboard-verification evidence.', source: affiliateItem ? 'runs/founder/checklist.json' : 'docs/README-PROTOTYPE2.md' };

  // (c) Shopee clause clarification OR dedicated offer blocks.
  const shopeeEvidence = readJsonSafe(root, join('runs', 'founder', 'shopee-compliance.json'));
  const cShopee = shopeeEvidence.json?.resolved === true
    ? { status: 'met', detail: 'Shopee §6.2(e) clarification or dedicated offer-block design evidenced on disk.', source: 'runs/founder/shopee-compliance.json' }
    : { status: 'unverified', detail: 'No Shopee §6.2(e) clarification or dedicated offer-block design on disk yet.' };

  // (d) disclosure live + scoped pilot.
  const disclosureEvidence = readJsonSafe(root, join('runs', 'founder', 'disclosure-readback.json'));
  const dDisclosure = disclosureEvidence.json?.live === true
    ? { status: 'met', detail: 'Disclosure live and readback-verified; scoped pilot recorded.', source: 'runs/founder/disclosure-readback.json' }
    : { status: 'unverified', detail: 'No live disclosure readback or scoped-pilot evidence on disk yet.' };

  const conditions = [
    { id: 'a-traffic', label: 'Steady traffic: 50 visitors a day for 2 weeks', ...aTraffic, source: aTraffic.source ?? source },
    { id: 'a-gsc', label: 'Or first organic Google clicks', ...aGsc, source: aGsc.source ?? 'docs/README-PROTOTYPE2.md' },
    { id: 'b-signup', label: 'Your signup, checked in the dashboard', ...bSignup, source: bSignup.source ?? 'docs/README-PROTOTYPE2.md' },
    { id: 'c-shopee', label: 'Shopee rule fix or separate offer blocks', ...cShopee, source: cShopee.source ?? 'docs/README-PROTOTYPE2.md' },
    { id: 'd-disclosure', label: 'Disclosure live plus a small pilot', ...dDisclosure, source: dDisclosure.source ?? 'docs/README-PROTOTYPE2.md' },
  ];
  return { schema: 'founder-revenue-readiness/1', generatedAt: now, status: 'not-live', conditions, trafficDaily, d7Source };
}

// ---------------------------------------------------------------------------
// deriveLoop — the 7-stage business loop, honest chips (contract §1 + v3.1 §B).
// TEST = static-proof label, never a live-green claim. RESEARCH = not-built
// until a scout brief item exists. Freeze-halted stages = "frozen — expected".
// ---------------------------------------------------------------------------
export function deriveLoop(root, now = new Date().toISOString()) {
  const freeze = freezeRead(root);
  const frozen = freeze.known && freeze.frozen;
  const freezeChip = (id, name) => ({
    id, name, state: frozen ? 'frozen-expected' : 'unverified',
    label: frozen ? 'Frozen — expected' : 'Freeze state unknown',
    value: freeze.at ? sgtDate(freeze.at) : null,
    source: 'runs/freeze-state.json', asOf: freeze.at,
  });

  // RESEARCH — a scout brief item (or its report) is the existence proof.
  let research = { id: 'research', name: 'Research', state: 'not-built', label: 'Capability not built — planned', value: null, source: 'docs/design-founder-os/BUSINESS-OS-DESIGN-v3.md', asOf: null, detail: 'No scout brief yet. The market-scout skill is planned; nothing to ask it today.' };
  const briefFiles = listDir(root, 'pending').filter((f) => /structural.*aisle-brief.*\.json$/.test(f));
  const briefReports = listDir(root, join('runs', 'reports')).filter((f) => /^aisle-brief-.*\.md$/.test(f));
  if (briefFiles.length) {
    const f = briefFiles[briefFiles.length - 1];
    const j = readJsonSafe(root, join('pending', f)).json;
    research = { id: 'research', name: 'Research', state: 'ok', label: 'Aisle brief ready', value: j?.createdAt ? sgtDate(j.createdAt) : null, source: join('pending', f), asOf: j?.createdAt ?? null };
  } else if (briefReports.length) {
    const f = briefReports[briefReports.length - 1];
    const m = /(\d{4}-\d{2}-\d{2})/.exec(f);
    research = { id: 'research', name: 'Research', state: 'ok', label: 'Aisle brief ready', value: m ? m[1] : null, source: join('runs', 'reports', f), asOf: m ? `${m[1]}T00:00:00+08:00` : null };
  }

  // FIND / EXECUTE / DEPLOY — freeze-halted under freeze; otherwise last proof.
  const latestReport = (prefix) => {
    const files = listDir(root, join('runs', 'reports')).filter((f) => f.startsWith(prefix) && f.endsWith('.md'));
    if (!files.length) return null;
    const f = files[files.length - 1];
    const m = /(\d{4}-\d{2}-\d{2})/.exec(f);
    return { file: join('runs', 'reports', f), date: m ? m[1] : null };
  };
  const haltedOrProof = (id, name, prefix) => {
    if (frozen || !freeze.known) return freezeChip(id, name);
    const r = latestReport(prefix);
    if (!r) return { id, name, state: 'unverified', label: 'No run proof yet', value: null, source: 'runs/reports/', asOf: null };
    return { id, name, state: 'ok', label: `Last report ${r.date ?? ''}`.trim(), value: r.date, source: r.file, asOf: r.date ? `${r.date}T00:00:00+08:00` : null };
  };
  const find = haltedOrProof('find', 'Find', 'refresh-');
  const execute = haltedOrProof('execute', 'Execute', 'reenrich-');
  let deploy;
  if (frozen || !freeze.known) deploy = freezeChip('deploy', 'Deploy');
  else {
    const s = readJsonSafe(root, join('runs', '12-sync-state.json'));
    deploy = s.json?.syncedAt
      ? { id: 'deploy', name: 'Deploy', state: 'ok', label: 'Last sync read back', value: sgtDate(s.json.syncedAt), source: 'runs/12-sync-state.json', asOf: s.json.syncedAt }
      : { id: 'deploy', name: 'Deploy', state: 'unverified', label: 'No sync proof yet', value: null, source: 'runs/12-sync-state.json', asOf: null };
  }

  // REVIEW — the D9 gate keeps working under freeze (audit log is the proof).
  const audit = readAudit(root);
  const lastDecisionAt = audit.decisions.length ? audit.decisions[audit.decisions.length - 1].at : null;
  const review = {
    id: 'review', name: 'Review', state: audit.decisions.length ? 'ok' : 'unverified',
    label: audit.decisions.length ? `${audit.decisions.length} decisions, ${audit.overrules.length} overrules` : 'No decisions yet',
    value: audit.decisions.length, source: 'pending/p2-audit', asOf: lastDecisionAt,
  };

  // TEST — static proof only. NEVER render a static proof as live suite health.
  // Preferred proof: dom-check.json checkedAt (committed content timestamp,
  // robust to checkout mtime) — labelled "dashboard checks only — NOT
  // full-suite". Fallback: the committed suite log (mtime-labelled).
  const domProof = readJsonSafe(root, join('runs', 'p2-18', 'dom-check.json'));
  const suiteProofRel = join('runs', 'p2-18', 'full-suite.log');
  const suiteProof = existsSync(resolve(root, suiteProofRel)) ? suiteProofRel : null;
  let test;
  if (domProof.json?.checkedAt) {
    const at = domProof.json.checkedAt;
    test = {
      id: 'test', name: 'Test', state: 'static-proof',
      label: `Last proof ${sgtDate(at)} (static)`, value: sgtDate(at),
      source: 'runs/p2-18/dom-check.json', asOf: at,
      detail: 'Dashboard checks only — NOT full-suite health. Live suite status not collected at read time.',
    };
  } else if (suiteProof) {
    const at = mtimeIso(root, suiteProof);
    test = {
      id: 'test', name: 'Test', state: 'static-proof',
      label: at ? `Last proof ${sgtDate(at)} (static)` : 'Static proof only',
      value: at ? sgtDate(at) : null, source: suiteProof, asOf: at,
      detail: 'Last committed suite log (static proof). Live suite status not collected at read time.',
    };
  } else {
    test = { id: 'test', name: 'Test', state: 'unverified', label: 'No proof on disk', value: null, source: 'runs/p2-18/', asOf: null, detail: 'No static proof file found; live suite status not collected.' };
  }

  // GROW — basket/blog halt under freeze; traffic number still shown honestly.
  // Unfrozen label is COMPUTED from the latest traffic snapshot (merge-review
  // M3): honest per-day thresholds, never a static qualitative claim. The
  // detail line says what the number means against the D7 50/day bar.
  const snap = latestInput(root, 'hashmeta-');
  const visitors = snap?.json?.traffic?.totals?.visitors ?? null;
  const range = snap?.json?.traffic?.range ?? null;
  let rangeDays = null;
  if (range?.start && range?.end) {
    const s = Date.parse(`${range.start}T00:00:00Z`);
    const e = Date.parse(`${range.end}T00:00:00Z`);
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) rangeDays = Math.round((e - s) / DAY_MS) + 1;
  }
  const perDay = visitors != null && rangeDays ? Math.round((visitors / rangeDays) * 100) / 100 : null;
  const means = `≈${perDay} visitors/day (${visitors} over ${rangeDays} days)`;
  let growState, growLabel, growDetail;
  if (frozen) {
    growState = 'frozen-expected'; growLabel = 'Frozen — expected';
    growDetail = 'Blog and basket jobs halt under freeze — expected silence, never an alarm.';
  } else if (!freeze.known) {
    growState = 'unverified'; growLabel = 'Freeze state unknown';
    growDetail = 'Cannot read runs/freeze-state.json — fail closed.';
  } else if (perDay == null) {
    growState = 'unverified'; growLabel = 'No traffic snapshot yet';
    growDetail = 'No usable Hashmeta traffic snapshot — growth is unverified, not zero.';
  } else if (perDay >= 50) {
    growState = 'ok'; growLabel = 'Traffic above 50 a day';
    growDetail = `${means}. D7 still needs 50 EVERY day for 14 days — see the revenue panel.`;
  } else if (perDay >= 10) {
    growState = 'ok'; growLabel = 'Traffic growing, below 50/day';
    growDetail = `${means} — growing, but below the 50/day D7 revival bar.`;
  } else if (perDay >= 1) {
    growState = 'ok'; growLabel = 'Forms live, traffic small';
    growDetail = `${means} — small; the D7 revival bar is 50/day.`;
  } else {
    growState = 'ok'; growLabel = 'Forms live, traffic tiny';
    growDetail = `${means} — tiny; the D7 revival bar is 50/day.`;
  }
  const grow = {
    id: 'grow', name: 'Grow',
    state: growState,
    label: growLabel,
    value: visitors,
    source: frozen || !freeze.known ? 'runs/freeze-state.json' : (snap ? snap.rel : 'runs/freeze-state.json'),
    valueSource: snap ? snap.rel : null,
    asOf: frozen || !freeze.known ? freeze.at : (snap?.json?.fetchedAt ?? null),
    detail: growDetail,
  };

  return { schema: 'founder-loop/1', generatedAt: now, stages: [research, find, execute, review, test, deploy, grow] };
}