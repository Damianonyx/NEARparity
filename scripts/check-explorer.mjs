#!/usr/bin/env node
// Optional, key-gated check against the NEAR Intents Explorer API (1Click swaps index).
// Asks two questions and saves the answer to docs/explorer-check.json:
//   1. Does the index contain swaps by an Intents account whose native_withdraw intents fund the buyback
//      wallet? (Many accounts do; see docs/withdrawer-sample.json. Two more were searched by hand: 0 found.)
//   2. Which 1Click transactions name the buyback wallet?
// Needs a JWT from https://partners.near-intents.org/ (Key type: Explorer). Provide it as EXPLORER_JWT,
// or run where a network proxy injects it. The API allows roughly one request per 30 s, so requests are spaced.
// Usage: EXPLORER_JWT=... node --use-env-proxy scripts/check-explorer.mjs
import { writeFile } from 'node:fs/promises';

const BASE = 'https://explorer.near-intents.org/api/v0/transactions';
const OPERATOR = '23f0bb1c85fba5ecba38d149c8b916d3a03ed53a00a2fce89b2066dacef24c74';
const WALLET = 'buybacks.multisignature.near';
const headers = process.env.EXPLORER_JWT ? { authorization: `Bearer ${process.env.EXPLORER_JWT}` } : {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(term) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${BASE}?numberOfTransactions=100&search=${encodeURIComponent(term)}`, { headers, signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => null);
    if (res.status === 429) { await wait(35_000); continue; }
    if (!res.ok || !Array.isArray(body)) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    return body;
  }
  throw new Error('rate limited');
}
const slim = (t) => ({
  created_at: t.createdAt, status: t.status, origin_asset: t.originAsset, destination_asset: t.destinationAsset,
  amount_in_usd: t.amountInUsd, amount_out: t.amountOutFormatted, recipient: t.recipient, senders: t.senders, referral: t.referral,
  near_tx_hashes: t.nearTxHashes,
});

const operatorRows = await search(OPERATOR);
await wait(35_000);
const walletRows = (await search(WALLET)).filter((t) => t.recipient === WALLET || (t.senders || []).includes(WALLET));
const intoWallet = walletRows.filter((t) => t.recipient === WALLET && t.status === 'SUCCESS' && t.destinationAsset === 'nep141:wrap.near');
const out = {
  checked_at: new Date().toISOString(),
  source: BASE,
  operator: OPERATOR,
  wallet: WALLET,
  operator_transactions_found: operatorRows.length,
  wallet_transactions_found: walletRows.length,
  successful_wnear_into_wallet: { count: intoWallet.length, near_total: intoWallet.reduce((a, t) => a + Number(t.amountOutFormatted || 0), 0) },
  wallet_transactions: walletRows.map(slim),
  reading: operatorRows.length
    ? 'The 1Click index contains transactions by the buyback operator; inspect them before treating any as purchases.'
    : 'The 1Click index has no transactions by the buyback operator: its buyback swaps happen inside NEAR Intents outside 1Click, so this API cannot verify them. Transactions naming the wallet are third-party 1Click transfers into it.',
};
await writeFile(new URL('../docs/explorer-check.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ ...out, wallet_transactions: `${walletRows.length} rows (see docs/explorer-check.json)` }, null, 2));
