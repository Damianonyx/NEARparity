#!/usr/bin/env node
// NEAR Parity data build. One command: fetch every source, compute metrics, write
//   data/latest.json, data/snapshots/<UTC timestamp>.json, data/status.json
// plus caches data/epochs.json, data/boundaries.json, data/wallet-transfers.json.
// Node 22 built-ins only; no keys. Behind a proxy run with: node --use-env-proxy scripts/build-data.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  DAY_MS, metric, parityRequiredDailyVolume, reconcileBurns, safeRatio, sumDaily, toYocto,
  utcWindow, weeklyBuckets, yoctoToNear,
} from './lib/calc.mjs';
import { ARCHIVAL_URL, blockBefore, createRpc, epochChecks, mapLimit, sampleInflationRates, walkEpochs, walletBalances } from './lib/near.mjs';

const ROOT = new URL('../', import.meta.url);
const DATA = new URL('data/', ROOT);
const BACKFILL_FROM = '2026-02-01T00:00:00.000Z';
const WINDOW_DAYS = 30;
const SCHEMA_VERSION = 1;
const log = (...a) => console.log(...a);

const readJson = async (rel, fallback) => {
  try { return JSON.parse(await readFile(new URL(rel, ROOT), 'utf8')); } catch { return fallback; }
};
const writeJson = async (rel, obj) => {
  const url = new URL(rel, ROOT);
  await mkdir(new URL('./', url), { recursive: true });
  await writeFile(url, `${JSON.stringify(obj, null, 2)}\n`);
};

const startedAt = new Date();
const now = process.env.NEAR_PARITY_NOW ? new Date(process.env.NEAR_PARITY_NOW) : startedAt;
const window = utcWindow(now, WINDOW_DAYS);
const wallet = await readJson('config/buyback-wallet.json', null);
const prevLatest = await readJson('data/latest.json', null);
const prevStatus = await readJson('data/status.json', { sources: {} });

// ---------- source status ----------
const status = {};
function setStatus(key, { ok, http_status = null, error = null, url = null }) {
  const s = status[key] || { calls: 0, failures: 0 };
  s.calls++;
  if (!ok) s.failures++;
  Object.assign(s, { url: url ?? s.url ?? null, http_status, fetched_at: new Date().toISOString() });
  if (ok && !s.error) s.ok = true;
  if (!ok) { s.ok = false; s.error = error; }
  status[key] = s;
}

async function getJson(key, url, { timeoutMs = 30_000, retries = 2, headers = {} } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    let http = null;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'near-parity-data-build', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      http = res.status;
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { http });
      const body = await res.json();
      setStatus(key, { ok: true, http_status: http, url });
      return body;
    } catch (e) { last = Object.assign(e, { http: e.http ?? http }); }
  }
  setStatus(key, { ok: false, http_status: last.http ?? null, error: last.message, url });
  throw last;
}

// ---------- groups: each returns data or throws; failures fall back to the previous good values ----------
const groupErrors = {};
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

const rpc = createRpc(ARCHIVAL_URL, {
  onStatus: (ok, http, error) => setStatus('near_archival_rpc', { ok, http_status: http, error, url: ARCHIVAL_URL }),
});

log(`NEAR Parity build ${startedAt.toISOString()} — window ${window.start} → ${window.end} (${WINDOW_DAYS} UTC days, end exclusive)`);

// ---------- 1. chain: epoch boundaries, supply at period boundaries, wallet balances ----------
const chain = await group('chain', async () => {
  const cache = await readJson('data/epochs.json', { records: [] });
  const saveEpochs = (records) => writeJson('data/epochs.json', {
    description: 'Per-epoch mint measured at each epoch boundary: supply(first block) − supply(previous block) + burns in the first block. yoctoNEAR strings.',
    source: ARCHIVAL_URL, backfill_from: BACKFILL_FROM, updated_at: new Date().toISOString(), records,
  });
  log('Walking epoch boundaries…');
  const { final, records } = await walkEpochs(rpc, { backfillFrom: BACKFILL_FROM, cached: cache.records, save: saveEpochs, log });
  await sampleInflationRates(rpc, records, { log });
  await saveEpochs(records);
  const fresh = records.filter((r) => !cache.records.some((c) => c.start_height === r.start_height));
  const checks = epochChecks(records);
  log(`  ${records.length} boundaries cached (${fresh.length} new). Final block ${final.height} @ ${final.time}`);

  // Boundary instants: window start/end + weekly chart buckets since BACKFILL_FROM.
  const buckets = weeklyBuckets(BACKFILL_FROM, window.end);
  const instants = [...new Set([window.start, window.end, ...buckets.flatMap((b) => [b.start, b.end])])].sort();
  const bcache = await readJson('data/boundaries.json', { boundaries: {} });
  const missing = instants.filter((i) => !bcache.boundaries[i]);
  log(`  ${instants.length} UTC boundaries needed, ${missing.length} to look up`);
  await mapLimit(missing, 2, async (iso) => {
    const b = await blockBefore(rpc, iso, records, final);
    bcache.boundaries[iso] = { block_height: b.height, block_hash: b.hash, block_time: b.time, total_supply: b.total_supply, wallets: {} };
  });
  // Wallet balances (candidate buyback wallet) at each boundary.
  const walletErrors = [];
  if (wallet?.account_id) {
    const need = instants.filter((i) => !bcache.boundaries[i].wallets?.[wallet.account_id]);
    await mapLimit(need, 2, async (iso) => {
      try {
        const bal = await walletBalances(rpc, wallet.account_id, bcache.boundaries[iso].block_hash);
        bcache.boundaries[iso].wallets[wallet.account_id] = bal;
      } catch (e) { walletErrors.push(`${iso}: ${e.message}`); }
    });
  }
  bcache.description = 'Last block before each UTC instant (end-exclusive periods), with total supply and wallet balances. yoctoNEAR strings.';
  bcache.updated_at = new Date().toISOString();
  bcache.boundaries = Object.fromEntries(Object.entries(bcache.boundaries).sort(([a], [b]) => a.localeCompare(b)));
  await writeJson('data/boundaries.json', bcache);
  return { final, records, checks, buckets, boundaries: bcache.boundaries, walletErrors };
});

// ---------- 2. DefiLlama: Intents volume, fees, revenue, holders revenue ----------
const LLAMA = {
  volume: ['defillama_volume', 'https://api.llama.fi/summary/dexs/near-intents'],
  fees: ['defillama_fees', 'https://api.llama.fi/summary/fees/near-intents?dataType=dailyFees'],
  revenue: ['defillama_revenue', 'https://api.llama.fi/summary/fees/near-intents?dataType=dailyRevenue'],
  holders: ['defillama_holders_revenue', 'https://api.llama.fi/summary/fees/near-intents?dataType=dailyHoldersRevenue'],
};
const llama = {};
for (const [k, [key, url]] of Object.entries(LLAMA)) {
  llama[k] = await group(`llama_${k}`, async () => {
    const body = await getJson(key, url);
    if (!Array.isArray(body.totalDataChart) || !body.totalDataChart.length) throw new Error('Empty totalDataChart');
    return { series: body.totalDataChart, methodology: body.methodology ?? null, url };
  });
}

// ---------- 3. Price: DefiLlama coins (primary), CoinGecko (fallback) ----------
const price = await group('price', async () => {
  const span = Math.ceil((new Date(window.end) - new Date(BACKFILL_FROM)) / DAY_MS) + 1;
  const start = Math.floor(new Date(BACKFILL_FROM).getTime() / 1000);
  let daily; let source;
  try {
    const url = `https://coins.llama.fi/chart/coingecko:near?start=${start}&span=${span}&period=1d&searchWidth=600`;
    const body = await getJson('price_defillama_chart', url);
    daily = body.coins['coingecko:near'].prices.map((p) => [p.timestamp, p.price]);
    source = { name: 'DefiLlama coins API (coingecko:near), daily', url };
  } catch (e) {
    const url = 'https://api.coingecko.com/api/v3/coins/near/market_chart?vs_currency=usd&days=365&interval=daily';
    const body = await getJson('price_coingecko', url);
    daily = body.prices.map(([ms, p]) => [Math.floor(ms / 1000), p]);
    source = { name: 'CoinGecko market_chart (fallback)', url };
  }
  // Key by UTC day: the sample nearest that day's 00:00 UTC, within ±10 minutes
  // (DefiLlama samples sometimes land at 23:59:59 of the previous day).
  const byDay = new Map(); const bestOff = new Map();
  for (const [ts, p] of daily) {
    const midnight = Math.round(ts / 86_400) * 86_400;
    const off = Math.abs(ts - midnight);
    if (off > 600) continue;
    const day = new Date(midnight * 1000).toISOString().slice(0, 10);
    if (!bestOff.has(day) || off < bestOff.get(day)) { byDay.set(day, p); bestOff.set(day, off); }
  }
  let current = null;
  try {
    const url = 'https://coins.llama.fi/prices/current/coingecko:near';
    const body = await getJson('price_defillama_current', url);
    const c = body.coins['coingecko:near'];
    current = { price: c.price, time: new Date(c.timestamp * 1000).toISOString(), url };
  } catch { /* current price optional; daily series still usable */ }
  return { byDay, source, current };
});

// ---------- 4. NearBlocks: transfers of the candidate wallet (no key; incremental cache) ----------
const transfers = await group('nearblocks', async () => {
  if (!wallet?.account_id) throw new Error('No wallet configured');
  const cache = await readJson('data/wallet-transfers.json', null);
  const fresh = cache?.account_id === wallet.account_id ? cache : { account_id: wallet.account_id, complete: false, resume_cursor: null, txns: [] };
  const knownIds = new Set(fresh.txns.map((t) => t.receipt_id));
  const slim = (t) => ({
    receipt_id: t.receipt_id, tx_hash: t.transaction_hash ?? null,
    time: new Date(Number(BigInt(t.block_timestamp) / 1_000_000n)).toISOString(),
    block_height: t.receipt_block?.block_height ?? t.block?.block_height ?? null,
    from: t.predecessor_account_id, to: t.receiver_account_id,
    actions: (t.actions || []).map((a) => a.method ? `${a.action}:${a.method}` : a.action),
    // NearBlocks returns deposits as JSON floats: approximate, used for listing only.
    deposit_near_approx: (t.actions || []).reduce((s, a) => s + (Number(a.deposit) || 0), 0) / 1e24,
    success: t.outcomes?.status ?? null,
  });
  const base = `https://api.nearblocks.io/v1/account/${wallet.account_id}/txns?per_page=100`;
  const saveProgress = () => writeJson('data/wallet-transfers.json', { ...fresh, updated_at: new Date().toISOString() });
  const page = async (cursor) => {
    const url = cursor ? `${base}&cursor=${cursor}` : base;
    // Keyless NearBlocks rate-limits bursts: pause between pages and back off on 429.
    for (let attempt = 0; ; attempt++) {
      try {
        const body = await getJson('nearblocks', url, { retries: 0 });
        await new Promise((r) => setTimeout(r, 4000));
        return body;
      } catch (e) {
        if (e.http !== 429 || attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 20_000 * (attempt + 1)));
      }
    }
  };
  // 1) Newest pages until a known receipt (or the end of history on the first run).
  const added = [];
  let cursor = null; let reachedKnown = false; let pages = 0;
  while (pages < (knownIds.size ? 60 : 1)) { // empty cache: one page here, then the saved backfill below
    const body = await page(cursor); pages++;
    const rows = body.txns || [];
    for (const t of rows) {
      if (knownIds.has(t.receipt_id)) { reachedKnown = true; break; }
      added.push(slim(t));
    }
    cursor = rows.length ? body.cursor || null : null;
    if (reachedKnown || !cursor) break;
  }
  fresh.txns = [...added, ...fresh.txns];
  if (!knownIds.size) { fresh.resume_cursor = cursor; fresh.complete = !cursor; }
  // 2) Continue an incomplete backfill from where the last run stopped.
  await saveProgress();
  while (!fresh.complete && fresh.resume_cursor && pages < 120) {
    let body;
    try { body = await page(fresh.resume_cursor); pages++; } catch (e) {
      log(`  NearBlocks backfill paused at ${fresh.txns.at(-1)?.time} (${e.message}); next run resumes`);
      groupErrors.nearblocks_backfill = e.message; // reported, but the cached pages are kept and used
      break;
    }
    const rows = body.txns || [];
    for (const t of rows) if (!knownIds.has(t.receipt_id)) fresh.txns.push(slim(t));
    fresh.resume_cursor = rows.length ? body.cursor || null : null;
    if (!fresh.resume_cursor) fresh.complete = true;
    await saveProgress();
  }
  const ids = new Set();
  fresh.txns = fresh.txns.filter((t) => !ids.has(t.receipt_id) && ids.add(t.receipt_id)).sort((a, b) => b.time.localeCompare(a.time));
  fresh.description = 'Receipts involving the candidate wallet, from NearBlocks (no key). Deposit amounts are NearBlocks floats (approximate) and used only for listing; balances come from the archival RPC.';
  fresh.source = base;
  fresh.updated_at = new Date().toISOString();
  await writeJson('data/wallet-transfers.json', fresh);
  return fresh;
});

// ---------- 5. NEAR's official revenue dashboard: wallet breakdown (cross-check only) ----------
const dashboard = await group('revenue_dashboard', async () => {
  const url = 'https://revenue.near.org/';
  let html; let http = null;
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'near-parity-data-build' }, signal: AbortSignal.timeout(30_000) });
    http = res.status;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    setStatus('near_revenue_dashboard', { ok: false, http_status: http, error: e.message, url });
    throw e;
  }
  // The page embeds its wallet breakdown as JSON rows (possibly with escaped quotes).
  const rows = [];
  const re = /name\\*":\\*"([a-z0-9._-]+\.near)\\*",\\*"nearAmount\\*":([0-9.]+),\\*"share\\*":([0-9.]+)/g;
  for (const m of html.matchAll(re)) if (!rows.some((r) => r.account === m[1])) rows.push({ account: m[1], near_amount: Number(m[2]), share_pct: Number(m[3]) });
  if (!rows.length) {
    setStatus('near_revenue_dashboard', { ok: false, http_status: http, error: 'Wallet breakdown not found in page', url });
    throw new Error('Wallet breakdown not found in page');
  }
  setStatus('near_revenue_dashboard', { ok: true, http_status: http, url });
  return { url, fetched_at: new Date().toISOString(), rows };
});

// ---------- compute metrics ----------
const W = { period_start: window.start, period_end: window.end };
const M = {}; // metric key → record
const groupOf = {}; // metric key → groups it depends on
const set = (key, groups, rec) => { M[key] = rec; groupOf[key] = groups; };
const unavailable = (unit, source, method, reason, extra = {}) => metric({ value: null, unit, ...W, source, method, status: 'unavailable', reason, ...extra });
const SRC_CHAIN = `NEAR mainnet archival RPC (${ARCHIVAL_URL}): block headers`;

let issuanceYocto = null; let issuanceNear = null;
if (chain) {
  const ws = Date.parse(window.start); const we = Date.parse(window.end);
  const inWin = chain.records.filter((r) => { const t = Date.parse(r.start_time); return t >= ws && t < we; });
  const bStart = chain.boundaries[window.start]; const bEnd = chain.boundaries[window.end];
  const rec = reconcileBurns({ mints: inWin.map((r) => r.mint_yocto), supplyStart: bStart.total_supply, supplyEnd: bEnd.total_supply });
  issuanceYocto = rec.issuance; issuanceNear = yoctoToNear(rec.issuance);
  const lastRate = chain.records.at(-1).max_inflation_rate ?? ['?', '?'];
  const flagged = chain.checks.filter((c) => c.issues.length);
  const winChecks = chain.checks.filter((c) => { const t = Date.parse(c.epoch_start_time); return t >= ws && t < we; });
  const ratios = winChecks.map((c) => c.mint_to_cap_ratio);
  set('issuance', ['chain'], metric({
    value: issuanceNear, value_yocto: rec.issuance.toString(), unit: 'NEAR', ...W, source: SRC_CHAIN,
    method: 'Σ over epoch boundaries whose first block falls in the period of [total_supply(first block) − total_supply(previous block) + Σ balance_burnt of chunks included in the first block].',
    status: 'measured', epochs_counted: inWin.length,
    reference_cap: { max_inflation_rate: `${lastRate[0]}/${lastRate[1]}`, note: 'Protocol maximum, shown for comparison only. Not measured issuance.' },
    mint_to_cap_ratio_range: ratios.length ? [Math.min(...ratios), Math.max(...ratios)] : null,
  }));
  set('daily_issuance', ['chain'], metric({
    value: issuanceNear / WINDOW_DAYS, unit: 'NEAR/day', ...W, source: SRC_CHAIN,
    method: `Measured period issuance ÷ ${WINDOW_DAYS} days.`, status: 'measured',
  }));
  set('issuance_annualised_rate', ['chain'], metric({
    value: (issuanceNear / yoctoToNear(bStart.total_supply)) * (365 / WINDOW_DAYS), unit: 'fraction per year', ...W, source: SRC_CHAIN,
    method: `Measured period issuance ÷ total supply at period start × 365/${WINDOW_DAYS}. An observed rate, not the protocol cap.`, status: 'measured',
  }));
  set('supply_start', ['chain'], metric({ value: yoctoToNear(bStart.total_supply), value_yocto: bStart.total_supply, unit: 'NEAR', ...W, source: SRC_CHAIN, method: `total_supply of block ${bStart.block_height} (last block before period start).`, status: 'measured', block_height: bStart.block_height }));
  set('supply_end', ['chain'], metric({ value: yoctoToNear(bEnd.total_supply), value_yocto: bEnd.total_supply, unit: 'NEAR', ...W, source: SRC_CHAIN, method: `total_supply of block ${bEnd.block_height} (last block before period end).`, status: 'measured', block_height: bEnd.block_height }));
  set('supply_change', ['chain'], metric({
    value: yoctoToNear(rec.supplyChange), value_yocto: rec.supplyChange.toString(), unit: 'NEAR', ...W, source: SRC_CHAIN,
    method: 'total_supply(end boundary block) − total_supply(start boundary block). Already net of burns; treasury purchases do not change it.', status: 'measured',
  }));
  set('derived_burns', ['chain'], metric({
    value: yoctoToNear(rec.derivedBurns), value_yocto: rec.derivedBurns.toString(), unit: 'NEAR', ...W, source: SRC_CHAIN,
    method: 'Derived: measured issuance − measured supply change over the same period (protocol burns: gas and fees). Not added to supply change again; buybacks are not burns.',
    status: 'measured', derived: true,
  }));
  set('epoch_checks', ['chain'], {
    status: flagged.length ? 'flagged' : 'ok', epochs_checked: chain.checks.length, epochs_flagged: flagged.length,
    flagged: flagged.slice(-20), window_mint_to_cap_ratio: ratios.length ? { min: Math.min(...ratios), max: Math.max(...ratios) } : null,
    method: 'Within each epoch supply must not rise (only burns). Each mint should be ≤ and close to supply × max_inflation_rate × epoch duration ÷ 31,556,952 s; ratio < 0.95 or > 1.001 is flagged.',
  });
} else {
  for (const k of ['issuance', 'daily_issuance', 'issuance_annualised_rate', 'supply_start', 'supply_end', 'supply_change', 'derived_burns']) {
    set(k, ['chain'], unavailable('NEAR', SRC_CHAIN, 'See chain method.', `Chain data failed this run: ${groupErrors.chain}`));
  }
}

const LL = 'DefiLlama (protocol slug near-intents)';
const llamaSum = (k) => (llama[k] ? sumDaily(llama[k].series, window.start, window.end) : null);
const llamaMetric = (key, k, unit, label, status, extraMethod = '') => {
  const s = llamaSum(k);
  if (!s) return set(key, [`llama_${k}`], unavailable(unit, LL, label, `DefiLlama ${k} request failed: ${groupErrors[`llama_${k}`]}`));
  if (s.sum == null) return set(key, [`llama_${k}`], unavailable(unit, `${LL}: ${llama[k].url}`, label, `${s.missing.length} of ${s.daysExpected} days missing (${s.missing.slice(0, 5).join(', ')}${s.missing.length > 5 ? '…' : ''}).`));
  set(key, [`llama_${k}`], metric({ value: s.sum, unit, ...W, source: `${LL}: ${llama[k].url}`, method: `${label} Sum of ${s.daysExpected} daily values.${extraMethod}`, status, days_present: s.daysPresent }));
};
const meth = llama.revenue?.methodology || llama.fees?.methodology || {};
llamaMetric('intents_volume', 'volume', 'USD', 'NEAR Intents swap volume as reported by DefiLlama.', 'measured');
llamaMetric('intents_gross_fees', 'fees', 'USD', `Gross fees. DefiLlama: "${meth.Fees ?? 'n/a'}"`, 'measured');
llamaMetric('intents_net_revenue', 'revenue', 'USD', `Net revenue captured after distributions. DefiLlama: "${meth.Revenue ?? 'n/a'}"`, 'measured');
llamaMetric('intents_holders_revenue', 'holders', 'USD', `DefiLlama holders revenue, labelled as buyback money from 2026-02-23. DefiLlama: "${meth.HoldersRevenue ?? 'n/a'}"`, 'proxy', ' A label, not confirmed purchases.');

const v = (k) => (M[k]?.status !== 'unavailable' ? M[k]?.value ?? null : null);
const ratioMetric = (key, groups, num, den, unit, method, status, scale = 1) => {
  const r = safeRatio(v(num), v(den));
  set(key, groups, r == null
    ? unavailable(unit, `Derived from ${num} and ${den}`, method, `Needs both ${num} and ${den} (one is unavailable or zero).`)
    : metric({ value: r * scale, unit, ...W, source: `Derived from ${num} and ${den}`, method, status }));
};
ratioMetric('net_revenue_capture_rate', ['llama_revenue', 'llama_volume'], 'intents_net_revenue', 'intents_volume', 'basis points', 'Net revenue ÷ swap volume over the period, in basis points (1 bp = 0.0001).', 'measured', 10_000);
ratioMetric('buyback_allocation', ['llama_holders', 'llama_revenue'], 'intents_holders_revenue', 'intents_net_revenue', 'percent', 'DefiLlama holders revenue ÷ net revenue over the period. Based on a label, so a proxy for the share used to buy NEAR.', 'proxy', 100);
set('avg_daily_volume', ['llama_volume'], v('intents_volume') == null
  ? unavailable('USD/day', LL, 'Volume ÷ 30.', 'Volume unavailable.')
  : metric({ value: v('intents_volume') / WINDOW_DAYS, unit: 'USD/day', ...W, source: M.intents_volume.source, method: `Period swap volume ÷ ${WINDOW_DAYS}.`, status: 'measured' }));

// Prices
if (price) {
  const days = sumDaily([...price.byDay].map(([d, p]) => [Date.parse(`${d}T00:00:00Z`) / 1000, p]), window.start, window.end);
  set('price_avg', ['price'], days.sum == null
    ? unavailable('USD', price.source.name, 'Mean of daily prices.', `${days.missing.length} daily prices missing.`)
    : metric({ value: days.sum / days.daysExpected, unit: 'USD', ...W, source: `${price.source.name}: ${price.source.url}`, method: 'Mean of daily 00:00 UTC prices in the period.', status: 'measured' }));
  set('price_current', ['price'], price.current
    ? metric({ value: price.current.price, unit: 'USD', period_start: price.current.time, period_end: price.current.time, source: `DefiLlama coins API: ${price.current.url}`, method: 'Latest price for coingecko:near.', status: 'measured' })
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
  ? metric({ value: px.value, unit: 'NEAR', ...W, source: `${LL} dailyHoldersRevenue ÷ daily NEAR price`, method: 'Proxy: Σ over days of (DefiLlama holders revenue in USD ÷ NEAR price that day). DefiLlama labels this revenue as buyback money; it is not a confirmed purchase record.', status: 'proxy' })
  : unavailable('NEAR', `${LL} dailyHoldersRevenue ÷ daily NEAR price`, 'Proxy: holders revenue ÷ daily price.', px ? `Missing days: ${px.missing.slice(0, 5).join(', ')}` : 'Holders revenue or price unavailable.'));

// Candidate wallet net accumulation (unconfirmed wallet).
const walletLabel = wallet?.official_source ? wallet.label : 'unconfirmed wallet';
let walletNet = null;
if (chain && wallet?.account_id) {
  const a = chain.boundaries[window.start].wallets?.[wallet.account_id]; const b = chain.boundaries[window.end].wallets?.[wallet.account_id];
  if (a && b) {
    walletNet = toYocto(b.total_yocto) - toYocto(a.total_yocto);
    set('wallet_net_accumulation', ['chain'], metric({
      value: yoctoToNear(walletNet), value_yocto: walletNet.toString(), unit: 'NEAR', ...W, source: `${SRC_CHAIN}: view_account, wrap.near ft_balance_of, intents.near mt_balance_of (nep141:wrap.near) for ${wallet.account_id}`,
      method: 'Change in NEAR held (native liquid + locked, wNEAR, and wNEAR inside intents.near) between the period boundary blocks. Net accumulation, not proof of purchases.',
      status: 'measured', wallet: wallet.account_id, wallet_label: walletLabel,
      balance_start_near: yoctoToNear(a.total_yocto), balance_end_near: yoctoToNear(b.total_yocto),
    }));
  }
}
if (!M.wallet_net_accumulation) set('wallet_net_accumulation', ['chain'], unavailable('NEAR', SRC_CHAIN, 'Balance change of the candidate wallet.', chain ? `Wallet balance lookups failed: ${chain.walletErrors.slice(0, 2).join('; ')}` : 'Chain data failed.', { wallet: wallet?.account_id ?? null, wallet_label: walletLabel }));

set('verified_purchases', [], unavailable('NEAR', 'n/a', 'Would require swap records attributed to an officially confirmed buyback wallet.',
  wallet?.official_source
    ? `The wallet is listed on an official source (${wallet.official_source.url}), but its balance change is net accumulation: transfers from intents.near do not show the swaps, so purchases are not verified.`
    : `The candidate wallet (${wallet?.account_id ?? 'none'}) is not confirmed by an official NEAR or NEAR Intents source in this build, and balance changes alone do not prove purchases.`));
set('coverage_verified', [], unavailable('ratio', 'n/a', 'Verified NEAR purchased ÷ newly issued NEAR.', 'Verified purchases are unavailable (see verified_purchases).'));
ratioMetric('coverage_proxy', ['llama_holders', 'price', 'chain'], 'buyback_proxy_near', 'issuance', 'ratio', 'Proxy: revenue-based buyback estimate (NEAR) ÷ measured issuance (NEAR), same 30 UTC days.', 'proxy');
ratioMetric('coverage_wallet', ['chain'], 'wallet_net_accumulation', 'issuance', 'ratio', `Net accumulation of the ${walletLabel} ÷ measured issuance, same 30 UTC days. Not verified purchases.`, 'proxy');

// Transfers summary (NearBlocks)
let transfersSummary = null;
if (transfers) {
  const ws = window.start; const we = window.end;
  const inWin = transfers.txns.filter((t) => t.time >= ws && t.time < we);
  const inbound = inWin.filter((t) => t.to === wallet.account_id && t.from !== wallet.account_id);
  const outbound = inWin.filter((t) => t.from === wallet.account_id);
  const byCounterparty = {};
  for (const t of inbound) {
    const c = (byCounterparty[t.from] ||= { count: 0, deposit_near_approx: 0 });
    c.count++; c.deposit_near_approx += t.deposit_near_approx;
  }
  transfersSummary = {
    ...W, source: transfers.source, complete_history: transfers.complete, receipts_cached: transfers.txns.length,
    first_receipt_time: transfers.txns.at(-1)?.time ?? null,
    inbound_count: inbound.length, outbound_count: outbound.length,
    inbound_by_counterparty: Object.fromEntries(Object.entries(byCounterparty).sort((a, b) => b[1].deposit_near_approx - a[1].deposit_near_approx).slice(0, 10)),
    outbound_recent: outbound.slice(0, 20),
    note: 'Inbound transfers from intents.near are consistent with NEAR withdrawn from Intents after swaps, but transfers alone do not show the swap. Amounts are approximate (NearBlocks floats).',
  };
}

// Simulator defaults (conditional scenario inputs).
const capBps = v('net_revenue_capture_rate'); const allocPct = v('buyback_allocation');
const simDefaults = {
  daily_issuance_near: v('daily_issuance'), price_usd: v('price_current') ?? v('price_avg'),
  net_revenue_capture_bps: capBps, buyback_allocation_pct: allocPct, observed_avg_daily_volume_usd: v('avg_daily_volume'),
};
const scenario = [simDefaults.daily_issuance_near, simDefaults.price_usd, capBps, allocPct].every((x) => x != null)
  ? parityRequiredDailyVolume({ dailyIssuanceNear: simDefaults.daily_issuance_near, priceUsd: simDefaults.price_usd, captureRate: capBps / 10_000, allocation: allocPct / 100 })
  : { finite: false, value: null, reason: 'Default inputs unavailable.' };
const simulator = {
  formula: 'Required daily volume (USD) = daily issuance (NEAR) × NEAR price (USD) ÷ (net revenue capture rate × buyback allocation)',
  label: 'Conditional scenario under the stated assumptions. Not a prediction and not a supply-neutrality threshold.',
  defaults: simDefaults, default_result: scenario, ...W,
};

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
    return {
      period_start: bk.start, period_end: bk.end, days: bk.days, partial: bk.partial,
      issuance_near: yoctoToNear(rec.issuance), supply_change_near: yoctoToNear(rec.supplyChange), derived_burns_near: yoctoToNear(rec.derivedBurns),
      buyback_proxy_near: p?.value ?? null, buyback_proxy_status: p?.value != null ? 'proxy' : 'unavailable',
      wallet_net_near: wa && wb ? yoctoToNear(toYocto(wb.total_yocto) - toYocto(wa.total_yocto)) : null,
      wallet_balance_end_near: wb ? yoctoToNear(wb.total_yocto) : null,
      verified_purchases_near: null,
    };
  });
}

// ---------- stale fallback: never overwrite good data with nulls ----------
// Optional cross-checks do not make a refresh "partial"; they are still reported in status.json.
const OPTIONAL_GROUPS = new Set(['revenue_dashboard', 'nearblocks_backfill']);
const failedGroups = new Set(Object.keys(groupErrors).filter((g) => !OPTIONAL_GROUPS.has(g)));
const stale = {};
for (const [key, rec] of Object.entries(M)) {
  const deps = groupOf[key] || [];
  const failedDep = deps.find((g) => failedGroups.has(g));
  const prev = prevLatest?.metrics?.[key];
  if (failedDep && prev && prev.status && prev.status !== 'unavailable') {
    M[key] = { ...prev, stale: true, stale_since: prev.stale_since ?? prevLatest.generated_at, stale_reason: `${failedDep} failed this run: ${groupErrors[failedDep]}` };
    stale[key] = M[key].stale_since;
  }
}
if (!series && prevLatest?.series_weekly) { series = prevLatest.series_weekly.map((r) => ({ ...r, stale: true })); stale.series_weekly = prevLatest.generated_at; }
if (series && prevLatest?.series_weekly && (failedGroups.has('llama_holders') || failedGroups.has('price'))) {
  const prevBy = new Map(prevLatest.series_weekly.map((r) => [r.period_start, r]));
  for (const r of series) if (r.buyback_proxy_near == null && prevBy.get(r.period_start)?.buyback_proxy_near != null) {
    r.buyback_proxy_near = prevBy.get(r.period_start).buyback_proxy_near; r.buyback_proxy_status = 'proxy'; r.buyback_proxy_stale = true;
  }
}
// Official dashboard figure vs the wallet's on-chain holdings now (different scopes; shown, not reconciled away).
let dashboardOut = null;
if (dashboard) {
  const row = dashboard.rows.find((r) => r.account === wallet?.account_id) ?? null;
  let onchainNow = null;
  if (row && chain) {
    try {
      const bal = await walletBalances(rpc, wallet.account_id, chain.final.hash);
      onchainNow = { block_height: chain.final.height, block_time: chain.final.time, total_near: yoctoToNear(bal.total_yocto), native_near: yoctoToNear(bal.native_yocto), wnear_near: yoctoToNear(bal.wnear_yocto), intents_wnear_near: yoctoToNear(bal.intents_wnear_yocto) };
    } catch { /* optional */ }
  }
  dashboardOut = {
    source: `NEAR revenue dashboard (official): ${dashboard.url}`, fetched_at: dashboard.fetched_at, wallet_breakdown: dashboard.rows,
    wallet_row: row, onchain_now: onchainNow,
    difference_near: row && onchainNow ? onchainNow.total_near - row.near_amount : null,
    note: 'The dashboard attributes captured revenue to wallets; on-chain holdings can differ (other inflows, outflows, timing). Neither figure alone proves purchases.',
  };
} else if (prevLatest?.official_dashboard) {
  dashboardOut = { ...prevLatest.official_dashboard, stale: true, stale_reason: groupErrors.revenue_dashboard };
}
let finalTransfers = transfersSummary ?? (prevLatest?.wallet_transfers ? { ...prevLatest.wallet_transfers, stale: true } : null);

// ---------- write outputs ----------
const anyOk = Object.keys(M).some((k) => M[k].status !== 'unavailable' && !M[k].stale);
const generatedAt = new Date().toISOString();
const latest = {
  schema_version: SCHEMA_VERSION,
  generated_at: generatedAt,
  last_successful_refresh: failedGroups.size === 0 ? generatedAt : (prevLatest?.last_successful_refresh ?? null),
  partial_refresh: failedGroups.size > 0,
  failed_groups: groupErrors,
  window: { ...window, note: 'Default comparison: the 30 most recent complete UTC days; start inclusive, end exclusive.' },
  central_question: 'Are NEAR Intents buybacks keeping pace with new NEAR issuance?',
  wallet: wallet ? { ...wallet, label_used: walletLabel } : null,
  metrics: M,
  stale,
  simulator,
  series_weekly: series,
  wallet_transfers: finalTransfers,
  official_dashboard: dashboardOut,
  sources: [
    { name: 'NEAR mainnet archival RPC (FastNEAR)', url: ARCHIVAL_URL, used_for: 'Epoch boundaries, total supply, burns, protocol config, wallet balances' },
    { name: 'DefiLlama DEX volume API', url: LLAMA.volume[1], used_for: 'NEAR Intents swap volume' },
    { name: 'DefiLlama fees API (dailyFees / dailyRevenue / dailyHoldersRevenue)', url: 'https://api.llama.fi/summary/fees/near-intents', used_for: 'Gross fees, net revenue, holders revenue (buyback proxy)' },
    { name: price?.source?.name ?? 'DefiLlama coins API (coingecko:near)', url: price?.source?.url ?? 'https://coins.llama.fi/chart/coingecko:near', used_for: 'Daily NEAR/USD price (CoinGecko market_chart is the documented fallback)' },
    { name: 'DefiLlama coins current price', url: 'https://coins.llama.fi/prices/current/coingecko:near', used_for: 'Default simulator price' },
    { name: 'NEAR revenue dashboard (official)', url: 'https://revenue.near.org/', used_for: 'Official listing of the buyback wallet; dashboard-attributed NEAR per wallet (cross-check)' },
    { name: 'NearBlocks API (keyless)', url: 'https://api.nearblocks.io/v1/account/{account}/txns', used_for: 'Listing the candidate wallet’s transfers' },
  ],
};
if (!anyOk && prevLatest) {
  log('No fresh data at all; keeping the previous data/latest.json untouched.');
} else {
  await writeJson('data/latest.json', latest);
  const stamp = generatedAt.replace(/[:]/g, '-').replace(/\.\d+Z$/, 'Z');
  await writeJson(`data/snapshots/${stamp}.json`, latest);
}
const statusOut = {
  generated_at: generatedAt,
  last_successful_refresh: latest.last_successful_refresh,
  sources: Object.fromEntries(Object.entries({ ...prevStatus.sources, ...status }).map(([k, s]) => [k, {
    ok: status[k] ? status[k].ok !== false : false, http_status: s.http_status ?? null, error: status[k] ? (status[k].ok === false ? s.error : null) : 'not called this run',
    fetched_at: s.fetched_at ?? null, url: s.url ?? null, calls: status[k]?.calls ?? 0, failures: status[k]?.failures ?? 0,
    last_ok_at: status[k]?.ok !== false && status[k] ? s.fetched_at : (prevStatus.sources?.[k]?.last_ok_at ?? null),
  }])),
  failed_groups: groupErrors,
  rpc_calls: rpc.calls,
};
await writeJson('data/status.json', statusOut);

// ---------- console summary ----------
const fmt = (k) => { const m = M[k]; return m.status === 'unavailable' ? `unavailable (${m.reason})` : `${typeof m.value === 'number' ? m.value.toLocaleString('en-US', { maximumFractionDigits: 4 }) : m.value} ${m.unit} [${m.status}${m.stale ? ', stale' : ''}]`; };
log('\nSummary', window.start, '→', window.end);
for (const k of Object.keys(M).filter((k) => k !== 'epoch_checks')) log(`  ${k}: ${fmt(k)}`);
if (M.epoch_checks) log(`  epoch_checks: ${M.epoch_checks.epochs_checked} checked, ${M.epoch_checks.epochs_flagged} flagged`);
log(`  simulator default: ${scenario.finite ? `$${Math.round(scenario.value).toLocaleString('en-US')}/day` : scenario.reason}`);
log(`  RPC calls: ${rpc.calls}. Failed groups: ${Object.keys(groupErrors).join(', ') || 'none'}`);
if (failedGroups.size) process.exitCode = 2; // partial refresh: data written with stale fallbacks
