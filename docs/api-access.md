# Phase 0: API access

Local check: **2026-11-14 11:15:42–11:15:45 UTC**, Node **v22.23.5**.
All **28 probes passed**, with HTTP **200** and the expected basic JSON shape.
The [timestamped local report](api-access-local.json) records every request, HTTP
status, and the first 300 characters of each response. These are access diagnostics,
not dashboard metrics or evidence of buyback purchases.

## Endpoint results

| Endpoint | Works here |
| --- | --- |
| `https://rpc.mainnet.fastnear.com` — `block`, `validators`, `EXPERIMENTAL_protocol_config` | Yes — all HTTP 200 |
| Same mainnet RPC — `query`: `view_account`, `wrap.near.ft_balance_of`, `intents.near.mt_balance_of` | Yes — all HTTP 200; contract return bytes decoded successfully |
| `https://archival-rpc.mainnet.fastnear.com` — the same six current-state probes | Yes — all HTTP 200 |
| Same archival RPC — epoch-start block, its `prev_hash` block, previous-epoch validators, historical protocol config, and all three historical balance queries | Yes — all seven HTTP 200 |
| `https://api.llama.fi/summary/dexs/near-intents` | Yes — HTTP 200; nonempty `totalDataChart` |
| `https://api.llama.fi/summary/fees/near-intents?dataType=dailyFees` | Yes — HTTP 200; nonempty `totalDataChart` |
| `https://api.llama.fi/summary/fees/near-intents?dataType=dailyRevenue` | Yes — HTTP 200; nonempty `totalDataChart` |
| `https://api.llama.fi/summary/fees/near-intents?dataType=dailyHoldersRevenue` | Yes — HTTP 200; nonempty `totalDataChart`; proxy only |
| `https://coins.llama.fi/chart/coingecko:near?start=1792022400&span=30&period=1d&searchWidth=600` | Yes — HTTP 200; nonempty price series |
| `https://coins.llama.fi/prices/current/coingecko:near` | Yes — HTTP 200; numeric price |
| `https://api.coingecko.com/api/v3/coins/near/market_chart?vs_currency=usd&days=30&interval=daily` | Yes — HTTP 200; nonempty price series |
| `https://api.nearblocks.io/v1/account/buybacks.multisignature.near/txns?page=1&per_page=1` | Yes — HTTP 200 without a key; first page only |
| `https://api.nearblocks.io/v1/account/buybacks.multisignature.near/ft-txns?page=1&per_page=1` | Yes — HTTP 200 without a key; first page only |

The Llama daily-chart request uses the 30 completed UTC days from
2026-10-15 00:00:00 inclusive to 2026-11-14 00:00:00 exclusive. The script computes
these dates afresh on each run. A nonempty series does not establish that every
day is present. CoinGecko's `days=30` fallback is an access probe; its returned
timestamps must be filtered to the common UTC window before any later comparison.

## Reproduce locally

Use a current Node 22 release (22.21 or newer for built-in proxy support):

```sh
node --use-env-proxy scripts/check-apis.mjs
```

To save the complete report, supply an output filename:

```sh
node --use-env-proxy scripts/check-apis.mjs api-check.json
```

No installation, build, API key, or secret is required. This environment uses an
outbound proxy: initial plain `fetch` calls failed, while built-in proxy support
worked. TLS verification stays enabled. The proxy flag also works on GitHub's
runner when no proxy is configured.

The script allows 25 seconds per request, continues after individual failures,
and prints HTTP status plus the first 300 response characters for every response.
An HTTP 200 containing an API error or missing expected fields is a failure.
A transport failure has a null HTTP status and an explicit error; dependent
historical probes are marked skipped when their block reference is unavailable.
Any failed or skipped probe produces a nonzero exit code after the report is saved.

## Run on GitHub

[`.github/workflows/api-check.yml`](../.github/workflows/api-check.yml) runs on
every push and pull request, and supports `workflow_dispatch`. It uses Node 22,
read-only repository permissions, and the same script. It does not commit data
or deploy anything.

Push this branch or open the PR, then open **Actions → API access check**. Once
the workflow exists on the default branch, **Run workflow** is also available.
The run summary contains the results table; the probe step contains URLs, request
bodies, HTTP statuses, and response previews. A JSON artifact is uploaded even
when probes fail. Paste the summary and any failed probe details for the next task.

GitHub runner access has **not yet been tested** in this phase's local run.

## Limits and later work

- The archival check follows one recent epoch boundary via `prev_hash`. It does
  not establish full archival coverage back to 2026-02-01 or historical state at
  the eventual 30-day boundaries. No issuance or burn calculation runs in Phase 0.
- `buybacks.multisignature.near` remains an **unconfirmed wallet**, recorded in
  [`config/buyback-wallet.json`](../config/buyback-wallet.json). Official attribution
  has not been verified. A returned balance or an increase in balance does not
  prove purchases; treasury purchases are not burns.
- DefiLlama holders revenue remains a **proxy**. Endpoint access does not verify
  purchases, the classification start date, or how gross fees and distributions
  map to net revenue. Those definitions require source review in the data phase.
- NearBlocks probes retrieve one sample page per endpoint, without direction
  filters. Full inbound/outbound history, pagination, swap attribution, and amount
  precision remain unvalidated.
- Series completeness, freshness, historical backfill, snapshot fallback, metrics,
  dashboard, and thesis documentation belong to the subsequent phases.
