// Self-contained fail-closed content guard (PRD D4/D5, defense in depth).
// One contract, two copies: the push-side sanitizer (issue 01) carries the
// same semantics; issue 03 adds a drift test importing BOTH modules.
// Keep the export signature assertSafe(value) stable.
//
// Throws on ANY deep string containing:
//   - email-like text
//   - internal path fragments: "/Users/", "runs/", "pending/", "scripts/", ".json"
//     (matched case-insensitively — fix round 1 B2)
//   - UUID-like ids
// Residual risk (F19): catches plaintext accidents, not determined encoding;
// the structural counts-only snapshot mapping is the primary defense.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const PATH_FRAGMENTS = ['/users/', 'runs/', 'pending/', 'scripts/', '.json']; // lowercase; matched case-insensitively

export function assertSafe(value) {
  const seen = new WeakSet();
  scan(value, seen);
  return true;
}

function scan(value, seen) {
  if (typeof value === 'string') {
    if (EMAIL_RE.test(value)) throw new Error('unsafe content: email-like text');
    const lower = value.toLowerCase();
    for (const frag of PATH_FRAGMENTS) {
      if (lower.includes(frag)) throw new Error('unsafe content: path fragment');
    }
    if (UUID_RE.test(value)) throw new Error('unsafe content: UUID-like id');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) scan(item, seen);
    return;
  }
  for (const key of Object.keys(value)) {
    scan(key, seen);
    scan(value[key], seen);
  }
}