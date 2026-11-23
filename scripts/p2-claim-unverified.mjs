// HealthHawk P2-11 — organic + unregulated-term rules -> the new "unverified"
// verdict (washing-detection role, claim-rule expansion). Deterministic
// checked-in code — no LLM discretion.
//
//   CLM-ORGANIC      "organic" IS regulated: Food Regulations Reg 9(5) + SFA
//                    Guide §F.1 (printed p56) require a certificate under a
//                    Codex CXG 32-1999 §6.3-compliant (or equivalent) system.
//                    No certification evidence is published in our data ->
//                    UNVERIFIED (the claim may be certified; we hold no
//                    evidence either way). NEVER "contradicted"/false.
//   CLM-UNREGULATED  terms with NO SG statutory definition (wholesome,
//                    goodness, traditional, age-old method, premium, pure,
//                    fresh) — general Reg 9 truthfulness only. UNVERIFIED,
//                    never phrased as false (PRD story 30).
//
// Boundary decisions (documented, deterministic):
// - "natural"/"naturally flavoured" stay owned by the 7b factual-composition
//   rules (CLM-NATURAL / CLM-NATURALFLAVOUR) — no double reporting.
// - "nutritious" is a nutrient-content descriptor owned by the nutrient /
//   nutrient-function families (regulatory research 10h) — recorded as
//   informational, never an unverified finding.
// - "wholegrain goodness" belongs to the wholegrain claim family — skipped.
// - Serving suggestions ("Top with fresh fruits") are NOT product claims —
//   skipped (false-positive trap discipline).
// - Ingredient-list tokens ("Natural Flavor") are declarations, not marketing
//   claims — ingredient evidence is never scanned for marketing terms.
// - HCS-logo context is HPB certification (slice-4 precedent) — skipped.
//
// ROLE SEPARATION: dry-run expansion layer; the live 7a/7b engine output is
// untouched (frozen findings + 17 golden pins byte-exact until merge promotes
// these rules THROUGH the D9 auto-gate). unverified verdicts are NEVER queued
// as accusations; they publish only as grey non-accusation renderings via the
// gate. Writes only under runs/ via the 7a assertWriteScope guard.

// (no engine imports needed — the unverified rules are claim-text checks;
// thresholds cite the SFA guide / Food Regulations, cached in runs/p2-11/)

export const AGENT_ID = 'agent:p2-11-claims';
export const SFA_GUIDE_URL = 'https://www.sfa.gov.sg/api/assets/6d49f810-e43c-4cef-a990-18a6f95dc969/a-guide-to-food-labelling-and-advertisements.pdf';
export const SFA_LANDING_URL = 'https://www.sfa.gov.sg/regulatory-standards-frameworks-guidelines/food-labelling-packaging-guidelines/labelling-requirements-for-food';
export const FOOD_REGS_URL = 'https://sso.agc.gov.sg/SL/SFA1973-RG1';
export const CODEX_CXG32_URL = 'https://www.fao.org/fileadmin/user_upload/livestockgov/documents/cxg_032e.pdf';
export const SFA_GUIDE_SHA256 = '7f64036e35561284f033a2b7f63a1f109779735804562f55ba00d9d5a84e4653';

export const UNVERIFIED_RULES = {
  'CLM-ORGANIC': {
    family: 'organic',
    threshold: '"organic" claims must be accompanied by a certificate substantiating certification under an inspection and certification system complying with Codex CXG 32-1999 §6.3 or an equivalent system (Food Regulations Reg 9(5); SFA Guide §F.1). No certification evidence is published in our data -> UNVERIFIED, not false.',
    sourceUrl: SFA_GUIDE_URL,
    pageRef: 'SFA A Guide to Food Labelling and Advertisements, §F.1 Organic, PDF p57 (printed p56), footnote 15 (Regulation 9(5) of the Food Regulations); guide SHA-256 ' + SFA_GUIDE_SHA256 + ' (fetched 2026-11-21T17:27Z, runs/p2-11/raw/)',
    sourceQuote: 'Products labelled with claims such as "organically produced", "organic" or similar terms, must be accompanied by a certificate to substantiate that the product is certified as organic under an inspection and certification system that complies with section 6.3 of the Codex Guidelines for the Production, Processing, Labelling and Marketing of Organically Produced Foods, CXG 32-1999, or an equivalent system.',
    secondarySources: [
      { name: 'Food Regulations Reg 9(5)', url: FOOD_REGS_URL },
      { name: 'Codex CXG 32-1999 §6.3', url: CODEX_CXG32_URL },
      { name: 'SFA labelling requirements landing page (Last Updated 11 Nov 2026)', url: SFA_LANDING_URL },
    ],
  },
  'CLM-UNREGULATED': {
    family: 'unregulated-term',
    threshold: 'unregulated marketing term — no SG statutory definition exists (SFA Guide defines no criteria for wholesome/goodness/traditional/age-old/premium/pure/fresh on general food); subject only to the general false/misleading prohibition (Food Regulations Reg 9). Not verifiable against nutrient criteria -> UNVERIFIED, never phrased as false.',
    sourceUrl: SFA_GUIDE_URL,
    pageRef: 'SFA A Guide to Food Labelling and Advertisements (no definition for these terms — verified against the full guide text, runs/p2-11/raw/sfa-guide-text.txt); Food Regulations Reg 9; p2-research-regulatory.md §3 10e',
    sourceQuote: 'Requirements on Other Claims, such as \'organic\' and \'gluten-free\' [the guide defines criteria for organic and gluten-free only; no statutory definition exists for wholesome/goodness/traditional/premium/pure/fresh]',
    secondarySources: [{ name: 'Food Regulations Reg 9 (false/misleading prohibition)', url: FOOD_REGS_URL }],
    heuristic: 'absence-of-definition is a verified legal fact; the unverified verdict is a grey-zone routing, not a numeric threshold',
  },
};

export const UNVERIFIED_NOTE = 'Unverified: no regulated definition or no certification evidence is published in our data for this claim. This is NOT a finding that the claim is false — it means nobody can verify it from the evidence we hold (PRD story 30/39). Grey-zone claims are never published as accusations.';

// ---------------------------------------------------------------------------
// Extraction — verbatim, with source location; one finding per EAN per rule.
// ---------------------------------------------------------------------------

const ORGANIC_RE = /\borganic(?:ally)?\b/gi;
const TERM_PATTERNS = [
  { term: 'wholesome', re: /\bwholesome(?:\s+[A-Za-z]+){0,2}/gi },
  { term: 'goodness', re: /\b(?:long-lasting\s+)?goodness\b/gi },
  { term: 'traditional', re: /\btraditional\b/gi },
  { term: 'age-old method', re: /\bage-old\s+method\b/gi },
  { term: 'premium', re: /\bpremium\b/gi },
  { term: 'pure', re: /\bpure\b/gi },
  { term: 'fresh', re: /\bfresh\b/gi },
];
const SERVING_SUGGESTION_RE = /(?:top|serve|garnish|add|mix)\s+(?:it\s+)?with\s+[^.;•]{0,30}\bfresh\b|\bfresh\s+fruits?\s+for\b/i;
const HCS_LOGO_RE = /HEALTHIER\s+CHOICE/i;
const NON_CLAIM_QUOTE_RE = /^\[(mascot|format|ingredients|prep|kidsPositioning|versatility|packName|back|chineseName)\]/i;

const SOURCE_PRIORITY = { 'pack-photo-ocr': 3, 'marketing-copy': 2, 'key-information': 2, 'name-positioning': 1, name: 1 };

function sourcesFor(product, sheetRow) {
  const sources = [{ location: 'product name (retailer listing)', text: product.name, sourceUrl: product?.offers?.[0]?.sourceUrl ?? null, priority: 1, type: 'name' }];
  for (const e of sheetRow?.evidence ?? []) {
    if (['marketing-copy', 'pack-photo-ocr', 'key-information', 'name-positioning'].includes(e.type) && e.quote) {
      sources.push({ location: `classification sheet evidence [${e.type}]`, text: e.quote, sourceUrl: e.sourceUrl ?? null, priority: SOURCE_PRIORITY[e.type] ?? 2, ocrRecord: e.ocrRecord ?? null, type: e.type });
    }
  }
  return sources;
}

function claimFrom(src, match, family, extra = {}) {
  return {
    family,
    quotedClaim: match[0].trim(),
    claimSource: { location: src.location, contextQuote: src.text, sourceUrl: src.sourceUrl, ocrRecord: src.ocrRecord ?? undefined },
    priority: src.priority,
    ...extra,
  };
}

export function extractUnverifiedClaims(product, sheetRow) {
  const out = [];
  const informational = [];
  let organic = null;
  const terms = new Map();
  for (const src of sourcesFor(product, sheetRow)) {
    if (NON_CLAIM_QUOTE_RE.test(src.text) && src.type !== 'name') continue; // annotation/ingredient quotes are not marketing claims
    // Organic — the name itself is a retailer-listing claim; pack/marketing
    // quotes corroborate. Ingredient-list quotes are skipped by the guard above.
    ORGANIC_RE.lastIndex = 0;
    let m;
    while ((m = ORGANIC_RE.exec(src.text)) !== null) {
      const c = claimFrom(src, m, 'organic');
      if (!organic || c.priority > organic.priority) organic = c;
    }
    for (const { term, re } of TERM_PATTERNS) {
      re.lastIndex = 0;
      while ((m = re.exec(src.text)) !== null) {
        const before = src.text.slice(Math.max(0, m.index - 30), m.index);
        const after = src.text.slice(m.index, m.index + m[0].length + 40);
        if (HCS_LOGO_RE.test(src.text) && /lower\s+in|higher\s+in/i.test(after)) continue; // HCS tagline vocabulary = certification
        if (term === 'goodness' && /whole[\s-]?grain\s+$/i.test(before)) {
          informational.push({ ean: product.ean, term, quotedClaim: m[0], reason: '"wholegrain goodness" belongs to the wholegrain claim family (7a rules own it) — not double-reported as an unregulated term', sourceUrl: src.sourceUrl });
          continue;
        }
        if (term === 'fresh' && SERVING_SUGGESTION_RE.test(src.text)) {
          informational.push({ ean: product.ean, term, quotedClaim: m[0], reason: 'serving suggestion ("top with fresh fruits"), not a claim that the product itself is fresh — never flagged (false-positive trap discipline)', sourceUrl: src.sourceUrl });
          continue;
        }
        const c = claimFrom(src, m, 'unregulated-term', { term });
        const prev = terms.get(term);
        if (!prev || c.priority > prev.priority) terms.set(term, c);
      }
    }
    // "nutritious" — nutrient-content descriptor, owned by the nutrient /
    // nutrient-function families; informational only (boundary decision).
    const nut = src.text.match(/\bnutritious\b[^.;•]{0,50}/i);
    if (nut) informational.push({ ean: product.ean, term: 'nutritious', quotedClaim: nut[0], reason: '"nutritious" is a nutrient-content descriptor owned by the nutrient/nutrient-function claim families (regulatory research 10h) — informational, not an unverified finding', sourceUrl: src.sourceUrl });
  }
  if (organic) out.push(organic);
  // One unregulated-term finding per EAN: the highest-priority source's first
  // term (deterministic order = TERM_PATTERNS order within a source).
  const termClaims = [...terms.values()].sort((a, b) => b.priority - a.priority);
  if (termClaims.length) out.push(termClaims[0]);
  return { claims: out, informational };
}

// ---------------------------------------------------------------------------
// Checks — the verdict is ALWAYS unverified (never false, never ok).
// ---------------------------------------------------------------------------

function unverifiedFinding(claim, product, ruleId, evidenceDetail, notes) {
  const rule = UNVERIFIED_RULES[ruleId];
  return {
    ean: product.ean,
    productName: product.name,
    productPageUrl: product?.offers?.[0]?.sourceUrl ?? null,
    ruleId,
    claimFamily: claim.family,
    quotedClaim: claim.quotedClaim,
    claimSource: claim.claimSource,
    evidence: {
      kind: 'claim-text',
      detail: evidenceDetail,
      sourceUrl: claim.claimSource.sourceUrl ?? product?.offers?.[0]?.sourceUrl ?? null,
    },
    threshold: { rule: rule.threshold, sourceUrl: rule.sourceUrl, sourceQuote: rule.sourceQuote, pageRef: rule.pageRef, heuristic: rule.heuristic ?? undefined, secondarySources: rule.secondarySources },
    verdict: 'unverified',
    confidence: 'high',
    notes: [UNVERIFIED_NOTE, ...notes],
    layer: 'p2-11',
  };
}

export function checkUnverifiedClaim(claim, product) {
  if (claim.family === 'organic') {
    return unverifiedFinding(claim, product, 'CLM-ORGANIC',
      `"${claim.quotedClaim}" — organic certification evidence (certificate under a Codex CXG 32-1999 §6.3-compliant or equivalent system) is NOT published in our data. The claim is regulated (Food Regulations Reg 9(5)) but UNVERIFIED from the evidence we hold — not false.`,
      [
        'Organic is REGULATED (unlike "natural"): the SFA Guide §F.1 requires a certificate. Verification path: request the pack certificate / certification-body listing. Until then the honest verdict is unverified.',
        'No nutrient accusation is made; any panel dispute on this SKU is irrelevant to this non-nutrient check.',
      ]);
  }
  return unverifiedFinding(claim, product, 'CLM-UNREGULATED',
    `"${claim.quotedClaim}" — "${claim.term}" has no SG statutory definition (SFA Guide; general Reg 9 truthfulness only). Not verifiable against nutrient criteria — UNVERIFIED, not false.`,
    [
      'The term is marketing puffery with no regulated criterion; the site reports that nobody regulates it instead of telling the shopper it is false (PRD story 30).',
      'Boundary: "natural" stays with the 7b factual-composition rules; "nutritious" with the nutrient families; serving suggestions and ingredient declarations are never marketing claims.',
    ]);
}

// ---------------------------------------------------------------------------
// Dry-run over the catalogue
// ---------------------------------------------------------------------------

export function runUnverified({ catalogue, sheet }) {
  const sheetByEan = new Map((sheet?.rows ?? []).map((r) => [String(r.ean), r]));
  const findings = [];
  const informational = [];
  let claimsExtracted = 0;
  for (const product of catalogue.products) {
    const sheetRow = sheetByEan.get(String(product.ean));
    const { claims, informational: info } = extractUnverifiedClaims(product, sheetRow);
    claimsExtracted += claims.length;
    informational.push(...info);
    for (const claim of claims) findings.push(checkUnverifiedClaim(claim, product));
  }
  const counts = {
    products: catalogue.products.length,
    claimsExtracted,
    findings: findings.length,
    organic: findings.filter((f) => f.ruleId === 'CLM-ORGANIC').length,
    unregulated: findings.filter((f) => f.ruleId === 'CLM-UNREGULATED').length,
    unverified: findings.filter((f) => f.verdict === 'unverified').length,
    informational: informational.length,
  };
  return { findings, informational, counts };
}