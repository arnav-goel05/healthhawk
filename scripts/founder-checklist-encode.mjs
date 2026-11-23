import { createHash } from 'node:crypto';
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(MODULE_DIR, '..');
export const CHECKLIST_REL = 'runs/founder/checklist.json';
export const SCHEMA = 'founder-checklist/1';

const ITEM_DEFS = [
  {
    id: 'newsletter-tool',
    title: 'Pick a newsletter tool (must allow unsubscribe)',
    why: 'The signup form collects emails but nothing can send yet. The tool you pick MUST support unsubscribe (PDPA and spam rules).',
    steps: '1. Choose a sending tool that supports unsubscribe. 2. Give the agent a recipient email address. 3. The agent then wires the forwarding rule and the weekly basket note. Until then, no email is sent and the site promises none.',
    source: { path: 'docs/reports/13-forms.md', section: '§2 CRM forwarding state + automated-follow-up AC' },
  },
  {
    id: 'phone-check',
    title: 'Do the 5-second phone check',
    why: 'Mobile checks so far are computer simulations, not a real phone. A quick human look is the last mile.',
    steps: 'Open the site on your phone, search, tap a card. If anything looks wrong, tell the agent.',
    source: { path: 'docs/reports/P2-CUTOVER-BRIEF.md', section: '§3 What needs YOU — 5-second phone check row' },
  },
  {
    id: 'video-go',
    title: 'Demo video: say go or let expire',
    why: 'The demo video and submission pack wait on your word. After the submission deadline this item expires honestly; it never silently vanishes.',
    steps: 'Say "go" to the agent, or do nothing and let the item expire.',
    expiresWhen: '2026-11-23T20:00:00+08:00',
    source: { path: 'docs/reports/P2-CUTOVER-BRIEF.md', section: '§3 What needs YOU — Demo video row' },
  },
  {
    id: 'payment-topup',
    title: 'Top up platform credits when needed (standing)',
    why: 'Publishing spends credits. Only you can pay. No cost ledger exists yet.',
    steps: 'Standing personal act. Top up QwenWork/Hashmeta credits when the agent reports low balance.',
    source: { path: 'docs/reports/founder-delegations.md', section: 'Scope interpretation — non-delegable: any payment/credit top-up' },
  },
  {
    id: 'affiliate-signup',
    title: 'Affiliate signup (Involve Asia) — tick when confirmed',
    why: 'Personal account signup only you can do. The affiliate BUILD stays gated on the four D7 revival conditions even after signup.',
    steps: '1. Sign up for Involve Asia with your personal account. 2. Verify the dashboard (RedMart rate/cookie). 3. Tell the agent and tick this item. Per-SKU match confirmations come later, gated by D7.',
    note: 'Founder-reported underway in a separate session — UNVERIFIED in repo (no signup evidence on disk). Tick when confirmed.',
    source: { path: 'docs/reports/13-forms.md', section: '§5 Affiliate programme — exact founder steps (D7(b) signup)' },
  },
  {
    id: 'g4-rollout',
    title: 'Wire content-hash stamping before going live',
    why: 'Until approval writers stamp review.evidenceContentHash, changed evidence under an old approval still auto-publishes — the G4 binding protects only hash-carrying approvals.',
    steps: 'PRE-UNFREEZE prerequisite: the orchestrator sequences approval-writer stamping (founder CLI approve + gate decision path) per the cited deferral, with a fixture proving a CLI-approved item binds. Tick this item only when that rollout is verified; complete it before unfreeze.',
    source: { path: 'docs/reports/fos-10-impl.md', section: '§5.3 (DEFERRED item 3 — approval-time stamping of review.evidenceContentHash)' },
  },
  {
    id: 'ratifications-growth',
    title: 'Ratified: growth ladder, newsletter/barcode gates, blog founder-gating',
    why: 'Expansion sequencing and gates ratified by the founder; recorded here so the decision is never re-asked.',
    status: 'done',
    doneAt: '2026-11-23',
    note: 'Founder 2026-11-23, grill-me Q3, verbatim: "yes". Ladder: SEO/blog → aisles → affiliate → newsletter (≥500 visitors/mo + unsubscribe) → barcode last. Exact ratification time not recorded; date only.',
    source: { path: 'docs/design-founder-os/interface-contract.md', section: 'Founder go line 5 (Q3 "yes") + §2 ratifications-growth' },
  },
  {
    id: 'ratifications-scout',
    title: 'Ratified: build the market-scout researcher',
    why: 'The market-scout skill (which aisle next, evidence-cited) was ratified by the founder; recorded here so the decision is never re-asked.',
    status: 'done',
    doneAt: '2026-11-23',
    note: 'Founder 2026-11-23, grill-me Q4, verbatim: "yes, build rn". Exact ratification time not recorded; date only.',
    source: { path: 'docs/design-founder-os/interface-contract.md', section: '§2 ratifications-scout + §5 (Phase B brought forward by founder "yes, build rn")' },
  },
  {
    id: 'ratifications-cockpit',
    title: 'Ratified: Honest Label cockpit styling',
    why: 'The cockpit visual restyle (Honest Label tokens, offline fonts) was ratified by the founder; recorded here so the decision is never re-asked.',
    status: 'done',
    doneAt: '2026-11-23',
    note: 'Founder 2026-11-23, grill-me Q6, verbatim: "yes". Exact ratification time not recorded; date only.',
    source: { path: 'docs/design-founder-os/interface-contract.md', section: 'Founder go line 5 (Q6 "yes") + §4 (A2, founder-approved Q6)' },
  },
];

export function itemIds() {
  return ITEM_DEFS.map((d) => d.id);
}

function sourceStamp(root, relPath) {
  const abs = resolve(root, relPath);
  const buf = readFileSync(abs);
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    mtime: statSync(abs).mtime.toISOString(),
  };
}

export function encodeChecklist(root, now = new Date()) {
  const encodedAt = now.toISOString();
  const existingPath = resolve(root, CHECKLIST_REL);
  const prevById = new Map();
  if (existsSync(existingPath)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(existingPath, 'utf8'));
    } catch {
      throw new Error(`existing ${CHECKLIST_REL} is not valid JSON — refusing to re-encode (would risk losing done ticks); fix or remove it deliberately`);
    }
    if (!parsed || parsed.schema !== SCHEMA || !Array.isArray(parsed.items)) {
      throw new Error(`existing ${CHECKLIST_REL} has an unknown schema — refusing to re-encode (would risk losing done ticks)`);
    }
    for (const it of parsed.items) {
      if (it && typeof it.id === 'string') prevById.set(it.id, it);
    }
  }
  const items = ITEM_DEFS.map((def) => {
    const stamp = sourceStamp(root, def.source.path);
    const prev = prevById.get(def.id);
    const item = {
      id: def.id,
      title: def.title,
      why: def.why,
    };
    if (def.steps) item.steps = def.steps;
    if (def.command) item.command = def.command;
    item.source = { path: def.source.path, section: def.source.section, sha256: stamp.sha256, mtime: stamp.mtime };
    item.createdAt = prev && typeof prev.createdAt === 'string' ? prev.createdAt : encodedAt;
    item.expiresWhen = def.expiresWhen ?? null;
    item.status = def.status === 'done' ? 'done' : 'open';
    if (def.doneAt) item.doneAt = def.doneAt;
    if (def.note) item.note = def.note;
    if (prev && prev.status === 'done') {
      item.status = 'done';
      if (prev.doneAt != null) item.doneAt = prev.doneAt;
      if (prev.note != null) item.note = prev.note;
    }
    return item;
  });
  return { schema: SCHEMA, encodedAt, items };
}

export function writeChecklist(root, checklist) {
  const dir = resolve(root, 'runs/founder');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'checklist.json');
  const tmp = join(dir, '.checklist.json.tmp');
  writeFileSync(tmp, JSON.stringify(checklist, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  return target;
}

export function checkStaleness(root, checklist) {
  return checklist.items.map((item) => {
    const abs = resolve(root, item.source.path);
    if (!existsSync(abs)) {
      return { id: item.id, stale: true, reason: 'source file missing', encodedSha256: item.source.sha256, currentSha256: null };
    }
    const currentSha256 = createHash('sha256').update(readFileSync(abs)).digest('hex');
    const stale = currentSha256 !== item.source.sha256;
    return {
      id: item.id,
      stale,
      reason: stale ? 'source sha256 changed since encoding' : 'current',
      encodedSha256: item.source.sha256,
      currentSha256,
    };
  });
}

export function isExpired(item, now = new Date()) {
  if (!item.expiresWhen || item.status === 'done') return false;
  const t = Date.parse(item.expiresWhen);
  if (Number.isNaN(t)) return false;
  return now.getTime() > t;
}

function main(argv) {
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      root = resolve(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${argv[i]} (usage: founder-checklist-encode.mjs [--root <path>])`);
    }
  }
  const checklist = encodeChecklist(root);
  const target = writeChecklist(root, checklist);
  const done = checklist.items.filter((i) => i.status === 'done').length;
  console.log(`encoded ${checklist.items.length} checklist items (${done} done) → ${target}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`checklist encode failed: ${err.message}`);
    process.exit(1);
  }
}