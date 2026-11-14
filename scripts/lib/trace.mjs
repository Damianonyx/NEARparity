// One-off on-chain buyback trace (BigQuery public NEAR dataset) → dashboard metrics. Pure; covered by the unit tests.
// The trace is a fixed snapshot: its own 30-day window and the issuance measured for that same window. When the
// dashboard window moves on, the figures keep their snapshot window (period_start/end) and say so; they are never
// re-divided by a different window's issuance.
import { metric, yoctoToNear } from './calc.mjs';

const SRC = (t) => `BigQuery public NEAR dataset (${t.dataset}): intents.near dip4/nep245 event logs (run ${t.run_on}; SQL in ${t.sql.join(', ')})`;

export function traceMetrics(trace, window) {
  if (!trace?.window?.start || !Number.isFinite(trace.near_bought_in_swaps) || !Number.isFinite(trace.issuance_near_in_window) || trace.issuance_near_in_window <= 0) return null;
  const sameWindow = trace.window.start === window.start && trace.window.end === window.end;
  const P = { period_start: trace.window.start, period_end: trace.window.end };
  const snapshot = { run_on: trace.run_on, window_matches_dashboard: sameWindow };
  const f = trace.funding_sources || {};
  const bought = metric({
    value: trace.near_bought_in_swaps, unit: 'NEAR', ...P, source: SRC(trace), source_type: 'onchain', status: 'measured', snapshot, lower_bound: true,
    method: `Lower bound of NEAR bought. The accounts that signed the native_withdraw intents to the buyback wallet in the window (at least ${trace.withdrawing_accounts_min}) made ${trace.swaps} token_diff swaps that gained wNEAR (${trace.near_sold_in_swaps} NEAR sold), paid with tokens including ${trace.paid_with_examples.join(', ')}. NEAR they received by transfer is not counted, because its payment leg is not visible in these events.`,
  });
  const withdrawn = metric({
    value: trace.near_withdrawn_to_wallet, unit: 'NEAR', ...P, source: SRC(trace), source_type: 'onchain', status: 'measured', snapshot,
    method: `Sum of ${trace.withdrawals} native_withdraw intents to the buyback wallet in the window. Cross-check: matches the wallet's RPC balance change for the same window to within 0.3%.`,
  });
  const untraced = metric({
    value: trace.near_withdrawn_to_wallet - trace.near_bought_in_swaps, unit: 'NEAR', ...P, source: SRC(trace), source_type: 'onchain', status: 'measured', snapshot,
    method: `NEAR delivered to the wallet that is not matched by a swap of the withdrawing accounts. It reached them by transfer inside NEAR Intents, mostly from one high-volume account (${f.hub_near ? Math.round(f.hub_near).toLocaleString('en-US') : '?'} NEAR in ${f.hub_transfers ?? '?'} transfers) that moved ${f.hub_total_outflow_near ? (f.hub_total_outflow_near / 1e6).toFixed(1) : '?'}M NEAR to many accounts in the window, was funded mainly by ${f.hub_main_source ?? 'a solver'}, and made no swaps itself. Consistent with market-maker fills, but the payment is not visible, so it is not counted as verified purchases.`,
  });
  const coverage = metric({
    value: trace.near_bought_in_swaps / trace.issuance_near_in_window, unit: 'ratio', ...P, source: `${SRC(trace)}; issuance: NEAR archival RPC`, source_type: 'onchain', status: 'measured', snapshot, lower_bound: true,
    method: `Verified NEAR bought (lower bound) ÷ measured issuance over the same window (${Math.round(trace.issuance_near_in_window).toLocaleString('en-US')} NEAR).`,
  });
  return { verified_purchases: bought, trace_withdrawn_to_wallet: withdrawn, trace_untraced_near: untraced, coverage_verified: coverage };
}

/** Rolling version: the daily BigQuery trace summed over the dashboard window (every day present), divided by the
 *  same window's measured issuance. Returns null when issuance is not a fresh measurement (the caller falls back). */
export function dailyTraceMetrics(sum, window, issuance, state) {
  if (!sum || !issuance || issuance.status !== 'measured' || issuance.stale || !(issuance.value > 0)) return null;
  const P = { period_start: window.start, period_end: window.end };
  const SRC = `BigQuery public NEAR dataset (${state?.dataset ?? 'bigquery-public-data.crypto_near_mainnet_us'}): intents.near event logs, queried daily (data/bigquery-daily.json)`;
  const daily = { updated_at: state?.updated_at ?? null, latest_block_utc: state?.latest_block_utc ?? null, accounts_known: Object.keys(state?.accounts || {}).length };
  const bought = yoctoToNear(sum.bought); const withdrawn = yoctoToNear(sum.withdrawn);
  return {
    verified_purchases: metric({
      value: bought, unit: 'NEAR', ...P, source: SRC, source_type: 'onchain', status: 'measured', lower_bound: true, daily, value_yocto: sum.bought.toString(), swaps: sum.swaps, sold_near: yoctoToNear(sum.sold),
      method: `Lower bound of NEAR bought: wNEAR gained in ${sum.swaps} token_diff swaps by the accounts that fund the buyback wallet (each counted from the first day it sent NEAR to the wallet), summed over the ${sum.days} days (${yoctoToNear(sum.sold).toFixed(0)} NEAR sold). NEAR they received by transfer is not counted, because its payment is not visible in these events.`,
    }),
    trace_withdrawn_to_wallet: metric({
      value: withdrawn, unit: 'NEAR', ...P, source: SRC, source_type: 'onchain', status: 'measured', daily, value_yocto: sum.withdrawn.toString(), withdrawals: sum.withdrawals,
      method: `Sum of ${sum.withdrawals} native_withdraw intents to the buyback wallet over the ${sum.days} days.`,
    }),
    trace_untraced_near: metric({
      value: withdrawn - bought, unit: 'NEAR', ...P, source: SRC, source_type: 'onchain', status: 'measured', daily,
      method: 'NEAR delivered to the wallet that is not matched by a swap of the accounts that fund it: it reached them by transfer inside NEAR Intents (see the one-off trace in docs/bigquery-results.json for where it came from).',
    }),
    coverage_verified: metric({
      value: bought / issuance.value, unit: 'ratio', ...P, source: `${SRC}; issuance: NEAR archival RPC`, source_type: 'onchain', status: 'measured', lower_bound: true, daily,
      method: 'Verified NEAR bought (lower bound, daily BigQuery trace) ÷ measured issuance over the same 30 UTC days.',
    }),
  };
}
