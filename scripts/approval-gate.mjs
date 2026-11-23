// HealthHawk approval gate — shared machine enforcement (fix round, issue 1).
// Single source of truth for "may this grade be public?" — used by score.mjs
// (write path), validate-catalogue.mjs (contract canary) and any later
// publish-sync path. A grade is publishable ONLY when a grade-change item for
// the EAN in pending/ is status 'approved' AND carries a review (approval
// record) AND its proposedGrade matches (null proposedGrade = legacy wildcard).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function readPendingQueue(dir = resolve(ROOT, 'pending')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(readFileSync(resolve(dir, f), 'utf8')); } catch { return null; } })
    .filter((x) => x && typeof x === 'object');
}

export function gradeApproved(queue, ean, grade) {
  return (queue ?? []).some((item) => item.kind === 'grade-change' && item.ean === ean
    && item.status === 'approved' && item.review != null
    && (item.proposedGrade == null || item.proposedGrade === grade));
}