# THESIS: NEAR Intents buybacks are not keeping pace with new NEAR issuance

**Central question:** Are NEAR Intents buybacks keeping pace with new NEAR issuance?

**Short answer:** No. Over the 30 UTC days from 15 Oct to 13 Nov 2026, revenue-based buyback NEAR equalled about **16%** of newly issued NEAR. The buyback wallet's net accumulation equalled about **11%**. Total supply still grew by **2.64 M NEAR**. Purchased NEAR is held in a wallet, not burned, so even a buyback that matched issuance would not by itself reduce supply.

> **Data snapshot.** Unless stated otherwise, every number below comes from [`data/snapshots/2026-11-14T13-10-44Z.json`](data/snapshots/2026-11-14T13-10-44Z.json), which is identical to `data/latest.json` at the time of writing. The live dashboard (https://nearparity.vercel.app/) refreshes daily, so its figures will move on. Status labels follow the dashboard: **measured**, **proxy** or **unavailable**. Where a figure comes from a cited source rather than our data, the source is linked.

## 1. The claim

1. **Buybacks cover a minority of issuance.** Over the default 30-day window, NEAR bought (or set aside to buy) with Intents revenue is roughly one-sixth of newly minted NEAR on the revenue-based proxy and about one-ninth on the wallet measure. Purchases that can be verified on-chain swap by swap cover at least 2.7% (§2.7).
2. **Supply is still growing at close to the protocol cap.** Observed issuance runs at an annualised **2.48%** of supply, just under the **2.5%** maximum. Protocol burns offset under 1% of it.
3. **Parity needs about 5× today's Intents volume**, under today's price, capture rate and allocation.
4. **"Buyback" here means "held", not "burned".** Total supply does not fall when the wallet accumulates NEAR.

This is an investment-thesis claim about *flows*. It is not a price prediction.

## 2. Supporting evidence

### 2.1 Issuance (measured)

| Metric (15 Oct – 13 Nov 2026, 30 UTC days) | Value | Status |
|---|---|---|
| Newly minted NEAR (102 epoch boundaries) | **2,668,045 NEAR** | measured |
| Per day | 88,935 NEAR | measured |
| Observed annualised rate (issuance ÷ supply at start × 365/30) | 2.48% | measured |
| Protocol cap, `max_inflation_rate` | 1/40 = 2.5% | reference only |

- **Method.** For each epoch boundary, `mint = supply(first block) − supply(previous block) + burns in the first block`, using exact yoctoNEAR integers read from the archival RPC. Since 2026-02-01, 947 epochs were checked. Each mint was 95.5%–99.99% of the cap formula in this window. One epoch (20 Jul 2026, 8.2 h long) was flagged at 93.8% of the cap.
- **Since 1 Feb 2026** (weekly series, 1 Feb – 13 Nov): **25,322,568 NEAR** minted.

### 2.2 Buyback coverage

| Measure (same 30 days) | NEAR | ÷ issuance | Status |
|---|---|---|---|
| Verified purchases: on-chain swaps by the accounts that fund the wallet (BigQuery trace, §2.7) | 73,168 | **2.7%** | measured, lower bound |
| NEAR delivered to the wallet by `native_withdraw` intents (BigQuery trace, §2.7) | 301,008 | **11.3%** | measured |
| Revenue-based proxy: Σ DefiLlama holders revenue (USD) ÷ daily NEAR price | 421,221 | **15.8%** | proxy |
| Buyback wallet net accumulation, excluding transfers from NEAR's other revenue wallets | 301,992 | **11.3%** | measured, used as a proxy |

**Trend** (weekly series; issuance-weighted coverage per block of weeks):

| Weeks starting | Proxy coverage | Wallet coverage |
|---|---|---|
| 1 Feb – 19 Apr 2026 (12 wks) | 10.6% | 0.1% |
| 26 Apr – 12 Jul 2026 (12 wks) | 10.8% | 7.7% |
| 19 Jul – 4 Oct 2026 (12 wks) | 17.1% | 11.4% |
| 11 Oct – 13 Nov 2026 (5 wks, last one partial) | 15.7% | 11.2% |

Coverage has risen since the summer but has never come close to parity. The highest single week for the proxy was 40% (week of 22 Mar 2026).

The wallet column is near zero before late April. The wallet was only created on 18 Mar 2026 (NearBlocks: account creation by `multisignature.near`). DefiLlama's revenue series instead counts captured revenue from 23 Feb in the wallets where it first lands. The two measures therefore start at different times.

### 2.3 Actual supply change (measured)

| Metric (same 30 days) | Value |
|---|---|
| Total supply at start / end | 1,308,982,204 → 1,311,625,144 NEAR |
| Supply change | **+2,642,940 NEAR** |
| Protocol burns (derived: issuance − supply change) | 25,104 NEAR (0.9% of issuance) |

The buyback wallet's NEAR does not appear in this table, because holding NEAR does not change total supply. Since 1 Feb 2026, total supply rose by **25,025,955 NEAR**. The wallet held about **2.28 M NEAR** at the time of the snapshot, roughly **0.17%** of total supply.

### 2.4 What parity would require (conditional scenario)

`Required daily volume = daily issuance × price ÷ (net revenue capture rate × buyback allocation)`

With the snapshot defaults (88,935 NEAR/day, $3.32 per NEAR, **4.76 bps** net revenue per dollar of volume, 100% of net revenue labelled for buybacks), parity needs about **$621 M/day** of Intents volume. The observed 30-day average was **$127 M/day**, so about **4.9×** the current level. This is a conditional scenario, not a forecast and not a supply-neutrality threshold.

- **Net revenue is small relative to volume.** Over the window: $3.80 B volume → $5.83 M gross fees → $1.81 M net revenue captured (DefiLlama, measured).
- **The allocation lever is exhausted.** DefiLlama labels 100% of net revenue as buyback money, so raising the allocation cannot close the gap. Only more volume, a higher capture rate, a lower price or lower issuance can.

### 2.5 Official framing vs on-chain reality

NEAR's official revenue dashboard ([revenue.near.org](https://revenue.near.org/)) says that NEAR "captures a growing share of fees, feeding buybacks that permanently remove NEAR from circulation". The NEAR in the buyback wallet is held, not burned. Total supply rose by 2.64 M NEAR in the window, and burns explain only 25 k NEAR of the difference from issuance. "Removed from circulation" is accurate only in the sense of "held by a NEAR-controlled multisig", and that is reversible: the wallet has sent NEAR out (17 outbound receipts in its history, including 12,000 NEAR on 10 Jul 2026, NearBlocks).

### 2.7 On-chain trace of the buyback (BigQuery, measured)

We traced the buyback wallet's funding through the NEAR BigQuery public dataset (`bigquery-public-data.crypto_near_mainnet_us`, `execution_outcomes` event logs of `intents.near`), for the same 30-day window (15 Oct – 13 Nov 2026). The dataset was current to 14 Nov 2026 when queried. The SQL is in [`queries/bigquery/`](queries/bigquery/) and the results are in [`docs/bigquery-results.json`](docs/bigquery-results.json); each query scanned about 35 GB and ran in the free BigQuery sandbox.

- **Who funds the wallet.** 771 `native_withdraw` intents delivered **301,008 NEAR** to the wallet, signed by at least 272 different NEAR Intents accounts. This matches the wallet's balance change from the archival RPC (301,992 NEAR) to within 0.3%.
- **What those accounts bought.** They made **7,979 swaps** (`token_diff` events) that gained **73,168 NEAR**, paying with tokens including USDT (Ethereum), USDT0 (Plasma), USDC (Base), ZEC and SUI. They sold no NEAR. This is **2.7% of the window's issuance** (2,668,045 NEAR), and it is the first swap-level, verified measure of the buyback.
- **The cross-check holds.** The solvers' wNEAR transfers to these accounts (blockzen 47,417, crux 18,582, anyliq 6,302; together 72,301 NEAR) match the swaps to within 1%.
- **Most of the rest came from one high-volume account.** One NEAR Intents account sent them **191,434 NEAR in 500 transfers**. In the same window that account sent 17.7M NEAR to many accounts in 31,736 transfers, was funded mainly by `solver-priv-liq.near` (6.5M NEAR), and made no swaps itself. That fits a market maker filling orders, but the payment side of those transfers is not visible in these events, so they are not counted as verified purchases.

So verified purchases are a **lower bound of 2.7%**. Counting every NEAR delivered to the wallet as bought gives 11.3%, and the revenue-based proxy gives 15.7–15.8%. On every measure, buybacks are a small fraction of issuance.

### 2.6 Network usage behind the buyback (measured, as reported by NearBlocks)

The buyback is funded by Intents fees, so it helps to know whether activity on NEAR is growing alongside it. These figures come from NearBlocks' daily network charts. Every daily row is in [`data/usage.json`](data/usage.json), and the figures below can be recomputed from the rows for the dates given.

| 30-day mean (15 Oct – 13 Nov 2026) vs the previous 30 days (15 Sep – 14 Oct) | Now | Before | Change |
|---|---|---|---|
| Daily active accounts | 64,822 | 74,812 | **−13.4%** |
| Daily transactions | 678,139 | 872,564 | **−22.3%** |
| New accounts (30-day total) | 283,950 | 345,347 | −17.8% |
| Daily active contracts | 69,939 | 55,981 | +24.9% |
| Intents volume (DefiLlama, 30-day total) | $3.80 B | $4.84 B | −21.5% |

- **Weekly index, week of 1 Feb 2026 = 100.** By the last full week (starting 1 Nov), Intents volume per day was at **97**, daily active accounts at **27** and daily transactions at **19**.
- **The two have come apart since August.** Intents volume roughly doubled from its summer level, while active accounts kept falling. Week-over-week changes in Intents volume and active accounts are essentially uncorrelated over 39 full weeks (r = −0.19; computed by the build, `meta.usage_correlation`; descriptive only, no lag or causality tested).
- **There is one structural break.** On 2 Apr 2026, daily transactions fell from 3,758,663 to 1,063,375 (−72%) and active contracts from 1,381,922 to 184,649, while active accounts barely moved (139,048 → 137,183). The drop was in activity per account, not in the number of accounts. Its cause is not verified here.
- **The 2025 baseline was higher still.** The 2025 daily averages were 421k active accounts and 5.34 M transactions (NearBlocks rows, 1 Jan – 31 Dec 2025).

What this means for the claim: the buyback depends on cross-chain swap volume through Intents, which has held up, not on NEAR's own on-chain activity, which has fallen. That makes the buyback more sensitive to Intents' competitive position than to NEAR adoption. It also means Intents volume is a poor stand-in for NEAR network usage over this period.

## 3. Counterevidence and the strongest case against the claim

- **The trend is improving.** Proxy coverage rose from about 11% (Feb–Jul) to 16–17% (Jul–Nov). If Intents volume keeps compounding, coverage rises with it, because issuance is nearly flat.
- **Price works in favour of the buyback.** Coverage in NEAR terms rises as the price falls. The window's average price was $4.35 against $3.32 at the snapshot. At a lower price, the same USD revenue buys more NEAR, and the simulator's required volume falls in proportion.
- **Issuance may fall.** [HSP-029](https://gov.near.org/t/hsp-029-establish-a-24-month-issuance-ramp-to-a-1-6-target-rate-of-near-token-emissions/42644), posted by House of Stake on 7 Oct 2026, proposes to cut the maximum issuance from 2.5% to a 1.6% target over a 24-month per-epoch ramp. Forum posts after the vote refer to it as approved. Mechanically, at a 1.6% cap and today's buyback NEAR, 30-day proxy coverage would be about 25% instead of 16%. That is still far from parity.
- **Our measures may undercount buybacks.** NEAR's dashboard lists two other revenue wallets (`fefundsadmin.sputnik-dao.near`, `1csfundsadmin.sputnik-dao.near`). If buyback NEAR also sits elsewhere, the wallet measure understates it. The proxy measure is not affected by this, because it counts revenue wherever it lands.
- **The proxy may overcount.** DefiLlama labels all net revenue from 23 Feb onward as buyback money. If some revenue is not converted to NEAR, the proxy overstates purchases. This argues against parity rather than for it.

## 4. Limitations

- **Verified purchases are a lower bound.** The BigQuery trace (§2.7) verifies 73,168 NEAR of swaps for the 15 Oct – 13 Nov window. Since 14 Nov 2026 the refresh workflow extends it daily: it queries only each new UTC day (about 1.2 GB) and keeps daily totals in `data/bigquery-daily.json`, signing in to Google with Workload Identity Federation, so no keys are stored. Its first run (37.27 GB, backfilling the 30-day window) reproduced the console results exactly: 73,168 NEAR bought, 301,008 NEAR delivered, 502 funding accounts. If BigQuery is ever unavailable, the dashboard falls back to the fixed snapshot, which keeps its own window and is labelled as such. In the daily version an account counts from the first day it sent NEAR to the wallet, so a swap made on an earlier day than its first withdrawal is not counted. Before BigQuery, we tried keyless routes. The wallet receives native NEAR transfers from `intents.near` every 30–90 minutes (3,408 receipts since creation). Each one is a `native_withdraw` intent signed by an account inside NEAR Intents (from the `dip4` event logs). They are not one operator: an evenly spaced sample of 120 inflows (April–November 2026) found **47 different withdrawing accounts**, two of which (`5880ad2b…f9247dd`, `143f2bb4…d3cfb31`) made 75 of the 120 withdrawals. **None** of the 120 carried its purchase in the same transaction; 42 included only dust swaps ([`docs/withdrawer-sample.json`](docs/withdrawer-sample.json), re-run with `npm run check:withdrawers`). So the NEAR is bought earlier, in separate transactions, and finding them means searching every `intents.near` event by account, which needs an indexer (such as the BigQuery NEAR dataset); there is no keyless public index. We also checked the first-party **NEAR Intents Explorer API** (the 1Click swap index, accessed with a Partner Dashboard key, 14 Nov 2026): it has **no transactions by the accounts checked**, including the two behind most withdrawals ([`docs/explorer-check.json`](docs/explorer-check.json)), so the buybacks cannot be verified there either. Verified purchases and verified coverage therefore stay **unavailable**.
- **A small overstatement in the wallet measure.** The same Explorer check lists four successful third-party 1Click transfers of wNEAR *into* the buyback wallet (3,988.7 NEAR in total, June–September 2026). They are not buybacks, but the wallet measure counts them as accumulation, about 0.2% of its growth since February. None fall in the 30-day window.
- **The proxy is a label converted at a reference price.** It uses DefiLlama's "holders revenue" (equal to net revenue since 23 Feb 2026) divided by the 00:00 UTC price of each day. Actual execution prices and timing are not observed.
- **The wallet reconciliation is mostly explained.** The wallet's on-chain holdings (2,281,072 NEAR) exceed the dashboard's all-time figure for it (1,781,812 NEAR) by 499,260 NEAR. Two items account for nearly all of the gap:
  - a **502,793 NEAR** transfer in from `1csfundsadmin.sputnik-dao.near` on 9 Sep 2026 (NearBlocks), an internal move between NEAR's own revenue wallets;
  - a smaller internal transfer (7,274 NEAR, 14 Jul 2026) and one outflow (12,000 NEAR, 10 Jul 2026).

  Excluding internal transfers, the wallet's net accumulation since February is **1,769,786 NEAR**. Adding back the 12,000 NEAR outflow gives 1,781,786 NEAR, within about 26 NEAR of the dashboard figure. That suggests the dashboard counts inflows from Intents without subtracting outflows. We infer this; NEAR has not stated it.
- **Third-party data.** DefiLlama volume, fees and revenue are reported as published, and DefiLlama revises its history: in a later build the same day, gross fees for this same window read $6.27 M rather than $5.83 M, and net revenue $1.802 M rather than $1.807 M. This is why every number here cites a fixed snapshot. If DefiLlama has not yet filled the last day, the build keeps the previous value, marked stale, rather than understating it.
- **The window is short.** The 30-day comparison reflects one market regime. Weekly history starts on 1 Feb 2026.

- **Network usage comes from NearBlocks, not BigQuery.** The daily build stays keyless, so it uses NearBlocks' daily charts for active accounts, transactions and contract activity. BigQuery (free sandbox, no billing account needed) is used for the one-off buyback trace in §2.7. The definitions are NearBlocks' own and are not formally documented, so the absolute levels should be read as NearBlocks-reported.

## 5. Findings that would invalidate the thesis

The claim "buybacks are not keeping pace with issuance" would be wrong, or would stop being true, if any of the following held:

1. **Verified purchases exceed the proxy materially.** Swap-level evidence showing purchases of 50% or more of issuance in a 30-day window would overturn the "minority offset" finding. The BigQuery trace (§2.7) verifies 2.7% swap by swap; even if every NEAR delivered to the wallet were counted as bought, it would be 11.3%.
2. **Coverage reaches parity.** Proxy or verified coverage of 100% or more of issuance in three consecutive 30-day windows would mean buybacks are keeping pace.
3. **Supply stops growing because of the buyback.** If purchased NEAR were burned, so that the 30-day total supply change fell to zero or below while issuance continued, the "held, not burned" point would no longer apply.
4. **Undercounting is shown.** If other NEAR wallets were shown to hold buyback NEAR not captured by either measure, coverage would need restating.
5. **Usage and Intents volume re-couple at a much higher level.** If NEAR's daily active accounts and transactions grew alongside Intents volume, the buyback base would be broader than this thesis assumes.
6. **The parity gap closes.** HSP-029 taking effect on-chain (`max_inflation_rate` falling below 1/40), combined with volume or capture-rate growth, would close the gap if the simulator's required volume fell to the observed 30-day average.

## 6. Verified context

| Claim | Status | Primary source |
|---|---|---|
| The October 2025 cut of maximum inflation from 5% to 2.5% | **Verified** | On-chain: `EXPERIMENTAL_protocol_config.max_inflation_rate` was `[1,20]` on 5 Oct 2025 (protocol 80) and `[1,40]` from about 2025-10-29 11:29 UTC (block ~170,351,519, protocol 81) through today (protocol 88). Announcement: [Near One, "Enhancing NEAR Tokenomics: Version 2.9.0 Halving Upgrade" (21 Oct 2025)](https://blog.nearone.org/announcement/2025/10/21/enhancing-near-tokenomics.html): "nearcore version 2.9.0 reduces the maximum annual inflation rate … from 5% to 2.5%", effective "once 80% of stake of block producing validators choose to adopt it". |
| The governance dispute around that cut | **Verified (qualitative)** | [gov.near.org #41140, "Reduce Inflation for NEAR Protocol"](https://gov.near.org/t/reduce-inflation-for-near-protocol/41140) (HOT DAO and LiNEAR, 24 Jun 2025) proposed an interim stake-weighted validator vote. In the thread, participants contested a proposed mid-vote change to the counting rules ("34% of total staked NEAR participates … 67% must vote YES") against "the 66.6% requirement set originally", and one post calls it "a proposal that already failed". The change then shipped as a protocol upgrade gated on 80% of block-producer stake. *The final vote tally appears only in press coverage, so we do not cite a number.* |
| The security incident DefiLlama lists for NEAR Intents on 1 Oct 2026 | **Verified as listed** | [DefiLlama hacks API](https://api.llama.fi/hacks): date 2026-10-01, "NEAR Intents" (DefiLlama id 6225), $3.8 M, chain BSC, "Bridge & Cross-Chain / Bridge Logic Flaw". DefiLlama's description: a bug in the interaction between the Omni deposit/withdrawal infrastructure and the NEAR Intents contract allowed unauthorised withdrawals; services were stopped and patched; NEAR Intents said losses would be compensated in full. We did not independently verify the amount or the compensation. |
| Partner concentration in Intents fees | **Not included** | Only secondary reports were found (single-partner shares of fees and volume). No primary per-partner breakdown could be verified. The verified fee terms are: authenticated partners get a 50/50 revenue share by default ([NEAR Intents docs, Fees](https://docs.near-intents.org/near-intents/fees)), and NEAR's dashboard reports 30-day capture rates by mechanism (front-end fees 18.4%, B2B partners 10.1%, quote improvement 3.1%; revenue.near.org, 14 Nov 2026). |
| A proposal to cut issuance further | **Verified: proposed; not in effect** | [HSP-029](https://gov.near.org/t/hsp-029-establish-a-24-month-issuance-ramp-to-a-1-6-target-rate-of-near-token-emissions/42644) (House of Stake, 7 Oct 2026): "Reduces NEAR's maximum protocol issuance from 2.5% to a target 1.6% … on a smooth 24-month per-epoch ramp, retaining the measured 90/10 split". The proposal models gross staking yield falling from 5.268% to 3.372%. Its implementation table requires a protocol upgrade released by NEAR One and adopted by validators. On-chain the cap is still 1/40 on 14 Nov 2026. Forum posts refer to it as approved; *we did not verify the vote result on the House of Stake portal.* |

Re-check these sources with `node scripts/verify-claims.mjs` (it also runs on GitHub Actions: `.github/workflows/verify-claims.yml`).

## 7. Reproduce every number

```sh
node scripts/test.mjs                    # offline tests
node --use-env-proxy scripts/build-data.mjs   # refresh data/latest.json (or use the committed snapshot)
node scripts/serve.mjs                   # http://localhost:8080
```

- **Weekly figures** in §2 come from `series_weekly` in the snapshot. The 30-day figures come from `metrics`.
- **Network-usage figures** in §2.6 come from the NearBlocks daily rows in `data/usage.json` for the stated dates, and from `meta.usage_correlation` and `meta.usage_largest_txn_drop` in `data/latest.json` (build of 2026-11-14 16:19 UTC onward). Every section on the dashboard has a *Query* panel with the exact requests.
- **The on-chain trace** in §2.7: run the SQL in `queries/bigquery/` in the BigQuery console (free sandbox). Results are in `docs/bigquery-results.json`; the summary the dashboard reads is `config/bigquery-trace.json`.
- **Epoch-level mints** are in `data/epochs.json`. Boundary blocks and wallet balances are in `data/boundaries.json`. Wallet transfers are in `data/wallet-transfers.json`.
