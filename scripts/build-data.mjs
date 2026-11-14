#!/usr/bin/env node
// NEAR Parity data build. One command: fetch every source, compute metrics, write
//   data/latest.json, data/snapshots/<UTC timestamp>.json (one per UTC day), data/status.json
// plus caches data/epochs.json, data/boundaries.json, data/wallet-transfers.json.
// Node 22 built-ins only; no keys. Behind a proxy: node --use-env-proxy scripts/build-data.mjs
// Exit codes: 0 = all core sources refreshed, 2 = partial refresh (stale fallbacks written), 1 = crash.
import {
  DAY_MS, metric, parityRequiredDailyVolume, reconcileBurns, safeRatio, sumDaily, toYocto,
  utcWindow, weeklyBuckets, yoctoToNear,
} from './lib/calc.mjs';
import { createStatus, createStore, getJson } from './lib/io.mjs';
import { USAGE_FIELDS, USAGE_URL, changeCorrelation, changePct, leadLag, leadVerdict, llamaWindowSum, parseUsage, priorWindow, windowStat } from './lib/usage.mjs';
import { ARCHIVAL_URLS, blockBefore, createRpc, epochChecks, mapLimit, sampleInflationRates, walkEpochs, walletBalances } from './lib/near.mjs';
import { DASHBOARD_URL, LLAMA, fetchDashboard, fetchLlamaSeries, fetchPrice, fetchTransfers } from './lib/sources.mjs';
import { discoverStakingPools, firstPositiveDay, internalTransfers, walletCreatedAt } from './lib/wallet.mjs';
import { traceMetrics, dailyTraceMetrics } from './lib/trace.mjs';
import { DAILY_TRACE_SQL, DAILY_USAGE_SQL, FRESHNESS_SQL, daysToQuery, gcpAccessToken, mergeDaily, runQuery, sumDays } from './lib/bigquery.mjs';
import { readFile } from 'node:fs/promises';

export const SCHEMA_VERSION = 2;
const BACKFILL_FROM = '2026-02-01T00:00:00.000Z';
const WINDOW_DAYS = 30;
const log = (...a) => console.log(...a);

const store = createStore(new URL('../', import.meta.url));
const { status, set: setStatus } = createStatus();
const startedAt = new Date();
const now = process.env.NEAR_PARITY_NOW ? new Date(process.env.NEAR_PARITY_NOW) : startedAt;
const window = utcWindow(now, WINDOW_DAYS);
const wallet = await store.readJson('config/buyback-wallet.json', null);
const trace = await store.readJson('config/bigquery-trace.json', null);
const prevLatest = await store.readJson('data/latest.json', null);
const prevStatus = await store.readJson('data/status.json', { sources: {} });

// ---------- groups: each returns data or null; failures fall back to the previous good values ----------
const groupErrors = {};
const notes = {}; // non-fatal problems (reported, never make a refresh partial)
// NEAR_PARITY_SIMULATE_FAIL=chain,llama_volume,price,… forces those groups to fail (to test stale fallbacks).
const SIMULATE_FAIL = new Set((process.env.NEAR_PARITY_SIMULATE_FAIL || '').split(',').filter(Boolean));
async function group(name, fn) {
  try {
    if (SIMULATE_FAIL.has(name)) throw new Error('simulated failure (NEAR_PARITY_SIMULATE_FAIL)');
    return await fn();
  } catch (e) {
    groupErrors[name] = e.message;
    log(`! ${name} failed: ${e.message}`);
    return null;
  }
}
const ctx = { setStatus, store, log, notes };
const rpcKey = (url) => (url === ARCHIVAL_URLS[0] ? 'near_archival_rpc' : 'near_archival_rpc_fallback');
const rpc = createRpc(ARCHIVAL_URLS, { onStatus: (ok, http, error, url) => setStatus(rpcKey(url), { ok, http_status: http, error, url }) });

log(`NEAR Parity build ${startedAt.toISOString()} — window ${window.start} → ${window.end} (${WINDOW_DAYS} UTC days, end exclusive)`);

// ---------- 1. NearBlocks: wallet transfers (needed first: they reveal staking pools) ----------
const transfers = await group('nearblocks', () => {
  if (!wallet?.account_id) throw new Error('No wallet configured');
  return fetchTransfers(ctx, wallet.account_id);
});
const transferHistory = transfers ?? (await store.readJson('data/wallet-transfers.json', null));
const pools = wallet?.account_id ? discoverStakingPools(transferHistory?.txns, wallet.account_id) : [];
if (pools.length) log(`  staking pools used by the wallet: ${pools.join(', ')}`);

// ---------- 2. chain: epoch boundaries, supply at period boundaries, wallet balances ----------
const chain = await group('chain', async () => {
  const cache = await store.readJson('data/epochs.json', { records: [] });
  const saveEpochs = (records) => store.writeJson('data/epochs.json', {
    description: 'Per-epoch mint measured at each epoch boundary: supply(first block) − supply(previous block) + burns in the first block. yoctoNEAR strings.',
    source: ARCHIVAL_URLS[0], backfill_from: BACKFILL_FROM, updated_at: new Date().toISOString(), records,
  });
  log('Walking epoch boundaries…');
  const { final, records } = await walkEpochs(rpc, { backfillFrom: BACKFILL_FROM, cached: cache.records, save: saveEpochs, log });
  await sampleInflationRates(rpc, records, { log });
  await saveEpochs(records);
  const fresh = records.length - cache.records.length;
  log(`  ${records.length} boundaries cached (${fresh} new). Final block ${final.height} @ ${final.time}`);

  const buckets = weeklyBuckets(BACKFILL_FROM, window.end);
  const instants = [...new Set([window.start, window.end, ...buckets.flatMap((b) => [b.start, b.end])])].sort();
  const bcache = await store.readJson('data/boundaries.json', { boundaries: {} });
  const missing = instants.filter((i) => !bcache.boundaries[i]);
  log(`  ${instants.length} UTC boundaries needed, ${missing.length} to look up`);
  await mapLimit(missing, 2, async (iso) => {
    const b = await blockBefore(rpc, iso, records, final);
    bcache.boundaries[iso] = { block_height: b.height, block_hash: b.hash, block_time: b.time, total_supply: b.total_supply, wallets: {} };
  });
  const walletErrors = [];
  if (wallet?.account_id) {
    const samePools = (bal) => JSON.stringify(bal?.pools ?? []) === JSON.stringify(pools);
    const need = instants.filter((i) => !samePools(bcache.boundaries[i].wallets?.[wallet.account_id]));
    await mapLimit(need, 2, async (iso) => {
      try { bcache.boundaries[iso].wallets[wallet.account_id] = await walletBalances(rpc, wallet.account_id, bcache.boundaries[iso].block_hash, { pools }); } catch (e) { walletErrors.push(`${iso}: ${e.message}`); }
    });
  }
  bcache.description = 'Last block before each UTC instant (end-exclusive periods), with total supply and wallet balances. yoctoNEAR strings.';
  bcache.updated_at = new Date().toISOString();
  bcache.boundaries = Object.fromEntries(Object.entries(bcache.boundaries).sort(([a], [b]) => a.localeCompare(b)));
  await store.writeJson('data/boundaries.json', bcache);
  return { final, records, checks: epochChecks(records), buckets, boundaries: bcache.boundaries, walletErrors };
});

// ---------- 3. DefiLlama, prices, official dashboard ----------
const llama = {};
for (const [k, [key, url]] of Object.entries(LLAMA)) llama[k] = await group(`llama_${k}`, () => fetchLlamaSeries(ctx, key, url));
const price = await group('price', () => fetchPrice(ctx, { from: BACKFILL_FROM, to: window.end }));
const dashboard = await group('revenue_dashboard', () => fetchDashboard(ctx));
// Daily on-chain buyback trace (BigQuery public NEAR dataset). Optional: runs only where Google sign-in is configured
// (GitHub Actions via Workload Identity Federation); otherwise the stored daily file / fixed snapshot is used.
const bqConf = await store.readJson('config/bigquery.json', null);
const bq = {
  project: process.env.NEAR_PARITY_GCP_PROJECT || bqConf?.project, serviceAccount: process.env.NEAR_PARITY_GCP_SA || bqConf?.service_account,
  provider: process.env.NEAR_PARITY_GCP_PROVIDER || bqConf?.workload_identity_provider,
  maxGbPerDay: bqConf?.max_gb_per_day ?? 2, maxDays: bqConf?.max_days_per_run ?? 35,
  usageFrom: bqConf?.usage_from ?? BACKFILL_FROM.slice(0, 10), usageMaxDays: bqConf?.usage_max_days_per_run ?? 400, usageMaxGbPerDay: bqConf?.usage_max_gb_per_day ?? 0.5,
};
let bqDaily = await store.readJson('data/bigquery-daily.json', null);
let bqUsage = await store.readJson('data/bigquery-usage.json', null);
const bqRun = await group('bigquery', async () => {
  if (!wallet?.account_id || !bq.project) return { skipped: 'not configured' };
  const token = await gcpAccessToken(bq);
  if (!token) return { skipped: 'Google sign-in not available here (runs in GitHub Actions)' };
  const since = new Date(now.getTime() - 3 * DAY_MS).toISOString().slice(0, 10);
  const fresh = await runQuery({ token, project: bq.project, sql: FRESHNESS_SQL, params: { since }, maxBytes: 1e9 });
  const latestUnix = Number(fresh.rows[0]?.latest);
  if (!Number.isFinite(latestUnix)) throw new Error('BigQuery freshness check returned no blocks');
  const winStartDay = window.start.slice(0, 10);
  const state = bqDaily && bqDaily.wallet === wallet.account_id ? bqDaily : { wallet: wallet.account_id, accounts: {}, days: {} };
  const lastDay = state.last_day && state.last_day >= new Date(Date.parse(window.start) - DAY_MS).toISOString().slice(0, 10) ? state.last_day : null;
  const range = daysToQuery({ lastDay, from: winStartDay, latestUnix, maxDays: bq.maxDays });
  const latestIso = new Date(latestUnix * 1000).toISOString();
  const out = { queried: range, latest_block_utc: latestIso, bytes: fresh.bytes };
  // Network usage (transactions, active accounts, contract usage): every complete day since usage_from, once.
  const uRange = daysToQuery({ lastDay: bqUsage?.last_day ?? null, from: bq.usageFrom, latestUnix, maxDays: bq.usageMaxDays });
  if (uRange) {
    const uDays = (Date.parse(uRange.end) - Date.parse(uRange.start)) / DAY_MS;
    const u = await runQuery({ token, project: bq.project, sql: DAILY_USAGE_SQL, params: uRange, maxBytes: uDays * bq.usageMaxGbPerDay * 1e9 });
    const days = { ...(bqUsage?.days || {}) };
    const by = new Map(u.rows.map((r) => [r.day, r]));
    for (let t = Date.parse(uRange.start); t < Date.parse(uRange.end); t += DAY_MS) {
      const d = new Date(t).toISOString().slice(0, 10); const r = by.get(d);
      if (!r) throw new Error(`BigQuery usage: no rows for ${d}`); // every day has transactions; a gap means bad data
      days[d] = { txns: Number(r.txns), active_accounts: Number(r.active_accounts), active_contracts: Number(r.active_contracts), function_calls: Number(r.function_calls) };
    }
    bqUsage = {
      description: 'Daily network usage from the BigQuery public NEAR dataset (scripts/lib/bigquery.mjs, DAILY_USAGE_SQL): transactions, distinct signers, distinct contracts receiving FUNCTION_CALL actions, and function calls, per UTC day.',
      dataset: 'bigquery-public-data.crypto_near_mainnet_us', updated_at: new Date().toISOString(), latest_block_utc: latestIso,
      last_day: new Date(Date.parse(uRange.end) - DAY_MS).toISOString().slice(0, 10), days,
    };
    await store.writeJson('data/bigquery-usage.json', bqUsage);
    log(`  BigQuery usage: ${uRange.start} → ${uRange.end} (${uDays} days), ${(u.bytes / 1e9).toFixed(2)} GB processed`);
    out.usage_queried = uRange; out.bytes += u.bytes;
  }
  if (!range) return out;
  const nDays = (Date.parse(range.end) - Date.parse(range.start)) / DAY_MS;
  const res = await runQuery({
    token, project: bq.project, sql: DAILY_TRACE_SQL, maxBytes: nDays * bq.maxGbPerDay * 1e9,
    params: { start: range.start, end: range.end, wallet: wallet.account_id, known: Object.keys(state.accounts) },
  });
  bqDaily = {
    ...mergeDaily(state, res.rows, range),
    description: 'Daily on-chain buyback trace from the BigQuery public NEAR dataset (scripts/lib/bigquery.mjs, DAILY_TRACE_SQL). Amounts are yoctoNEAR integer strings.',
    dataset: 'bigquery-public-data.crypto_near_mainnet_us', updated_at: new Date().toISOString(), latest_block_utc: latestIso,
  };
  await store.writeJson('data/bigquery-daily.json', bqDaily);
  log(`  BigQuery: ${range.start} → ${range.end} (${nDays} days), ${(res.bytes / 1e9).toFixed(2)} GB processed`);
  return { ...out, bytes: out.bytes + res.bytes, job_id: res.job_id };
});
if (bqRun?.skipped) log(`  BigQuery trace skipped: ${bqRun.skipped}`);
if (bqRun && !bqRun.skipped) setStatus('bigquery', { ok: true, url: 'https://bigquery.googleapis.com' });
else if (groupErrors.bigquery) setStatus('bigquery', { ok: false, error: groupErrors.bigquery, url: 'https://bigquery.googleapis.com' });
// Network usage (NearBlocks daily charts, keyless). Past days are immutable, so a failed fetch falls back to the cache.
const usage = await group('usage', async () => {
  const body = await getJson(setStatus, 'nearblocks_charts', USAGE_URL, { retries: 2 });
  const rows = parseUsage(body.charts, '2025-01-01').filter((r) => r.date < window.end.slice(0, 10));
  if (!rows.length) throw new Error('No usage rows returned');
  await store.writeJson('data/usage.json', {
    description: 'Daily NEAR network usage as reported by NearBlocks (/v1/charts), complete UTC days since 2025-01-01. Field definitions are NearBlocks’ own.',
    source: USAGE_URL, updated_at: new Date().toISOString(), fields: USAGE_FIELDS, rows,
  });
  return { rows };
});
const usageRows = usage?.rows ?? (await store.readJson('data/usage.json', null))?.rows ?? null;
const bqUsageRows = bqUsage?.days ? Object.entries(bqUsage.days).map(([date, d]) => ({ date, ...d })).sort((a, b) => a.date.localeCompare(b.date)) : null;
// Weekly/derived usage prefers BigQuery when it covers the whole range; NearBlocks otherwise (and for 2025).
const bqCovers = (start, end, field = 'txns') => !!bqUsageRows && windowStat(bqUsageRows, field, start, end).value != null;
const usageFor = (start, end) => (bqCovers(start, end) ? bqUsageRows : usageRows);

// ---------- data-derived dates (never hard-coded in the UI) ----------
const meta = {
  backfill_from: BACKFILL_FROM,
  wallet_created_at: walletCreatedAt(transferHistory?.txns, wallet?.account_id) ?? prevLatest?.meta?.wallet_created_at ?? null,
  holders_revenue_labelled_from: firstPositiveDay(llama.holders?.series) ?? prevLatest?.meta?.holders_revenue_labelled_from ?? null,
  staking_pools: pools,
  usage_source: bqCovers(BACKFILL_FROM, window.end) ? 'BigQuery' : 'NearBlocks',
  // Largest single-day fall in daily transactions since backfill_from (a structural break worth showing).
  usage_largest_txn_drop: (() => {
    const r = ((bqCovers(BACKFILL_FROM, window.end) ? bqUsageRows : usageRows) || []).filter((x) => x.date >= BACKFILL_FROM.slice(0, 10) && x.date < window.end.slice(0, 10));
    let best = null;
    for (let i = 1; i < r.length; i++) {
      const a = r[i - 1]; const b = r[i];
      if (!a.txns || b.txns == null) continue;
      const change = (b.txns - a.txns) / a.txns;
      if (!best || change < best.change) best = { from: a.date, to: b.date, txns_before: a.txns, txns_after: b.txns, change, active_accounts_before: a.active_accounts, active_accounts_after: b.active_accounts, active_contracts_before: a.active_contracts, active_contracts_after: b.active_contracts };
    }
    return best;
  })(),
};

// ---------- compute metrics ----------
const W = { period_start: window.start, period_end: window.end };
const M = {}; const groupOf = {};
const set = (key, groups, rec) => { M[key] = rec; groupOf[key] = groups; };
const unavailable = (unit, source, method, reason, extra = {}) => metric({ value: null, unit, ...W, source, method, status: 'unavailable', reason, ...extra });
const SRC_CHAIN = `NEAR mainnet archival RPC (${ARCHIVAL_URLS[0]}): block headers`;

if (chain) {
  const ws = Date.parse(window.start); const we = Date.parse(window.end);
  const inWin = chain.records.filter((r) => { const t = Date.parse(r.start_time); return t >= ws && t < we; });
  const bStart = chain.boundaries[window.start]; const bEnd = chain.boundaries[window.end];
  const rec = reconcileBurns({ mints: inWin.map((r) => r.mint_yocto), supplyStart: bStart.total_supply, supplyEnd: bEnd.total_supply });
  const issuanceNear = yoctoToNear(rec.issuance);
  const lastRate = chain.records.at(-1).max_inflation_rate ?? ['?', '?'];
  const flagged = chain.checks.filter((c) => c.issues.length);
  const ratios = chain.checks.filter((c) => { const t = Date.parse(c.epoch_start_time); return t >= ws && t < we; }).map((c) => c.mint_to_cap_ratio).filter((r) => r != null);
  set('issuance', ['chain'], metric({
    value: issuanceNear, value_yocto: rec.issuance.toString(), unit: 'NEAR', ...W, source: SRC_CHAIN, source_type: 'onchain',
    method: 'Σ over epoch boundaries whose first block falls in the period of [total_supply(first block) − total_supply(previous block) + Σ balance_burnt of chunks included in the first block].',
    status: 'measured', epochs_counted: inWin.length,
    reference_cap: { max_inflation_rate: `${lastRate[0]}/${lastRate[1]}`, note: 'Protocol maximum, shown for comparison only. Not measured issuance.' },
    mint_to_cap_ratio_range: ratios.length ? [Math.min(...ratios), Math.max(...ratios)] : null,
  }));
  set('daily_issuance', ['chain'], metric({ value: issuanceNear / WINDOW_DAYS, unit: 'NEAR/day', ...W, source: SRC_CHAIN, source_type: 'onchain', method: `Measured period issuance ÷ ${WINDOW_DAYS} days.`, status: 'measured' }));
  set('issuance_annualised_rate', ['chain'], metric({
    value: (issuanceNear / yoctoToNear(bStart.total_supply)) * (365 / WINDOW_DAYS), unit: 'fraction per year', ...W, source: SRC_CHAIN, source_type: 'onchain',
    method: `Measured period issuance ÷ total supply at period start × 365/${WINDOW_DAYS}. An observed rate, not the protocol cap.`, status: 'measured',
  }));
  set('supply_start', ['chain'], metric({ value: yoctoToNear(bStart.total_supply), value_yocto: bStart.total_supply, unit: 'NEAR', ...W, source: SRC_CHAIN, source_type: 'onchain', method: `total_supply of block ${bStart.block_height} (last block before period start).`, status: 'measured', block_height: bStart.block_height }));
  set('supply_end', ['chain'], metric({ value: yoctoToNear(bEnd.total_supply), value_yocto: bEnd.total_supply, unit: 'NEAR', ...W, source: SRC_CHAIN, source_type: 'onchain', method: `total_supply of block ${bEnd.block_height} (last block before period end).`, status: 'measured', block_height: bEnd.block_height }));
  set('supply_change', ['chain'], metric({ value: yoctoToNear(rec.supplyChange), value_yocto: rec.supplyChange.toString(), unit: 'NEAR', ...W, source: SRC_CHAIN, source_type: 'onchain', method: 'total_supply(end boundary block) − total_supply(start boundary block). Already net of burns; treasury purchases do not change it.', status: 'measured' }));
  set('derived_burns', ['chain'], metric({
    value: yoctoToNear(rec.derivedBurns), value_yocto: rec.derivedBurns.toString(), unit: 'NEAR', ...W, source: SRC_CHAIN, source_type: 'onchain',
    method: 'Derived: measured issuance − measured supply change over the same period (protocol burns: gas and fees). Not added to supply change again; buybacks are not burns.',
    status: 'measured', derived: true,
  }));
  set('epoch_checks', ['chain'], {
    status: flagged.length ? 'flagged' : 'ok', epochs_checked: chain.checks.length, epochs_flagged: flagged.length,
    flagged: flagged.slice(-20), window_mint_to_cap_ratio: ratios.length ? { min: Math.min(...ratios), max: Math.max(...ratios) } : null,
    method: 'Within each epoch supply must not rise (only burns); boundaries must be one epoch apart; each mint should be ≤ and close to supply × max_inflation_rate × epoch duration ÷ 31,556,952 s (ratio < 0.95 or > 1.001 is flagged).',
  });
} else {
  for (const k of ['issuance', 'daily_issuance', 'issuance_annualised_rate', 'supply_start', 'supply_end', 'supply_change', 'derived_burns']) {
    set(k, ['chain'], unavailable('NEAR', SRC_CHAIN, 'See chain method.', `Chain data failed this run: ${groupErrors.chain}`));
  }
}

const LL = 'DefiLlama (protocol slug near-intents)';
const labelledFrom = meta.holders_revenue_labelled_from ?? 'the start of the buyback program';
const llamaMetric = (key, k, unit, label, status, extraMethod = '') => {
  const s = llama[k] ? sumDaily(llama[k].series, window.start, window.end) : null;
  if (!s) return set(key, [`llama_${k}`], unavailable(unit, LL, label, `DefiLlama ${k} request failed: ${groupErrors[`llama_${k}`]}`, { reported_by: 'DefiLlama' }));
  if (s.sum == null) return set(key, [`llama_${k}`], unavailable(unit, `${LL}: ${llama[k].url}`, label, `${s.missing.length} of ${s.daysExpected} days missing (${s.missing.slice(0, 5).join(', ')}${s.missing.length > 5 ? '…' : ''}).`, { reported_by: 'DefiLlama' }));
  set(key, [`llama_${k}`], metric({ value: s.sum, unit, ...W, source: `${LL}: ${llama[k].url}`, source_type: 'third_party', reported_by: 'DefiLlama', method: `${label} Sum of ${s.daysExpected} daily values.${extraMethod}`, status, days_present: s.daysPresent }));
};
const meth = llama.revenue?.methodology || llama.fees?.methodology || {};
llamaMetric('intents_volume', 'volume', 'USD', 'NEAR Intents swap volume as reported by DefiLlama.', 'measured');
llamaMetric('intents_gross_fees', 'fees', 'USD', `Gross fees. DefiLlama: "${meth.Fees ?? 'n/a'}"`, 'measured');
llamaMetric('intents_net_revenue', 'revenue', 'USD', `Net revenue captured after distributions. DefiLlama: "${meth.Revenue ?? 'n/a'}"`, 'measured');
llamaMetric('intents_holders_revenue', 'holders', 'USD', `DefiLlama holders revenue, labelled as buyback money from ${labelledFrom}. DefiLlama: "${meth.HoldersRevenue ?? 'n/a'}"`, 'proxy', ' A label, not confirmed purchases.');

const v = (k) => (M[k]?.status !== 'unavailable' ? M[k]?.value ?? null : null);
const ratioMetric = (key, groups, num, den, unit, method, status, scale = 1, extra = {}) => {
  const r = safeRatio(v(num), v(den));
  set(key, groups, r == null
    ? unavailable(unit, `Derived from ${num} and ${den}`, method, `Needs both ${num} and ${den} (one is unavailable or zero).`)
    : metric({ value: r * scale, unit, ...W, source: `Derived from ${num} and ${den}`, source_type: 'derived', method, status, ...extra }));
};
ratioMetric('net_revenue_capture_rate', ['llama_revenue', 'llama_volume'], 'intents_net_revenue', 'intents_volume', 'basis points', 'Net revenue ÷ swap volume over the period, in basis points (1 bp = 0.0001).', 'measured', 10_000, { reported_by: 'DefiLlama' });
ratioMetric('buyback_allocation', ['llama_holders', 'llama_revenue'], 'intents_holders_revenue', 'intents_net_revenue', 'percent', 'DefiLlama holders revenue ÷ net revenue over the period. Based on a label, so a proxy for the share used to buy NEAR.', 'proxy', 100, { reported_by: 'DefiLlama' });
set('avg_daily_volume', ['llama_volume'], v('intents_volume') == null
  ? unavailable('USD/day', LL, 'Volume ÷ 30.', 'Volume unavailable.')
  : metric({ value: v('intents_volume') / WINDOW_DAYS, unit: 'USD/day', ...W, source: M.intents_volume.source, source_type: 'third_party', reported_by: 'DefiLlama', method: `Period swap volume ÷ ${WINDOW_DAYS}.`, status: 'measured' }));

if (price) {
  const days = sumDaily([...price.byDay].map(([d, p]) => [Date.parse(`${d}T00:00:00Z`) / 1000, p]), window.start, window.end);
  set('price_avg', ['price'], days.sum == null
    ? unavailable('USD', price.source.name, 'Mean of daily prices.', `${days.missing.length} daily prices missing.`)
    : metric({ value: days.sum / days.daysExpected, unit: 'USD', ...W, source: `${price.source.name}: ${price.source.url}`, source_type: 'third_party', reported_by: price.source.reported_by, method: 'Mean of daily 00:00 UTC prices in the period.', status: 'measured' }));
  set('price_current', ['price'], price.current
    ? metric({ value: price.current.price, unit: 'USD', period_start: price.current.time, period_end: price.current.time, source: `DefiLlama coins API: ${price.current.url}`, source_type: 'third_party', reported_by: 'DefiLlama', method: 'Latest price for coingecko:near.', status: 'measured' })
    : unavailable('USD', 'DefiLlama coins API', 'Latest price.', 'Current price request failed.'));
} else {
  set('price_avg', ['price'], unavailable('USD', 'DefiLlama coins API / CoinGecko', 'Mean of daily prices.', `Price sources failed: ${groupErrors.price}`));
  set('price_current', ['price'], unavailable('USD', 'DefiLlama coins API', 'Latest price.', `Price sources failed: ${groupErrors.price}`));
}

// Buyback proxy in NEAR: daily holders revenue (USD) ÷ that day's price.
function proxyNear(start, end) {
  if (!llama.holders || !price) return null;
  const s = sumDaily(llama.holders.series, start, end);
  if (s.sum == null) return { value: null, missing: s.missing };
  const hv = new Map(llama.holders.series.map(([ts, val]) => [new Date(ts * 1000).toISOString().slice(0, 10), val]));
  let near = 0; const noPrice = [];
  for (const d of [...hv.keys()].filter((d) => d >= start.slice(0, 10) && d < end.slice(0, 10))) {
    const p = price.byDay.get(d);
    if (!p) { noPrice.push(d); continue; }
    near += hv.get(d) / p;
  }
  return noPrice.length ? { value: null, missing: noPrice } : { value: near, missing: [] };
}
const px = proxyNear(window.start, window.end);
set('buyback_proxy_near', ['llama_holders', 'price'], px?.value != null
  ? metric({ value: px.value, unit: 'NEAR', ...W, source: `${LL} dailyHoldersRevenue ÷ daily NEAR price`, source_type: 'derived', reported_by: 'DefiLlama', method: 'Proxy: Σ over days of (DefiLlama holders revenue in USD ÷ NEAR price that day). DefiLlama labels this revenue as buyback money; it is not a confirmed purchase record.', status: 'proxy' })
  : unavailable('NEAR', `${LL} dailyHoldersRevenue ÷ daily NEAR price`, 'Proxy: holders revenue ÷ daily price.', px ? `Missing days: ${px.missing.slice(0, 5).join(', ')}` : 'Holders revenue or price unavailable.'));

// Buyback wallet: net accumulation, excluding moves between NEAR's own revenue wallets.
const walletLabel = wallet?.official_source ? wallet.label : 'unconfirmed wallet';
const related = new Set(wallet?.related_revenue_wallets?.accounts || []);
const internal = (start, end) => internalTransfers({ txns: transferHistory?.txns, ftTxns: transferHistory?.ft_txns, complete: transferHistory?.complete }, wallet?.account_id, related, start, end);
const WALLET_SRC = `${SRC_CHAIN}: view_account, wrap.near ft_balance_of, intents.near mt_balance_of (nep141:wrap.near)${pools.length ? `, staking pools ${pools.join(', ')}` : ''}`;
if (chain && wallet?.account_id) {
  const a = chain.boundaries[window.start].wallets?.[wallet.account_id]; const b = chain.boundaries[window.end].wallets?.[wallet.account_id];
  if (a && b) {
    const net = toYocto(b.total_yocto) - toYocto(a.total_yocto);
    set('wallet_net_accumulation', ['chain'], metric({
      value: yoctoToNear(net), value_yocto: net.toString(), unit: 'NEAR', ...W, source: `${WALLET_SRC} for ${wallet.account_id}`, source_type: 'onchain',
      method: 'Change in NEAR held (native liquid + locked, wNEAR, wNEAR inside intents.near, and NEAR delegated to staking pools) between the period boundary blocks. Net accumulation, not proof of purchases.',
      status: 'measured', wallet: wallet.account_id, wallet_label: walletLabel,
      balance_start_near: yoctoToNear(a.total_yocto), balance_end_near: yoctoToNear(b.total_yocto), staked_end_near: yoctoToNear(b.staked_yocto ?? '0'),
    }));
  }
}
if (!M.wallet_net_accumulation) set('wallet_net_accumulation', ['chain'], unavailable('NEAR', SRC_CHAIN, 'Balance change of the buyback wallet.', chain ? `Wallet balance lookups failed: ${chain.walletErrors.slice(0, 2).join('; ')}` : 'Chain data failed.', { wallet: wallet?.account_id ?? null, wallet_label: walletLabel }));
{
  const it = internal(window.start, window.end);
  if (M.wallet_net_accumulation.status === 'measured' && it) {
    set('wallet_internal_transfers', ['chain', 'nearblocks'], metric({
      value: it.net, unit: 'NEAR', ...W, source: `NearBlocks transfers between ${wallet.account_id} and ${[...related].join(', ')}`, source_type: 'onchain',
      method: 'Inbound minus outbound transfers (native NEAR receipts and wNEAR FT events) between the buyback wallet and the other revenue wallets listed on revenue.near.org.', status: 'measured', transfers: it.count,
    }));
    set('wallet_net_excl_internal', ['chain', 'nearblocks'], metric({
      value: M.wallet_net_accumulation.value - it.net, unit: 'NEAR', ...W, source: `${M.wallet_net_accumulation.source}; NearBlocks transfers`, source_type: 'onchain',
      method: 'Wallet net accumulation (archival RPC balances) minus net transfers from NEAR\'s other listed revenue wallets, so moves between NEAR\'s own wallets are not counted as new buyback NEAR. Still net accumulation, not proof of purchases.',
      status: 'measured', derived: true, wallet: wallet.account_id, wallet_label: walletLabel,
    }));
  } else {
    set('wallet_internal_transfers', ['chain', 'nearblocks'], unavailable('NEAR', 'NearBlocks transfers', 'Internal transfers.', 'Transfer history or wallet balances unavailable.'));
    set('wallet_net_excl_internal', ['chain', 'nearblocks'], unavailable('NEAR', 'Archival RPC balances + NearBlocks transfers', 'Net accumulation minus internal transfers.', 'Wallet balances or transfer history unavailable.'));
  }
}
const rolling = sumDays(bqDaily, window.start, window.end);
const traced = (rolling && dailyTraceMetrics(rolling, window, M.issuance, bqDaily)) || traceMetrics(trace, window);
if (traced) {
  for (const [k, rec] of Object.entries(traced)) set(k, [], rec);
} else {
  set('verified_purchases', [], unavailable('NEAR', 'n/a', 'Would require swap records attributed to the buyback wallet.',
    wallet?.official_source
      ? `The wallet is listed on an official source (${wallet.official_source.url}). Its inflows are native_withdraw intents from many accounts inside NEAR Intents (docs/withdrawer-sample.json); the purchases happen in separate transactions with no keyless public index, so they are not verified.`
      : `The wallet (${wallet?.account_id ?? 'none'}) is not confirmed by an official source, and balance changes alone do not prove purchases.`));
  set('coverage_verified', [], unavailable('ratio', 'n/a', 'Verified NEAR purchased ÷ newly issued NEAR.', 'No verified purchase record exists: wallet inflows from intents.near do not show the swaps behind them.'));
}
ratioMetric('coverage_proxy', ['llama_holders', 'price', 'chain'], 'buyback_proxy_near', 'issuance', 'ratio', 'Proxy: revenue-based buyback estimate (NEAR) ÷ measured issuance (NEAR), same 30 UTC days.', 'proxy');
ratioMetric('coverage_wallet', ['chain', 'nearblocks'], 'wallet_net_excl_internal', 'issuance', 'ratio', `Net accumulation of the ${walletLabel}, excluding transfers from NEAR's other listed revenue wallets, ÷ measured issuance, same 30 UTC days. Not verified purchases.`, 'proxy');

// ---------- network usage (NearBlocks), compared with the previous 30 days ----------
const prior = priorWindow(window.start, window.end);
const PW = { prior_period_start: prior.start, prior_period_end: prior.end };
const USAGE_SRC = `NearBlocks daily charts: ${USAGE_URL}`;
const BQ_USAGE_SRC = 'BigQuery public NEAR dataset (bigquery-public-data.crypto_near_mainnet_us), filtered on block_date: data/bigquery-usage.json';
const BQ_DEF = {
  active_accounts: 'distinct transaction signers per UTC day (transactions.signer_account_id)',
  txns: 'transactions per UTC day (rows of transactions)',
  active_contracts: 'distinct accounts receiving FUNCTION_CALL actions per UTC day (receipt_actions.receipt_receiver_account_id)',
  function_calls: 'FUNCTION_CALL receipt actions per UTC day (receipt_actions)',
};
const usageMetric = (key, field, agg, unit, label) => {
  if (BQ_DEF[field] && bqCovers(prior.start, window.end, field)) {
    const now = windowStat(bqUsageRows, field, window.start, window.end, agg);
    const before = windowStat(bqUsageRows, field, prior.start, prior.end, agg);
    const nb = usageRows ? windowStat(usageRows, field, window.start, window.end, agg).value : null;
    return set(key, [], metric({
      value: now.value, unit, ...W, source: BQ_USAGE_SRC, source_type: 'onchain', reported_by: 'BigQuery',
      method: `${label} Mean of ${now.days} daily values: ${BQ_DEF[field]}. Compared with the previous ${now.days} days. NearBlocks' own figure for the same days is kept as a cross-check (nearblocks_value).`,
      status: 'measured', prior_value: before.value, ...PW, change_pct: changePct(now.value, before.value), nearblocks_value: nb,
    }));
  }
  if (field === 'function_calls') return set(key, [], unavailable(unit, BQ_USAGE_SRC, label, 'BigQuery usage data does not cover this window and the previous one.'));
  if (!usageRows) return set(key, ['usage'], unavailable(unit, USAGE_SRC, label, `NearBlocks charts unavailable: ${groupErrors.usage}`, { reported_by: 'NearBlocks' }));
  const now = windowStat(usageRows, field, window.start, window.end, agg);
  const before = windowStat(usageRows, field, prior.start, prior.end, agg);
  if (now.value == null) return set(key, ['usage'], unavailable(unit, USAGE_SRC, label, `${now.missing.length} of ${now.days} days missing (${now.missing.slice(0, 3).join(', ')}).`, { reported_by: 'NearBlocks' }));
  set(key, ['usage'], metric({
    value: now.value, unit, ...W, source: USAGE_SRC, source_type: 'third_party', reported_by: 'NearBlocks',
    method: `${label} ${agg === 'sum' ? 'Sum' : 'Mean'} of ${now.days} daily values of NearBlocks' "${field}" (NearBlocks' definition). Compared with the previous ${now.days} days.`,
    status: 'measured', prior_value: before.value, ...PW, change_pct: changePct(now.value, before.value),
  }));
};
usageMetric('usage_active_accounts', 'active_accounts', 'mean', 'accounts/day', 'Daily active accounts.');
usageMetric('usage_txns', 'txns', 'mean', 'transactions/day', 'Daily transactions.');
usageMetric('usage_new_accounts', 'new_accounts', 'sum', 'accounts', 'New accounts created.');
usageMetric('usage_active_contracts', 'active_contracts', 'mean', 'contracts/day', 'Daily active contracts.');
usageMetric('usage_function_calls', 'function_calls', 'mean', 'calls/day', 'Daily contract calls.');
if (M.intents_volume?.status === 'measured' && llama.volume) {
  const pv = llamaWindowSum(llama.volume.series, prior.start, prior.end);
  Object.assign(M.intents_volume, { prior_value: pv, ...PW, change_pct: changePct(M.intents_volume.value, pv) });
}

// Transfers summary (NearBlocks)
let transfersSummary = null;
if (transferHistory && wallet?.account_id) {
  const inWin = transferHistory.txns.filter((t) => t.time >= window.start && t.time < window.end);
  const inbound = inWin.filter((t) => t.to === wallet.account_id && t.from !== wallet.account_id && t.deposit_near_approx > 0);
  const outbound = inWin.filter((t) => t.from === wallet.account_id && t.to !== wallet.account_id);
  const byCounterparty = {};
  for (const t of inbound) { const c = (byCounterparty[t.from] ||= { count: 0, deposit_near_approx: 0 }); c.count++; c.deposit_near_approx += t.deposit_near_approx; }
  transfersSummary = {
    ...W, source: transferHistory.source, complete_history: transferHistory.complete, receipts_cached: transferHistory.txns.length,
    ft_events_cached: transferHistory.ft_txns?.length ?? 0, first_receipt_time: transferHistory.txns.at(-1)?.time ?? null,
    inbound_count: inbound.length, outbound_count: outbound.length,
    inbound_by_counterparty: Object.fromEntries(Object.entries(byCounterparty).sort((a, b) => b[1].deposit_near_approx - a[1].deposit_near_approx).slice(0, 10)),
    outbound_recent: outbound.slice(0, 20), staking_pools: pools, stale: transfers ? undefined : true,
    note: 'Inbound transfers from intents.near are native_withdraw intents from many accounts inside NEAR Intents; they are consistent with NEAR bought there, but transfers alone do not show the swap. Receipt amounts are approximate (NearBlocks floats).',
  };
}

// ---------- weekly series for the chart ----------
let series = null;
if (chain) {
  series = chain.buckets.map((bk) => {
    const s = Date.parse(bk.start); const e = Date.parse(bk.end);
    const mints = chain.records.filter((r) => { const t = Date.parse(r.start_time); return t >= s && t < e; }).map((r) => r.mint_yocto);
    const a = chain.boundaries[bk.start]; const b = chain.boundaries[bk.end];
    const rec = reconcileBurns({ mints, supplyStart: a.total_supply, supplyEnd: b.total_supply });
    const wa = a.wallets?.[wallet?.account_id]; const wb = b.wallets?.[wallet?.account_id];
    const p = proxyNear(bk.start, bk.end);
    const walletNet = wa && wb ? yoctoToNear(toYocto(wb.total_yocto) - toYocto(wa.total_yocto)) : null;
    const internalNet = internal(bk.start, bk.end)?.net ?? null;
    return {
      period_start: bk.start, period_end: bk.end, days: bk.days, partial: bk.partial,
      issuance_near: yoctoToNear(rec.issuance), supply_change_near: yoctoToNear(rec.supplyChange), derived_burns_near: yoctoToNear(rec.derivedBurns),
      buyback_proxy_near: p?.value ?? null, buyback_proxy_status: p?.value != null ? 'proxy' : 'unavailable',
      wallet_net_near: walletNet, wallet_internal_near: internalNet,
      wallet_net_excl_internal_near: walletNet != null && internalNet != null ? walletNet - internalNet : null,
      wallet_balance_end_near: wb ? yoctoToNear(wb.total_yocto) : null,
      verified_purchases_near: (() => { const v = sumDays(bqDaily, bk.start, bk.end); return v ? yoctoToNear(v.bought) : null; })(),
      intents_volume_usd: llama.volume ? llamaWindowSum(llama.volume.series, bk.start, bk.end) : null,
      ...(() => {
        const rows = usageFor(bk.start, bk.end);
        const w = (f) => (rows ? windowStat(rows, f, bk.start, bk.end).value : null);
        return { active_accounts_avg: w('active_accounts'), txns_avg: w('txns'), active_contracts_avg: w('active_contracts'), usage_source: rows === bqUsageRows ? 'BigQuery' : rows ? 'NearBlocks' : null };
      })(),
      price_avg_usd: (() => {
        if (!price?.byDay) return null;
        let sum = 0; let n = 0;
        for (let t = s; t < e; t += DAY_MS) { const p = price.byDay.get(new Date(t).toISOString().slice(0, 10)); if (p == null) return null; sum += p; n++; }
        return n ? sum / n : null;
      })(),
    };
  });
}

// ---------- stale fallback: never overwrite good data with nulls ----------
// A metric that is unavailable this run (source failed, or e.g. DefiLlama has not filled the last day yet)
// keeps its previous good value, marked stale with its own period and the reason.
const OPTIONAL_GROUPS = new Set(['revenue_dashboard', 'bigquery']);
const failedGroups = new Set(Object.keys(groupErrors).filter((g) => !OPTIONAL_GROUPS.has(g)));
const stale = {};
for (const [key, rec] of Object.entries(M)) {
  const prev = prevLatest?.metrics?.[key];
  if (!prev || !prev.status || prev.status === 'unavailable' || !['measured', 'estimate', 'proxy'].includes(prev.status)) continue;
  const failedDep = (groupOf[key] || []).find((g) => failedGroups.has(g));
  if (failedDep || rec.status === 'unavailable') {
    M[key] = { ...prev, stale: true, stale_since: prev.stale_since ?? prevLatest.generated_at, stale_reason: failedDep ? `${failedDep} failed this run: ${groupErrors[failedDep]}` : `Unavailable this run: ${rec.reason}` };
    stale[key] = M[key].stale_since;
  }
}
if (!series && prevLatest?.series_weekly) { series = prevLatest.series_weekly.map((r) => ({ ...r, stale: true })); stale.series_weekly = prevLatest.generated_at; }
if (series && prevLatest?.series_weekly) {
  const prevBy = new Map(prevLatest.series_weekly.map((r) => [r.period_start, r]));
  for (const r of series) {
    const p = prevBy.get(r.period_start);
    if (!p) continue;
    if (r.buyback_proxy_near == null && p.buyback_proxy_near != null) { r.buyback_proxy_near = p.buyback_proxy_near; r.buyback_proxy_status = 'proxy'; r.buyback_proxy_stale = true; }
    if (r.wallet_net_excl_internal_near == null && p.wallet_net_excl_internal_near != null) { r.wallet_net_excl_internal_near = p.wallet_net_excl_internal_near; r.wallet_internal_near = p.wallet_internal_near; r.wallet_stale = true; }
    for (const f of ['intents_volume_usd', 'active_accounts_avg', 'txns_avg', 'active_contracts_avg']) if (r[f] == null && p[f] != null) { r[f] = p[f]; r[`${f}_stale`] = true; }
  }
}

// Simulator defaults (conditional scenario inputs), from the metrics after stale fallbacks.
const capBps = v('net_revenue_capture_rate'); const allocPct = v('buyback_allocation');
const simDefaults = { daily_issuance_near: v('daily_issuance'), price_usd: v('price_current') ?? v('price_avg'), net_revenue_capture_bps: capBps, buyback_allocation_pct: allocPct, observed_avg_daily_volume_usd: v('avg_daily_volume') };
const scenario = [simDefaults.daily_issuance_near, simDefaults.price_usd, capBps, allocPct].every((x) => x != null)
  ? parityRequiredDailyVolume({ dailyIssuanceNear: simDefaults.daily_issuance_near, priceUsd: simDefaults.price_usd, captureRate: capBps / 10_000, allocation: allocPct / 100 })
  : { finite: false, value: null, reason: 'Default inputs unavailable.' };
const simulator = {
  formula: 'Required daily volume (USD) = daily issuance (NEAR) × NEAR price (USD) ÷ (net revenue capture rate × buyback allocation)',
  label: 'Conditional scenario under the stated assumptions. Not a prediction and not a supply-neutrality threshold.',
  defaults: simDefaults, default_result: scenario, ...W,
  defaults_stale: ['daily_issuance', 'price_current', 'net_revenue_capture_rate', 'buyback_allocation', 'avg_daily_volume'].some((k) => M[k]?.stale) || undefined,
};

// Official dashboard figure vs the wallet's on-chain holdings now (different scopes; shown, not reconciled away).
let dashboardOut = null;
if (dashboard) {
  const row = dashboard.rows.find((r) => r.account === wallet?.account_id) ?? null;
  let onchainNow = null;
  if (row && chain) {
    try {
      const bal = await walletBalances(rpc, wallet.account_id, chain.final.hash, { pools });
      onchainNow = { block_height: chain.final.height, block_time: chain.final.time, total_near: yoctoToNear(bal.total_yocto), native_near: yoctoToNear(bal.native_yocto), wnear_near: yoctoToNear(bal.wnear_yocto), intents_wnear_near: yoctoToNear(bal.intents_wnear_yocto), staked_near: yoctoToNear(bal.staked_yocto) };
    } catch { /* optional */ }
  }
  dashboardOut = {
    source: `NEAR revenue dashboard (official): ${dashboard.url}`, fetched_at: dashboard.fetched_at, wallet_breakdown: dashboard.rows,
    wallet_row: row, onchain_now: onchainNow, difference_near: row && onchainNow ? onchainNow.total_near - row.near_amount : null,
    note: 'The dashboard attributes captured revenue to wallets; on-chain holdings can differ (other inflows, outflows, timing). Neither figure alone proves purchases.',
  };
} else if (prevLatest?.official_dashboard) {
  dashboardOut = { ...prevLatest.official_dashboard, stale: true, stale_reason: groupErrors.revenue_dashboard };
}
const finalTransfers = transfersSummary ?? (prevLatest?.wallet_transfers ? { ...prevLatest.wallet_transfers, stale: true } : null);

// Do Intents volume and on-chain usage move together week to week? (descriptive, full weeks only)
if (series) {
  const full = series.filter((r) => !r.partial);
  const vol = full.map((r) => r.intents_volume_usd); const acc = full.map((r) => r.active_accounts_avg); const tx = full.map((r) => r.txns_avg);
  const ca = changeCorrelation(vol, acc); const ct = changeCorrelation(vol, tx);
  meta.usage_correlation = {
    intents_volume_vs_active_accounts: ca, intents_volume_vs_txns: ct,
    method: 'Pearson correlation of week-over-week % changes, full 7-day weeks since backfill_from. Descriptive only: no lag, no causality.',
    usage_source: full.every((r) => r.usage_source === 'BigQuery') ? 'BigQuery' : 'NearBlocks',
  };
  // The track hypothesis: is Intents volume a better leading indicator of network usage than NEAR price?
  const px = full.map((r) => r.price_avg_usd);
  const li = { usage_source: meta.usage_correlation.usage_source, weeks: full.length, first_week: full[0]?.period_start ?? null, last_week: full.at(-1)?.period_start ?? null };
  for (const [key, field, label] of [['active_accounts', 'active_accounts_avg', 'daily active accounts'], ['txns', 'txns_avg', 'daily transactions']]) {
    const u = full.map((r) => r[field]);
    const volume = leadLag(vol, u); const priceL = leadLag(px, u);
    li[key] = { volume, price: priceL, verdict: leadVerdict(volume, priceL, label) };
  }
  li.method = 'Week-over-week % changes of Intents volume (DefiLlama) and of the weekly mean NEAR price, at week t, against the change in weekly usage at week t + lag (lag 0–4). Pearson r and Spearman ρ (rank-based, robust to one-off jumps such as 2 Apr 2026). The noise band is ±1.96/√n (about 95%): a lead counts only if both r and ρ are positive and above it. Descriptive, not causal; about 40 weekly points.';
  meta.leading_indicator = li;
}

// ---------- the query behind every figure (reproducible requests, with the actual blocks used) ----------
const RPC0 = ARCHIVAL_URLS[0];
const curlRpc = (body) => `curl -s ${RPC0} -H 'content-type: application/json' \\\n  -d '${JSON.stringify({ jsonrpc: '2.0', id: 1, ...body })}'`;
const firstEpoch = chain?.records.find((r) => Date.parse(r.start_time) >= Date.parse(window.start));
const bS = chain?.boundaries[window.start]; const bE = chain?.boundaries[window.end];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const sqlText = async (rel) => { try { return (await readFile(store.url(rel), 'utf8')).trim(); } catch { return null; } };
const traceSql = [];
for (const [rel, label] of [
  ['queries/bigquery/02-buybacks-30d.sql', 'BigQuery: NEAR delivered to the buyback wallet, and what the accounts behind it bought (swaps)'],
  ['queries/bigquery/03-funding-sources-30d.sql', 'BigQuery: where the rest of their NEAR came from (transfers and deposits, by source)'],
  ['queries/bigquery/04-hub-account-30d.sql', 'BigQuery: every NEAR flow of the hub account behind most of those transfers'],
]) { const code = trace ? await sqlText(rel) : null; if (code) traceSql.push({ label, code }); }
const queries = {
  issuance: firstEpoch ? [
    { label: `First epoch boundary in the window: its first block (${firstEpoch.start_height}) and the block before it (${firstEpoch.prev_height})`, code: `${curlRpc({ method: 'block', params: { block_id: firstEpoch.start_height } })}\n${curlRpc({ method: 'block', params: { block_id: firstEpoch.prev_height } })}` },
    { label: 'Per boundary, then summed over every boundary whose first block falls in the window (all listed in data/epochs.json)', code: 'mint = result.header.total_supply(first) − result.header.total_supply(previous)\n     + Σ result.chunks[].balance_burnt where chunk.height_included == first block height\nissuance = Σ mint   (BigInt, yoctoNEAR)' },
    { label: 'Previous epoch’s last block, from any block (how the walk goes back without the validators method)', code: curlRpc({ method: 'block', params: { finality: 'final' } }) + '\n# result.header.next_epoch_id = hash of the previous epoch’s last block' },
  ] : [],
  supply: bS && bE ? [
    { label: `Total supply at the last block before the window start (${bS.block_height}) and end (${bE.block_height})`, code: `${curlRpc({ method: 'block', params: { block_id: bS.block_height } })}\n${curlRpc({ method: 'block', params: { block_id: bE.block_height } })}` },
    { label: 'Supply change and derived burns', code: 'supply_change = total_supply(end) − total_supply(start)\nburns = issuance − supply_change' },
  ] : [],
  intents: [
    { label: 'DefiLlama daily series (volume, gross fees, net revenue, labelled buyback revenue)', code: Object.values(LLAMA).map(([, u]) => `curl -s '${u}'`).join('\n') },
    { label: 'For each series: sum the 30 daily values in the window (all 30 required)', code: `Σ totalDataChart[i][1] for days ${window.start.slice(0, 10)} … ${new Date(Date.parse(window.end) - 864e5).toISOString().slice(0, 10)}\ncapture_bps = net_revenue ÷ volume × 10,000` },
  ],
  coverage: [
    { label: 'Buyback proxy: labelled buyback revenue (USD) ÷ that day’s NEAR price', code: `curl -s '${LLAMA.holders[1]}'\ncurl -s '${price?.source?.url ?? 'https://coins.llama.fi/chart/coingecko:near'}'\nproxy_near = Σ_day holders_usd(day) ÷ price(day, 00:00 UTC)\ncoverage = proxy_near ÷ issuance` },
    ...(bS && bE && wallet?.account_id ? [{ label: `Buyback wallet holdings at the window’s boundary blocks (${bS.block_height}, ${bE.block_height}); repeat for both`, code: `${curlRpc({ method: 'query', params: { request_type: 'view_account', account_id: wallet.account_id, block_id: bE.block_height } })}\n${curlRpc({ method: 'query', params: { request_type: 'call_function', account_id: 'wrap.near', method_name: 'ft_balance_of', args_base64: b64({ account_id: wallet.account_id }), block_id: bE.block_height } })}\n${curlRpc({ method: 'query', params: { request_type: 'call_function', account_id: 'intents.near', method_name: 'mt_balance_of', args_base64: b64({ account_id: wallet.account_id, token_id: 'nep141:wrap.near' }), block_id: bE.block_height } })}\n# net = Δ(native + locked + wNEAR + wNEAR in intents + staked) − transfers from NEAR's other revenue wallets (NearBlocks)` }] : []),
  ],
  trace: [
    ...(bqDaily?.days ? [{ label: 'BigQuery, run daily by the refresh workflow: per-day NEAR withdrawn to the wallet and swaps by the accounts that fund it (@start, @end, @wallet, @known = accounts already seen)', code: DAILY_TRACE_SQL }] : []),
    ...(traceSql.length ? traceSql : (trace ? [{ label: 'BigQuery SQL', code: (trace.sql || []).join('\n') }] : [])),
  ],
  weekly: [{ label: 'The same calculations per 7-day bucket from 2026-02-01 (boundary blocks in data/boundaries.json)', code: 'issuance_week = Σ mint for boundaries in the week\nproxy_week = Σ_day holders_usd ÷ price\nwallet_week = Δ wallet holdings − internal transfers' }],
  usage: [
    ...(bqUsage?.days ? [{ label: 'BigQuery public NEAR dataset, per UTC day (run by the refresh workflow for each new day; filtered on block_date, the partition column)', code: DAILY_USAGE_SQL }] : []),
    { label: 'NearBlocks daily network charts (keyless; cross-check, and the 2025 baseline)', code: `curl -s '${USAGE_URL}'` },
    { label: 'Weekly values, the index, and the correlation', code: 'active_accounts_week = mean(daily active_accounts)\ntxns_week = mean(daily txns)\nintents_volume_week = Σ DefiLlama daily volume ÷ days\nindex = value ÷ value(first week from 2026-02-01) × 100\nr = pearson(week-over-week % change of volume, of active accounts), full weeks' },
    { label: 'Leading-indicator test (the track hypothesis)', code: 'for lag in 0..4:\n  r(lag)   = pearson(Δ% volume[t], Δ% usage[t + lag])\n  rho(lag) = spearman(same pairs)\n  same for Δ% weekly mean NEAR price\nlead = lag ≥ 1 with r > 1.96/√n and rho > 1.96/√n' },
  ],
  simulator: [{ label: 'Conditional scenario', code: 'required_daily_volume_usd = daily_issuance_near × price_usd ÷ ((capture_bps ÷ 10,000) × (allocation_pct ÷ 100))' }],
};

// ---------- health ----------
const partial = failedGroups.size > 0;
const consecutivePartial = partial ? (prevStatus.consecutive_partial_runs ?? 0) + 1 : 0;
const rpcUsage = Object.fromEntries(Object.entries(rpc.usage).map(([u, x]) => [u, x]));
const fallbackServed = Object.entries(rpc.usage).filter(([u]) => u !== ARCHIVAL_URLS[0]).reduce((a, [, x]) => a + x.served, 0);

// ---------- write outputs ----------
const anyOk = Object.keys(M).some((k) => M[k].status !== 'unavailable' && !M[k].stale);
const generatedAt = new Date().toISOString();
const latest = {
  schema_version: SCHEMA_VERSION,
  generated_at: generatedAt,
  last_successful_refresh: partial ? (prevLatest?.last_successful_refresh ?? null) : generatedAt,
  partial_refresh: partial,
  failed_groups: groupErrors,
  notes,
  health: { consecutive_partial_runs: consecutivePartial, rpc_fallback_calls_served: fallbackServed },
  window: { ...window, note: 'Default comparison: the 30 most recent complete UTC days; start inclusive, end exclusive.' },
  central_question: 'Are NEAR Intents buybacks keeping pace with new NEAR issuance?',
  meta,
  wallet: wallet ? { ...wallet, label_used: walletLabel } : null,
  metrics: M,
  stale,
  simulator,
  series_weekly: series,
  wallet_transfers: finalTransfers,
  official_dashboard: dashboardOut,
  onchain_trace: trace ? (({ description, ...t }) => t)(trace) : null,
  queries,
  sources: [
    { name: 'NEAR mainnet archival RPC (FastNEAR)', url: ARCHIVAL_URLS[0], used_for: 'Epoch boundaries, total supply, burns, protocol config, wallet balances', fallbacks: ARCHIVAL_URLS.slice(1) },
    { name: 'DefiLlama DEX volume API', url: LLAMA.volume[1], used_for: 'NEAR Intents swap volume' },
    { name: 'DefiLlama fees API (dailyFees / dailyRevenue / dailyHoldersRevenue)', url: 'https://api.llama.fi/summary/fees/near-intents', used_for: 'Gross fees, net revenue, holders revenue (buyback proxy)' },
    { name: price?.source?.name ?? 'DefiLlama coins API (coingecko:near)', url: price?.source?.url ?? 'https://coins.llama.fi/chart/coingecko:near', used_for: 'Daily NEAR/USD price (CoinGecko market_chart is the documented fallback)' },
    { name: 'DefiLlama coins current price', url: 'https://coins.llama.fi/prices/current/coingecko:near', used_for: 'Default simulator price' },
    { name: 'NEAR revenue dashboard (official)', url: DASHBOARD_URL, used_for: 'Official listing of the buyback wallet; dashboard-attributed NEAR per wallet (cross-check)' },
    { name: 'NearBlocks API (keyless)', url: 'https://api.nearblocks.io/v1/account/{account}/txns', used_for: 'The buyback wallet’s receipts and FT events' },
    { name: 'NearBlocks network charts (keyless)', url: USAGE_URL, used_for: 'Daily active accounts, transactions, new accounts and active contracts' },
  ],
};
if (!anyOk && prevLatest) {
  log('No fresh data at all; keeping the previous data/latest.json untouched.');
} else {
  await store.writeJson('data/latest.json', latest);
  // One snapshot per UTC day (the first successful build of the day); earlier snapshots are never removed.
  const today = generatedAt.slice(0, 10);
  const existing = (await store.list('data/snapshots/')).filter((f) => f.startsWith(today));
  if (!existing.length) {
    const stamp = generatedAt.replace(/[:]/g, '-').replace(/\.\d+Z$/, 'Z');
    await store.writeJson(`data/snapshots/${stamp}.json`, latest);
    log(`  snapshot data/snapshots/${stamp}.json`);
  }
}
const statusOut = {
  generated_at: generatedAt,
  last_successful_refresh: latest.last_successful_refresh,
  partial_refresh: partial,
  consecutive_partial_runs: consecutivePartial,
  sources: Object.fromEntries(Object.entries({ ...prevStatus.sources, ...status }).map(([k, s]) => [k, {
    ok: status[k] ? status[k].ok !== false : false, http_status: s.http_status ?? null, error: status[k] ? (status[k].ok === false ? s.error : null) : 'not called this run',
    fetched_at: s.fetched_at ?? null, url: s.url ?? null, calls: status[k]?.calls ?? 0, failures: status[k]?.failures ?? 0,
    last_ok_at: status[k]?.ok !== false && status[k] ? s.fetched_at : (prevStatus.sources?.[k]?.last_ok_at ?? null),
  }])),
  failed_groups: groupErrors,
  notes,
  rpc_calls: rpc.calls,
  rpc_usage: rpcUsage,
};
await store.writeJson('data/status.json', statusOut);

// ---------- console summary ----------
const fmt = (k) => { const m = M[k]; return m.status === 'unavailable' ? `unavailable (${m.reason})` : `${typeof m.value === 'number' ? m.value.toLocaleString('en-US', { maximumFractionDigits: 4 }) : m.value} ${m.unit} [${m.status}${m.stale ? ', stale' : ''}]`; };
log('\nSummary', window.start, '→', window.end);
for (const k of Object.keys(M).filter((k) => k !== 'epoch_checks')) log(`  ${k}: ${fmt(k)}`);
if (M.epoch_checks) log(`  epoch_checks: ${M.epoch_checks.epochs_checked} checked, ${M.epoch_checks.epochs_flagged} flagged`);
log(`  simulator default: ${scenario.finite ? `$${Math.round(scenario.value).toLocaleString('en-US')}/day` : scenario.reason}`);
log(`  RPC calls: ${rpc.calls} (fallback served ${fallbackServed}). Failed groups: ${Object.keys(groupErrors).join(', ') || 'none'}. Consecutive partial runs: ${consecutivePartial}`);
if (partial) process.exitCode = 2;
