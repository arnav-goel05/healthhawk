// P4 canonical plain-verdict display vocabulary (docs/PRD-P4-SIMPLIFY.md).
// Render-layer ONLY: data verdict values stay frozen. Founder-locked wording:
//   contradicted -> "doesn't match the label"
//   unverified   -> "we couldn't check this"
// Other verdicts (misleading, borderline) keep their existing plain-summary
// treatment; this map passes them through unchanged.
export const PLAIN_VERDICTS = Object.freeze({
  contradicted: "doesn't match the label",
  unverified: "we couldn't check this",
});

export function plainVerdict(verdict) {
  return PLAIN_VERDICTS[verdict] ?? verdict;
}