#!/usr/bin/env node
// Keyless on-chain check of who funds the buyback wallet, and whether the purchase appears in the same transaction.
// For an evenly spaced sample of the wallet's inflows from intents.near (from data/wallet-transfers.json), it reads
// each transaction's dip4 event logs from the archival RPC and records:
//   - which NEAR Intents account signed the native_withdraw to the wallet;
//   - whether that account's token_diff (swap) in the same transaction delivered the withdrawn NEAR (>= 90%).
// Saves docs/withdrawer-sample.json. Usage: node scripts/check-withdrawers.mjs [sampleSize=120]
import { readFile, writeFile } from 'node:fs/promises';

const WALLET = 'buybacks.multisignature.near';
const N = Number(process.argv[2] || 120);
const URLS = (process.env.NEAR_PARITY_RPC_URLS || 'https://archival-rpc.mainnet.fastnear.com,https://archival-rpc.mainnet.near.org').split(',');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;

async function txStatus(hash) {
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const url of URLS) {
      try {
        const res = await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'EXPERIMENTAL_tx_status', params: { tx_hash: hash, sender_account_id: 'intents.near', wait_until: 'FINAL' } }),
        });
        if (res.status === 429) { await wait(2000 * (attempt + 1)); continue; }
        const j = await res.json();
        if (j.result) return j.result;
      } catch { /* try the next endpoint */ }
    }
  }
  return null;
}

const T = JSON.parse(await readFile(new URL('../data/wallet-transfers.json', import.meta.url), 'utf8'));
const inflows = T.txns.filter((x) => x.from === 'intents.near' && x.success).sort((a, b) => a.time.localeCompare(b.time));
const picks = [...new Set(Array.from({ length: N }, (_, i) => Math.floor((i * (inflows.length - 1)) / Math.max(1, N - 1))))].map((i) => inflows[i]);

const rows = [];
for (const p of picks) {
  const res = await txStatus(p.tx_hash);
  if (!res) { rows.push({ tx_hash: p.tx_hash, time: p.time, error: 'unavailable' }); continue; }
  const events = res.receipts_outcome.flatMap((o) => o.outcome.logs).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11)));
  for (const w of events.filter((e) => e.event === 'native_withdraw').flatMap((e) => e.data).filter((d) => d.receiver_id === WALLET)) {
    const diffs = events.filter((e) => e.event === 'token_diff').flatMap((e) => e.data).filter((d) => d.account_id === w.account_id);
    const swappedNear = diffs.reduce((s, d) => s + near(d.diff?.['nep141:wrap.near'] || '0'), 0);
    rows.push({ tx_hash: p.tx_hash, time: p.time, withdrawing_account: w.account_id, withdrawn_near: near(w.amount), wnear_from_swap_in_same_tx: swappedNear });
  }
  await wait(300);
}

const ok = rows.filter((r) => !r.error);
const counts = {};
for (const r of ok) counts[r.withdrawing_account] = (counts[r.withdrawing_account] || 0) + 1;
const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
const full = ok.filter((r) => r.wnear_from_swap_in_same_tx >= 0.9 * r.withdrawn_near);
const out = {
  checked_at: new Date().toISOString(),
  method: 'EXPERIMENTAL_tx_status on the archival RPC; dip4 native_withdraw and token_diff events in each inflow transaction',
  inflows_total: inflows.length, sampled: picks.length, withdrawals_read: ok.length, errors: rows.length - ok.length,
  sample_period: [picks[0]?.time, picks.at(-1)?.time],
  distinct_withdrawing_accounts: top.length,
  top_withdrawing_accounts: top.slice(0, 5).map(([account, n]) => ({ account, withdrawals: n })),
  withdrawals_with_purchase_in_same_tx: full.length,
  withdrawals_with_any_swap_in_same_tx: ok.filter((r) => r.wnear_from_swap_in_same_tx > 0).length,
  reading: full.length
    ? 'Some withdrawals carry the purchase in the same transaction; those purchases can be read from the chain.'
    : 'Many different NEAR Intents accounts fund the wallet, and no sampled withdrawal carries its purchase in the same transaction (only dust swaps). The NEAR is bought earlier, in separate transactions that can only be found by searching every intents.near event by account (an indexer such as BigQuery), so purchases stay unverified.',
  rows,
};
await writeFile(new URL('../docs/withdrawer-sample.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ ...out, rows: undefined }, null, 2));
