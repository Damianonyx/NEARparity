# NEAR Parity

**Are NEAR Intents buybacks keeping pace with new NEAR issuance?**

NEAR Parity is an interactive research dashboard for the NEAR Hackathon (Investment Thesis track). It compares newly minted NEAR with NEAR Intents revenue, the evidence for buybacks, and the actual change in total supply, and it shows every calculation.

**Live site:** https://nearparity.vercel.app/ · **Thesis:** [THESIS.md](THESIS.md)

One distinction governs everything here: **buybacks do not automatically reduce total supply.** Purchased NEAR can stay in a treasury wallet. Matching issuance through purchases would not establish zero inflation or price appreciation.

## What you can do with it (do X → see Y)

Requirements: Node 22 (22.21 or newer if you are behind an HTTP proxy). No `npm install`, no build step, no API keys.

| Do | See |
|---|---|
| `node scripts/test.mjs` | 13 offline tests pass (parity formula, zero denominator, BigInt conversions, burn reconciliation, 30-day windowing, block search, epoch checks). No network needed. |
| `node scripts/serve.mjs` then open http://localhost:8080 | The dashboard, using the committed dataset in `data/`. |
| `node scripts/build-data.mjs` (behind a proxy: `node --use-env-proxy scripts/build-data.mjs`) | Fresh data: `data/latest.json`, a new `data/snapshots/<UTC timestamp>.json`, and `data/status.json`. With the committed caches this takes well under a minute. The console prints every metric with its status. Exit code 0 = all core sources refreshed, 2 = partial refresh (failed sources keep their last good values, marked stale). |
| `node scripts/check-apis.mjs` | An access check of every endpoint (HTTP status plus the first 300 characters of each response). |
| `node scripts/verify-claims.mjs` | Re-fetches the primary sources cited in THESIS.md and prints the relevant passages. |
| `NEAR_PARITY_SIMULATE_FAIL=chain,price node scripts/build-data.mjs` | The stale fallback in action: the named sources "fail", and their last good values are kept and marked stale with their date. Run this in a copy of the repo, since it rewrites `data/`. |

GitHub Actions does the same thing automatically: `.github/workflows/refresh.yml` runs the tests and the build on every push, by hand, and daily at 05:41 UTC, then commits `data/` on `main`. Vercel redeploys `main` on every push, so the site picks up each refresh.

## Repository map

```
index.html, style.css, app.js     dashboard (no framework; app.js imports the tested formula from scripts/lib/calc.mjs)
scripts/build-data.mjs            one command: fetch → compute → write data/
scripts/lib/calc.mjs              pure calculations (parity formula, BigInt yoctoNEAR, burn reconciliation, windows)
scripts/lib/near.mjs              NEAR RPC: epoch walk, timestamp → block search, wallet balances
scripts/test.mjs, fixtures/       offline tests
scripts/serve.mjs                 local static server
scripts/check-apis.mjs            Phase 0 endpoint access check
scripts/verify-claims.mjs         re-checks the primary sources cited in THESIS.md
config/buyback-wallet.json        the buyback wallet and its official citation
data/                             committed dataset (see "Data files")
.github/workflows/                api-check.yml, refresh.yml, verify-claims.yml
```

## Data sources

| Source | Used for |
|---|---|
| NEAR mainnet archival RPC (FastNEAR) `https://archival-rpc.mainnet.fastnear.com` | Epoch boundaries, total supply, burns, protocol config, wallet balances |
| DefiLlama `api.llama.fi/summary/dexs/near-intents` | NEAR Intents swap volume |
| DefiLlama `api.llama.fi/summary/fees/near-intents?dataType=dailyFees / dailyRevenue / dailyHoldersRevenue` | Gross fees, net revenue, and revenue labelled as buyback money |
| DefiLlama coins `coins.llama.fi/chart/coingecko:near` and `/prices/current/coingecko:near` | Daily and current NEAR/USD price. Documented fallback: CoinGecko `api/v3/coins/near/market_chart` |
| NEAR revenue dashboard (official) `https://revenue.near.org/` | Official listing of the buyback wallet; NEAR attributed to each revenue wallet (cross-check) |
| NearBlocks API (keyless) `api.nearblocks.io/v1/account/{account}/txns` | Listing the buyback wallet's transfers |

## NEAR integrations used

- **JSON-RPC methods:** `block` (headers: `total_supply`, `timestamp_nanosec`, `epoch_id`, `next_epoch_id`, `prev_hash`; chunk `balance_burnt`), `EXPERIMENTAL_protocol_config` (`max_inflation_rate`, `protocol_version`), `query` → `view_account`, and `query` → `call_function` on `wrap.near` (`ft_balance_of`) and `intents.near` (`mt_balance_of` for `nep141:wrap.near`).
- **Archival reads by block hash**, so every figure is pinned to a specific block (heights and hashes are in `data/boundaries.json` and `data/epochs.json`).
- **Epoch walk by header:** on the archival node, `validators` returns `UNKNOWN_EPOCH` for older epochs. Instead, a block's `next_epoch_id` is the hash of the previous epoch's last block, so the build walks back epoch by epoch from headers alone.
- **The buyback wallet** `buybacks.multisignature.near`, a multisig listed on NEAR's revenue dashboard, plus the two other listed revenue wallets, `fefundsadmin.sputnik-dao.near` and `1csfundsadmin.sputnik-dao.near`.

No wallet connection or smart contract is needed.

## Calculation definitions

All default comparisons use **one window: the 30 most recent complete UTC days** (start inclusive, end exclusive). Every metric is stored with `value`, `unit`, `period_start`, `period_end`, `source`, `method` and `status`, where status is `measured`, `estimate`, `proxy` or `unavailable`. An unavailable metric has `value: null` and a `reason`; it is never 0 and never a guess. yoctoNEAR amounts are BigInt and become decimals only for display.

- **Issuance (measured).** NEAR mints at each epoch boundary. For each boundary: `mint = total_supply(first block) − total_supply(previous block) + Σ balance_burnt of chunks included in the first block`. This is exact, because for any block `total_supply = previous supply + minted − burnt`, which the build verified to the yoctoNEAR. Period issuance is the sum over boundaries whose first block falls in the period. Boundaries since 2026-01-31 are cached in `data/epochs.json`.
- **Sanity checks.** Within each epoch, supply may only fall. Each mint should sit at or just below `supply × max_inflation_rate × epoch duration ÷ 31,556,952 s`; a ratio below 0.95 or above 1.001 is flagged. The maximum inflation rate is a cap and is never shown as measured issuance.
- **Supply at a UTC instant** is the `total_supply` of the last block before that instant. The build finds it with an interpolated binary search over heights, skipping missing heights.
- **Actual supply change (measured)** = supply(end) − supply(start).
- **Burns (measured, derived)** = issuance − supply change over the same period. Burns are never added to the supply change again, and treasury purchases are never counted as burns.
- **Intents economics (measured, as reported by DefiLlama)**: daily values summed over the 30 days. If any day is missing, the total is unavailable. Capture rate = net revenue ÷ volume, in basis points.
- **Buyback proxy (proxy)** = Σ over days of (DefiLlama holders revenue in USD ÷ that day's NEAR price). DefiLlama labels captured revenue from 2026-02-23 as buyback money. That is a label, not a record of purchases.
- **Wallet net accumulation (measured)** = change in NEAR held by the buyback wallet (native liquid + locked, wNEAR, and wNEAR inside `intents.near`) between the window's boundary blocks, **minus** transfers from NEAR's other listed revenue wallets, which only move revenue that was already captured. It is net accumulation, not proof of purchases.
- **Buyback coverage** = buyback NEAR ÷ newly issued NEAR over the same period. *Verified* coverage needs verified purchases and is unavailable (see Limitations). The proxy and wallet versions are labelled `proxy`.
- **Parity simulator (conditional scenario):** `Required daily volume (USD) = daily issuance (NEAR) × NEAR price (USD) ÷ (net revenue capture rate × buyback allocation)`. Rates are decimal fractions (bps ÷ 10,000, % ÷ 100). If either rate is zero, the result is "No finite volume achieves parity under these assumptions." The result is not a prediction and not a supply-neutrality threshold.

## Data files

- `data/latest.json`: every metric, the weekly series since 2026-02-01, simulator defaults, the wallet reconciliation and the source list.
- `data/status.json`: per source, ok or failed, HTTP code, error, fetched_at, last_ok_at.
- `data/snapshots/<UTC timestamp>.json`: a copy of each build, so the site stays usable and the history is auditable.
- `data/epochs.json`, `data/boundaries.json`, `data/wallet-transfers.json`: caches, so refreshes only fetch new epochs, blocks and transfers.

## Limitations

- **No verified purchases.** The wallet receives NEAR from `intents.near` every 30–90 minutes, but transfers do not show the swaps behind them, so verified purchases and verified coverage are unavailable. The wallet is listed on NEAR's official revenue dashboard, which confirms the account, not the purchases.
- **The proxy depends on a label.** DefiLlama's holders revenue equals its net revenue from 2026-02-23 onward. Converting it to NEAR at each day's 00:00 UTC price ignores execution prices and timing.
- **DefiLlama figures are third-party aggregates**, reported as published. DefiLlama's daily values can lag by a day; a missing day makes a 30-day total unavailable rather than understated.
- **Burns are derived**, not read from a burn event log. They include all protocol burns (gas and fees) and nothing else.
- **The wallet reconciliation is only partly explained.** On-chain holdings differ from the dashboard's all-time figure, mostly because of an internal transfer from another NEAR revenue wallet and one outflow. About 26 NEAR remains unexplained (THESIS.md).
- **Price source:** DefiLlama coins (coingecko:near), daily samples matched to the nearest UTC midnight within ±10 minutes.
- **Rate limits:** FastNEAR and keyless NearBlocks rate-limit bursts. The build retries with backoff, saves progress, and resumes on the next run.

## Disclosure

The code in this repository was written with AI coding assistants, **Claude Code** (Anthropic) and **Codex** (OpenAI), under the author's direction. Data and claims were checked against the sources listed above, and every number in THESIS.md can be traced to `data/latest.json` or a cited source.

## License

[MIT](LICENSE) © 2026 Damianonyx
