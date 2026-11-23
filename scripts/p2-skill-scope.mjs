// HealthHawk P2-19 — role write-scope guard for ALL 13 roles (machine teeth).
// Generalizes the washing-detection reference guard (7a-claim-rules.mjs
// assertWriteScope/guardedWrite) to every role in docs/contracts/handoff.md.
// NEW file by design: scripts/p2-gate-lib.mjs is hash-bound by standing gate
// verdicts and is NOT touched by this slice.
//
// Honest limitation (PRD): this guards writes that go THROUGH the guard (role
// scripts + guarded session writes). It is not OS sandboxing; field-level
// discipline inside an allowed file (e.g. extraction touching only
// ingredients/nutrition layers of data/catalogue.json) is enforced by
// validate-catalogue.mjs + the never-overwrite script contracts, not here.
//
// Zero deps, zero network. Pure path logic + one guarded write helper.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Repo-relative allowlists. A path is allowed iff it equals an allowed file
// entry, lives under an allowed directory prefix, or matches a single-segment
// glob entry (slice 08). Anything else throws.
export const ROLE_SCOPES = Object.freeze({
  research: ['runs/'],
  matching: ['data/catalogue.json', 'pending/', 'runs/'],
  extraction: ['data/catalogue.json', 'pending/', 'runs/'],
  classification: ['data/classification/sheet.json', 'pending/', 'runs/'],
  scoring: ['data/catalogue.json', 'pending/', 'runs/'],
  'washing-detection': ['data/claims/', 'pending/', 'runs/'],
  'publish-sync': ['runs/', 'pending/'],
  content: ['pending/', 'runs/'],
  analyst: ['runs/', 'pending/'],
  'additive-evidence': ['data/additives/', 'pending/', 'runs/'],
  // Founder-OS slice 07: market-scout — brief report + ONE structural item +
  // own-brief supersede updates. Minimal scope; never catalogue/data/app.
  scout: ['runs/', 'pending/'],
  // Founder-OS slice 08 (addendum §B2): Monday founder-report job — EXACT
  // declared scope: digest scope + WEEKLY + founder dir. Glob entries are
  // single-segment (digest-*.md never matches a subdirectory).
  'founder-report': ['runs/p2-18/', 'runs/reports/digest-*.md', 'dashboard/index.html', 'runs/reports/WEEKLY-*.md', 'runs/founder/'],
  // Governance + merge machinery (merge-03/04 precedent): reports, test pins,
  // app rebuild, sanctioned catalogue applies/re-pins. NEVER the sheet, NEVER
  // additives KB, NEVER reviewer verdicts / audit records by hand.
  orchestrator: ['runs/', 'pending/', 'docs/reports/', 'tests/', 'app/', 'scripts/', 'data/catalogue.json', 'data/claims/'],
});

export const ROLES = Object.freeze(Object.keys(ROLE_SCOPES));

// Denied for EVERY role regardless of allowlist:
// - freeze state: founder-only unfreeze (a session never edits it)
// - p2-audit: decision/overrule records are written ONLY by scripts/p2-gate.mjs
//   through its own assertAuditWritePath — never hand-written by a role session.
export const GLOBAL_DENY = Object.freeze(['runs/freeze-state.json', 'pending/p2-audit/']);

export function checkWriteScope(role, relPath) {
  if (!ROLE_SCOPES[role]) return { ok: false, reason: `unknown role: ${role}` };
  if (typeof relPath !== 'string' || relPath.length === 0) return { ok: false, reason: 'empty path' };
  const norm = relPath.replace(/\\/g, '/');
  if (norm.startsWith('/') || norm.includes('..') || norm.split('/').some((s) => s === '')) {
    return { ok: false, reason: 'path must be repo-relative, normalized, no traversal' };
  }
  for (const deny of GLOBAL_DENY) {
    if (norm === deny || (deny.endsWith('/') && norm.startsWith(deny))) {
      return { ok: false, reason: `globally denied (founder-only / gate-script-only): ${deny}` };
    }
  }
  const allowed = ROLE_SCOPES[role].some((p) => {
    // Single-segment glob entries (slice 08: digest-*.md / WEEKLY-*.md).
    // Additive: no pre-existing entry contains '*', so legacy behaviour is
    // byte-identical for every other role.
    if (p.includes('*')) {
      const re = new RegExp(`^${p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
      return re.test(norm);
    }
    return p.endsWith('/') ? norm.startsWith(p) : norm === p;
  });
  if (!allowed) return { ok: false, reason: `outside ${role} write scope` };
  return { ok: true };
}

export function assertWriteScope(role, relPath) {
  const c = checkWriteScope(role, relPath);
  if (!c.ok) throw new Error(`WRITE SCOPE VIOLATION: ${role} may not write ${relPath} (${c.reason})`);
  return resolve(ROOT, relPath);
}

// Guarded write: assert FIRST, then write. A refusal leaves the disk untouched.
export function guardedWrite(role, relPath, content, { root = ROOT } = {}) {
  const c = checkWriteScope(role, relPath);
  if (!c.ok) throw new Error(`WRITE SCOPE VIOLATION: ${role} may not write ${relPath} (${c.reason})`);
  const p = resolve(root, relPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}