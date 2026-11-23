#!/usr/bin/env node
// HealthHawk slice 14 — LEARN loop assembler (deterministic, read-only).
// Takes the collected evidence JSON (runs/14-learn-inputs-<date>.json, written
// by the agent from Hashmeta MCP reads: get_site_traffic, get_page_search_queries,
// list_form_submissions + data/requests/ local logs) and produces the weekly
// research-cycle input list: runs/reports/learn-<date>.md + .json.
// Never invents demand: empty sources render honest "none yet" lines.
//
// Usage: node scripts/14-learn.mjs --inputs runs/14-learn-inputs-2026-11-21.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const INPUT_TYPES = ['requested-product', 'zero-result-term', 'newsletter-lead', 'coverage-gap', 'seo-opportunity'];

export function validateLearnInputs(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return ['inputs document missing/not an object'];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.date ?? '')) errors.push('date must be YYYY-MM-DD');
  for (const k of ['traffic', 'searchQueries', 'formSubmissions', 'localRequestLogs']) {
    if (!doc.sources?.[k]) errors.push(`sources.${k} missing`);
    else if (typeof doc.sources[k].honestyNote !== 'string' || !doc.sources[k].honestyNote) errors.push(`sources.${k}.honestyNote required (honest low-traffic/empty disclosure)`);
  }
  if (!Array.isArray(doc.researchCycleInputs)) errors.push('researchCycleInputs must be an array');
  else for (const [i, it] of doc.researchCycleInputs.entries()) {
    if (!INPUT_TYPES.includes(it.type)) errors.push(`researchCycleInputs[${i}].type invalid: ${it.type}`);
    if (typeof it.source !== 'string' || !it.source) errors.push(`researchCycleInputs[${i}].source required`);
    if (typeof it.action !== 'string' || !it.action) errors.push(`researchCycleInputs[${i}].action required`);
    if (!('value' in it)) errors.push(`researchCycleInputs[${i}].value required (null = none yet, never invented)`);
  }
  return errors;
}

export function buildLearnReport(doc) {
  const errors = validateLearnInputs(doc);
  if (errors.length) throw new Error(`LEARN inputs invalid: ${errors.join('; ')}`);
  const s = doc.sources;
  const lines = [];
  lines.push(`# LEARN — research-cycle inputs — ${doc.date}`);
  lines.push('');
  lines.push(`Collected: ${doc.collectedAt ?? 'unknown'} · ${doc.collectedBy ?? 'agent'} · deterministic assembly (scripts/14-learn.mjs) from Hashmeta MCP reads + local logs. Empty sources are stated honestly; no demand is invented.`);
  lines.push('');
  lines.push('## What the signals say');
  lines.push('');
  const t = s.traffic;
  lines.push(`- **Traffic:** ${t.last30d?.views ?? 0} views / ${t.last30d?.visitors ?? 0} visitors (last 30 days); today ${t.today?.views ?? 0} views. ${t.honestyNote}`);
  const bots = (t.aiBots ?? []).map((b) => `${b.bot} (${b.purpose}, ${b.fetches} fetches)`).join(', ');
  if (bots) lines.push(`- **AI crawlers:** ${bots} — GEO visibility is starting; content must stay citation-worthy.`);
  lines.push(`- **Search queries:** ${(s.searchQueries.queries ?? []).length} Google queries recorded. ${s.searchQueries.honestyNote}`);
  lines.push(`- **Form submissions:** request-a-product ${s.formSubmissions.requestForm?.totalDocs ?? 0}, newsletter ${s.formSubmissions.newsletterForm?.totalDocs ?? 0}. ${s.formSubmissions.honestyNote}`);
  lines.push(`- **Local zero-result logs:** ${(s.localRequestLogs.files ?? []).length} collected file(s). ${s.localRequestLogs.honestyNote}`);
  lines.push('');
  lines.push('## Research-cycle input list');
  lines.push('');
  lines.push('| Type | Value | Source | Next action |');
  lines.push('|---|---|---|---|');
  for (const it of doc.researchCycleInputs) {
    lines.push(`| ${it.type} | ${it.value ?? '— none yet'} | ${it.source} | ${it.action} |`);
  }
  lines.push('');
  lines.push('## Loop wiring');
  lines.push('');
  lines.push('- Requested products + zero-result terms → catalogue-expansion candidates (research/sourcing role; new SKUs enter via the approval queue, never auto-added).');
  lines.push('- Newsletter leads → weekly healthiest-basket note (runs/reports/basket-<date>.md; sending tool is a founder decision).');
  lines.push('- Analytics + search queries → reviewed weekly (this report) and fed to the content strategist prompt (blog writer) + the Mon 09:00 SGT draft cron (b352dbbf).');
  lines.push('- Honesty rule: near-zero traffic is reported as near-zero; no fabricated demand, no invented requests.');
  lines.push('');
  const md = lines.join('\n');
  return { md, json: { date: doc.date, generatedBy: 'script:14-learn.mjs', inputs: doc.researchCycleInputs, sourceCounts: { trafficViews30d: t.last30d?.views ?? 0, searchQueries: (s.searchQueries.queries ?? []).length, requestSubmissions: s.formSubmissions.requestForm?.totalDocs ?? 0, newsletterSubmissions: s.formSubmissions.newsletterForm?.totalDocs ?? 0, localLogFiles: (s.localRequestLogs.files ?? []).length } } };
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--inputs');
  const inputsPath = i >= 0 ? args[i + 1] : null;
  if (!inputsPath) { console.error('usage: 14-learn.mjs --inputs <runs/14-learn-inputs-*.json>'); process.exit(1); }
  const doc = JSON.parse(readFileSync(resolve(ROOT, inputsPath), 'utf8'));
  const { md, json } = buildLearnReport(doc);
  const dir = resolve(ROOT, 'runs', 'reports');
  mkdirSync(dir, { recursive: true });
  const mdPath = resolve(dir, `learn-${doc.date}.md`);
  const jsonPath = resolve(dir, `learn-${doc.date}.json`);
  writeFileSync(mdPath, md + '\n');
  writeFileSync(jsonPath, JSON.stringify(json, null, 2) + '\n');
  console.log(JSON.stringify({ mdPath, jsonPath, inputs: json.inputs.length, sourceCounts: json.sourceCounts }, null, 2));
}

if (isMain(import.meta.url)) main();