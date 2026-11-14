# NEAR Parity data API

The dashboard is a static site over a public JSON dataset. Anyone can read the same files directly, with CORS enabled (`Access-Control-Allow-Origin: *`) and no caching (`Cache-Control: max-age=0, must-revalidate`).

| Endpoint | What it is | Updated |
|---|---|---|
| `https://nearparity.vercel.app/data/latest.json` | Every metric for the latest 30-day window, the weekly series since 2026-02-01, simulator defaults, the wallet reconciliation, sources | Twice daily (05:41 and 13:17 UTC) |
| `https://nearparity.vercel.app/data/status.json` | Per-source health: ok, HTTP code, error, fetched_at, last_ok_at, retries; RPC endpoint usage; consecutive partial runs | Every build |
| `https://nearparity.vercel.app/data/snapshots/<UTC timestamp>.json` | Immutable copy of `latest.json`, one per UTC day (the first successful build of the day) | Daily |
| `https://nearparity.vercel.app/data/epochs.json` | Every epoch boundary since 2026-01-31: heights, hashes, supplies, burns, exact mint (yoctoNEAR) | Twice daily |
| `https://nearparity.vercel.app/data/boundaries.json` | The last block before each UTC boundary used, with total supply and wallet balances | Twice daily |
| `https://nearparity.vercel.app/data/wallet-transfers.json` | The buyback wallet's NearBlocks receipts and FT events | Twice daily |
| `https://nearparity.vercel.app/data/usage.json` | Daily NEAR network usage from NearBlocks since 2025-01-01: `txns`, `active_accounts`, `new_accounts`, `active_contracts` (NearBlocks' definitions) | Twice daily |

The contract below is enforced in CI by `node scripts/check-data.mjs`.

## `latest.json` (schema_version 2)

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | number | `2`. Incremented on breaking changes. |
| `generated_at` | ISO time | When this file was built. |
| `last_successful_refresh` | ISO time or null | The last build in which every core source succeeded. |
| `partial_refresh` | boolean | True if a core source failed in this build (its values are the previous ones, marked stale). |
| `failed_groups`, `notes` | object | Source groups that failed this run; non-fatal notes (for example, a paused NearBlocks backfill). |
| `health` | object | `consecutive_partial_runs`, `rpc_fallback_calls_served`. |
| `window` | object | `{ start, end, days: 30 }`: the 30 most recent complete UTC days, start inclusive, end exclusive. |
| `meta` | object | Data-derived dates and facts: `wallet_created_at`, `holders_revenue_labelled_from`, `backfill_from`, `staking_pools`, `usage_largest_txn_drop` (the largest one-day fall in transactions since backfill_from), `usage_correlation` (week-over-week change correlations, descriptive). |
| `wallet` | object | The buyback wallet, its official citation (`official_source`), related revenue wallets, and the label used. |
| `metrics` | object | Keyed metric records (below). |
| `stale` | object | Metric key → since when its value has been carried over. |
| `simulator` | object | Formula, label, `defaults` (daily issuance, price, capture bps, allocation %, observed volume) and `default_result`. |
| `series_weekly` | array | One row per 7-day bucket since 2026-02-01: `issuance_near`, `supply_change_near`, `derived_burns_near`, `buyback_proxy_near`, `wallet_net_near`, `wallet_internal_near`, `wallet_net_excl_internal_near`, `wallet_balance_end_near`, `verified_purchases_near` (NEAR bought in swaps by the accounts that fund the wallet, for weeks where every day is in the daily BigQuery trace; otherwise null), `intents_volume_usd`, `active_accounts_avg`, `txns_avg`, `active_contracts_avg`, `partial`, `days`. |
| `wallet_transfers` | object | Summary of the wallet's transfers in the window (counts, counterparties, outbound list). |
| `onchain_trace` | object or null | Summary of the BigQuery trace (`config/bigquery-trace.json`): window, run date, totals, funding sources, SQL and results paths. |
| `official_dashboard` | object | revenue.near.org wallet breakdown vs on-chain holdings now, and the difference. |
| `queries` | object | The query behind each section (`issuance`, `supply`, `intents`, `coverage`, `trace`, `weekly`, `usage`, `simulator`; `trace` holds the BigQuery SQL): a list of `{ label, code }` with runnable requests using the actual blocks of this build. |
| `sources` | array | Name, URL and use of every source. |

### Metric record

Every metric has the same shape:

```json
{
  "value": 2668044.592172994,
  "value_yocto": "2668044592172994318466346373546",
  "unit": "NEAR",
  "period_start": "2026-10-15T00:00:00.000Z",
  "period_end": "2026-11-14T00:00:00.000Z",
  "source": "NEAR mainnet archival RPC (...): block headers",
  "source_type": "onchain",
  "method": "Σ over epoch boundaries …",
  "status": "measured"
}
```

- `status` is one of `measured`, `estimate`, `proxy`, `unavailable`.
- **Unavailable means `value: null` and a `reason`.** It is never 0 and never a guess.
- `value_yocto`, when present, is the exact integer in yoctoNEAR (10⁻²⁴ NEAR). `value` is the same quantity as a display number.
- `source_type` is `onchain`, `third_party` or `derived`. Third-party values carry `reported_by` (for example `DefiLlama`).
- `derived: true` marks values computed from other measured values (for example burns = issuance − supply change).
- `stale: true` with `stale_since` and `stale_reason` marks a value carried over from an earlier build because the source failed, or was unavailable, in this one.

### Metric keys

| Key | Unit | Status | Definition |
|---|---|---|---|
| `issuance` | NEAR | measured | Σ epoch-boundary mints in the window (supply jump + burns in the boundary block) |
| `daily_issuance` | NEAR/day | measured | issuance ÷ 30 |
| `issuance_annualised_rate` | fraction/yr | measured | issuance ÷ supply at window start × 365/30 (observed, not the cap) |
| `supply_start`, `supply_end` | NEAR | measured | `total_supply` of the last block before each window boundary |
| `supply_change` | NEAR | measured | supply_end − supply_start |
| `derived_burns` | NEAR | measured, derived | issuance − supply_change |
| `epoch_checks` | — | ok / flagged | Sanity checks over all cached epochs |
| `intents_volume`, `intents_gross_fees`, `intents_net_revenue` | USD | measured (DefiLlama) | Sums of 30 daily values |
| `intents_holders_revenue` | USD | proxy (DefiLlama) | Revenue that DefiLlama labels as buyback money |
| `net_revenue_capture_rate` | bps | measured | net revenue ÷ volume × 10,000 |
| `buyback_allocation` | % | proxy | holders revenue ÷ net revenue × 100 |
| `avg_daily_volume` | USD/day | measured | volume ÷ 30 |
| `price_avg`, `price_current` | USD | measured (DefiLlama) | Mean of daily 00:00 UTC prices; latest price |
| `buyback_proxy_near` | NEAR | proxy | Σ daily (holders revenue ÷ that day's price) |
| `wallet_net_accumulation` | NEAR | measured | Change in the wallet's NEAR: native, wNEAR, wNEAR in intents.near, and staked |
| `wallet_internal_transfers` | NEAR | measured | Net transfers in from NEAR's other listed revenue wallets |
| `wallet_net_excl_internal` | NEAR | measured, derived | wallet_net_accumulation − wallet_internal_transfers |
| `verified_purchases`, `coverage_verified` | NEAR, ratio | measured (lower bound) | BigQuery on-chain trace: NEAR bought in swaps by the accounts that fund the wallet, and ÷ issuance of the same window. Daily when `data/bigquery-daily.json` covers every day of the window (`daily` holds `updated_at`, `latest_block_utc`, `accounts_known`; `value_yocto`, `swaps`, `sold_near` are included). Otherwise a fixed snapshot: `period_start`/`period_end` are the trace window, and `snapshot.window_matches_dashboard` says whether it equals `window`. Unavailable if `config/bigquery-trace.json` is absent. |
| `trace_withdrawn_to_wallet`, `trace_untraced_near` | NEAR | measured | Same trace: NEAR delivered to the wallet by `native_withdraw` intents, and the part not matched to a swap. |
| `coverage_proxy` | ratio | proxy | buyback_proxy_near ÷ issuance |
| `coverage_wallet` | ratio | proxy | wallet_net_excl_internal ÷ issuance |
| `usage_active_accounts`, `usage_txns`, `usage_active_contracts` | per day | measured (NearBlocks) | 30-day mean of NearBlocks' daily field; each carries `prior_value`, `prior_period_start/end` and `change_pct` against the previous 30 days |
| `usage_new_accounts` | accounts | measured (NearBlocks) | 30-day sum, with the same prior-window comparison |

`intents_volume` also carries `prior_value` and `change_pct` for the same comparison.

## Example

```js
const L = await fetch('https://nearparity.vercel.app/data/latest.json').then((r) => r.json());
const c = L.metrics.coverage_proxy;
console.log(c.status === 'unavailable' ? `unavailable: ${c.reason}` : `${(c.value * 100).toFixed(1)}% (${c.status})`);
```
