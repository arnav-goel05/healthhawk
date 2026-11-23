// HealthHawk — Nutri-Score 2023 general-foods point tables (AUDITED).
//
// Source of truth: docs/README.md §4 "Scoring — verified & corrected"
// (2023 tables audited: sugars 0–15 pts, salt 0–20, protein 0–7, fibre 0–5,
// energy 335 kJ steps; N>=11 -> drop protein; nuts/oils removed from FVL;
// cutoffs A <=0, B 1–2, C 3–10, D 11–18, E >=19; score range -17…55).
//
// The README carries the audit summary; the exact threshold rows below were
// transcribed line-for-line from the official Santé publique France
// "Nutri-Score Updated algorithm" workbook (4 Apr 2024) as implemented in
// Open Food Facts' reference engine lib/ProductOpener/Nutriscore.pm
// (%points_thresholds_2023, fetched 2026-11-20, see runs/raw/ audit trail in
// docs/reports/01-stageB.md), and verified against the official SPF test
// cases (apple sauce s=0/A, granulated sugar s=20/E, sea salt s=20/E,
// standard cheese N=22 with protein always counted).
//
// 2023 rules implemented here (general-foods branch ONLY, per 100g dry):
// - Negative points N = energy + sugars + saturated fat + salt.
//   Component caps: energy max 10 (>3350 kJ), saturated fat max 10 (>10 g) —
//   the sat-fat/energy negative-point caps of the 2023 tables.
// - Positive points P = FVL + fibre + protein, EXCEPT protein is dropped
//   when N >= 11 (2023 removed the old FVL>=5 exemption — README audit).
// - FVL = fruits/vegetables/legumes % (nuts and oils NO longer qualify).
// - s = N - P; grade cutoffs A <=0, B 1–2, C 3–10, D 11–18, E >=19.
// - No pre-rounding of nutrient values (updated Nutri-Score FAQ: points are
//   assigned on the values as declared).
// - Thresholds are STRICTLY greater-than (value > threshold earns the point).
//
// NOT official Nutri-Score branding: HealthHawk displays "Hawk Grade",
// attributed as "derived using the Nutri-Score 2023 algorithm".

// kJ / 100g — 335 kJ steps, 0–10 points (unchanged from 2017).
export const ENERGY_KJ_THRESHOLDS = [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350];

// g sugars / 100g — 2023 "Sugar Ib" scale, 0–15 points (2017 was 0–10).
export const SUGARS_G_THRESHOLDS = [3.4, 6.8, 10, 14, 17, 20, 24, 27, 31, 34, 37, 41, 44, 48, 51];

// g saturated fat / 100g — 1 g steps, 0–10 points (cap at >10 g).
export const SATURATED_FAT_G_THRESHOLDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// g salt / 100g — 2023 scale, 0.2 g steps, 0–20 points (2017 was 0–10).
export const SALT_G_THRESHOLDS = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6, 2.8, 3.0, 3.2, 3.4, 3.6, 3.8, 4.0];

// mg sodium / 100g — same scale expressed as sodium (salt g = sodium mg / 1000 * 2.5).
export const SODIUM_MG_THRESHOLDS = SALT_G_THRESHOLDS.map((s) => Math.round((s * 1000) / 2.5));

// % fruits/vegetables/legumes — 2023: nuts/oils removed; >40%:1, >60%:2, >80%:5.
export const FVL_PERCENT_THRESHOLDS = [40, 60, 80];
export const FVL_POINTS = [1, 2, 5];

// g fibre / 100g — 2023 "Fibre scenario II" (AOAC), 0–5 points.
export const FIBRE_G_THRESHOLDS = [3.0, 4.1, 5.2, 6.3, 7.4];

// g protein / 100g — 2023 "Protein scenario II", 0–7 points.
export const PROTEIN_G_THRESHOLDS = [2.4, 4.8, 7.2, 9.6, 12, 14, 17];

// 2023 general-foods grade cutoffs (README audit): A <=0, B 1–2, C 3–10, D 11–18, E >=19.
export const GRADE_CUTOFFS = [
  { grade: 'A', max: 0 },
  { grade: 'B', max: 2 },
  { grade: 'C', max: 10 },
  { grade: 'D', max: 18 },
  { grade: 'E', max: Infinity },
];

export const SCORE_MIN = -17; // 0 N - 17 P
export const SCORE_MAX = 55;  // 55 N - 0 P

// Points = count of thresholds strictly exceeded (caps at table length).
export function pointsFor(value, thresholds) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  let pts = 0;
  for (const t of thresholds) if (value > t) pts++;
  return pts;
}

export function gradeForScore(s) {
  for (const { grade, max } of GRADE_CUTOFFS) if (s <= max) return grade;
  return 'E';
}