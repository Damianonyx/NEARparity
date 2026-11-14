#!/usr/bin/env node
// BigQuery check (no data is changed): dataset freshness, the columns this project's SQL relies on, and free
// dry-run cost estimates for each query over typical ranges. Needs Google sign-in: runs in GitHub Actions
// (Workload Identity Federation, see docs/api-access.md) or locally with NEAR_PARITY_GCP_TOKEN.
// Usage: node scripts/check-bigquery.mjs
import { readFile } from 'node:fs/promises';
import { DAILY_TRACE_SQL, DAILY_USAGE_SQL, DATASET, FRESHNESS_SQL, gcpAccessToken, runQuery } from './lib/bigquery.mjs';

const conf = JSON.parse(await readFile(new URL('../config/bigquery.json', import.meta.url), 'utf8'));
const token = await gcpAccessToken({ provider: conf.workload_identity_provider, serviceAccount: conf.service_account });
if (!token) { console.log('No Google sign-in available here; run in GitHub Actions or set NEAR_PARITY_GCP_TOKEN.'); process.exit(0); }
const q = (sql, params = {}, extra = {}) => runQuery({ token, project: conf.project, sql, params, maxBytes: 2e9, ...extra });
const day = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

const fresh = await q(FRESHNESS_SQL, { since: day(3) });
console.log('latest block (UTC):', new Date(Number(fresh.rows[0].latest) * 1000).toISOString());
const cols = await q(`SELECT table_name, column_name, data_type FROM \`${DATASET}.INFORMATION_SCHEMA.COLUMNS\`
  WHERE table_name IN ('transactions', 'receipt_actions') ORDER BY table_name, ordinal_position`);
for (const t of ['transactions', 'receipt_actions']) console.log(`${t}:`, cols.rows.filter((r) => r.table_name === t).map((r) => `${r.column_name}:${r.data_type}`).join(', '));

const ranges = [['1 day', day(2), day(1)], ['60 days', day(61), day(1)], ['since 2026-02-01', '2026-02-01', day(1)], ['since 2025-01-01', '2025-01-01', day(1)]];
for (const [name, sql, params] of [['usage', DAILY_USAGE_SQL, {}], ['trace', DAILY_TRACE_SQL, { wallet: 'buybacks.multisignature.near', known: [] }]]) {
  for (const [label, start, end] of ranges) {
    try {
      const r = await q(sql, { start, end, ...params }, { dryRun: true });
      console.log(`dry run ${name} ${label} (${start} → ${end}): ${(r.bytes / 1e9).toFixed(2)} GB`);
    } catch (e) { console.log(`dry run ${name} ${label}: ERROR ${e.message}`); }
  }
}
