#!/usr/bin/env node
// Offline tests (no network). Run: node scripts/test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  daysIn, epochMint, expectedMaxMint, metric, parityRequiredDailyVolume, reconcileBurns, safeRatio,
  sumDaily, toYocto, utcWindow, weeklyBuckets, yoctoToNear, yoctoToNearString,
} from './lib/calc.mjs';
import { blockBefore, blockBurnt, epochChecks } from './lib/near.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('parity formula: issuance × price ÷ (capture rate × allocation)', () => {
  const r = parityRequiredDailyVolume({ dailyIssuanceNear: 90_000, priceUsd: 3.33, captureRate: 0.000476, allocation: 1 });
  assert.equal(r.finite, true);
  assert.ok(Math.abs(r.value - 629_621_848.7394958) < 1e-3);
  // Halving the allocation doubles the required volume.
  const half = parityRequiredDailyVolume({ dailyIssuanceNear: 90_000, priceUsd: 3.33, captureRate: 0.000476, allocation: 0.5 });
  assert.ok(Math.abs(half.value - 2 * r.value) < 1e-3);
  // Basis points and percent convert to decimals before the formula.
  const bps = 4.76; const pct = 100;
  const conv = parityRequiredDailyVolume({ dailyIssuanceNear: 90_000, priceUsd: 3.33, captureRate: bps / 10_000, allocation: pct / 100 });
  assert.ok(Math.abs(conv.value - r.value) < 1e-3);
});

test('parity formula: zero denominator has no finite answer', () => {
  for (const [captureRate, allocation] of [[0, 1], [0.0005, 0], [0, 0]]) {
    const r = parityRequiredDailyVolume({ dailyIssuanceNear: 90_000, priceUsd: 3.33, captureRate, allocation });
    assert.equal(r.finite, false);
    assert.equal(r.value, null);
    assert.equal(r.reason, 'No finite volume achieves parity under these assumptions.');
  }
});

test('parity formula: rejects missing, negative or non-finite inputs instead of guessing', () => {
  for (const bad of [null, undefined, NaN, Infinity, -1, '3']) {
    const r = parityRequiredDailyVolume({ dailyIssuanceNear: 90_000, priceUsd: bad, captureRate: 0.0005, allocation: 1 });
    assert.equal(r.finite, false);
    assert.equal(r.value, null);
  }
});

test('BigInt yoctoNEAR conversions', () => {
  assert.equal(toYocto('1000000000000000000000000'), 10n ** 24n);
  assert.equal(yoctoToNear('1000000000000000000000000'), 1);
  assert.equal(yoctoToNear(0n), 0);
  assert.equal(yoctoToNear('-2500000000000000000000000'), -2.5);
  assert.equal(yoctoToNearString('1311676559659316056050032373585614'), '1311676559.659316056050032373585614');
  assert.equal(yoctoToNearString('1'), '0.000000000000000000000001');
  assert.equal(yoctoToNearString('-1500000000000000000000000'), '-1.5');
  // Precision beyond Number: the exact string keeps every digit.
  assert.equal(String(toYocto('1311676559659316056050032373585614')), '1311676559659316056050032373585614');
  assert.ok(Math.abs(yoctoToNear('1311676559659316056050032373585614') - 1311676559.659316) < 1e-3);
  for (const bad of ['1.5', '1e24', 1e24, '', 'abc']) assert.throws(() => toYocto(bad));
});

test('epoch mint: supply jump + burns in the boundary block (real mainnet boundary)', () => {
  const f = fixture('epochs.json').real_boundary;
  const mint = epochMint({ supplyPrev: f.total_supply_prev, supplyStart: f.total_supply_start, boundaryBurnt: f.boundary_block_burnt });
  assert.equal(mint.toString(), f.expected_mint_yocto);
  assert.ok(Math.abs(yoctoToNear(mint) - 25_966.268718546264) < 1e-6);
});

test('blockBurnt counts only chunks newly included in the block', () => {
  const block = { header: { height: 10 }, chunks: [
    { height_included: 10, balance_burnt: '5' }, { height_included: 9, balance_burnt: '100' }, { height_included: 10, balance_burnt: '7' },
  ] };
  assert.equal(blockBurnt(block), 12n);
});

test('burn reconciliation: burns derived once, purchases never counted', () => {
  const r = reconcileBurns({ mints: ['100', '200'], supplyStart: '1000', supplyEnd: '1250' });
  assert.equal(r.issuance, 300n);
  assert.equal(r.supplyChange, 250n);
  assert.equal(r.derivedBurns, 50n);
  // Identity: supply change = issuance − burns (no double counting).
  assert.equal(r.supplyChange, r.issuance - r.derivedBurns);
  // No mints in the period: all supply decline is burns.
  const none = reconcileBurns({ mints: [], supplyStart: '1000', supplyEnd: '990' });
  assert.equal(none.derivedBurns, 10n);
});

test('epoch sanity checks flag supply rising inside an epoch and mints above the cap', () => {
  const { records } = fixture('epochs.json');
  const checks = epochChecks(records);
  assert.equal(checks.length, 2);
  assert.ok(checks[0].issues.includes('mint above max_inflation_rate cap'), JSON.stringify(checks[0]));
  assert.ok(checks[1].issues.includes('supply rose inside the epoch'), JSON.stringify(checks[1]));
  assert.ok(checks[1].mint_to_cap_ratio > 0.99 && checks[1].mint_to_cap_ratio <= 1.001);
  assert.ok(!checks[1].issues.some((i) => i.startsWith('boundary spacing')));
  // A missing epoch shows up as a spacing gap.
  const gap = epochChecks([records[0], { ...records[2], start_height: 1000 + 2 * 43_200 + 5 }]);
  assert.ok(gap[0].issues.some((i) => i.startsWith('boundary spacing')));
  // Cap formula: 1e9 NEAR × 2.5% × 7 h ÷ 31,556,952 s ≈ 19,963.9 NEAR.
  const exp = expectedMaxMint({ supply: 10n ** 33n, rate: [1, 40], durationNs: 25_200n * 10n ** 9n });
  assert.ok(Math.abs(yoctoToNear(exp) - 19_963.9) < 0.1);
});

test('30-day windowing uses complete UTC days, end exclusive', () => {
  const w = utcWindow(new Date('2026-11-14T11:51:18Z'));
  assert.equal(w.start, '2026-10-15T00:00:00.000Z');
  assert.equal(w.end, '2026-11-14T00:00:00.000Z');
  const days = daysIn(w.start, w.end);
  assert.equal(days.length, 30);
  assert.equal(days[0], '2026-10-15');
  assert.equal(days.at(-1), '2026-11-13');
  // Exactly at midnight: today is not complete, so it is excluded.
  assert.deepEqual(utcWindow(new Date('2026-11-14T00:00:00Z')), w);
});

test('daily sums: missing days make the total unavailable, never zero; out-of-window days ignored', () => {
  const { series } = fixture('llama-series.json');
  const w = utcWindow(new Date('2026-11-14T06:00:00Z'));
  const s = sumDaily(series, w.start, w.end);
  assert.equal(s.sum, null);
  assert.deepEqual(s.missing, ['2026-10-20']);
  assert.equal(s.daysPresent, 29);
  assert.equal(s.partialSum, 285); // 5 + 28 × 10; the 2026-11-14 value (99) is outside the window
  const full = sumDaily([...series, [1792454400, 10]], w.start, w.end);
  assert.equal(full.sum, 295);
});

test('weekly chart buckets are fixed from the anchor; the last may be partial', () => {
  const b = weeklyBuckets('2026-02-01T00:00:00.000Z', '2026-02-20T00:00:00.000Z');
  assert.equal(b.length, 3);
  assert.deepEqual(b.map((x) => x.days), [7, 7, 5]);
  assert.equal(b[2].partial, true);
});

test('metric records: unavailable means null + reason; ratios refuse zero denominators', () => {
  const u = metric({ value: 0, unit: 'NEAR', source: 's', method: 'm', status: 'unavailable', reason: 'source failed' });
  assert.equal(u.value, null);
  assert.throws(() => metric({ value: null, unit: 'NEAR', source: 's', method: 'm', status: 'unavailable' }));
  assert.throws(() => metric({ value: null, unit: 'NEAR', source: 's', method: 'm', status: 'measured' }));
  assert.throws(() => metric({ value: 1, unit: 'NEAR', source: 's', method: 'm', status: 'guess' }));
  assert.equal(safeRatio(1, 0), null);
  assert.equal(safeRatio(null, 2), null);
  assert.equal(safeRatio(1, 4), 0.25);
});

test('blockBefore finds the last block before a UTC instant, skipping missing heights', async () => {
  // Fake chain: heights 1000..100000, ~0.6 s apart with jitter; every 7th height missing.
  const base = Date.parse('2026-11-01T00:00:00Z') * 1e6;
  const ns = (h) => BigInt(Math.round(base + (h - 1000) * 6e8 + ((h * 7919) % 97) * 1e6));
  const exists = (h) => h >= 1000 && h <= 100_000 && h % 7 !== 0;
  let calls = 0;
  const rpc = { call: async (method, { block_id }) => {
    calls++;
    if (!exists(block_id)) throw Object.assign(new Error('UNKNOWN_BLOCK'), { name: 'UNKNOWN_BLOCK' });
    return { header: { height: block_id, hash: `h${block_id}`, prev_hash: `h${block_id - 1}`, epoch_id: 'e', next_epoch_id: 'n',
      timestamp_nanosec: ns(block_id).toString(), total_supply: String(block_id) }, chunks: [] };
  } };
  const rec = (h) => ({ start_height: h, start_hash: `h${h}`, start_time: new Date(Number(ns(h) / 1_000_000n)).toISOString(), start_timestamp_ns: ns(h).toString(), total_supply_start: String(h) });
  const records = [rec(1000), rec(44201), rec(87401)];
  const final = { height: 100_000, timestamp_ns: ns(100_000).toString() };
  for (const iso of ['2026-11-01T03:00:00.000Z', '2026-11-01T12:00:00.000Z', '2026-11-01T16:00:00.000Z']) {
    const t = BigInt(Date.parse(iso)) * 1_000_000n;
    let expected = null;
    for (let h = 1000; h <= 100_000; h++) if (exists(h) && ns(h) < t) expected = h;
    calls = 0;
    const b = await blockBefore(rpc, iso, records, final);
    assert.equal(b.height, expected, iso);
    assert.ok(calls < 40, `too many calls: ${calls}`);
  }
});

// ---------- wallet accounting and source parsing ----------
import { discoverStakingPools, firstPositiveDay, internalTransfers, walletCreatedAt } from './lib/wallet.mjs';
import { parseDashboardRows, pricesByDay } from './lib/sources.mjs';

test('staking pools are discovered from the wallet’s own stake calls only', () => {
  const W = 'w.near';
  const txns = [
    { from: W, to: 'a.poolv1.near', actions: ['FUNCTION_CALL:deposit_and_stake'], success: true },
    { from: W, to: 'b.pool.near', actions: ['FUNCTION_CALL:deposit'], success: true },
    { from: W, to: 'c.poolv1.near', actions: ['FUNCTION_CALL:deposit_and_stake'], success: false },
    { from: 'x.near', to: 'd.poolv1.near', actions: ['FUNCTION_CALL:deposit_and_stake'] },
    { from: W, to: 'dex.near', actions: ['FUNCTION_CALL:swap'] },
  ];
  assert.deepEqual(discoverStakingPools(txns, W), ['a.poolv1.near', 'b.pool.near']);
});

test('internal transfers net native and wNEAR moves with related wallets, inside the window only', () => {
  const W = 'w.near'; const R = new Set(['r.near']);
  const txns = [
    { time: '2026-11-10T00:00:00Z', from: 'r.near', to: W, deposit_near_approx: 500, success: true },
    { time: '2026-11-11T00:00:00Z', from: W, to: 'r.near', deposit_near_approx: 100, success: true },
    { time: '2026-11-12T00:00:00Z', from: 'intents.near', to: W, deposit_near_approx: 999, success: true },
    { time: '2026-09-01T00:00:00Z', from: 'r.near', to: W, deposit_near_approx: 7, success: true },
  ];
  const ftTxns = [{ time: '2026-11-13T00:00:00Z', contract: 'wrap.near', counterparty: 'r.near', delta_yocto: '2000000000000000000000000000' }];
  const it = internalTransfers({ txns, ftTxns, complete: true }, W, R, '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z');
  assert.deepEqual(it, { inbound: 2500, outbound: 100, net: 2400, count: 3 });
  // Incomplete history that does not reach the window start → unknown, not zero.
  assert.equal(internalTransfers({ txns: txns.slice(0, 2), complete: false }, W, R, '2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z'), null);
});

test('wallet creation date and first labelled day come from the data', () => {
  assert.equal(walletCreatedAt([{ to: 'w.near', time: '2026-04-01T00:00:00Z', actions: ['TRANSFER'] }, { to: 'w.near', time: '2026-03-18T12:42:28Z', actions: ['CREATE_ACCOUNT', 'TRANSFER'] }], 'w.near'), '2026-03-18T12:42:28Z');
  assert.equal(firstPositiveDay([[1771632000, 0], [1771718400, 0], [1771804800, 6275]]), '2026-02-23');
  assert.equal(firstPositiveDay([[1771632000, 0]]), null);
});

test('dashboard rows parse from escaped page data; prices match the nearest UTC midnight', () => {
  const html = String.raw`x\"rows\":[{\"name\":\"fefundsadmin.sputnik-dao.near\",\"nearAmount\":2015642.62,\"share\":46.3,\"pct\":46.3},{\"name\":\"buybacks.multisignature.near\",\"nearAmount\":1781811.8,\"share\":40.9}]`;
  assert.deepEqual(parseDashboardRows(html).map((r) => [r.account, r.near_amount]), [['fefundsadmin.sputnik-dao.near', 2015642.62], ['buybacks.multisignature.near', 1781811.8]]);
  const byDay = pricesByDay([[1794614399, 3.1], [1794614400 + 86400 + 900, 9], [1794614400 + 2 * 86400 + 30, 3.3]]);
  assert.equal(byDay.get('2026-11-14'), 3.1); // 23:59:59 the day before → next midnight
  assert.equal(byDay.has('2026-11-15'), false); // 15 minutes off → rejected, not guessed
  assert.equal(byDay.get('2026-11-16'), 3.3);
});

// ---------- network usage helpers ----------
import { changeCorrelation, changePct, indexTo100, llamaWindowSum, parseUsage, priorWindow, windowStat } from './lib/usage.mjs';

test('usage rows parse to numbers; missing fields stay null, never 0', () => {
  const rows = parseUsage([
    { date: '2026-11-02T00:00:00.000Z', txns: '10', active_accounts: '4', new_accounts: null, active_contracts: 'x' },
    { date: '2026-11-01T00:00:00.000Z', txns: '8', active_accounts: '2', new_accounts: '1', active_contracts: '3' },
    { date: '2024-01-01T00:00:00.000Z', txns: '1' },
  ], '2025-01-01');
  assert.deepEqual(rows.map((r) => r.date), ['2026-11-01', '2026-11-02']);
  assert.equal(rows[1].new_accounts, null); assert.equal(rows[1].active_contracts, null);
});

test('usage window stats need every day; the prior window is the same length just before', () => {
  const rows = [{ date: '2026-11-01', txns: 2 }, { date: '2026-11-02', txns: 4 }, { date: '2026-11-03', txns: 6 }];
  assert.equal(windowStat(rows, 'txns', '2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z').value, 3);
  assert.equal(windowStat(rows, 'txns', '2026-11-01T00:00:00Z', '2026-11-04T00:00:00Z', 'sum').value, 12);
  const gap = windowStat(rows, 'txns', '2026-10-31T00:00:00Z', '2026-11-02T00:00:00Z');
  assert.equal(gap.value, null); assert.deepEqual(gap.missing, ['2026-10-31']);
  assert.deepEqual(priorWindow('2026-10-15T00:00:00.000Z', '2026-11-14T00:00:00.000Z'), { start: '2026-09-15T00:00:00.000Z', end: '2026-10-15T00:00:00.000Z' });
  assert.equal(changePct(80, 100), -0.2); assert.equal(changePct(1, 0), null); assert.equal(changePct(null, 1), null);
  assert.deepEqual(indexTo100([null, 50, 100, null]), [null, 100, 200, null]);
  assert.equal(llamaWindowSum([[1793491200, 5], [1793577600, 7]], '2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z'), 12);
  assert.equal(llamaWindowSum([[1793491200, 5]], '2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z'), null);
});

test('week-over-week change correlation', () => {
  assert.ok(Math.abs(changeCorrelation([1, 2, 4, 8, 4], [10, 20, 40, 80, 40]).r - 1) < 1e-12);
  assert.ok(Math.abs(changeCorrelation([1, 2, 1, 2, 1], [2, 1, 2, 1, 2]).r + 1) < 1e-9);
  assert.deepEqual(changeCorrelation([1, 2], [1, 2]), { r: null, n: 1 });
});

test('on-chain trace: fixed snapshot window, own issuance, lower bound, never re-divided', async () => {
  const { traceMetrics } = await import('./lib/trace.mjs');
  const trace = JSON.parse(readFileSync(new URL('../config/bigquery-trace.json', import.meta.url), 'utf8'));
  const same = traceMetrics(trace, { start: trace.window.start, end: trace.window.end });
  assert.equal(same.verified_purchases.status, 'measured');
  assert.equal(same.verified_purchases.lower_bound, true);
  assert.equal(same.verified_purchases.value, trace.near_bought_in_swaps);
  assert.equal(same.coverage_verified.value, trace.near_bought_in_swaps / trace.issuance_near_in_window);
  assert.equal(same.trace_untraced_near.value, trace.near_withdrawn_to_wallet - trace.near_bought_in_swaps);
  assert.equal(same.coverage_verified.snapshot.window_matches_dashboard, true);
  const later = traceMetrics(trace, { start: '2026-10-16T00:00:00.000Z', end: '2026-11-15T00:00:00.000Z' });
  assert.equal(later.coverage_verified.value, same.coverage_verified.value, 'a moved window must not change the snapshot ratio');
  assert.equal(later.coverage_verified.period_start, trace.window.start, 'figures keep their own window');
  assert.equal(later.coverage_verified.snapshot.window_matches_dashboard, false);
  assert.equal(traceMetrics(null, { start: 'x', end: 'y' }), null);
  assert.equal(traceMetrics({ ...trace, issuance_near_in_window: 0 }, trace.window), null, 'no division by zero');
});

test('daily BigQuery trace: which days to query, merge, BigInt sums', async () => {
  const { daysToQuery, mergeDaily, sumDays } = await import('./lib/bigquery.mjs');
  const latest = Date.parse('2026-11-14T11:00:00Z') / 1000;
  assert.deepEqual(daysToQuery({ lastDay: null, from: '2026-10-15', latestUnix: latest }), { start: '2026-10-15', end: '2026-11-14' });
  assert.deepEqual(daysToQuery({ lastDay: '2026-11-12', from: '2026-10-15', latestUnix: latest }), { start: '2026-11-13', end: '2026-11-14' });
  assert.equal(daysToQuery({ lastDay: '2026-11-13', from: '2026-10-15', latestUnix: latest }), null, 'today is incomplete');
  assert.deepEqual(daysToQuery({ lastDay: null, from: '2026-01-01', latestUnix: latest, maxDays: 10 }), { start: '2026-01-01', end: '2026-01-11' }, 'capped per run');
  const st = mergeDaily({}, [{ day: '2026-11-01', withdrawals: '2', withdrawn_yocto: '10000000000000000000000000000000', swaps: '1', bought_yocto: '5', sold_yocto: '0', new_accounts: ['a'] }], { start: '2026-11-01', end: '2026-11-03' });
  assert.equal(st.last_day, '2026-11-02');
  assert.deepEqual(st.days['2026-11-02'], { withdrawals: 0, withdrawn_yocto: '0', swaps: 0, bought_yocto: '0', sold_yocto: '0' }, 'a day without rows had no activity');
  assert.deepEqual(st.accounts, { a: '2026-11-01' });
  const s = sumDays(st, '2026-11-01T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
  assert.equal(s.withdrawn, 10n ** 31n); assert.equal(s.bought, 5n); assert.equal(s.days, 2);
  assert.equal(sumDays(st, '2026-10-31T00:00:00.000Z', '2026-11-03T00:00:00.000Z'), null, 'a missing day → no total');
});
