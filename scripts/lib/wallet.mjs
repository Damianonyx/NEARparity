// Pure helpers for the buyback-wallet accounting. No I/O; covered by the offline tests.
import { yoctoToNear } from './calc.mjs';

const STAKE_METHODS = new Set(['deposit_and_stake', 'stake', 'stake_all', 'deposit_and_stake_all']);
const POOL_ACCOUNT = /\.(pool|poolv1|poolv2)\.near$|\.pool\.[a-z0-9]+\.m0$/;

/**
 * Staking pools the wallet has delegated to, discovered from its outbound function calls.
 * Staked NEAR is still held by the wallet, so it must not be read as an outflow.
 */
export function discoverStakingPools(txns, accountId) {
  const pools = new Set();
  for (const t of txns || []) {
    if (t.from !== accountId || t.success === false) continue;
    const methods = (t.actions || []).filter((a) => a.startsWith('FUNCTION_CALL:')).map((a) => a.slice(14));
    if (methods.some((m) => STAKE_METHODS.has(m)) || (POOL_ACCOUNT.test(t.to) && methods.includes('deposit'))) pools.add(t.to);
  }
  return [...pools].sort();
}

/**
 * Transfers between the wallet and NEAR's other listed revenue wallets in [start, end):
 * native NEAR (NearBlocks receipt deposits) and wNEAR (NearBlocks FT events, exact amounts).
 * Returns null when the cached history does not reach back to `start`.
 */
export function internalTransfers({ txns = [], ftTxns = [], complete = false }, accountId, related, start, end) {
  if (!accountId) return null;
  const oldest = txns.at(-1)?.time;
  if (!complete && (!oldest || oldest > start)) return null;
  let inbound = 0; let outbound = 0; let count = 0; let ftNet = 0n; const invalid = [];
  for (const t of txns) {
    if (t.time < start || t.time >= end || t.success === false) continue;
    if (t.invalid && ((t.to === accountId && related.has(t.from)) || (t.from === accountId && related.has(t.to)))) { invalid.push(t.receipt_id ?? t.tx_hash); continue; }
    if (t.to === accountId && related.has(t.from)) { inbound += t.deposit_near_approx; count++; }
    if (t.from === accountId && related.has(t.to)) { outbound += t.deposit_near_approx; count++; }
  }
  for (const f of ftTxns) {
    if (f.time < start || f.time >= end || f.contract !== 'wrap.near' || !related.has(f.counterparty)) continue;
    if (f.invalid || f.delta_yocto == null) { invalid.push(f.event_index ?? f.tx_hash); continue; }
    ftNet += BigInt(f.delta_yocto); // exact integer arithmetic for token amounts
    count++;
  }
  // A malformed record that would enter the calculation makes it unavailable instead of silently wrong.
  if (invalid.length) return { invalid };
  const ft = yoctoToNear(ftNet);
  if (ft >= 0) inbound += ft; else outbound -= ft;
  return { inbound, outbound, net: inbound - outbound, count };
}

/** When the wallet account was created (its CREATE_ACCOUNT receipt), else its earliest receipt. */
export function walletCreatedAt(txns, accountId) {
  const created = (txns || []).filter((t) => t.to === accountId && (t.actions || []).includes('CREATE_ACCOUNT')).map((t) => t.time).sort()[0];
  return created ?? (txns || []).map((t) => t.time).sort()[0] ?? null;
}

/** First UTC day with a positive value in a DefiLlama [unixSeconds, value] series. */
export function firstPositiveDay(series) {
  const hit = (series || []).find(([, v]) => typeof v === 'number' && v > 0);
  return hit ? new Date(hit[0] * 1000).toISOString().slice(0, 10) : null;
}
