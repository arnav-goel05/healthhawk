// HealthHawk — SG Nutri-Grade beverage thresholds (A–D), VERIFIED live 2026-11-20.
//
// Evidence cache: runs/raw/nutrigrade-thresholds-evidence.md (URLs + verbatim
// quotes + fetch dates). Official sources:
//   1. HealthHub (HPB-contributed, © MOH Singapore):
//      https://www.healthhub.sg/programmes/nutrition-hub/nutri-grade-mark
//      A: "≤ 1g sugar and no sweetener" / "≤ 0.7g Saturated fat" (*per 100 ml);
//      B: "> 1 to 5g" / "> 0.7 to 1.2g"; C: "> 5 to 10g" / "> 1.2 to 2.8g";
//      D: "> 10g" / "> 2.8g". Worse-of-two: "the final grade will take the
//      poorer … grade" (FAQ).
//   2. HPB "Measures for Nutri-Grade" (last updated 3 Oct 2026):
//      https://www.hpb.gov.sg/healthy-living/food-and-beverage/nutri-grade/
//      Powders/concentrates reconstituted before consumption ARE Nutri-Grade
//      beverages (e.g. 3-in-1 instant coffee). Packaged beverages follow the
//      original 30-Dec-2022 thresholds; the 30-Dec-2023 extension covers
//      freshly prepared drinks (not our packaged SKUs). Figure 1 chart cached
//      at runs/raw/nutrigrade-hpb-fig1-grading-chart-20261120.png (OCR-verified).
//   3. SFA-hosted MOH/HPB consultation responses (new Sixteenth Schedule):
//      https://www.sfa.gov.sg/api/assets/29129c3c-0cd1-4546-bd16-f33a5a37c602
//      (cached runs/raw/nutrigrade-sfa-consultation-responses-20261120.pdf/.txt)
//      - Sweetener floor: beverages containing aspartame/sugar alcohols/other
//        sugar substitutes "will be graded 'B' instead of 'A' even if [they meet]
//        the sugar and saturated fat thresholds".
//      - Reconstitution: grading values are "grams of sugar and saturated fat
//        per 100 ml … as prepared according to instructions indicated by the
//        manufacturer" (Sixteenth Schedule para 6(c)(iv)).
//      - Grading sugar = total sugar minus lactose/galactose DECLARED on the
//        NIP; undeclared amounts are taken as zero (never estimated).
//
// NOT the Nutri-Score beverage branch (PRD Implementation Decisions): this is
// the SG Nutri-Grade system, per 100ml AS CONSUMED. No grade E exists.
// Display remains own-brand "Hawk Grade"; attribution names HPB/MOH thresholds.

export const NUTRIGRADE_ATTRIBUTION =
  'derived using the Singapore Nutri-Grade beverage thresholds (HPB/MOH)';

// g sugar / 100ml as consumed — inclusive upper bounds per the official chart.
export const NUTRIGRADE_SUGAR_G_PER100ML = [
  { grade: 'A', max: 1 },
  { grade: 'B', max: 5 },
  { grade: 'C', max: 10 },
  { grade: 'D', max: Infinity },
];

// g saturated fat / 100ml as consumed.
export const NUTRIGRADE_SATFAT_G_PER100ML = [
  { grade: 'A', max: 0.7 },
  { grade: 'B', max: 1.2 },
  { grade: 'C', max: 2.8 },
  { grade: 'D', max: Infinity },
];

export const NUTRIGRADE_ORDER = ['A', 'B', 'C', 'D']; // best -> worst; no E

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function gradeFromTable(value, table) {
  for (const { grade, max } of table) if (value <= max) return grade;
  return 'D';
}

export function nutriGradeSugar(sugarsGPer100ml) {
  if (!isNum(sugarsGPer100ml) || sugarsGPer100ml < 0) return null;
  return gradeFromTable(sugarsGPer100ml, NUTRIGRADE_SUGAR_G_PER100ML);
}

export function nutriGradeSatFat(satFatGPer100ml) {
  if (!isNum(satFatGPer100ml) || satFatGPer100ml < 0) return null;
  return gradeFromTable(satFatGPer100ml, NUTRIGRADE_SATFAT_G_PER100ML);
}

export function worseNutriGrade(a, b) {
  if (!NUTRIGRADE_ORDER.includes(a) || !NUTRIGRADE_ORDER.includes(b)) return null;
  return NUTRIGRADE_ORDER.indexOf(a) >= NUTRIGRADE_ORDER.indexOf(b) ? a : b;
}

// Pure Nutri-Grade grading, per 100ml AS CONSUMED.
// Required: sugarsG, saturatedFatG (total sugar and sat fat, g/100ml).
// Optional: lactoseG, galactoseG (NIP-declared only; default 0 per HPB rule —
// undeclared amounts are taken as zero, never estimated).
// hasSweetener: boolean when known. When UNKNOWN (undefined/null) the grade is
// still computed if it is B/C/D (sweeteners cannot change those), but a
// threshold-grade of A cannot be confirmed ("no sweetener" is an A condition)
// -> { rated:false } — never fabricate an A.
export function nutriGradeBeverage(inputs) {
  const { sugarsG, saturatedFatG, lactoseG = 0, galactoseG = 0, hasSweetener } = inputs ?? {};
  const missing = [];
  const invalid = [];
  if (!isNum(sugarsG)) missing.push('sugarsG');
  else if (sugarsG < 0) invalid.push('sugarsG');
  if (!isNum(saturatedFatG)) missing.push('saturatedFatG');
  else if (saturatedFatG < 0) invalid.push('saturatedFatG');
  if (missing.length > 0 || invalid.length > 0) {
    const parts = [
      ...missing.map((k) => `${k} (missing)`),
      ...invalid.map((k) => `${k} (negative — impossible nutrient value)`),
    ];
    return { rated: false, reason: `invalid per-100ml inputs: ${parts.join(', ')} — refusing to grade, never clamp-to-0`, missing, invalid };
  }
  if (!isNum(lactoseG) || lactoseG < 0 || !isNum(galactoseG) || galactoseG < 0) {
    return { rated: false, reason: 'lactoseG/galactoseG must be non-negative numbers when provided', missing: [], invalid: ['lactoseG/galactoseG'] };
  }
  const sugarsForGradingG = Math.max(0, sugarsG - lactoseG - galactoseG);
  const sugarGrade = nutriGradeSugar(sugarsForGradingG);
  const satFatGrade = nutriGradeSatFat(saturatedFatG);
  // Defensive: never report rated:true with a null grade (review 03a issue 1).
  if (!sugarGrade || !satFatGrade) {
    return { rated: false, reason: 'ungradeable nutrient values (null component grade)', missing: [], invalid: [] };
  }
  let grade = worseNutriGrade(sugarGrade, satFatGrade);
  const sweetenerKnown = typeof hasSweetener === 'boolean';
  if (grade === 'A' && !sweetenerKnown) {
    return { rated: false, reason: 'sweetener status unknown — grade A requires confirmed "no sweetener"', missing: ['hasSweetener'], sugarGrade, satFatGrade };
  }
  const sweetenerFloorApplied = grade === 'A' && hasSweetener === true;
  if (sweetenerFloorApplied) grade = 'B'; // SFA: sweeteners -> B instead of A
  return {
    rated: true,
    sugarsForGradingG,
    lactoseG,
    galactoseG,
    sugarGrade,
    satFatGrade,
    sweetenerFloorApplied,
    grade,
  };
}