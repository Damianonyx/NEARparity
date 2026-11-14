// NEAR chain access: JSON-RPC with retries, epoch-boundary walk, timestamp → block search,
// and wallet balances at a block. Node 22 built-ins only.
import { epochMint, expectedMaxMint, toYocto } from './calc.mjs';

export const RPC_URL = 'https://rpc.mainnet.fastnear.com';
export const ARCHIVAL_URL = 'https://archival-rpc.mainnet.fastnear.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RpcError extends Error {
  constructor(name, message, httpStatus = 200) { super(message); this.name = name; this.httpStatus = httpStatus; }
}

export function createRpc(url, { onStatus, timeoutMs = 30_000, retries = 8 } = {}) {
  let calls = 0;
  async function call(method, params) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) await sleep(Math.min(30_000, (lastErr?.httpStatus === 429 ? 3000 : 500) * 2 ** (attempt - 1)));
      calls++;
      let httpStatus = null;
      try {
        const res = await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'near-parity', method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        httpStatus = res.status;
        if (res.status === 429 || res.status >= 500) throw new RpcError('HTTP', `HTTP ${res.status}`, res.status);
        const body = await res.json();
        if (body.error) {
          const name = body.error.cause?.name || body.error.name || 'RPC_ERROR';
          // Deterministic answers (unknown block/account/epoch) are not retried.
          const err = new RpcError(name, `${name}: ${body.error.data || body.error.message}`, res.status);
          if (/UNKNOWN_|NOT_FOUND|UNAVAILABLE|PARSE/.test(name) || res.status === 400) { onStatus?.(true, res.status); throw Object.assign(err, { final: true }); }
          throw err;
        }
        onStatus?.(true, res.status);
        return body.result;
      } catch (e) {
        if (e.final) throw e;
        lastErr = e;
        if (!e.httpStatus) e.httpStatus = httpStatus;
      }
    }
    onStatus?.(false, lastErr?.httpStatus ?? null, lastErr?.message);
    throw lastErr;
  }
  return { call, url, get calls() { return calls; } };
}

/** Run `fn` over items with at most `limit` in flight. Preserves order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const nsToIso = (ns) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
const isoToNs = (iso) => BigInt(new Date(iso).getTime()) * 1_000_000n;

/** Σ balance_burnt of chunks newly included in this block (height_included == block height). */
export function blockBurnt(block) {
  return block.chunks
    .filter((c) => c.height_included === block.header.height)
    .reduce((a, c) => a + BigInt(c.balance_burnt), 0n);
}

function slimBlock(b) {
  return {
    height: b.header.height, hash: b.header.hash, prev_hash: b.header.prev_hash,
    epoch_id: b.header.epoch_id, next_epoch_id: b.header.next_epoch_id,
    timestamp_ns: b.header.timestamp_nanosec, time: nsToIso(b.header.timestamp_nanosec),
    total_supply: b.header.total_supply, burnt: blockBurnt(b).toString(),
  };
}

export async function getBlock(rpc, blockId) {
  return slimBlock(await rpc.call('block', typeof blockId === 'object' ? blockId : { block_id: blockId }));
}

/** First existing block after `prev` (skipping missing heights), verified by prev_hash. */
async function nextBlockAfter(rpc, prev, maxSkip = 30) {
  for (let h = prev.height + 1; h <= prev.height + maxSkip; h++) {
    try {
      const b = await getBlock(rpc, h);
      if (b.prev_hash !== prev.hash) throw new Error(`Block ${h} does not follow ${prev.height}`);
      return b;
    } catch (e) { if (e.name !== 'UNKNOWN_BLOCK') throw e; }
  }
  throw new Error(`No block found after height ${prev.height}`);
}

/** Build one boundary record from the last block of an epoch (fetches the next epoch's first block). */
async function boundaryRecord(rpc, last) {
  const first = await nextBlockAfter(rpc, last);
  const mint = epochMint({ supplyPrev: last.total_supply, supplyStart: first.total_supply, boundaryBurnt: first.burnt });
  return {
    epoch_id: first.epoch_id, start_height: first.height, start_hash: first.hash, start_time: first.time,
    start_timestamp_ns: first.timestamp_ns, prev_height: last.height, prev_hash: last.hash, prev_time: last.time,
    prev_next_epoch_id: last.next_epoch_id,
    total_supply_prev: last.total_supply, total_supply_start: first.total_supply, boundary_block_burnt: first.burnt,
    mint_yocto: mint.toString(),
  };
}

/**
 * Walk epoch boundaries backwards. A block's next_epoch_id is the hash of the previous epoch's last
 * block, which avoids `validators` (unavailable on archival nodes for old epochs).
 *  - top segment: from the current epoch back to the newest cached boundary (all-or-nothing, so no gaps)
 *  - bottom segment: from the oldest cached boundary back to `backfillFrom` (saved as it goes)
 * `cached` is the sorted record list; `save(records)` persists progress. Returns { final, records }.
 */
export async function walkEpochs(rpc, { backfillFrom, cached = [], save = async () => {}, log = () => {}, concurrency = 3 }) {
  const final = await getBlock(rpc, { finality: 'final' });
  const stopNs = isoToNs(backfillFrom);
  const known = new Set(cached.map((r) => r.prev_hash));
  let records = [...cached];

  async function walk(fromHash, stop) {
    const lasts = [];
    let cursor = await getBlock(rpc, fromHash);
    while (!stop(cursor)) {
      lasts.push(cursor);
      if (BigInt(cursor.timestamp_ns) < stopNs) break;
      cursor = await getBlock(rpc, cursor.next_epoch_id);
      if (lasts.length % 100 === 0) log(`  walked ${lasts.length} epochs back to ${cursor.time}`);
    }
    return lasts;
  }
  // Top segment.
  // With an empty cache, take only the newest boundary here; the bottom segment backfills in saved batches.
  const topLasts = cached.length
    ? await walk(final.next_epoch_id, (b) => known.has(b.hash))
    : [await getBlock(rpc, final.next_epoch_id)];
  if (topLasts.length) {
    log(`  top segment: ${topLasts.length} new boundaries`);
    const top = await mapLimit(topLasts, concurrency, (l) => boundaryRecord(rpc, l));
    records = [...records, ...top].sort((a, b) => a.start_height - b.start_height);
    await save(records);
  }
  // Bottom segment (initial backfill or an interrupted one).
  const oldest = records[0];
  if (oldest && BigInt(oldest.start_timestamp_ns) >= stopNs && BigInt(isoToNs(oldest.prev_time)) >= stopNs) {
    log(`  extending backfill below ${oldest.start_time}`);
    let cursorHash = oldest.prev_next_epoch_id ?? (await getBlock(rpc, oldest.prev_hash)).next_epoch_id;
    while (true) {
      const batch = [];
      let cursor = await getBlock(rpc, cursorHash);
      for (let i = 0; i < 50; i++) {
        batch.push(cursor);
        if (BigInt(cursor.timestamp_ns) < stopNs) break;
        cursor = await getBlock(rpc, cursor.next_epoch_id);
      }
      const recs = await mapLimit(batch, concurrency, (l) => boundaryRecord(rpc, l));
      records = [...recs, ...records].sort((a, b) => a.start_height - b.start_height);
      await save(records);
      log(`  backfilled to ${records[0].start_time} (${records.length} boundaries)`);
      if (BigInt(batch.at(-1).timestamp_ns) < stopNs) break;
      cursorHash = cursor.hash;
    }
  }
  return { final, records };
}

/**
 * Attach max_inflation_rate to each record from EXPERIMENTAL_protocol_config sampled at every
 * `step`-th boundary (and the newest). Records between samples take the value of the sample
 * at or after them only when the samples on both sides agree; otherwise they stay unsampled.
 */
export async function sampleInflationRates(rpc, records, { step = 25, log = () => {} } = {}) {
  const idx = [];
  for (let i = 0; i < records.length; i += step) idx.push(i);
  if (idx.at(-1) !== records.length - 1) idx.push(records.length - 1);
  const need = idx.filter((i) => !records[i].max_inflation_rate_sampled);
  await mapLimit(need, 2, async (i) => {
    const cfg = await rpc.call('EXPERIMENTAL_protocol_config', { block_id: records[i].start_hash });
    records[i].max_inflation_rate = cfg.max_inflation_rate;
    records[i].protocol_version = cfg.protocol_version;
    records[i].max_inflation_rate_sampled = true;
  });
  log(`  protocol config sampled at ${need.length} new boundaries`);
  for (let k = 0; k < idx.length - 1; k++) {
    const a = records[idx[k]]; const b = records[idx[k + 1]];
    const same = JSON.stringify(a.max_inflation_rate) === JSON.stringify(b.max_inflation_rate);
    for (let i = idx[k] + 1; i < idx[k + 1]; i++) {
      if (records[i].max_inflation_rate_sampled) continue;
      records[i].max_inflation_rate = same ? a.max_inflation_rate : null;
    }
  }
  return records;
}

/**
 * Sanity checks over consecutive boundary records (oldest first):
 *  - within an epoch, supply should only fall (burns): supply(last block of k) ≤ supply(first block of k)
 *  - each mint should be close to (and not above) supply × max_inflation_rate × duration ÷ year.
 */
export function epochChecks(records) {
  const checks = [];
  for (let i = 1; i < records.length; i++) {
    const a = records[i - 1]; const b = records[i];
    const within = toYocto(b.total_supply_prev) - toYocto(a.total_supply_start);
    const durationNs = BigInt(b.start_timestamp_ns) - BigInt(a.start_timestamp_ns);
    const mint = toYocto(b.mint_yocto);
    const expected = b.max_inflation_rate ? expectedMaxMint({ supply: b.total_supply_prev, rate: b.max_inflation_rate, durationNs }) : null;
    const ratio = expected ? Number((mint * 1_000_000n) / expected) / 1e6 : null;
    const issues = [];
    if (within > 0n) issues.push('supply rose inside the epoch');
    if (b.prev_hash === a.prev_hash) issues.push('duplicate boundary');
    // Continuity: consecutive boundaries are one epoch (~43,200 heights) apart; a gap means a missing epoch.
    const spacing = b.start_height - a.start_height;
    if (spacing > 43_200 * 1.5 || spacing < 43_200 * 0.5) issues.push(`boundary spacing ${spacing} heights (missing or extra epoch?)`);
    if (ratio != null && ratio > 1.001) issues.push('mint above max_inflation_rate cap');
    if (ratio != null && ratio < 0.95) issues.push('mint more than 5% below cap');
    if (ratio == null) issues.push('max_inflation_rate not sampled; cap check skipped');
    checks.push({
      epoch_start_height: b.start_height, epoch_start_time: b.start_time, duration_hours: Number(durationNs) / 3.6e12,
      within_epoch_supply_change_yocto: within.toString(), mint_yocto: b.mint_yocto, expected_max_mint_yocto: expected?.toString() ?? null,
      mint_to_cap_ratio: ratio, issues,
    });
  }
  return checks;
}

/**
 * Last block with timestamp < `iso` (the supply "at" a UTC boundary). Uses cached epoch
 * boundaries to narrow the range, then binary-searches heights, skipping missing heights.
 */
export async function blockBefore(rpc, iso, records, final) {
  const t = isoToNs(iso);
  let k = -1;
  for (let i = 0; i < records.length; i++) if (BigInt(records[i].start_timestamp_ns) < t) k = i;
  if (k < 0) throw new Error(`No cached epoch boundary before ${iso}`);
  const r = records[k];
  let loBlock = { height: r.start_height, hash: r.start_hash, time: r.start_time, timestamp_ns: r.start_timestamp_ns, total_supply: r.total_supply_start };
  let lo = loBlock.height;
  let hi = k + 1 < records.length ? records[k + 1].start_height : final.height + 1;
  let hiNs = k + 1 < records.length ? BigInt(records[k + 1].start_timestamp_ns) : BigInt(final.timestamp_ns) + 1n;
  if (k + 1 >= records.length && BigInt(final.timestamp_ns) < t) throw new Error(`${iso} is after the final block`);
  let iter = 0;
  while (hi - lo > 1) {
    // Interpolation search (block times are nearly uniform), falling back to bisection.
    const loNs = BigInt(loBlock.timestamp_ns);
    let mid = Math.floor((lo + hi) / 2);
    if (iter++ < 6 && hiNs > loNs) {
      const guess = lo + Number(((t - loNs) * BigInt(hi - lo)) / (hiNs - loNs));
      mid = Math.min(hi - 1, Math.max(lo + 1, guess + (iter % 2 ? 2 : -2)));
    }
    let found = null;
    for (let h = mid; h > lo && h > mid - 10; h--) {
      try { found = await getBlock(rpc, h); break; } catch (e) { if (e.name !== 'UNKNOWN_BLOCK') throw e; }
    }
    if (!found) { lo = mid; continue; } // all heights (mid-10, mid] missing; loBlock stays valid
    if (BigInt(found.timestamp_ns) < t) { lo = mid; loBlock = found; } else { hi = found.height; hiNs = BigInt(found.timestamp_ns); }
  }
  return loBlock;
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const decodeResult = (r) => JSON.parse(Buffer.from(r.result).toString('utf8'));

/** NEAR held by an account at a block: native (liquid + locked), wNEAR, and wNEAR inside intents.near. */
export async function walletBalances(rpc, accountId, blockHash) {
  let native = 0n; let exists = true;
  try {
    const acc = await rpc.call('query', { request_type: 'view_account', account_id: accountId, block_id: blockHash });
    native = BigInt(acc.amount) + BigInt(acc.locked);
  } catch (e) {
    if (e.name !== 'UNKNOWN_ACCOUNT') throw e;
    exists = false; // the account did not exist yet: its balance is genuinely zero
  }
  const call = async (contract, method, args) => {
    const r = await rpc.call('query', { request_type: 'call_function', account_id: contract, method_name: method, args_base64: b64(args), block_id: blockHash });
    return toYocto(decodeResult(r));
  };
  const wnear = await call('wrap.near', 'ft_balance_of', { account_id: accountId });
  const intents = await call('intents.near', 'mt_balance_of', { account_id: accountId, token_id: 'nep141:wrap.near' });
  return { exists, native_yocto: native.toString(), wnear_yocto: wnear.toString(), intents_wnear_yocto: intents.toString(), total_yocto: (native + wnear + intents).toString() };
}
