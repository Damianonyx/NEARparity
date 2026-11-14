#!/usr/bin/env node
// Integration tests: run the real build end to end against a simulated network (scripts/fixtures/mock-network.mjs)
// in a temporary copy of the repo, and check every result against values computed independently from the
// simulated chain. No network access, no dependencies. Run: node scripts/test-integration.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHAIN, WALLET, existingIn, heightAt, missing, supplyAt } from './fixtures/mock-network.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = '2026-11-14T12:00:00.000Z';
const dir = await mkdtemp(join(tmpdir(), 'near-parity-it-'));
await cp(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
await cp(join(ROOT, 'config'), join(dir, 'config'), { recursive: true });
await mkdir(join(dir, 'data'), { recursive: true });

function build(env = {}) {
  const r = spawnSync(process.execPath, ['--import', join(dir, 'scripts/fixtures/mock-network.mjs'), join(dir, 'scripts/build-data.mjs')], {
    env: { ...process.env, NEAR_PARITY_FAST: '1', NEAR_PARITY_NOW: NOW, NEAR_PARITY_RPC_URLS: 'https://fake-archival.test,https://fake-fallback.test', ...env },
    encoding: 'utf8', timeout: 300_000,
  });
  if (r.status !== 0 && r.status !== 2) console.error(r.stdout, r.stderr);
  return r;
}
const read = async (f) => JSON.parse(await readFile(join(dir, 'data', f), 'utf8'));

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
  assert.equal((await readdir(join(dir, 'data/snapshots'))).length, 1);
  const S = await read('status.json');
  assert.equal(S.consecutive_partial_runs, 0);
  assert.equal(S.sources.near_archival_rpc.ok, true);
});

test('run 2: backfill resumes; a missing last day keeps the previous value as stale', async () => {
  const r = build({ MOCK_LLAMA_DROP_LAST_DAY: '1' });
  assert.equal(r.status, 0, r.stdout.slice(-2000));
  const L = await read('latest.json');
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
  assert.equal((await read('status.json')).consecutive_partial_runs, 1);
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

test.after(() => rm(dir, { recursive: true, force: true }));
