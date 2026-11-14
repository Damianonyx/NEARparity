// Simulated network for the integration test. Loaded with `node --import ./scripts/fixtures/mock-network.mjs`,
// it replaces globalThis.fetch with deterministic fakes of every source the build uses:
//   - a NEAR chain (1 block/s, 43,200-height epochs, skipped heights, exact supply/mint/burn arithmetic)
//   - the buyback wallet (created mid-way, an internal transfer, a staking deposit, a wNEAR transfer)
//   - DefiLlama series, prices, NearBlocks pages, and the revenue dashboard HTML.
// Knobs (env): MOCK_NEARBLOCKS_FAIL_PAGE=n (HTTP 500 on that receipts page), MOCK_LLAMA_DROP_LAST_DAY=1,
//              MOCK_PRIMARY_RPC_DOWN=1 (first RPC endpoint returns 503).
export const CHAIN = {
  T0: Date.UTC(2026, 0, 1) / 1000, H0: 100_000_000, L: 43_200,
  S0: 10n ** 33n, MINT: 34_200n * 10n ** 24n, BURN: 10n ** 20n,
};
export const WALLET = {
  id: 'buybacks.multisignature.near', related: '1csfundsadmin.sputnik-dao.near', pool: 'test.poolv1.near',
  rate: 10n ** 22n, // native growth per height (0.01 NEAR)
  created: Date.UTC(2026, 2, 18, 12) / 1000,
  internalAt: Date.UTC(2026, 10, 1, 1) / 1000, internal: 5n * 10n ** 29n, // 500,000 NEAR from a related wallet
  stakeAt: Date.UTC(2026, 10, 5) / 1000, stake: 10n ** 29n, // 100,000 NEAR delegated (must not count as an outflow)
  wnearAt: Date.UTC(2026, 10, 7) / 1000, wnear: 2n * 10n ** 27n, // 2,000 wNEAR from a related wallet
};
const { T0, H0, L, S0, MINT, BURN } = CHAIN;
const nowS = () => Math.floor((process.env.NEAR_PARITY_NOW ? Date.parse(process.env.NEAR_PARITY_NOW) : Date.now()) / 1000);
export const heightAt = (s) => H0 + (s - T0);
export const missing = (h) => h % 1000 === 7;
const missingUpTo = (h) => Math.floor((h - 7) / 1000) - Math.floor((H0 - 7) / 1000);
export const existingIn = (a, b) => (b - a) - (missingUpTo(b) - missingUpTo(a)); // existing heights in (a, b]
const epochOf = (h) => Math.floor((h - H0) / L);
const start = (k) => H0 + k * L;
export function supplyAt(h) { return S0 + MINT * BigInt(epochOf(h)) - BURN * BigInt(existingIn(H0, h)); }
const finalHeight = () => { let h = heightAt(nowS()) - 5; while (missing(h)) h--; return h; };

function block(h) {
  const k = epochOf(h);
  return {
    header: {
      height: h, hash: `h${h}`, prev_hash: `h${missing(h - 1) ? h - 2 : h - 1}`,
      epoch_id: k >= 1 ? `h${start(k - 1) - 1}` : 'genesis', next_epoch_id: `h${start(k) - 1}`,
      timestamp_nanosec: (BigInt(T0 + (h - H0)) * 1_000_000_000n).toString(), total_supply: supplyAt(h).toString(),
    },
    chunks: [{ height_included: h, balance_burnt: BURN.toString() }, { height_included: h - 1, balance_burnt: '999' }],
  };
}
const tsOf = (h) => T0 + (h - H0);
const ats = (s) => heightAt(s);
function walletAt(h) {
  const t = tsOf(h);
  if (t < WALLET.created) return null;
  let native = BigInt(h - ats(WALLET.created)) * WALLET.rate;
  if (t >= WALLET.internalAt) native += WALLET.internal;
  if (t >= WALLET.stakeAt) native -= WALLET.stake;
  return { native, wnear: t >= WALLET.wnearAt ? WALLET.wnear : 0n, staked: t >= WALLET.stakeAt ? WALLET.stake : 0n };
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const rpcErr = (name) => json({ jsonrpc: '2.0', id: 'x', error: { name: 'HANDLER_ERROR', cause: { name }, message: name } });
const rpcOk = (result) => json({ jsonrpc: '2.0', id: 'x', result });
const enc = (v) => [...Buffer.from(JSON.stringify(v))];

function handleRpc(body) {
  const { method, params } = body;
  const resolve = (p) => {
    if (p.finality) return finalHeight();
    const id = p.block_id;
    const h = typeof id === 'number' ? id : Number(String(id).slice(1));
    if (!Number.isFinite(h) || missing(h) || h < H0 || h > finalHeight()) return null;
    return h;
  };
  if (method === 'block') { const h = resolve(params); return h == null ? rpcErr('UNKNOWN_BLOCK') : rpcOk(block(h)); }
  if (method === 'EXPERIMENTAL_protocol_config') return rpcOk({ max_inflation_rate: [1, 40], protocol_version: 88, epoch_length: L });
  if (method === 'query') {
    const h = resolve(params); if (h == null) return rpcErr('UNKNOWN_BLOCK');
    const w = walletAt(h);
    if (params.request_type === 'view_account') {
      if (params.account_id !== WALLET.id || !w) return rpcErr('UNKNOWN_ACCOUNT');
      return rpcOk({ amount: w.native.toString(), locked: '0' });
    }
    if (params.request_type === 'call_function') {
      const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString());
      if (params.account_id === 'wrap.near') return rpcOk({ result: enc((args.account_id === WALLET.id && w ? w.wnear : 0n).toString()) });
      if (params.account_id === 'intents.near') return rpcOk({ result: enc('0') });
      if (params.account_id === WALLET.pool) return rpcOk({ result: enc((w ? w.staked : 0n).toString()) });
      return rpcErr('UNKNOWN_ACCOUNT');
    }
  }
  return rpcErr('UNKNOWN_METHOD');
}

// ---- DefiLlama, prices, NearBlocks, dashboard ----
const DAY = 86_400;
function dailySeries(value, { from = T0, dropLast = false, zeroBefore = null } = {}) {
  const end = Math.floor(nowS() / DAY) * DAY - (dropLast ? DAY : 0); // complete days only
  const out = [];
  for (let t = from; t < end; t += DAY) out.push([t, zeroBefore && t < zeroBefore ? 0 : value]);
  return out;
}
const llama = (series) => ({ totalDataChart: series, methodology: { Fees: 'fees', Revenue: 'revenue', HoldersRevenue: 'holders' } });

const nbTime = (s) => (BigInt(s) * 1_000_000_000n).toString();
function walletTxns() {
  const rows = [];
  const add = (s, from, to, actions) => rows.push({
    receipt_id: `r${rows.length}`, transaction_hash: `t${rows.length}`, block_timestamp: nbTime(s),
    predecessor_account_id: from, receiver_account_id: to, actions, outcomes: { status: true },
  });
  add(WALLET.created + 10, 'multisignature.near', WALLET.id, [{ action: 'CREATE_ACCOUNT' }, { action: 'TRANSFER', deposit: 5e24 }]);
  for (let s = WALLET.created + DAY; s < nowS() - 3600; s += DAY) add(s, 'intents.near', WALLET.id, [{ action: 'TRANSFER', deposit: 864e24 }]);
  add(WALLET.internalAt, WALLET.related, WALLET.id, [{ action: 'TRANSFER', deposit: Number(WALLET.internal) }]);
  add(WALLET.stakeAt, WALLET.id, WALLET.pool, [{ action: 'FUNCTION_CALL', method: 'deposit_and_stake', deposit: Number(WALLET.stake) }]);
  return rows.sort((a, b) => (BigInt(b.block_timestamp) > BigInt(a.block_timestamp) ? 1 : -1));
}
// NearBlocks daily charts: constant usage with one structural step on 2026-04-02 (txns 3M → 1M, contracts 2M → 100k).
export const USAGE = { stepDay: '2026-04-02', txnsBefore: 3e6, txnsAfter: 1e6, accounts: 1e5, newAccounts: 5e3, contractsBefore: 2e6, contractsAfter: 1e5 };
function usageCharts() {
  const out = [];
  const end = Math.floor(nowS() / DAY) * DAY; // today is incomplete and is excluded by the build
  for (let t = Date.UTC(2025, 11, 1) / 1000; t <= end; t += DAY) {
    const d = new Date(t * 1000).toISOString();
    const after = d.slice(0, 10) >= USAGE.stepDay;
    out.push({ date: d, txns: String(after ? USAGE.txnsAfter : USAGE.txnsBefore), active_accounts: String(USAGE.accounts), new_accounts: String(USAGE.newAccounts), active_contracts: String(after ? USAGE.contractsAfter : USAGE.contractsBefore) });
  }
  return { charts: out };
}
let receiptPagesServed = 0;
function nearblocks(url) {
  const u = new URL(url);
  if (u.pathname === '/v1/charts') return json(usageCharts());
  const cursor = Number(u.searchParams.get('cursor') || 0);
  const per = Number(u.searchParams.get('per_page') || 25);
  if (u.pathname.endsWith('/ft-txns')) {
    return json({ txns: [{ event_index: 'e1', transaction_hash: 'tf', block_timestamp: nbTime(WALLET.wnearAt), affected_account_id: WALLET.id, involved_account_id: WALLET.related, delta_amount: WALLET.wnear.toString(), cause: 'TRANSFER', ft: { contract: 'wrap.near', symbol: 'wNEAR', decimals: 24 } }] });
  }
  receiptPagesServed++;
  if (Number(process.env.MOCK_NEARBLOCKS_FAIL_PAGE) === receiptPagesServed) return json({ message: 'boom' }, 500);
  const all = walletTxns();
  const rows = all.slice(cursor, cursor + per);
  return json({ txns: rows, cursor: cursor + per < all.length ? String(cursor + per) : null });
}
function dashboardHtml() {
  const rows = [{ name: 'fefundsadmin.sputnik-dao.near', nearAmount: 1000, share: 50, pct: 50 }, { name: WALLET.id, nearAmount: 777.5, share: 40, pct: 40 }];
  const escaped = JSON.stringify(rows).replace(/"/g, '\\\\\\"'); // as embedded in the page's flight data
  return `<!doctype html><html><body><script>self.__next_f.push([1,"1a:[\\"$\\",null,{\\"rows\\":${escaped}}]"])</script></body></html>`;
}

// Google sign-in (GitHub OIDC → STS → service account) and BigQuery jobs.query, for the daily trace.
// Each simulated day: 2 withdrawals of 500 NEAR to the wallet, 3 swaps buying 250 NEAR in total; two accounts
// appear on the first queried day. The first query response is incomplete, to exercise job polling.
export const BQ = { withdrawnPerDay: 10n ** 27n, boughtPerDay: 250n * 10n ** 24n, swapsPerDay: 3, withdrawalsPerDay: 2 };
let bqPending = null;
function bigquery(url, init) {
  const auth = (init.headers || {}).authorization;
  if (auth !== 'Bearer sa-token') return json({ error: { message: 'bad token' } }, 401);
  if ((init.method || 'GET') === 'GET') { const r = bqPending; bqPending = null; return json(r); }
  const body = JSON.parse(init.body);
  if (!body.maximumBytesBilled) return json({ error: { message: 'maximumBytesBilled required by the test' } }, 400);
  const p = Object.fromEntries(body.queryParameters.map((q) => [q.name, q.parameterValue.value ?? q.parameterValue.arrayValues.map((v) => v.value)]));
  const ref = { projectId: 'near-parity', jobId: `job${Date.now()}`, location: 'us-east1' };
  if (body.query.includes('.blocks`')) {
    return json({ jobComplete: true, jobReference: ref, schema: { fields: [{ name: 'latest', type: 'INTEGER' }] }, rows: [{ f: [{ v: String(nowS() - 3600) }] }], totalBytesProcessed: '5000000' });
  }
  const known = (p.known || []).filter(Boolean);
  const rows = [];
  for (let t = Date.parse(p.start); t < Date.parse(p.end); t += DAY * 1000) {
    const day = new Date(t).toISOString().slice(0, 10);
    const fresh = !known.length && day === p.start ? [{ v: 'acc-a' }, { v: 'acc-b' }] : [];
    rows.push({ f: [{ v: day }, { v: String(BQ.withdrawalsPerDay) }, { v: BQ.withdrawnPerDay.toString() }, { v: String(BQ.swapsPerDay) }, { v: BQ.boughtPerDay.toString() }, { v: '0' }, { v: fresh }] });
  }
  const fields = ['day', 'withdrawals', 'withdrawn_yocto', 'swaps', 'bought_yocto', 'sold_yocto'].map((name) => ({ name, type: 'STRING' })).concat([{ name: 'new_accounts', type: 'STRING', mode: 'REPEATED' }]);
  bqPending = { jobComplete: true, jobReference: ref, schema: { fields }, rows, totalBytesProcessed: String(rows.length * 1.2e9) };
  return json({ jobComplete: false, jobReference: ref });
}
function google(url, init) {
  const host = new URL(url).host;
  if (host === 'fake-oidc.test') return (init.headers || {}).authorization === 'bearer req-token' ? json({ value: 'oidc-jwt' }) : json({}, 401);
  if (host === 'sts.googleapis.com') {
    const b = JSON.parse(init.body);
    return b.subjectToken === 'oidc-jwt' && b.audience.startsWith('//iam.googleapis.com/projects/') ? json({ access_token: 'fed-token' }) : json({ error: 'bad exchange' }, 400);
  }
  if (host === 'iamcredentials.googleapis.com') return (init.headers || {}).authorization === 'Bearer fed-token' ? json({ accessToken: 'sa-token' }) : json({}, 403);
  return bigquery(url, init);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const host = new URL(url).host;
  if (host.startsWith('fake-archival') || host.startsWith('fake-fallback')) {
    if (process.env.MOCK_PRIMARY_RPC_DOWN && host.startsWith('fake-archival')) return json({ error: 'down' }, 503);
    return handleRpc(JSON.parse(init.body));
  }
  if (host === 'api.llama.fi') {
    if (url.includes('/dexs/')) return json(llama(dailySeries(1e8)));
    const type = new URL(url).searchParams.get('dataType');
    if (type === 'dailyFees') return json(llama(dailySeries(2e5)));
    if (type === 'dailyRevenue') return json(llama(dailySeries(5e4)));
    if (type === 'dailyHoldersRevenue') return json(llama(dailySeries(5e4, { zeroBefore: Date.UTC(2026, 1, 23) / 1000, dropLast: !!process.env.MOCK_LLAMA_DROP_LAST_DAY })));
  }
  if (host === 'coins.llama.fi') {
    if (url.includes('/prices/current/')) return json({ coins: { 'coingecko:near': { price: 2, timestamp: nowS() } } });
    const prices = dailySeries(2).map(([t], i) => ({ timestamp: i % 5 === 0 ? t - 1 : t, price: 2 })); // some samples at 23:59:59
    return json({ coins: { 'coingecko:near': { prices } } });
  }
  if (host === 'api.nearblocks.io') return nearblocks(url);
  if (['fake-oidc.test', 'sts.googleapis.com', 'iamcredentials.googleapis.com', 'bigquery.googleapis.com'].includes(host)) return google(url, init);
  if (host === 'revenue.near.org') return new Response(dashboardHtml(), { status: 200, headers: { 'content-type': 'text/html' } });
  if (realFetch && process.env.MOCK_ALLOW_REAL) return realFetch(input, init);
  return json({ error: `unmocked ${url}` }, 404);
};
