#!/usr/bin/env node
// Data contract check for data/latest.json (see docs/data-api.md). Exits 1 on any violation.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = process.argv[2] || fileURLToPath(new URL('../data/latest.json', import.meta.url));
const L = JSON.parse(readFileSync(file, 'utf8'));
const errors = [];
const need = (cond, msg) => { if (!cond) errors.push(msg); };
const iso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

need(L.schema_version === 2, `schema_version must be 2 (got ${L.schema_version})`);
need(iso(L.generated_at), 'generated_at must be an ISO timestamp');
need(L.last_successful_refresh === null || iso(L.last_successful_refresh), 'last_successful_refresh must be ISO or null');
need(iso(L.window?.start) && iso(L.window?.end) && L.window.days === 30, 'window must have ISO start/end and days = 30');
need(Date.parse(L.window.end) - Date.parse(L.window.start) === 30 * 86_400_000, 'window must span exactly 30 days');
need(L.meta && 'wallet_created_at' in L.meta && 'holders_revenue_labelled_from' in L.meta, 'meta must carry data-derived dates');
const REQUIRED = ['issuance', 'daily_issuance', 'issuance_annualised_rate', 'supply_start', 'supply_end', 'supply_change', 'derived_burns',
  'intents_volume', 'intents_gross_fees', 'intents_net_revenue', 'intents_holders_revenue', 'net_revenue_capture_rate', 'buyback_allocation',
  'avg_daily_volume', 'price_avg', 'price_current', 'buyback_proxy_near', 'wallet_net_accumulation', 'wallet_net_excl_internal',
  'verified_purchases', 'coverage_verified', 'coverage_proxy', 'coverage_wallet'];
for (const k of REQUIRED) need(L.metrics?.[k], `metrics.${k} is required`);
for (const [k, m] of Object.entries(L.metrics || {})) {
  if (k === 'epoch_checks') continue;
  for (const f of ['unit', 'source', 'method', 'status']) need(m[f] != null, `metrics.${k}.${f} is required`);
  need(['measured', 'estimate', 'proxy', 'unavailable'].includes(m.status), `metrics.${k}.status is invalid (${m.status})`);
  if (m.status === 'unavailable') need(m.value === null && typeof m.reason === 'string' && m.reason, `metrics.${k}: unavailable needs value null and a reason`);
  else need(typeof m.value === 'number' && Number.isFinite(m.value), `metrics.${k}: value must be a finite number`);
  if (m.value_yocto != null) need(/^-?\d+$/.test(m.value_yocto), `metrics.${k}.value_yocto must be an integer string`);
  if (m.stale) need(iso(m.stale_since) && m.stale_reason, `metrics.${k}: stale values need stale_since and stale_reason`);
}
const mm = L.metrics;
if (mm.issuance?.value_yocto && mm.supply_change?.value_yocto && mm.derived_burns?.value_yocto && !mm.issuance.stale) {
  need(BigInt(mm.issuance.value_yocto) - BigInt(mm.supply_change.value_yocto) === BigInt(mm.derived_burns.value_yocto), 'burn reconciliation must hold exactly: issuance − supply change = burns');
}
need(Array.isArray(L.series_weekly), 'series_weekly must be an array');
for (const r of L.series_weekly || []) need(iso(r.period_start) && iso(r.period_end) && typeof r.issuance_near === 'number', `series row ${r.period_start} malformed`);
need(L.simulator?.formula && L.simulator?.default_result, 'simulator block is required');
need(Array.isArray(L.sources) && L.sources.length >= 5, 'sources list is required');

if (errors.length) { console.log(`${errors.length} contract violation(s):\n- ${errors.join('\n- ')}`); process.exitCode = 1; }
else console.log(`data contract ok: ${Object.keys(L.metrics).length} metrics, ${L.series_weekly.length} weekly rows, generated ${L.generated_at}`);
