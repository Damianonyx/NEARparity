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
let receiptPagesServed = 0;
function nearblocks(url) {
  const u = new URL(url);
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
  if (host === 'revenue.near.org') return new Response(dashboardHtml(), { status: 200, headers: { 'content-type': 'text/html' } });
  if (realFetch && process.env.MOCK_ALLOW_REAL) return realFetch(input, init);
  return json({ error: `unmocked ${url}` }, 404);
};
