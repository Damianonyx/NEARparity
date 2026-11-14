// External data sources for the build: DefiLlama, prices, NearBlocks, NEAR's revenue dashboard.
// Each fetcher records per-source status and throws on failure; the build decides on fallbacks.
import { DAY_MS } from './calc.mjs';
import { getJson, getText, politeDelay } from './io.mjs';

export const LLAMA = {
  volume: ['defillama_volume', 'https://api.llama.fi/summary/dexs/near-intents'],
  fees: ['defillama_fees', 'https://api.llama.fi/summary/fees/near-intents?dataType=dailyFees'],
  revenue: ['defillama_revenue', 'https://api.llama.fi/summary/fees/near-intents?dataType=dailyRevenue'],
  holders: ['defillama_holders_revenue', 'https://api.llama.fi/summary/fees/near-intents?dataType=dailyHoldersRevenue'],
};
export const DASHBOARD_URL = 'https://revenue.near.org/';

/** One DefiLlama daily series: { series: [[unixSeconds, value]], methodology, url }. */
export async function fetchLlamaSeries({ setStatus }, key, url) {
  const body = await getJson(setStatus, key, url);
  if (!Array.isArray(body.totalDataChart) || !body.totalDataChart.length) throw new Error('Empty totalDataChart');
  return { series: body.totalDataChart, methodology: body.methodology ?? null, url };
}

/** Map daily [unixSeconds, price] samples to UTC days, using the sample nearest 00:00 UTC (±10 min). */
export function pricesByDay(daily) {
  const byDay = new Map(); const bestOff = new Map();
  for (const [ts, p] of daily) {
    const midnight = Math.round(ts / 86_400) * 86_400;
    const off = Math.abs(ts - midnight);
    if (off > 600 || typeof p !== 'number') continue;
    const day = new Date(midnight * 1000).toISOString().slice(0, 10);
    if (!bestOff.has(day) || off < bestOff.get(day)) { byDay.set(day, p); bestOff.set(day, off); }
  }
  return byDay;
}

/** Daily NEAR/USD from DefiLlama coins; CoinGecko as the documented fallback (its free API covers ≤365 days,
 *  so older days are simply missing and anything that needs them shows as unavailable). */
export async function fetchPrice({ setStatus }, { from, to }) {
  const span = Math.ceil((new Date(to) - new Date(from)) / DAY_MS) + 1;
  const start = Math.floor(new Date(from).getTime() / 1000);
  let daily; let source;
  try {
    const url = `https://coins.llama.fi/chart/coingecko:near?start=${start}&span=${span}&period=1d&searchWidth=600`;
    const body = await getJson(setStatus, 'price_defillama_chart', url);
    daily = body.coins['coingecko:near'].prices.map((p) => [p.timestamp, p.price]);
    source = { name: 'DefiLlama coins API (coingecko:near), daily', url, reported_by: 'DefiLlama' };
  } catch {
    const days = Math.min(365, span);
    const url = `https://api.coingecko.com/api/v3/coins/near/market_chart?vs_currency=usd&days=${days}&interval=daily`;
    const body = await getJson(setStatus, 'price_coingecko', url);
    daily = body.prices.map(([ms, p]) => [Math.floor(ms / 1000), p]);
    source = { name: 'CoinGecko market_chart (fallback)', url, reported_by: 'CoinGecko' };
  }
  let current = null;
  try {
    const url = 'https://coins.llama.fi/prices/current/coingecko:near';
    const body = await getJson(setStatus, 'price_defillama_current', url);
    const c = body.coins['coingecko:near'];
    current = { price: c.price, time: new Date(c.timestamp * 1000).toISOString(), url };
  } catch { /* optional: the daily series is still usable */ }
  return { byDay: pricesByDay(daily), source, current };
}

const slimTxn = (t) => ({
  receipt_id: t.receipt_id, tx_hash: t.transaction_hash ?? null,
  time: new Date(Number(BigInt(t.block_timestamp) / 1_000_000n)).toISOString(),
  block_height: t.receipt_block?.block_height ?? t.block?.block_height ?? null,
  from: t.predecessor_account_id, to: t.receiver_account_id,
  actions: (t.actions || []).map((a) => (a.method ? `${a.action}:${a.method}` : a.action)),
  // NearBlocks returns receipt deposits as JSON floats: approximate, used for listing and internal-transfer netting.
  deposit_near_approx: (t.actions || []).reduce((s, a) => s + (Number(a.deposit) || 0), 0) / 1e24,
  success: t.outcomes?.status ?? null,
});
const slimFt = (t) => ({
  event_index: t.event_index, tx_hash: t.transaction_hash ?? null,
  time: new Date(Number(BigInt(t.block_timestamp) / 1_000_000n)).toISOString(),
  contract: t.ft?.contract ?? null, counterparty: t.involved_account_id ?? null, cause: t.cause ?? null,
  delta_yocto: /^-?\d+$/.test(String(t.delta_amount)) ? String(t.delta_amount) : '0', // exact smallest units
});

/**
 * Incremental NearBlocks history for the wallet: receipts (txns) and fungible-token events (ft-txns).
 * New pages are fetched until a known item; an interrupted first backfill resumes on the next run.
 * Progress is saved after every page. Returns the cache object.
 */
export async function fetchTransfers({ setStatus, store, log, notes }, accountId) {
  const cache = await store.readJson('data/wallet-transfers.json', null);
  const fresh = cache?.account_id === accountId ? cache : { account_id: accountId, complete: false, resume_cursor: null, txns: [] };
  fresh.ft_txns ||= [];
  const base = `https://api.nearblocks.io/v1/account/${accountId}/txns?per_page=100`;
  const ftBase = `https://api.nearblocks.io/v1/account/${accountId}/ft-txns?per_page=100`;
  const save = () => store.writeJson('data/wallet-transfers.json', { ...fresh, updated_at: new Date().toISOString() });
  const page = async (urlBase, cursor) => {
    const url = cursor ? `${urlBase}&cursor=${cursor}` : urlBase;
    for (let attempt = 0; ; attempt++) {
      try {
        const body = await getJson(setStatus, 'nearblocks', url, { retries: 0 });
        await politeDelay(4000); // keyless rate limit
        return body;
      } catch (e) {
        if (e.http !== 429 || attempt >= 4) throw e;
        await politeDelay(20_000 * (attempt + 1));
      }
    }
  };
  // Receipts: newest pages until a known receipt.
  const knownIds = new Set(fresh.txns.map((t) => t.receipt_id));
  const added = []; let cursor = null; let pages = 0;
  while (pages < (knownIds.size ? 60 : 1)) {
    const body = await page(base, cursor); pages++;
    const rows = body.txns || []; let reachedKnown = false;
    for (const t of rows) { if (knownIds.has(t.receipt_id)) { reachedKnown = true; break; } added.push(slimTxn(t)); }
    cursor = rows.length ? body.cursor || null : null;
    if (reachedKnown || !cursor) break;
  }
  fresh.txns = [...added, ...fresh.txns];
  if (!knownIds.size) { fresh.resume_cursor = cursor; fresh.complete = !cursor; }
  await save();
  // Resume an incomplete backfill.
  while (!fresh.complete && fresh.resume_cursor && pages < 120) {
    let body;
    try { body = await page(base, fresh.resume_cursor); pages++; } catch (e) {
      log(`  NearBlocks backfill paused at ${fresh.txns.at(-1)?.time} (${e.message}); next run resumes`);
      notes.nearblocks_backfill = e.message;
      break;
    }
    const rows = body.txns || [];
    for (const t of rows) if (!knownIds.has(t.receipt_id)) fresh.txns.push(slimTxn(t));
    fresh.resume_cursor = rows.length ? body.cursor || null : null;
    if (!fresh.resume_cursor) fresh.complete = true;
    await save();
  }
  // FT events (wNEAR etc.), newest first until a known event.
  const knownFt = new Set(fresh.ft_txns.map((t) => t.event_index));
  const addedFt = []; let ftCursor = null;
  for (let p = 0; p < 20; p++) {
    const body = await page(ftBase, ftCursor);
    const rows = body.txns || []; let reachedKnown = false;
    for (const t of rows) { if (knownFt.has(t.event_index)) { reachedKnown = true; break; } addedFt.push(slimFt(t)); }
    ftCursor = rows.length ? body.cursor || null : null;
    if (reachedKnown || !ftCursor) break;
  }
  fresh.ft_txns = [...addedFt, ...fresh.ft_txns];
  const dedupe = (arr, key) => { const seen = new Set(); return arr.filter((t) => !seen.has(t[key]) && seen.add(t[key])); };
  fresh.txns = dedupe(fresh.txns, 'receipt_id').sort((a, b) => b.time.localeCompare(a.time));
  fresh.ft_txns = dedupe(fresh.ft_txns, 'event_index').sort((a, b) => b.time.localeCompare(a.time));
  fresh.description = 'Receipts (txns) and fungible-token events (ft_txns) involving the buyback wallet, from NearBlocks (no key). Receipt deposits are NearBlocks floats (approximate); FT deltas are exact smallest-unit strings. Balances come from the archival RPC.';
  fresh.source = base;
  fresh.updated_at = new Date().toISOString();
  await store.writeJson('data/wallet-transfers.json', fresh);
  return fresh;
}

/** Parse the wallet breakdown rows embedded in revenue.near.org (JSON, possibly with escaped quotes). */
export function parseDashboardRows(html) {
  const rows = [];
  const re = /name\\*":\\*"([a-z0-9._-]+\.near)\\*",\\*"nearAmount\\*":([0-9.]+),\\*"share\\*":([0-9.]+)/g;
  for (const m of html.matchAll(re)) if (!rows.some((r) => r.account === m[1])) rows.push({ account: m[1], near_amount: Number(m[2]), share_pct: Number(m[3]) });
  return rows;
}

export async function fetchDashboard({ setStatus }) {
  const html = await getText(setStatus, 'near_revenue_dashboard', DASHBOARD_URL);
  const rows = parseDashboardRows(html);
  if (!rows.length) {
    setStatus('near_revenue_dashboard', { ok: false, http_status: 200, error: 'Wallet breakdown not found in page', url: DASHBOARD_URL });
    throw new Error('Wallet breakdown not found in page');
  }
  setStatus('near_revenue_dashboard', { ok: true, http_status: 200, url: DASHBOARD_URL });
  return { url: DASHBOARD_URL, fetched_at: new Date().toISOString(), rows };
}
