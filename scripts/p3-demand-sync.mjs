#!/usr/bin/env node
// HealthHawk P3-10 — idempotent request-demand queue sync (pull-based).
// Pulls Hashmeta "Request a product" form submissions (read-only MCP
// sync_form_submissions + list_form_submissions, exported to a JSON file by
// the agent) and appends them to a demand queue OUTSIDE data/ (default
// runs/demand/queue.json — runs/ is the existing state/evidence write scope).
// Keyed by submission id: re-runs are byte-identical no-ops.
//
// Each entry carries the inferred department (slice-02 config vocabulary via
// scripts/p3-demand-infer.mjs; catalogue EAN/name match preferred when it
// resolves) + the submission timestamp + the sync timestamp. Unknown products
// are logged honestly as "unclassified". Emails are NEVER stored (PII stays
// in the platform inbox). Zero data/ writes; the write path is machine-guarded
// by the P2-19 role scope (analyst: runs/ + pending/ only).
//
// Usage:
//   node scripts/p3-demand-sync.mjs --submissions <json> \
//     [--queue runs/demand/queue.json] [--catalogue data/catalogue.json] [--root <dir>]
//
// Submission shape (MCP list_form_submissions): {docs|submissions|items:[…]}
// or a bare array; each item carries id, createdAt, form.id and answers as
// submissionData [{field,value}] (normalized by the existing p2-ux-demand
// answersOf/requestKeyOf helpers — reused, not duplicated).

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { DEPARTMENTS } from './departments.config.mjs';
import { answersOf, requestKeyOf } from './p2-ux-demand.mjs';
import { inferDepartment, UNCLASSIFIED } from './p3-demand-infer.mjs';
import { assertWriteScope, guardedWrite } from './p2-skill-scope.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const QUEUE_SCHEMA = 'healthhawk-demand-queue-v1';
export const DEFAULT_QUEUE = 'runs/demand/queue.json';

export function emptyQueue(now) {
  return { schema: QUEUE_SCHEMA, source: 'hashmeta-form-2-request-a-product', updatedAt: now, entries: [] };
}

// Resolve one submission's department. Catalogue match (EAN/name) is the
// strongest evidence — the product's own configured department. Otherwise the
// pure config-vocabulary inference runs on the product text (+ notes context).
// A catalogue department missing from the config is NOT borrowed silently;
// it falls through to inference (honest unclassified if nothing matches).
export function departmentOfSubmission(submission, catalogue, departments = DEPARTMENTS) {
  const key = requestKeyOf(submission, catalogue);
  if (key && (key.via === 'ean' || key.via === 'name') && key.ean) {
    const product = (catalogue?.products ?? []).find((p) => p.ean === key.ean);
    if (product?.department && departments[product.department]) {
      return { department: product.department, departmentVia: 'catalogue', key };
    }
  }
  const a = answersOf(submission);
  const inf = inferDepartment(`${a.product ?? ''} ${a.notes ?? ''}`, departments);
  return { department: inf.department, departmentVia: inf.via, matchedTokens: inf.matchedTokens, key };
}

// Pure idempotent merge. Existing entries are keyed by submissionId; duplicates
// are counted, never re-appended. With zero additions the ORIGINAL doc is
// returned unchanged (byte-identical no-op, updatedAt preserved). Entries are
// canonically sorted (requestedAt, submissionId) so input order never matters.
// Submissions without an id cannot be keyed idempotently → skipped honestly.
// Submissions without a product field are still logged (unclassified) — the
// request happened; only its aisle is unknown.
export function mergeSubmissions(queueDoc, submissions, { catalogue = null, departments = DEPARTMENTS, now } = {}) {
  const base = queueDoc ?? emptyQueue(now);
  const byId = new Map(base.entries.map((e) => [String(e.submissionId), e]));
  const added = [];
  const skipped = [];
  let duplicates = 0;
  for (const s of submissions ?? []) {
    const id = s?.id;
    if (id == null || String(id) === '') { skipped.push({ id: null, reason: 'no submission id (cannot key idempotently)' }); continue; }
    const sid = String(id);
    if (byId.has(sid)) { duplicates += 1; continue; }
    const a = answersOf(s);
    const { department, departmentVia, matchedTokens, key } = departmentOfSubmission(s, catalogue, departments);
    const entry = {
      submissionId: sid,
      formId: s?.form?.id ?? null,
      product: a.product ?? '',
      store: a.store ?? '',
      notes: a.notes ?? '',
      ean: key?.ean ?? null,
      name: key?.name ?? a.product ?? '',
      matchedVia: key?.via ?? null,
      department,
      departmentVia,
      matchedTokens: matchedTokens ?? [],
      requestedAt: s?.createdAt ?? null,
      loggedAt: now,
    };
    byId.set(sid, entry);
    added.push(sid);
  }
  if (added.length === 0) return { doc: base, added, duplicates, skipped };
  const entries = [...byId.values()].sort((x, y) =>
    String(x.requestedAt ?? '').localeCompare(String(y.requestedAt ?? ''))
    || x.submissionId.localeCompare(y.submissionId));
  return { doc: { ...base, updatedAt: now, entries }, added, duplicates, skipped };
}

// Normalize an MCP export file into a submissions array.
export function submissionsOf(doc) {
  if (Array.isArray(doc)) return doc;
  return doc?.docs ?? doc?.submissions ?? doc?.items ?? [];
}

function main() {
  const args = process.argv.slice(2);
  const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const subPath = arg('--submissions');
  if (!subPath) {
    console.error('usage: p3-demand-sync.mjs --submissions <json> [--queue runs/demand/queue.json] [--catalogue data/catalogue.json] [--root <dir>]');
    process.exit(1);
  }
  const root = resolve(arg('--root') ?? ROOT);
  const queueRel = arg('--queue') ?? DEFAULT_QUEUE;
  // Machine write-scope guard: the queue must live in runs/ or pending/ —
  // NEVER data/ (freeze). Refusal happens BEFORE any write.
  assertWriteScope('analyst', queueRel);
  const subDoc = JSON.parse(readFileSync(resolve(root, subPath), 'utf8'));
  const submissions = submissionsOf(subDoc);
  const catPath = arg('--catalogue') ?? 'data/catalogue.json';
  const catalogue = existsSync(resolve(root, catPath)) ? JSON.parse(readFileSync(resolve(root, catPath), 'utf8')) : { products: [] };
  const queuePath = resolve(root, queueRel);
  const existing = existsSync(queuePath) ? JSON.parse(readFileSync(queuePath, 'utf8')) : null;
  const now = new Date().toISOString();
  const { doc, added, duplicates, skipped } = mergeSubmissions(existing, submissions, { catalogue, now });
  if (added.length > 0 || !existing) {
    guardedWrite('analyst', queueRel, JSON.stringify(doc, null, 2) + '\n', { root });
  }
  console.log(JSON.stringify({ queue: queueRel, added: added.length, duplicates, skipped, totalEntries: doc.entries.length, wrote: added.length > 0 || !existing }, null, 2));
}

if (isMain(import.meta.url)) main();