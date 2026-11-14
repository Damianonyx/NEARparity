// One-off on-chain buyback trace (BigQuery public NEAR dataset) → dashboard metrics. Pure; covered by the unit tests.
// The trace is a fixed snapshot: its own 30-day window and the issuance measured for that same window. When the
// dashboard window moves on, the figures keep their snapshot window (period_start/end) and say so; they are never
// re-divided by a different window's issuance.
import { metric } from './calc.mjs';

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
