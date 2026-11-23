// HealthHawk P2-10 — structured ingredient parser (pure library, zero deps).
//
// Replaces the ad-hoc extraction seam (7a parseIngredientList / build-app
// splitTopLevelIngredients / 8-occurrences segmentation) with a bracket-aware,
// taxonomy-anchored tree:
//   - every ingredient node carries raw (verbatim span), name, depth/path,
//     annotations, children, and controlled-vocabulary flags;
//   - every percent carries min/max/estimate + EXPLICIT basis (product vs
//     sub-ingredient vs ambiguous) + provenance tier + declared flag;
//   - additive mentions link to the OFF additives taxonomy (data/additives/
//     kb.json) by id (never eNumber alone), mirroring the curated 8-occurrences
//     matching precedence + fortificant exclusions exactly;
//   - wholegrain share sums ONLY declared, exact, product-basis percents on
//     wholegrain-named tokens. Parser estimates (tier 'estimated') and OFF
//     estimates NEVER feed the share. Nested sub-ingredient percents (parent
//     compound declares its own %) are NEVER summed as product share (the
//     Quaker 5 Prebiotic case, docs/reports/p2-da-technical.md §2.1).
//
// Basis rules (documented, deterministic):
//   depth 0                          -> 'product'
//   nearest ancestor declares a %    -> 'sub-ingredient' (relative to it)
//   an ancestor bracket is UNCLOSED  -> 'ambiguous' (withheld, never guessed —
//                                       the 08-curation-review sanctions
//                                       withhold-over-repair for the 5
//                                       malformed-bracket SKUs)
//   otherwise (categorical wrapper   -> 'product' (e.g. "Cereal Grains
//   without its own declared share)     [Wholegrain wheat (36.8%), ...]")
//
// Migration discipline: the claims profile reproduces 7a cleanIngredientText
// byte-for-byte; the decode profile reproduces 8-occurrences cleaning +
// depth-0 comma/newline segmentation byte-for-byte, so additive identities,
// ordinals and position bands stay identical to the curated occurrences.json.
// Improvements (OCR prefix-noise strip, colon-before-bracket, annotation
// recognition, percent basis) are recorded as anomalies/structural deltas and
// shadow-diffed — nothing silently changes meaning (runs/p2-10/shadow-report.md).
//
// Vocabulary regexes are mirrored VERBATIM from scripts/7a-claim-rules.mjs at
// HEAD d6ef2b5; tests/p2-parser-adapter.test.mjs pins source equality so drift
// is caught. Additive matching is mirrored VERBATIM from scripts/8-occurrences.mjs
// (same precedence, aliases, exclusions); tests pin output parity against
// data/additives/occurrences.json.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PARSER_VERSION = '1.0.0';
export const SCHEMA = 'p2-parser/1';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Declared provenance tiers whose stated percentages are label evidence
// (mirrors 7a SCOREABLE_TIERS minus the nutrition-only derived tiers).
export const DECLARED_TIERS = new Set(['label-declared', 'off-label', 'ocr-label']);

// ---------------------------------------------------------------------------
// Controlled vocabulary — mirrored verbatim from 7a-claim-rules.mjs @ d6ef2b5.
// ---------------------------------------------------------------------------

export const WHOLEGRAIN_RE = /\bwhole[\s-]?grain|\bwholegrain|\bwholemeal|\bwhole\s?wheat|\bwhole\s?oat|\brolled\s?oats?\b|\boat\s?flakes?\b|\bvollkorn|\bflocons\s?d[’']?avoine|\bwhole\s?corn|\bwholegrain\s?corn|\bbrown\s?rice|\bblack\s?rice|\bred\s?rice|\bwhole\s?rye|\bwhole\s?barley|(?:^|\s)oats?(?:\s|$|\d)/i;
export const REFINED_RE = /\bcorn\s?semolina|\bcorn\s?grits?|\bcorn\s?flour|\bcorn\s?meal|\bdegermed|\bsemolina|\brice\s?flour|\brice\s?semolina|\bwheat\s?flour|\bwheat\s?starch|\bcorn\s?starch|\bmaize\b|(?:^|\s)corn(?:\s|$|\()|(?:^|\s)rice(?:\s|$|\()/i;
export const FREE_SUGAR_RE = /\b(?:cane\s?sugar|raw\s?sugar|brown\s?sugar|invert\s?sugar|coconut\s?sugar|palm\s?sugar|sugar|glucose\s?syrup|corn\s?syrup|rice\s?syrup|maple\s?syrup|golden\s?syrup|agave|molasses|treacle|jaggery|honey|malt\s?extract|barley\s?malt|malted\s?barley|malt|fructose|dextrose|sucrose|maltose|juice\s?concentrate|concentrated\s?(?:fruit\s?)?juice|fruit\s?juice|caramel(?:ized|ised)?\s?sugar\s?syrup)\b/i;
export const SWEETENER_RE = /\b(?:aspartame|sucralose|saccharin|acesulfame|steviol|stevia|neotame|advantame|alitame|cyclamate)\b/i;
export const SUGAR_ALCOHOL_RE = /\b(?:maltitol|sorbitol|xylitol|erythritol|isomalt|lactitol|mannitol)\b/i;
export const GRAIN_GROUP_RE = /^(?:cereal\s?grains?|cereals?|grains?|cereal\s?flakes?|cereal)\s*[\[({]/i;

const ALLERGEN_CUT = /(?:^|[.;]\s*|\s•\s*|\n)\s*(?:Allergen (?:Information|advice)|Contains?\s*:|May contain|Contain cereals|Contains cereals|Contains cereal\b|Contains gluten|Contains oat\b|Contains wheat\b|Contains milk\b)/i;
const KNOWN_INGREDIENT_WORD = /\b(?:oats?|wheat|corn|rice|barley|rye|sugar|flour|semolina|grits?|milk|honey|malt|molasses|salt|grain|grains|cocoa|chocolate|nuts?|almonds?|pecans?|walnuts?|cashews?|pistachios?|hazelnuts?|oil|raisins?|dates?|cranberr|strawberr|blueberr|banana|goji|longan|sesame|beans?|triticale|buckwheat|starch|syrup|cream|whey|caseinate|vitamin|mineral|antioxidant|emulsifier|stabiliser|stabilizer|flavour|flavor|tocopherol|lecithin|gluten|vollkorn|avoine|weizen|haferflocken|rosinen|nüsse|salz|maize)\b/i;

// ---------------------------------------------------------------------------
// Cleaning profiles (byte-parity with the legacy paths is pinned by tests).
// ---------------------------------------------------------------------------

// EXACT mirror of 7a cleanIngredientText.
export function cleanForClaims(text) {
  if (typeof text !== 'string') return '';
  let t = text.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '');
  t = t.replace(/_/g, '');
  t = t.replace(/^\[ingredients?\]\s*/i, '').replace(/^ingredients?\s*:\s*/i, '');
  t = t.replace(/^[•\s]+/, '');
  const cut = t.search(ALLERGEN_CUT);
  if (cut >= 0) t = t.slice(0, cut);
  return t.replace(/\s+/g, ' ').trim().replace(/[.,;]\s*$/, '');
}

// EXACT mirror of 8-occurrences stripHtml + ingredientList (depth-0 advisory).
const OCC_ADVISORY_RX = /(allergens?\s+(information|advice)|may\s+contain|processed\s+in\s+a\s+facility|contains?\s*:|contain(s)?\s+(cereals?\s+containing\s+gluten|cereal\s+containing\s+gluten|gluten|oats?\b|wheat|soy\b|milk)|with\s+gluten\s+containing\s+cereal|contains\s+prebiotic)/gi;
function stripHtmlOcc(s) {
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/•/g, ' ').replace(/ /g, ' ');
}
function bracketDepths(s) {
  const d = new Array(s.length); let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') { d[i] = depth; depth++; }
    else if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); d[i] = depth; }
    else d[i] = depth;
  }
  return d;
}
export function cleanForDecode(text) {
  if (typeof text !== 'string') return '';
  const s = stripHtmlOcc(text);
  const depths = bracketDepths(s);
  OCC_ADVISORY_RX.lastIndex = 0;
  let m;
  while ((m = OCC_ADVISORY_RX.exec(s))) {
    if (depths[m.index] === 0) return s.slice(0, m.index);
  }
  return s;
}

// EXACT mirror of build-app stripHtmlTags + ingredientListText (SAFETY_ADVISORY_RX).
const APP_ADVISORY_RX = /(allergens?\s+(information|advice)|may\s+contain|processed\s+in\s+a\s+facility|contains?\s*:|contain(s)?\s+(cereals?\s+containing\s+gluten|cereal\s+containing\s+gluten|gluten|oats?\b|wheat|soy\b|milk)|with\s+gluten\s+containing\s+cereal)/gi;
const stripHtmlApp = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/•/g, ' ').replace(/ /g, ' ');
export function cleanForApp(text) {
  if (typeof text !== 'string') return '';
  const s = stripHtmlApp(text);
  const depths = bracketDepths(s);
  APP_ADVISORY_RX.lastIndex = 0;
  let m;
  while ((m = APP_ADVISORY_RX.exec(s))) { if (depths[m.index] === 0) return s.slice(0, m.index); }
  return s;
}

// ---------------------------------------------------------------------------
// Segmentation — depth-counting, identical to the legacy splitters.
// pieces: [{raw, start, end}] offsets relative to the cleaned text.
// ---------------------------------------------------------------------------

function splitPieces(s, baseOffset, splitNewlines) {
  const parts = [];
  let depth = 0, cur = '', curStart = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    const isSep = ch === ',' || (splitNewlines && ch === '\n');
    if (isSep && depth === 0) {
      if (cur.trim()) parts.push({ raw: cur.trim(), start: baseOffset + curStart, end: baseOffset + i });
      cur = ''; curStart = i + 1;
    } else cur += ch;
  }
  if (cur.trim()) parts.push({ raw: cur.trim(), start: baseOffset + curStart, end: baseOffset + s.length });
  return parts;
}

export function splitTopLevel(s, { splitNewlines = false } = {}) {
  return splitPieces(s, 0, splitNewlines).map((p) => p.raw);
}

// bracketsBalanced — exact mirror of 8-occurrences (depth counting, any type).
export function bracketsBalanced(s) {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

// ---------------------------------------------------------------------------
// Percent parsing
// ---------------------------------------------------------------------------

const PCT_NUM = '(\\d+(?:\\.\\d+)?)\\s*%';
const QUAL_BEFORE = /(less\s+than|under|below|at\s+least|minimum|min\.?|maximum|max\.?|approx(?:imately)?|about|~|<|≤|>|≥)\s*$/i;
const QUAL_AFTER = /^\s*(?:or\s+less|or\s+more|max(?:imum)?|min(?:imum)?)/i;

function qualifierFrom(before, after) {
  const b = before.match(QUAL_BEFORE);
  const a = after.match(QUAL_AFTER);
  const q = (b ? b[1] : '').toLowerCase();
  if (/^(less\s+than|under|below|<|≤)$/.test(q) || /^or\s+less$/.test((a?.[0] ?? '').trim().toLowerCase()) || /^(maximum|max\.?)$/.test(q)) return 'lt';
  if (/^(at\s+least|minimum|min\.?|>|≥)$/.test(q) || /^or\s+more$/.test((a?.[0] ?? '').trim().toLowerCase())) return 'gt';
  if (/^(approx(?:imately)?|about|~)$/.test(q)) return 'approx';
  return null;
}

// Parse a percent declaration out of a name-region string (head + inter/trailing
// text, never inside child brackets). Returns {percent, nameRegion, anomalies}.
function parsePercentInRegion(region) {
  const anomalies = [];
  const re = new RegExp(PCT_NUM, 'g');
  const matches = [...region.matchAll(re)];
  if (!matches.length) return { percent: null, nameRegion: region, anomalies };
  if (matches.length > 1) anomalies.push({ type: 'multiple-percents', detail: region.trim() });
  const m = matches[0];
  const value = Number(m[1]);
  const before = region.slice(0, m.index);
  const after = region.slice(m.index + m[0].length);
  const qualifier = qualifierFrom(before, after);
  // "Contains less than 0.5% of X" / "2% or less of the following" — the bound
  // scopes over the FOLLOWING siblings (OFF bug #2989 class), not just this token.
  const scopeFollowing = /(?:less\s+than\s*$|or\s+less\s+of\s+(?:the\s+following\s*)?$)/i.test(before + after)
    || /^\s*of\s+(?:the\s+following\b)?/i.test(after);
  let nameRegion = region;
  if (scopeFollowing) {
    nameRegion = region.replace(/^.*?(?:contains?\s+)?less\s+than\s+\d+(?:\.\d+)?\s*%\s*of\s*/i, '')
      .replace(/^.*?\d+(?:\.\d+)?\s*%\s*or\s+less\s+of\s+(?:the\s+following\s*)?/i, '');
  } else {
    // strip the percent phrase (with qualifier) from the name region
    const phraseStart = before.search(/(?:less\s+than|under|below|at\s+least|minimum|min\.?|maximum|max\.?|approx(?:imately)?|about|~|<|≤|>|≥)\s*$/i);
    const cutStart = phraseStart >= 0 ? phraseStart : m.index;
    let cutEnd = m.index + m[0].length;
    const afterQual = after.match(QUAL_AFTER);
    if (afterQual) cutEnd += afterQual[0].length;
    nameRegion = region.slice(0, cutStart) + ' ' + region.slice(cutEnd);
  }
  const percent = {
    value: qualifier === 'lt' || qualifier === 'gt' ? null : value,
    min: qualifier === 'lt' ? 0 : qualifier === 'gt' ? value : value,
    max: qualifier === 'lt' ? value : qualifier === 'gt' ? null : value,
    estimate: qualifier === 'lt' || qualifier === 'gt' ? null : value,
    qualifier,
    scopeFollowing: scopeFollowing || undefined,
    declared: true,
    raw: m[0].trim(),
  };
  return { percent, nameRegion, anomalies };
}

const PCT_GROUP_RE = new RegExp('^\\s*(?:(?:less\\s+than|under|below|at\\s+least|minimum|min\\.?|maximum|max\\.?|approx(?:imately)?|about|~|<|≤|>|≥)\\s*)?' + PCT_NUM + '\\s*(?:or\\s+less|or\\s+more)?\\s*$', 'i');

// Annotation brackets: allergen/source/colour/function notes, NOT sub-ingredients
// ("(Gluten)", "(Cow's Milk)", "(Contains Milk)", "(Colour)", "(Preservative)").
const ALLERGEN_NOTE_WORDS = /^(?:gluten|soya|soy|milk|cow's milk|barley|wheat|oats?|eggs?|peanuts?|tree\s+nuts?|almonds?|hazelnuts?|cashews?|walnuts?|pecans?|macadamias?|sesame|lupin|sulphites?|fish|shellfish|crustaceans?|molluscs?|celery|mustard)(?:\s+(?:and|&)\s+(?:gluten|soya|soy|milk|barley|wheat|oats?|eggs?|peanuts?|tree\s+nuts?|almonds?|hazelnuts?|cashews?|walnuts?|pecans?|sesame|lupin))*$/i;
function classifyBracketContent(content) {
  const c = content.trim();
  if (PCT_GROUP_RE.test(c)) return { kind: 'percent' };
  if (/^(?:contains|from|source\s+of)\b/i.test(c)) return { kind: 'annotation', noteKind: 'source' };
  if (/^(?:colour|color|preservative|antioxidant|emulsifier|stabiliser|stabilizer|raising\s+agent|anticaking\s+agent|sweetener|flavouring|flavoring)$/i.test(c)) return { kind: 'annotation', noteKind: 'function' };
  if (!c.includes(',') && ALLERGEN_NOTE_WORDS.test(c)) return { kind: 'annotation', noteKind: 'allergen' };
  return { kind: 'children' };
}

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------

function buildNode(piece, depth, path, ancestors, ctx) {
  const { raw } = piece;
  const node = {
    raw,
    name: '',
    depth,
    path,
    percent: null,
    estimate: null,
    annotations: [],
    children: [],
    flags: { wholegrain: false, refined: false, freeSugar: false, sweetener: false, sugarAlcohol: false },
    additiveLinks: [],
    span: { start: piece.start, end: piece.end },
    bracket: null,
  };

  // Walk the raw token: head text, then bracket groups, then inter/trailing text.
  const firstOpener = raw.search(/[\[({]/);
  let nameRegion = firstOpener < 0 ? raw : raw.slice(0, firstOpener);
  let interText = '';
  let lastPercentGroupEnd = -1;
  let i = firstOpener;
  while (i >= 0 && i < raw.length) {
    const open = raw[i];
    // find the matching closer by depth counting (legacy semantics: ANY closer
    // decrements; mismatched types are recorded as anomalies, not re-guessed).
    let d = 1, j = i + 1;
    while (j < raw.length && d > 0) {
      const ch = raw[j];
      if (ch === '(' || ch === '[' || ch === '{') d++;
      else if (ch === ')' || ch === ']' || ch === '}') d--;
      if (d === 0) break;
      j++;
    }
    const closed = j < raw.length;
    const closer = closed ? raw[j] : null;
    if (closed && !((open === '(' && closer === ')') || (open === '[' && closer === ']') || (open === '{' && closer === '}'))) {
      ctx.anomalies.push({ type: 'mismatched-bracket-types', detail: `${open}…${closer} in "${raw.slice(0, 60)}"`, path });
    }
    let content = raw.slice(i + 1, closed ? j : raw.length);
    if (!closed) content = content.replace(/[\])}]\s*$/, ''); // legacy innerContent tolerance
    const cls = classifyBracketContent(content);
    if (cls.kind === 'percent') {
      const inner = parsePercentInRegion(content);
      if (inner.percent) {
        if (node.percent) ctx.anomalies.push({ type: 'multiple-percents', detail: raw, path });
        else node.percent = inner.percent;
      }
    } else if (cls.kind === 'annotation') {
      node.annotations.push({ raw: raw.slice(i, closed ? j + 1 : raw.length), kind: cls.noteKind, text: content.trim() });
    } else {
      node.bracket = { open, close: closer, closed };
      const childPieces = splitPieces(content, piece.start + i + 1, ctx.splitNewlines);
      const childAncestors = [...ancestors, { node, closed }];
      childPieces.forEach((cp, k) => {
        node.children.push(buildNode(cp, depth + 1, `${path}.${k}`, childAncestors, ctx));
      });
    }
    if (cls.kind === 'percent') lastPercentGroupEnd = closed ? j + 1 : raw.length;
    // text between/after bracket groups belongs to the name region unless it is
    // another bracket group
    const next = closed ? j + 1 : raw.length;
    const rest = raw.slice(next);
    const nextOpener = rest.search(/[\[({]/);
    const inter = nextOpener < 0 ? rest : rest.slice(0, nextOpener);
    nameRegion += ' ' + inter;
    interText += ' ' + inter;
    if (!closed) { i = -1; break; }
    i = nextOpener < 0 ? -1 : next + nextOpener;
  }

  // Merged trailing ingredient: a percent group followed by a NEW capitalized
  // ingredient word with no separating comma ("Oats (20%) Sugar", "Corn
  // Semolina (39%)]. Sugar"). The trailing word is a fused sibling, not part
  // of this ingredient's name (contrast OFF #3819 lowercase "en poudre").
  if (node.percent && !node.children.length && lastPercentGroupEnd >= 0) {
    const tail = raw.slice(lastPercentGroupEnd);
    if (/^[\s.)\]}]*[A-ZÄÖÜ]/.test(tail) && /[a-z]{2,}/i.test(tail)) {
      ctx.anomalies.push({ type: 'trailing-merged-text', detail: tail.trim(), path });
      node.mergedText = true;
      nameRegion = nameRegion.slice(0, Math.max(0, nameRegion.length - tail.length));
    }
  }

  // colon-before-bracket (OFF #3617): "name: (...)" == "name (...)"
  if (/:\s*$/.test(nameRegion) && (node.children.length || node.annotations.length || node.percent)) {
    ctx.anomalies.push({ type: 'colon-before-bracket', detail: raw, path });
    nameRegion = nameRegion.replace(/:\s*$/, ' ');
  }
  // malformed merge: a stray closer fused two ingredients into one token and
  // text after the child bracket still carries ingredient words (Milo class).
  if (node.children.length && /[a-z]{3,}/i.test(interText)) {
    ctx.anomalies.push({ type: 'trailing-merged-text', detail: interText.trim(), path });
    node.mergedText = true;
  }

  const pct = parsePercentInRegion(nameRegion);
  if (pct.percent) {
    if (node.percent) ctx.anomalies.push({ type: 'multiple-percents', detail: raw, path });
    else node.percent = pct.percent;
  }
  ctx.anomalies.push(...pct.anomalies.map((a) => ({ ...a, path })));
  node.name = pct.nameRegion.replace(/[()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\.\s*(?:contains?|may\s+contain|allergen|to\s+produce)\b[\s\S]*$/i, '')
    .replace(/[.,;:]\s*$/, '').trim();

  // non-percent quantities (OFF #6132 class): mg/kg etc. are NEVER percents.
  if (/\d+(?:\.\d+)?\s*(?:mg|g|µg|mcg)\s*\/\s*(?:kg|100\s*g|100\s*ml|serving)/i.test(raw)) {
    ctx.anomalies.push({ type: 'non-percent-quantity', detail: raw, path });
  }

  node.flags = {
    wholegrain: WHOLEGRAIN_RE.test(raw),
    refined: !WHOLEGRAIN_RE.test(raw) && REFINED_RE.test(raw),
    freeSugar: FREE_SUGAR_RE.test(raw),
    sweetener: SWEETENER_RE.test(raw),
    sugarAlcohol: SUGAR_ALCOHOL_RE.test(raw),
  };
  return node;
}

function nearestDeclaredAncestor(ancestors) {
  for (let k = ancestors.length - 1; k >= 0; k--) {
    const a = ancestors[k];
    if (!a.closed) return null; // broken chain before any declared ancestor
    if (a.node.percent?.declared && a.node.percent.value !== null) return a;
  }
  return null;
}
function resolveBasis(node, ancestors) {
  if (!ancestors.length) return 'product';
  for (let k = ancestors.length - 1; k >= 0; k--) {
    const a = ancestors[k];
    if (!a.closed) return 'ambiguous';
    if (a.node.percent?.declared && a.node.percent.value !== null) return 'sub-ingredient';
  }
  return 'product';
}
function basisReason(basis, ancestors) {
  if (basis === 'product') return ancestors.length ? 'categorical wrapper without a declared share; percent treated as product-basis (declared within group)' : 'top-level ingredient (depth 0)';
  if (basis === 'sub-ingredient') return 'nearest ancestor compound declares its own percent; this percent is relative to that compound (QUID nesting)';
  return 'an ancestor bracket is unclosed/malformed; basis withheld (ambiguous), never guessed';
}

// Second pass: basis + tier on EVERY percent (and estimate), resolved once the
// whole tree exists (a parent's head percent is parsed after its children).
function resolveAllBases(nodes, ancestors, tier) {
  for (const n of nodes) {
    const basis = resolveBasis(n, ancestors);
    if (n.percent) {
      n.percent.tier = tier;
      n.percent.basis = basis;
      n.percent.basisReason = basisReason(basis, ancestors);
      if (basis === 'sub-ingredient') {
        const rel = nearestDeclaredAncestor(ancestors);
        n.percent.relativeTo = rel ? { path: rel.node.path, name: rel.node.name, percent: rel.node.percent.value } : null;
      }
    }
    n.basis = basis;
    if (n.children.length) resolveAllBases(n.children, [...ancestors, { node: n, closed: n.bracket ? n.bracket.closed : true }], tier);
  }
}

// ---------------------------------------------------------------------------
// OFF-style bounded estimates for UNDECLARED percents (tier 'estimated').
// Heuristic, documented: at each sibling level the budget is 100 (local);
// declared siblings fix their bounds; an undeclared sibling gets min 0 and
// max = 100 − sum(declared sibling mins), capped by the previous sibling's max
// (SG descending-weight order). estimate = (min+max)/2. NEVER feeds share.
// ---------------------------------------------------------------------------

function assignEstimates(nodes, budget = 100) {
  const declaredMinSum = nodes.reduce((s, n) => s + (n.percent?.declared ? (n.percent.min ?? 0) : 0), 0);
  let prevMax = budget;
  for (const n of nodes) {
    if (n.percent?.declared) {
      prevMax = n.percent.max ?? prevMax;
    } else {
      const max = Math.max(0, Math.min(budget - declaredMinSum, prevMax));
      n.estimate = { min: 0, max: round2(max), estimate: round2(max / 2), tier: 'estimated', declared: false, basis: n.basis ?? 'product' };
      prevMax = max;
    }
    if (n.children.length) {
      const childBudget = 100; // children percents are local to the compound
      assignEstimates(n.children, childBudget);
      if (n.percent?.declared && n.percent.value !== null) {
        for (const c of n.children) {
          if (c.estimate) c.estimate.productEquivalent = { estimate: round2(n.percent.value * c.estimate.estimate / 100), tier: 'estimated', declared: false };
        }
      }
    }
  }
}
const round2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------
// Wholegrain share — product-basis DECLARED EXACT percents only.
// ---------------------------------------------------------------------------

export function computeWholegrain(doc) {
  const contributors = [];
  const excluded = [];
  for (const n of doc.flat) {
    const nameWg = WHOLEGRAIN_RE.test(n.name);
    const p = n.percent;
    if (nameWg && p && p.declared && p.value !== null && p.qualifier === null && p.basis === 'product' && DECLARED_TIERS.has(p.tier)) {
      contributors.push({ path: n.path, name: n.name, raw: n.raw, percent: p.value, tier: p.tier });
      continue;
    }
    // Meaning-carrying exclusions: wholegrain-named tokens that do not
    // qualify, AND any token whose percent basis is sub-ingredient/ambiguous
    // (the nested-% bug class) regardless of name — auditable, never silent.
    if (p && (nameWg || p.basis === 'sub-ingredient' || p.basis === 'ambiguous')) {
      excluded.push({
        path: n.path, name: n.name, raw: n.raw, percent: p.value ?? p.max,
        reason: !nameWg ? `not a wholegrain-named ingredient; percent basis ${p.basis} (never a product wholegrain share)`
          : !DECLARED_TIERS.has(p.tier) ? `non-declared provenance tier (${p.tier}) — OFF/estimate tiers never feed share`
            : p.basis === 'sub-ingredient' ? 'sub-ingredient basis (percent of the parent compound, not of the product) — never summed as product share'
              : p.basis === 'ambiguous' ? 'ambiguous basis (unclosed ancestor bracket) — withheld, never guessed'
                : p.qualifier ? `bounded declaration (${p.qualifier}), not an exact share` : 'not an exact declared value',
      });
    } else if (nameWg && !p && n.estimate) {
      excluded.push({ path: n.path, name: n.name, raw: n.raw, percent: null, reason: 'no declared percent; parser estimate (tier estimated) never feeds share' });
    }
  }
  const share = contributors.length ? round2(contributors.reduce((s, c) => s + c.percent, 0)) : null;
  return { share, contributors, excluded };
}

// ---------------------------------------------------------------------------
// Additive taxonomy anchoring — EXACT mirror of 8-occurrences matching.
// ---------------------------------------------------------------------------

export function loadKb(root = ROOT) {
  return JSON.parse(readFileSync(resolve(root, 'data/additives/kb.json'), 'utf8'));
}

function normText(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}
function termRegex(term) {
  const words = normText(term).split(' ').filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return null;
  return new RegExp('(?<![a-z0-9])' + words.join('[\\s]+') + '(?![a-z0-9])', 'i');
}

export const ALIASES = [
  { term: 'mixed tocopherol concentrate', id: 'en:e306', why: "label 'Mixed Tocopherol Concentrate' = tocopherol-rich extract (KB plural 'mixed tocopherols')" },
  { term: 'mixed tocopherol', id: 'en:e306', why: "singular of KB 'mixed tocopherols' (e306)" },
  { term: 'tocopherol', id: 'en:e306', why: "singular antioxidant 'Tocopherol' = tocopherol-rich extract e306 (KB 'Tocopherols'); NOT vitamin-E tocopheryl acetate" },
  { term: 'caramel colour', id: 'en:e150a', why: "British spelling of KB 'caramel color' (e150a plain caramel)" },
  { term: 'turmeric oleoresin', id: 'en:e100', why: "colouring turmeric oleoresin = curcumin e100 (KB 'turmeric extract'); only the '(Colour)' use, not spice turmeric" },
  { term: 'sodium citrate', id: 'en:e331', why: "singular of KB 'Sodium citrates' (e331)" },
  { term: 'monoglycerides', id: 'en:e471', why: "label 'Monoglycerides' = mono- and diglycerides of fatty acids e471" },
  { term: 'annatto extract', id: 'en:e160b', why: "label 'Annatto Extract' = annatto e160b" },
  { term: 'cochineal extract', id: 'en:e120', why: "label 'Cochineal Extract' = cochineal/carmines e120" },
  { term: 'gylcerin', id: 'en:e422', why: "OCR typo of 'Glycerin' (e422 glycerol) on Post Blueberry Morning" },
  { term: 'sillicon dioxide', id: 'en:e551', why: "OCR typo of 'Silicon Dioxide' (e551) on Nestum" },
];

export const FORTIFICANT_EXCLUDE_IDS = {
  'en:e101i': "riboflavin declared only as vitamin B2 fortificant ('Vitamins (...)' / 'Riboflavin (Vitamin B2)'), not the E101 colour",
  'en:e375': 'niacin/nicotinic acid declared only as vitamin B3 fortificant, not a technological additive',
  'en:e450': "matched only via 'Ferric Pyrophosphate' (iron fortificant under 'Minerals'); no technological diphosphate use",
  'en:e917': "potassium iodate declared only as the iodine fortificant in 'Iodized Salt (Sodium Chloride, Potassium Iodate)'",
};

const ENUM_RX = /\b(?:e|ins)\s*-?\s*(\d{3,4})\s*([a-z]?)\s*(\([ivx]{1,4}\)|[ivx]{1,4})?/gi;

export function createAdditiveMatcher(kb) {
  const byId = new Map(kb.additives.map((a) => [a.id, a]));
  const additiveEntries = kb.additives.filter((a) => a.eNumber != null);
  const synonymMatchers = [];
  for (const a of additiveEntries) {
    for (const lang of ['en', 'xx']) {
      for (const t of a.synonyms?.[lang] ?? []) {
        if (/^e[\s-]?\d/i.test(t.trim())) continue;
        const rx = termRegex(t);
        if (rx) synonymMatchers.push({ id: a.id, term: t, rx, priority: 1 });
      }
    }
  }
  const aliasMatchers = ALIASES.map((al) => ({ id: al.id, term: al.term, rx: termRegex(al.term), priority: 2, alias: true }));

  function enumMatches(text) {
    const out = [];
    for (const m of text.matchAll(ENUM_RX)) {
      const suffix = (m[1] + (m[2] || '') + (m[3] || '')).toLowerCase().replace(/[^a-z0-9]/g, '');
      const id = 'en:e' + suffix;
      if (byId.has(id) && byId.get(id).eNumber != null) {
        out.push({ id, start: m.index, end: m.index + m[0].length, term: m[0].trim(), priority: 3, type: 'e-number' });
      }
    }
    return out;
  }

  function matchSegment(seg) {
    const candidates = [...enumMatches(seg)];
    for (const m of [...aliasMatchers, ...synonymMatchers]) {
      const mm = seg.match(m.rx);
      if (mm) candidates.push({ id: m.id, start: mm.index, end: mm.index + mm[0].length, term: mm[0], priority: m.priority, type: m.alias ? 'alias' : 'synonym' });
    }
    candidates.sort((a, b) => b.priority - a.priority || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    const accepted = [];
    for (const c of candidates) {
      if (accepted.some((a) => c.start < a.end && a.start < c.end)) continue;
      if (accepted.some((a) => a.id === c.id)) continue;
      accepted.push(c);
    }
    const enumENumbers = new Set(accepted.filter((a) => a.type === 'e-number').map((a) => byId.get(a.id).eNumber));
    return accepted.filter((a) => a.type === 'e-number' || !enumENumbers.has(byId.get(a.id).eNumber));
  }

  function inFortificantBracket(segment, start) {
    const before = segment.slice(0, start);
    const rx = /(vitamins?(?:\s+(?:and|&)\s+minerals?)?|minerals?|nutrient\s+powder|iodized\s+salt)\s*\(/gi;
    let last = null, m;
    while ((m = rx.exec(before))) last = { end: m.index + m[0].length };
    if (last && !before.slice(last.end).includes(')')) return true;
    return false;
  }

  return { byId, matchSegment, inFortificantBracket };
}

export function positionBand(pos, total) {
  if (total <= 0) return 'unknown';
  const third = Math.ceil(total / 3);
  if (pos <= third) return 'first-third';
  if (pos <= 2 * third) return 'middle-third';
  return 'last-third';
}

export const MALFORMED_BAND_NOTE = "Source ingredient brackets are unclosed/malformed, so the top-level ordinal is unreliable; positionBand withheld ('unknown') to avoid a misleading 'how much' signal. Excerpt may include trailing advisory text swallowed by the unclosed bracket. Additive identity is unaffected.";

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

function flatten(nodes, out = []) {
  for (const n of nodes) { out.push(n); flatten(n.children, out); }
  return out;
}

// "X a% and Y b%" — two percent-bearing conjuncts fused by 'and' with no comma
// (Quaker Prebiotic 'Orange Peel Powder 0.65% and Poria Cocos Powder 0.04%').
// Split into sibling nodes so each percent attaches to its own ingredient.
// Only fires when BOTH conjuncts carry percents — 'Sodium Citrate and Sodium
// Hexametaphosphate' (no percents) stays one token (legacy additive parity).
function splitAndConjuncts(nodes, ctx, depth) {
  const out = [];
  for (const n of nodes) {
    if (n.percent?.declared && !n.children.length && (n.raw.match(/%/g) ?? []).length >= 2 && /\s+and\s+/i.test(n.raw)) {
      const m = n.raw.match(/\s+and\s+(?=[\s\S]*\d+(?:\.\d+)?\s*%)/i);
      if (m) {
        const left = n.raw.slice(0, m.index).trim();
        const right = n.raw.slice(m.index + m[0].length).trim();
        const lStart = n.span.start + n.raw.indexOf(left);
        const rStart = n.span.start + n.raw.indexOf(right, m.index);
        const a = buildNode({ raw: left, start: lStart, end: lStart + left.length }, depth, '', [], ctx);
        const b = buildNode({ raw: right, start: rStart, end: rStart + right.length }, depth, '', [], ctx);
        a.children = splitAndConjuncts(a.children, ctx, depth + 1);
        b.children = splitAndConjuncts(b.children, ctx, depth + 1);
        ctx.anomalies.push({ type: 'and-conjunction-split', detail: n.raw, path: n.path });
        out.push(a, b);
        continue;
      }
    }
    if (n.children.length) n.children = splitAndConjuncts(n.children, ctx, depth + 1);
    out.push(n);
  }
  return out;
}

function assignPaths(nodes, prefix = '') {
  nodes.forEach((n, i) => {
    n.path = prefix ? `${prefix}.${i}` : String(i);
    if (n.children.length) assignPaths(n.children, n.path);
  });
}

// List-start marker after OCR noise prefix (Honey Bunches class):
// "opost consumer brands, llc 6% 6% 10% ingredients: corn, ..." — the noise
// before "ingredients:" is NOT an ingredient list. Stripped ONLY in the claims
// profile and ONLY when the prefix contains no known ingredient word.
function stripNoisePrefix(cleaned, ctx) {
  const m = cleaned.match(/\bingredients?\s*:\s*/i);
  if (!m || m.index === 0) return cleaned;
  const prefix = cleaned.slice(0, m.index);
  if (KNOWN_INGREDIENT_WORD.test(prefix)) {
    ctx.anomalies.push({ type: 'list-start-marker-with-ingredient-prefix', detail: prefix });
    return cleaned;
  }
  ctx.prefixNoise = prefix.trim();
  ctx.anomalies.push({ type: 'ocr-prefix-noise-stripped', detail: prefix.trim() });
  return cleaned.slice(m.index + m[0].length);
}

export function parseStructured(rawText, { profile = 'claims', provenanceTier = 'label-declared', sourceUrl = null, fetchedAt = null, kb = null, matcher = null } = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  const ctx = { anomalies: [], prefixNoise: null, provenanceTier, splitNewlines: profile !== 'claims' };
  let cleaned = profile === 'claims' ? cleanForClaims(rawText) : profile === 'app' ? cleanForApp(rawText) : cleanForDecode(rawText);
  if (profile === 'claims') cleaned = stripNoisePrefix(cleaned, ctx);
  const malformed = !bracketsBalanced(cleaned);
  const pieces = splitPieces(cleaned, 0, ctx.splitNewlines);
  let tree = pieces.map((p, k) => buildNode(p, 0, String(k), [], ctx));
  tree = splitAndConjuncts(tree, ctx, 0);
  assignPaths(tree);
  const flat = flatten(tree);

  resolveAllBases(tree, [], provenanceTier);
  assignEstimates(tree);

  // "less than N% of" bounds scope over following siblings (OFF #2989).
  for (const level of [tree, ...flat.map((n) => n.children).filter((c) => c.length)]) {
    for (let k = 0; k < level.length; k++) {
      const p = level[k].percent;
      if (p?.declared && p.scopeFollowing && p.qualifier === 'lt') {
        for (let j = k + 1; j < level.length; j++) {
          if (!level[j].percent) {
            level[j].inheritedBound = { max: p.max, qualifier: 'lt', tier: p.tier, declared: true, from: level[k].path };
            if (level[j].estimate) {
              level[j].estimate.max = Math.min(level[j].estimate.max, p.max);
              level[j].estimate.estimate = round2(level[j].estimate.max / 2);
            }
          }
        }
      }
    }
  }

  const doc = {
    schema: SCHEMA,
    parserVersion: PARSER_VERSION,
    profile,
    provenanceTier,
    sourceUrl,
    fetchedAt,
    sourceTextSha256: sha256(rawText),
    cleanedText: cleaned,
    prefixNoise: ctx.prefixNoise,
    malformed,
    anomalies: ctx.anomalies,
    tree,
    flat,
    first: null,
    wholegrain: null,
    additives: { links: [], exclusions: [], segments: [] },
  };

  // Effective first ingredient: descend leading grain groups AND empty-name
  // bracket wrappers (the Milo "[Whole Grain Wheat Flour (30.0%), …]" piece —
  // 07a-review issue 6 prefers the innermost wholegrain token for group quotes).
  let first = tree[0] ?? null;
  const isGrainGroup = (n) => GRAIN_GROUP_RE.test(n.raw.replace(/:\s*(?=[\[({])/g, ''));
  while (first && first.children.length && (isGrainGroup(first) || first.name === '' || first.mergedText)) {
    first = first.children[0];
  }
  doc.first = first;
  doc.wholegrain = computeWholegrain(doc);

  // Additive anchoring at the legacy segment granularity (identity + ordinal
  // parity with occurrences.json), then mapped onto tree nodes by span.
  const m = matcher ?? (kb ? createAdditiveMatcher(kb) : null);
  if (m) {
    const segments = pieces;
    segments.forEach((seg, idx) => {
      const hits = m.matchSegment(seg.raw);
      const segRec = { index: idx, raw: seg.raw, position: idx + 1, totalIngredients: segments.length, positionBand: malformed ? 'unknown' : positionBand(idx + 1, segments.length), hits: [] };
      if (malformed) segRec.positionNote = MALFORMED_BAND_NOTE;
      if (/packaging\s+material/i.test(seg.raw)) segRec.useNote = 'Declared for the PACKAGING material, not the food itself — packaging-use antioxidant; decode should not list it as an in-food additive (kept as a label mention, flagged for merge).';
      for (const h of hits) {
        if (FORTIFICANT_EXCLUDE_IDS[h.id]) {
          doc.additives.exclusions.push({ id: h.id, term: h.term, segment: idx, reason: FORTIFICANT_EXCLUDE_IDS[h.id] });
          continue;
        }
        if (m.inFortificantBracket(seg.raw, h.start)) {
          doc.additives.exclusions.push({ id: h.id, term: h.term, segment: idx, reason: 'declared inside a Vitamins/Minerals/Iodized-Salt fortificant bracket' });
          continue;
        }
        const absStart = seg.start + h.start;
        let target = null;
        for (const n of flat) {
          if (n.span.start <= absStart && absStart < n.span.end) {
            if (!target || n.depth > target.depth) target = n;
          }
        }
        const link = { id: h.id, term: h.term, matchType: h.type, segment: idx, nodePath: target?.path ?? null };
        doc.additives.links.push(link);
        if (target) target.additiveLinks.push({ id: h.id, term: h.term, matchType: h.type });
        segRec.hits.push({ id: h.id, term: h.term, matchType: h.type, nodePath: target?.path ?? null });
      }
      doc.additives.segments.push(segRec);
    });
  }
  return doc;
}

// Convenience: parse all three profiles for a catalogue record.
export function parseRecord(product, { kb = null, matcher = null } = {}) {
  const ing = product?.ingredients;
  if (!ing?.text) return null;
  const opts = { provenanceTier: ing.provenanceTier ?? 'label-declared', sourceUrl: ing.sourceUrl ?? null, fetchedAt: ing.fetchedAt ?? null, kb, matcher };
  return {
    ean: String(product.ean),
    productName: product.name,
    claims: parseStructured(ing.text, { ...opts, profile: 'claims' }),
    decode: parseStructured(ing.text, { ...opts, profile: 'decode' }),
    app: parseStructured(ing.text, { ...opts, profile: 'app' }),
  };
}
