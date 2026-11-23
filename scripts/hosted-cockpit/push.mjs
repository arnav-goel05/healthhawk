// Hosted Cockpit issue 03 — cron-side push script (PRD D5/D6/D8/D12).
// Reads the committed digest aggregate READ-ONLY, sanitizes via the issue-01
// pure module, reads the ingest token from a local file OUTSIDE the repo at
// runtime, POSTs the snapshot to {url}/api/ingest (Bearer), and writes
// evidence + a dated report ONLY under runs/hosted-cockpit/**. Failures write
// runs/12-alert-hosted-cockpit-<UTCcompact>.json at runs/ TOP level (matches
// the founder-queue inbox scan /^12-alert-.*\.json$/) and exit non-zero.
// Fail-closed, NO retry. Token never in stdout/evidence/report/alerts.
// Works under freeze (read-only derivation). Never invokes founder.mjs,
// never writes data/, app/, pending/, scripts/, docs/, freeze-state, no git,
// no platform tools. Zero deps, Node built-ins only.

import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { sanitize } from './sanitize.mjs';

const EVIDENCE_SCHEMA = 'hosted-push-evidence/1';
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_AGGREGATE = join('runs', 'p2-18', 'aggregate.json');
const EVIDENCE_RE = /^push-.*\.json$/;
const REPORT_RE = /^hosted-push-.*\.md$/;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--') || i + 1 >= argv.length) return null;
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

function utcCompact(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function sgtDate(date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function oneLineReason(reason, token) {
  let line = String(reason).replace(/\s+/g, ' ').trim();
  if (token && line.includes(token)) line = line.split(token).join('[redacted]');
  return line.slice(0, 300);
}

function isRealDir(path) {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function writeAlert(root, now, step, reason, token) {
  const runsDir = join(root, 'runs');
  if (existsSync(runsDir) && !isRealDir(runsDir)) return null;
  mkdirSync(runsDir, { recursive: true });
  const file = join(runsDir, `12-alert-hosted-cockpit-${utcCompact(now)}.json`);
  const alert = {
    alert: 'hosted-push-failed',
    alertAt: now.toISOString(),
    step,
    reason: oneLineReason(reason, token),
  };
  writeFileSync(file, `${JSON.stringify(alert, null, 1)}\n`);
  return file;
}

function fail(root, now, step, reason, token) {
  let alertPath = null;
  try {
    alertPath = writeAlert(root, now, step, reason, token);
  } catch {
    alertPath = null;
  }
  const where = alertPath ? ` (alert: ${alertPath})` : ' (alert write failed)';
  process.stderr.write(`hosted push failed: ${step}${where}\n`);
  return 1;
}

function pruneOwnEvidence(scopeDir, now) {
  const cutoff = now.getTime() - RETENTION_MS;
  for (const name of readdirSync(scopeDir)) {
    if (!EVIDENCE_RE.test(name) && !REPORT_RE.test(name)) continue;
    const path = join(scopeDir, name);
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) continue;
    if (st.mtimeMs < cutoff) unlinkSync(path);
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args || !args.root || !args['token-file'] || !args.url) {
    process.stderr.write('usage: push.mjs --root <repoRoot> --token-file <absPath> --url <pageBaseUrl> [--now <ISO>] [--aggregate <relPath>]\n');
    return 2;
  }
  const root = resolve(args.root);
  const now = args.now ? new Date(args.now) : new Date();
  if (!Number.isFinite(now.getTime())) {
    process.stderr.write('hosted push: --now is not a valid ISO timestamp\n');
    return 2;
  }
  if (!/^https?:\/\//.test(args.url)) {
    process.stderr.write('hosted push: --url must be an http(s) base URL\n');
    return 2;
  }
  const baseUrl = args.url.replace(/\/+$/, '');
  const aggregateRel = args.aggregate ?? DEFAULT_AGGREGATE;
  if (isAbsolute(aggregateRel)) {
    process.stderr.write('hosted push: --aggregate must be a path relative to --root\n');
    return 2;
  }
  const aggregatePath = resolve(root, aggregateRel);
  if (!aggregatePath.startsWith(root + sep)) {
    process.stderr.write('hosted push: --aggregate escapes --root\n');
    return 2;
  }

  // Review A note (fix round 1): any unexpected throw below also writes the
  // inbox alert before exiting (D8), with the token redacted when known.
  let token = null;
  try {
    let aggregate;
    try {
      aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8'));
    } catch {
      return fail(root, now, 'read-aggregate', 'committed aggregate missing or unreadable (fail-closed)', null);
    }

    let snapshot;
    try {
      snapshot = sanitize(aggregate);
    } catch (err) {
      const message = /^hosted (sanitize|snapshot guard)/.test(err?.message ?? '')
        ? err.message
        : 'sanitize failed (unexpected error)';
      return fail(root, now, 'sanitize', message, null);
    }

    try {
      token = readFileSync(resolve(args['token-file']), 'utf8').trim();
    } catch {
      return fail(root, now, 'read-token', 'ingest token file missing or unreadable (fail-closed)', null);
    }
    if (token.length === 0) {
      return fail(root, now, 'read-token', 'ingest token file empty (fail-closed)', null);
    }

    let response;
    try {
      response = await fetch(`${baseUrl}/api/ingest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify(snapshot),
      });
    } catch (err) {
      const cause = err?.cause?.message ? ` (${err.cause.message})` : '';
      return fail(root, now, 'ingest', `network error: ${err?.message ?? 'fetch failed'}${cause}`, token);
    }
    if (!response.ok) {
      return fail(root, now, 'ingest', `ingest rejected: HTTP ${response.status} (no retry)`, token);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      return fail(root, now, 'ingest-response', 'ingest response body unreadable (fail-closed)', token);
    }
    if (payload?.ok !== true || typeof payload.receivedAt !== 'string' || payload.receivedAt.length === 0) {
      return fail(root, now, 'ingest-response', 'ingest response missing ok/receivedAt (fail-closed)', token);
    }

    const runsDir = join(root, 'runs');
    const scopeDir = join(runsDir, 'hosted-cockpit');
    if ((existsSync(runsDir) && !isRealDir(runsDir)) || (existsSync(scopeDir) && !isRealDir(scopeDir))) {
      return fail(root, now, 'evidence', 'runs/hosted-cockpit is not a real directory (refusing to write through links)', token);
    }
    const compact = utcCompact(now);
    const dateSGT = sgtDate(now);
    const evidenceRel = join('runs', 'hosted-cockpit', `push-${compact}.json`);
    const reportRel = join('runs', 'hosted-cockpit', `hosted-push-${dateSGT}.md`);
    const evidence = {
      schema: EVIDENCE_SCHEMA,
      pushedAt: now.toISOString(),
      aggregateGeneratedAt: snapshot.dataAsOf,
      digestDateSGT: snapshot.digestDateSGT,
      receivedAt: payload.receivedAt,
      url: baseUrl,
      ok: true,
    };
    const mismatch = snapshot.digestDateSGT !== dateSGT;
    const report = [
      `# Hosted cockpit push — ${dateSGT} (SGT)`,
      '',
      `- pushedAt: ${evidence.pushedAt}`,
      `- aggregate generatedAt: ${evidence.aggregateGeneratedAt ?? 'missing'}`,
      `- digestDateSGT: ${evidence.digestDateSGT ?? 'missing'}`,
      `- receivedAt (page): ${evidence.receivedAt}`,
      `- url: ${evidence.url}`,
      '- result: ok',
      '',
      'Sanitized snapshot pushed by scripts/hosted-cockpit/push.mjs (read-only derivation; works under freeze).',
      mismatch
        ? 'Digest date differs from push date — recorded honestly; the page banner surfaces staleness (push does not fail on mismatch).'
        : 'Digest date matches push date (SGT).',
      '',
    ].join('\n');
    try {
      mkdirSync(scopeDir, { recursive: true });
      writeFileSync(join(root, evidenceRel), `${JSON.stringify(evidence, null, 1)}\n`);
      writeFileSync(join(root, reportRel), report);
    } catch (err) {
      return fail(root, now, 'evidence', `evidence write failed: ${err?.message ?? 'unknown'}`, token);
    }
    try {
      pruneOwnEvidence(scopeDir, now);
    } catch (err) {
      return fail(root, now, 'prune', `evidence prune failed: ${err?.message ?? 'unknown'}`, token);
    }

    process.stdout.write(`hosted push ok: receivedAt=${payload.receivedAt} evidence=${evidenceRel}\n`);
    return 0;
  } catch (err) {
    return fail(root, now, 'unexpected', `unexpected error: ${err?.message ?? 'unknown'}`, token);
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((err) => {
  process.stderr.write(`hosted push failed: unexpected error: ${oneLineReason(err?.message ?? 'unknown', null)}\n`);
  process.exitCode = 1;
});