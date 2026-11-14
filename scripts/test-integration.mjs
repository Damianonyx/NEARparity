#!/usr/bin/env node
// Integration tests: run the real build end to end against a simulated network (scripts/fixtures/mock-network.mjs)
// in a temporary copy of the repo, and check every result against values computed independently from the
// simulated chain. No network access, no dependencies. Run: node scripts/test-integration.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BQ, CHAIN, USAGE, WALLET, existingIn, heightAt, missing, supplyAt } from './fixtures/mock-network.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = '2026-11-14T12:00:00.000Z';
async function makeDir() {
  const d = await mkdtemp(join(tmpdir(), 'near-parity-it-'));
  await cp(join(ROOT, 'scripts'), join(d, 'scripts'), { recursive: true });
  await cp(join(ROOT, 'config'), join(d, 'config'), { recursive: true });
  await mkdir(join(d, 'data'), { recursive: true });
  return d;
}
const dir = await makeDir();
const dirs = [dir];

function build(env = {}, d = dir) {
  const r = spawnSync(process.execPath, ['--import', join(d, 'scripts/fixtures/mock-network.mjs'), join(d, 'scripts/build-data.mjs')], {
    // Never use a real Google sign-in from the test runs (the refresh job has an OIDC token): only the fakes in run 5+.
    env: { ...process.env, ACTIONS_ID_TOKEN_REQUEST_URL: '', ACTIONS_ID_TOKEN_REQUEST_TOKEN: '', NEAR_PARITY_GCP_TOKEN: '', NEAR_PARITY_FAST: '1', NEAR_PARITY_NOW: NOW, NEAR_PARITY_RPC_URLS: 'https://fake-archival.test,https://fake-fallback.test', ...env },
    encoding: 'utf8', timeout: 300_000,
  });
  if (r.status !== 0 && r.status !== 2) console.error(r.stdout, r.stderr);
  return r;
}
const read = async (f, d = dir) => JSON.parse(await readFile(join(d, 'data', f), 'utf8'));
const contract = (d) => spawnSync(process.execPath, [join(d, 'scripts/check-data.mjs'), join(d, 'data/latest.json')], { encoding: 'utf8' });

// Independent expectations from the simulated chain.
const lastBefore = (iso) => { let h = heightAt(Date.parse(iso) / 1000) - 1; while (missing(h)) h--; return h; };
const WIN = { start: '2026-10-15T00:00:00.000Z', end: '2026-11-14T00:00:00.000Z' };
const hS = lastBefore(WIN.start); const hE = lastBefore(WIN.end);
const epochsInWindow = 60; // epochs start every 12 h at 00:00 and 12:00 UTC
const expIssuance = CHAIN.MINT * BigInt(epochsInWindow);
const expBurns = CHAIN.BURN * BigInt(existingIn(hS, hE));
const expSupplyChange = supplyAt(hE) - supplyAt(hS);
const near = (y) => Number(y / 10n ** 18n) / 1e6;
const expWalletOrganic = near(BigInt(hE - hS) * WALLET.rate); // growth only; staking is neutral
const internalNear = near(WALLET.internal + WALLET.wnear);

test('run 1: fresh build from an empty data directory', async () => {
  const r = build({ MOCK_NEARBLOCKS_FAIL_PAGE: '2' }); // NearBlocks fails mid-backfill: must pause, not fail
  assert.equal(r.status, 0, r.stdout.slice(-2000));
  const L = await read('latest.json');
  assert.equal(L.schema_version, 2);
  assert.deepEqual([L.window.start, L.window.end], [WIN.start, WIN.end]);
  const m = L.metrics;
  // Exact BigInt reconciliation.
  assert.equal(m.issuance.value_yocto, expIssuance.toString());
  assert.equal(m.issuance.epochs_counted, epochsInWindow);
  assert.equal(m.supply_change.value_yocto, expSupplyChange.toString());
  assert.equal(m.derived_burns.value_yocto, expBurns.toString());
  assert.equal(BigInt(m.issuance.value_yocto) - BigInt(m.supply_change.value_yocto), BigInt(m.derived_burns.value_yocto));
  assert.equal(m.epoch_checks.epochs_flagged, 0, JSON.stringify(m.epoch_checks.flagged?.[0]));
  // Third-party sums and ratios.
  assert.equal(m.intents_volume.value, 30 * 1e8);
  assert.equal(m.intents_volume.reported_by, 'DefiLlama');
  assert.ok(Math.abs(m.net_revenue_capture_rate.value - 5) < 1e-9);
  assert.ok(Math.abs(m.buyback_proxy_near.value - 30 * 5e4 / 2) < 1e-6, 'prices matched to the nearest midnight, incl. 23:59:59 samples');
  assert.ok(Math.abs(m.coverage_proxy.value - (30 * 5e4 / 2) / near(expIssuance)) < 1e-9);
  // Wallet: staking is not an outflow; internal transfers (native + wNEAR) are excluded.
  assert.ok(Math.abs(m.wallet_net_accumulation.value - (expWalletOrganic + internalNear)) < 1e-6, `${m.wallet_net_accumulation.value} vs ${expWalletOrganic + internalNear}`);
  assert.ok(Math.abs(m.wallet_internal_transfers.value - internalNear) < 1e-6);
  assert.ok(Math.abs(m.wallet_net_excl_internal.value - expWalletOrganic) < 1e-6);
  assert.deepEqual(L.meta.staking_pools, [WALLET.pool]);
  assert.equal(L.meta.holders_revenue_labelled_from, '2026-02-23');
  // NearBlocks backfill paused on the failing page and will resume.
  const T = await read('wallet-transfers.json');
  assert.equal(T.complete, false); assert.ok(T.resume_cursor);
  assert.equal(L.notes.nearblocks_backfill, 'HTTP 500');
  // Official dashboard parsed from escaped page data.
  assert.equal(L.official_dashboard.wallet_row.near_amount, 777.5);
  // Simulator defaults derived from the window.
  assert.ok(Math.abs(L.simulator.default_result.value - (near(expIssuance) / 30) * 2 / (5 / 10_000)) < 1e-3);
  // Network usage (NearBlocks charts) vs the previous 30 days, and the detected structural break.
  assert.equal(m.usage_txns.value, USAGE.txnsAfter); assert.equal(m.usage_txns.change_pct, 0);
  assert.equal(m.usage_active_accounts.value, USAGE.accounts);
  assert.equal(m.usage_new_accounts.value, 30 * USAGE.newAccounts);
  assert.equal(m.usage_active_contracts.reported_by, 'NearBlocks');
  assert.equal(m.intents_volume.change_pct, 0);
  assert.deepEqual([L.meta.usage_largest_txn_drop.to, L.meta.usage_largest_txn_drop.txns_after], [USAGE.stepDay, USAGE.txnsAfter]);
  assert.ok(Math.abs(L.meta.usage_largest_txn_drop.change - (USAGE.txnsAfter / USAGE.txnsBefore - 1)) < 1e-12);
  const wk = L.series_weekly.find((r) => r.period_start.startsWith('2026-04-26'));
  assert.equal(wk.txns_avg, USAGE.txnsAfter); assert.equal(wk.intents_volume_usd, 7 * 1e8);
  // Every section ships the query behind it, with the actual blocks used.
  for (const k of ['issuance', 'supply', 'intents', 'coverage', 'weekly', 'usage', 'simulator']) assert.ok(L.queries[k]?.length, `queries.${k}`);
  assert.match(L.queries.supply[0].code, new RegExp(String(L.metrics.supply_start.block_height)));
  // On-chain trace (config/bigquery-trace.json): fixed window equal to this run's window, measured lower bound.
  const trace = JSON.parse(await readFile(join(dir, 'config/bigquery-trace.json'), 'utf8'));
  assert.equal(m.verified_purchases.status, 'measured');
  assert.equal(m.verified_purchases.value, trace.near_bought_in_swaps);
  assert.equal(m.coverage_verified.value, trace.near_bought_in_swaps / trace.issuance_near_in_window, 'divided by the snapshot window issuance');
  assert.equal(m.coverage_verified.snapshot.window_matches_dashboard, true);
  assert.ok(L.queries.trace?.length, 'queries.trace');
  assert.equal(L.onchain_trace.run_on, trace.run_on);
  assert.equal((await readdir(join(dir, 'data/snapshots'))).length, 1);
  const S = await read('status.json');
  assert.equal(S.consecutive_partial_runs, 0);
  assert.equal(S.sources.near_archival_rpc.ok, true);
});

test('run 2: backfill resumes; a missing last day keeps the previous value as stale and the refresh is partial', async () => {
  const before = await read('latest.json');
  const r = build({ MOCK_LLAMA_DROP_LAST_DAY: '1' });
  assert.equal(r.status, 2, 'HTTP 200 with the last day missing is an incomplete refresh');
  const L = await read('latest.json');
  assert.equal(L.partial_refresh, true);
  assert.equal(L.last_successful_refresh, before.last_successful_refresh, 'a partial run does not advance the success time');
  assert.ok(L.notes.incomplete_metrics.includes('intents_holders_revenue'));
  assert.equal((await read('status.json')).consecutive_partial_runs, 1);
  const T = await read('wallet-transfers.json');
  assert.equal(T.complete, true);
  assert.equal(L.meta.wallet_created_at, new Date((WALLET.created + 10) * 1000).toISOString(), 'creation date from the CREATE_ACCOUNT receipt');
  const h = L.metrics.intents_holders_revenue;
  assert.equal(h.stale, true); assert.equal(h.value, 30 * 5e4); assert.match(h.stale_reason, /days missing/);
  assert.equal(L.metrics.coverage_proxy.stale, true);
  assert.equal(L.metrics.intents_volume.stale, undefined, 'unaffected metrics stay fresh');
  assert.equal((await readdir(join(dir, 'data/snapshots'))).length, 1, 'one snapshot per UTC day');
});

test('run 3: a failed source is a partial refresh with stale values, never nulls', async () => {
  const before = await read('latest.json');
  const r = build({ NEAR_PARITY_SIMULATE_FAIL: 'chain' });
  assert.equal(r.status, 2);
  const L = await read('latest.json');
  assert.equal(L.partial_refresh, true);
  assert.equal(L.metrics.issuance.stale, true);
  assert.equal(L.metrics.issuance.value_yocto, expIssuance.toString());
  assert.equal(L.last_successful_refresh, before.last_successful_refresh);
  assert.equal((await read('status.json')).consecutive_partial_runs, 2, 'run 2 and run 3 were both partial');
  assert.ok(Array.isArray(L.series_weekly) && L.series_weekly.length > 30);
});

test('run 4: when the primary RPC is down, the fallback endpoint serves', async () => {
  const r = build({ MOCK_PRIMARY_RPC_DOWN: '1' });
  assert.equal(r.status, 0, r.stdout.slice(-2000));
  const L = await read('latest.json');
  assert.equal(L.metrics.issuance.stale, undefined);
  assert.ok(L.health.rpc_fallback_calls_served > 0);
  const S = await read('status.json');
  assert.equal(S.sources.near_archival_rpc.ok, false);
  assert.equal(S.sources.near_archival_rpc_fallback.ok, true);
  assert.equal(S.consecutive_partial_runs, 0);
});

const GCP = { NEAR_PARITY_GCP_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/github/providers/nearparity', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fake-oidc.test/token?api-version=2.0', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req-token' };

test('run 5: daily BigQuery trace (keyless sign-in) backfills the window and replaces the snapshot', async () => {
  const r = build(GCP);
  assert.equal(r.status, 0, r.stdout.slice(-2000));
  assert.match(r.stdout, /BigQuery: 2026-10-15 → 2026-11-14 \(30 days\)/);
  const D = await read('bigquery-daily.json');
  assert.equal(Object.keys(D.days).length, 30); assert.equal(D.last_day, '2026-11-13');
  assert.deepEqual(D.accounts, { 'acc-a': '2026-10-15', 'acc-b': '2026-10-15' });
  const L = await read('latest.json'); const m = L.metrics;
  const bought = near(BQ.boughtPerDay * 30n);
  assert.equal(m.verified_purchases.status, 'measured');
  assert.equal(m.verified_purchases.value_yocto, (BQ.boughtPerDay * 30n).toString(), 'BigInt sum of daily yocto strings');
  assert.ok(Math.abs(m.verified_purchases.value - bought) < 1e-6);
  assert.ok(m.verified_purchases.daily, 'rolling, not the fixed snapshot');
  assert.equal(m.verified_purchases.period_start, WIN.start);
  assert.ok(Math.abs(m.coverage_verified.value - bought / near(expIssuance)) < 1e-12, 'divided by this window’s issuance');
  assert.ok(Math.abs(m.trace_withdrawn_to_wallet.value - near(BQ.withdrawnPerDay * 30n)) < 1e-6);
  assert.match(L.queries.trace[0].code, /@known/);
  const wk = L.series_weekly.find((w) => w.period_start.startsWith('2026-10-18'));
  assert.ok(Math.abs(wk.verified_purchases_near - near(BQ.boughtPerDay * 7n)) < 1e-6, 'weekly verified series where every day is traced');
  assert.equal(L.series_weekly.find((w) => w.period_start.startsWith('2026-02-01')).verified_purchases_near, null, 'untraced weeks stay null');
  assert.equal((await read('status.json')).sources.bigquery.ok, true);
  // Network usage from BigQuery (backfilled since backfill_from), NearBlocks kept as a cross-check.
  assert.match(r.stdout, /BigQuery usage: 2026-02-01 → 2026-11-14 \(286 days\)/);
  assert.equal(m.usage_active_accounts.reported_by, 'BigQuery');
  assert.equal(m.usage_active_accounts.value, BQ.usage.active_accounts);
  assert.equal(m.usage_active_accounts.nearblocks_value, USAGE.accounts);
  assert.equal(m.usage_txns.value, BQ.usage.txns); assert.equal(m.usage_function_calls.value, BQ.usage.function_calls);
  assert.equal(L.meta.usage_source, 'BigQuery');
  assert.equal(L.series_weekly[0].usage_source, 'BigQuery'); assert.equal(L.series_weekly[0].txns_avg, BQ.usage.txns);
  assert.match(L.queries.usage[0].code, /block_date >= @start/);
  // The leading-indicator test runs on the BigQuery weekly series (flat simulated usage → no lead).
  const li = L.meta.leading_indicator;
  assert.equal(li.usage_source, 'BigQuery'); assert.equal(li.active_accounts.volume.length, 5);
  assert.equal(li.active_accounts.verdict.supports_hypothesis, false);
  assert.ok(typeof L.series_weekly[0].price_avg_usd === 'number');
});

test('run 6: nothing new to query → no BigQuery trace query, figures kept', async () => {
  const r = build(GCP);
  assert.equal(r.status, 0, r.stdout.slice(-2000));
  assert.doesNotMatch(r.stdout, /BigQuery: \d{4}/);
  assert.ok((await read('latest.json')).metrics.verified_purchases.daily);
});

test('run 7: next day → queries one new day with the known accounts; sign-in failure is optional, never partial', async () => {
  const r = build({ ...GCP, NEAR_PARITY_NOW: '2026-11-15T12:00:00.000Z' });
  assert.equal(r.status, 0, r.stdout.slice(-2000));
  assert.match(r.stdout, /BigQuery: 2026-11-14 → 2026-11-15 \(1 days\)/);
  assert.match(r.stdout, /BigQuery usage: 2026-11-14 → 2026-11-15 \(1 days\)/);
  const D = await read('bigquery-daily.json');
  assert.equal(D.last_day, '2026-11-14'); assert.equal(Object.keys(D.accounts).length, 2);
  const L = await read('latest.json');
  assert.equal(L.metrics.verified_purchases.period_start, '2026-10-16T00:00:00.000Z');
  const bad = build({ ...GCP, NEAR_PARITY_NOW: '2026-11-15T12:00:00.000Z', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'wrong' });
  assert.equal(bad.status, 0, 'BigQuery is an optional source');
  assert.equal((await read('latest.json')).partial_refresh, false);
  assert.match((await read('latest.json')).failed_groups.bigquery, /OIDC/);
});

// ---------- regressions from the external audit (each in a fresh workspace) ----------
test('audit 1: no staking pools, empty cache → every boundary wallet record is fetched', async () => {
  const d = await makeDir(); dirs.push(d);
  const r = build({ MOCK_NO_STAKE: '1' }, d);
  assert.ok([0, 2].includes(r.status), r.stdout.slice(-1500));
  const B = await read('boundaries.json', d);
  const missingWallet = Object.entries(B.boundaries).filter(([, b]) => !b.wallets?.[WALLET.id]);
  assert.equal(missingWallet.length, 0, `${missingWallet.length} boundaries without a wallet record`);
  const L = await read('latest.json', d);
  assert.deepEqual(L.meta.staking_pools, []);
  assert.equal(L.metrics.wallet_net_accumulation.status, 'measured');
});

test('audit 2: a missing epoch in the cache blocks publication of chain figures (no negative burns)', async () => {
  const d = await makeDir(); dirs.push(d);
  assert.equal(build({}, d).status, 0);
  const good = await read('latest.json', d);
  const E = await read('epochs.json', d);
  const victim = E.records.findIndex((x) => x.start_time >= WIN.start && x.start_time < WIN.end) + 5;
  E.records.splice(victim, 1);
  await writeFile(join(d, 'data/epochs.json'), JSON.stringify(E));
  const r = build({}, d);
  assert.equal(r.status, 2, 'partial refresh');
  const L = await read('latest.json', d);
  assert.equal(L.partial_refresh, true);
  assert.match(L.failed_groups.chain, /integrity check failed/);
  assert.equal(L.metrics.issuance.stale, true); assert.equal(L.metrics.issuance.value_yocto, good.metrics.issuance.value_yocto, 'previous good value kept');
  assert.ok(L.metrics.derived_burns.value >= 0, 'never a negative measured burn');
  assert.ok(L.series_weekly.every((w) => w.derived_burns_near == null || w.derived_burns_near >= 0));
  assert.equal(contract(d).status, 0, contract(d).stdout);
});

test('audit 3: next UTC day with revenue failing → stale coverage keeps its own dates; weekly values only for identical periods', async () => {
  const d = await makeDir(); dirs.push(d);
  assert.equal(build({}, d).status, 0);
  const r = build({ NEAR_PARITY_NOW: '2026-11-15T12:00:00.000Z', NEAR_PARITY_SIMULATE_FAIL: 'llama_holders' }, d);
  assert.equal(r.status, 2);
  const L = await read('latest.json', d);
  assert.equal(L.window.start, '2026-10-16T00:00:00.000Z');
  const c = L.metrics.coverage_proxy;
  assert.equal(c.stale, true); assert.equal(c.period_start, WIN.start, 'stale value carries its own (previous) window');
  for (const w of L.series_weekly) if (w.buyback_proxy_stale) assert.equal(w.days, 7);
  const last = L.series_weekly.at(-1);
  assert.ok(!(last.partial && last.buyback_proxy_stale), 'a partial week never borrows a value from a different-length row');
  assert.equal(contract(d).status, 0, contract(d).stdout);
});

test('audit 4: a malformed token amount is quarantined, never stored or counted as zero', async () => {
  const d = await makeDir(); dirs.push(d);
  build({ MOCK_BAD_FT: '1' }, d);
  const T = await read('wallet-transfers.json', d);
  const bad = T.ft_txns.find((f) => f.invalid);
  assert.ok(bad && bad.delta_yocto === null, 'kept as null with an invalid flag');
  assert.ok(!T.ft_txns.some((f) => f.delta_yocto === '0'));
  const L = await read('latest.json', d);
  assert.equal(L.metrics.wallet_internal_transfers.status, 'unavailable');
  assert.match(L.metrics.wallet_internal_transfers.reason, /malformed/);
});

test.after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
