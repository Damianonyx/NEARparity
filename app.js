// NEAR Parity dashboard. No framework. Reads data/latest.json and data/status.json.
// The parity formula is imported from the same module the offline tests cover.
import { parityRequiredDailyVolume } from './scripts/lib/calc.mjs';

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return n;
};

// ---------- formatting ----------
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const fmtNear = (v) => (v == null ? '—' : `${nf0.format(v)} NEAR`);
const fmtUsdFull = (v) => (v == null ? '—' : `$${nf0.format(v)}`);
const fmtUsd = (v) => {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
};
const fmtPct = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtDayShort = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtTime = (iso) => (iso ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'never');
const lastDay = (endIso) => new Date(Date.parse(endIso) - 86_400_000).toISOString(); // end is exclusive
const periodText = (m) => (m?.period_start && m?.period_end ? `${fmtDay(m.period_start)} – ${fmtDay(lastDay(m.period_end))} (UTC, end inclusive)` : '');

function pill(m) {
  if (!m) return [el('span', { class: 'pill pill-unavailable' }, 'unavailable')]; // always a list: callers spread it
  const label = m.derived ? 'measured · derived' : m.reported_by ? `${m.status} · ${m.reported_by}` : m.status;
  const frag = [el('span', { class: `pill pill-${m.status}`, title: m.reported_by ? `${statusHelp[m.status] || ''} Reported by ${m.reported_by} (third-party data).` : statusHelp[m.status] }, label)];
  if (m.stale) frag.push(' ', el('span', { class: 'pill pill-stale', title: m.stale_reason || '' }, m.period_start && m.period_end ? `stale · value for ${fmtDayShort(m.period_start)} – ${fmtDay(lastDay(m.period_end))}` : `stale since ${fmtDay(m.stale_since)}`));
  if (m.snapshot && !m.snapshot.window_matches_dashboard) frag.push(' ', el('span', { class: 'pill pill-stale', title: `One-off BigQuery trace run ${m.snapshot.run_on}; its window differs from the dashboard window.` }, `fixed window ${fmtDayShort(m.period_start)} – ${fmtDay(lastDay(m.period_end))}`));
  return frag;
}
const statusHelp = {
  measured: 'Observed directly from the named source (DefiLlama figures are third-party measurements).',
  estimate: 'Estimated; see method.',
  proxy: 'A stand-in for the quantity of interest, not a direct measurement of it.',
  unavailable: 'Not available. Shown as unavailable, never as zero.',
};

// ---------- data loading ----------
async function load() {
  const [latest, status] = await Promise.all([
    fetch('data/latest.json', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(`data/latest.json: HTTP ${r.status}`); return r.json(); }),
    fetch('data/status.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  return { latest, status };
}

// ---------- header + answer ----------
function renderMeta(L) {
  const meta = $('#refresh-meta');
  meta.textContent = '';
  meta.append('Last successful refresh: ', el('strong', {}, fmtTime(L.last_successful_refresh)), ` · Data generated ${fmtTime(L.generated_at)}`);
  const staleKeys = Object.keys(L.stale || {});
  if (L.partial_refresh || staleKeys.length) {
    meta.append(' · ', el('strong', {}, 'Partial refresh:'), ` ${Object.keys(L.failed_groups || {}).join(', ') || 'some sources'} failed; affected values keep their last good data and are marked stale.`);
  }
  $('#window-label').textContent = `${fmtDay(L.window.start)} – ${fmtDay(lastDay(L.window.end))}`;
}

function renderAnswer(L) {
  const m = L.metrics;
  const box = $('#answer');
  box.textContent = '';
  const proxy = m.coverage_proxy; const wallet = m.coverage_wallet; const verified = m.coverage_verified;
  box.append(
    el('p', { class: 'eyebrow' }, `Buyback coverage · ${fmtDay(proxy?.period_start ?? L.window.start)} – ${fmtDay(lastDay(proxy?.period_end ?? L.window.end))}${proxy?.stale ? ' (previous window, stale)' : ''}`),
    el('div', { class: 'big' }, proxy?.value != null ? fmtPct(proxy.value) : 'Unavailable', ' ', ...pill(proxy)),
    el('p', { class: 'answer-line' }, 'of newly issued NEAR is matched by the revenue-based buyback proxy.'),
    el('p', { class: 'small muted' },
      `Verified on-chain purchases: ${verified?.value != null ? `${fmtPct(verified.value)} (lower bound)` : 'unavailable'}. Wallet net accumulation: ${wallet?.value != null ? fmtPct(wallet.value) : 'unavailable'} (not purchases).`),
  );
}

// ---------- cards ----------
const shortPeriod = (m) => (m?.period_start ? `${fmtDayShort(m.period_start)} – ${fmtDay(lastDay(m.period_end))}` : '');
function row(label, m, { fmt = fmtNear, baseStatus = null } = {}) {
  const showPill = m && (m.status !== baseStatus || m.stale || m.derived);
  const k = el('span', { class: 'k' }, label, showPill ? [' ', ...pill(m)] : null);
  const v = !m || m.status === 'unavailable' || m.value == null
    ? el('span', { class: 'v' }, 'Unavailable', el('span', { class: 'reason' }, m?.reason || 'No data.'))
    : el('span', { class: 'v' }, fmt(m.value));
  return el('li', {}, k, v);
}

/** "Query" disclosure: the exact, runnable request(s) behind a figure (from latest.json `queries`). */
function queryBlock(items, summary = 'Query') {
  if (!items?.length) return null;
  return el('details', { class: 'query' }, el('summary', {}, summary),
    ...items.map((q) => el('div', { class: 'q' }, el('p', { class: 'q-label' }, q.label), el('pre', {}, el('code', {}, q.code)))));
}

let cardNo = 0;
function card({ title, hero, rows = [], source, how, query }) {
  const hm = hero.m; const ok = hm && hm.status !== 'unavailable' && hm.value != null;
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, el('span', { class: 'num' }, `[ 0${++cardNo} ]`), title), el('span', { class: 'period' }, shortPeriod(hm))),
    el('p', { class: 'hero-label' }, hero.label),
    el('div', { class: 'hero-value' }, ok ? (hero.fmt || fmtNear)(hm.value) : 'Unavailable', ' ', ...pill(hm)),
    ok && hero.note ? el('p', { class: 'hero-note' }, hero.note) : (!ok ? el('p', { class: 'hero-note' }, hm?.reason || '') : null),
    rows.length ? el('ul', { class: 'rows' }, rows.map((r) => row(r[0], r[1], { ...(r[2] || {}), baseStatus: hm?.status }))) : null,
    el('p', { class: 'src' }, `Source: ${source}`),
    el('details', {}, el('summary', {}, 'How this is calculated'), el('div', { class: 'how', html: how })),
    queryBlock(query),
  );
}

function renderCards(L) {
  const m = L.metrics; const checks = m.epoch_checks;
  const cap = m.issuance?.reference_cap;
  const wrap = $('#cards');
  wrap.textContent = '';
  const ratio = m.issuance?.mint_to_cap_ratio_range;
  wrap.append(
    card({
      title: 'Issuance', query: L.queries?.issuance,
      hero: { label: 'Newly minted NEAR', m: m.issuance, note: m.issuance?.epochs_counted ? `${m.issuance.epochs_counted} epoch boundaries` : null },
      rows: [
        ['Per day', m.daily_issuance, { fmt: (v) => `${nf0.format(v)} NEAR` }],
        ['Observed annual rate', m.issuance_annualised_rate, { fmt: (v) => `${fmtPct(v, 2)}${cap ? ` (cap ${fmtPct(eval_rate(cap.max_inflation_rate), 1)})` : ''}` }],
      ],
      source: 'NEAR archival RPC (block headers)',
      how: `<p>NEAR mints new tokens at each epoch boundary (about every 7 hours). For every boundary whose first block falls in the window, the build reads <code>total_supply</code> of the first block and of the block before it, and adds back the protocol burns included in that first block: <code>mint = supply(first) − supply(previous) + burnt(first)</code>. These are exact yoctoNEAR integers, summed with BigInt.</p>
<p>Sanity checks: within each epoch supply must only fall (burns), and each mint should sit just under <code>supply × max_inflation_rate × epoch duration ÷ year</code>. ${checks ? `${checks.epochs_checked} epochs checked since February, ${checks.epochs_flagged} flagged` : ''}${ratio ? `; in this window mints were ${fmtPct(ratio[0])}–${fmtPct(ratio[1])} of that cap.` : '.'} The cap is shown for comparison only and is never used as issuance.</p>
<p>Epoch boundaries are cached in <a href="data/epochs.json">data/epochs.json</a>.</p>`,
    }),
    card({
      title: 'Intents economics', query: L.queries?.intents,
      hero: { label: 'Net revenue captured', m: m.intents_net_revenue, fmt: fmtUsd, note: m.net_revenue_capture_rate?.value != null ? `${nf2.format(m.net_revenue_capture_rate.value)} bps of swap volume` : null },
      rows: [
        ['Swap volume', m.intents_volume, { fmt: fmtUsd }],
        ['Gross fees', m.intents_gross_fees, { fmt: fmtUsd }],
        ['Labelled as buyback money', m.intents_holders_revenue, { fmt: fmtUsd }],
      ],
      source: 'DefiLlama (near-intents)',
      how: `<p>Daily DefiLlama values are summed over the same 30 UTC days. If any day is missing, the total is shown as unavailable rather than summed with a gap.</p>
<p><strong>Gross fees</strong>: protocol plus affiliate fees on swaps. <strong>Net revenue</strong>: NEAR's captured revenue after partner and front-end distributions (DefiLlama measures it as NEAR/wNEAR swept into NEAR's revenue wallets). <strong>Labelled buyback revenue</strong>: DefiLlama's “holders revenue”, which labels captured revenue from ${escapeHtml(L.meta?.holders_revenue_labelled_from ?? 'the start of the buyback program')} as buyback money. It is a label, not a record of purchases, so it is kept separate from verified purchases and marked proxy.</p>
<p>Capture rate = net revenue ÷ volume. Allocation = labelled buyback revenue ÷ net revenue.</p>`,
    }),
    card({
      title: 'Buyback coverage', query: L.queries?.coverage,
      hero: { label: 'Proxy ÷ issuance', m: m.coverage_proxy, fmt: (v) => fmtPct(v), note: m.buyback_proxy_near?.value != null ? `${fmtNear(m.buyback_proxy_near.value)} proxy vs ${fmtNear(m.issuance?.value)} issued` : null },
      rows: [
        ['Verified purchases ÷ issuance (lower bound)', m.coverage_verified, { fmt: (v) => fmtPct(v) }],
        ['Wallet net ÷ issuance', m.coverage_wallet, { fmt: (v) => fmtPct(v) }],
      ],
      source: 'NEAR RPC · DefiLlama · daily price',
      how: `<p><strong>Verified purchases</strong> ${m.coverage_verified?.value != null ? `are NEAR bought on-chain in swaps by the accounts that fund the buyback wallet, ÷ issuance over the same window. It is a lower bound; see the on-chain trace card below.` : `would be verified NEAR purchased ÷ newly issued NEAR over the same period. It is unavailable: ${escapeHtml(m.verified_purchases?.reason || '')}`}</p>
<p><strong>Proxy</strong>: for each day, DefiLlama labelled buyback revenue (USD) ÷ that day's NEAR price, summed and divided by measured issuance over the same 30 days.</p>
<p><strong>Wallet net accumulation</strong>: change in NEAR held by <code>${escapeHtml(L.wallet?.account_id || '')}</code> (native + wNEAR + wNEAR inside intents.near) between the window's boundary blocks, minus transfers from NEAR's other listed revenue wallets (${escapeHtml((L.wallet?.related_revenue_wallets?.accounts || []).join(', '))}; ${m.wallet_internal_transfers?.value != null ? fmtNear(m.wallet_internal_transfers.value) : 'unavailable'} in this window), ÷ measured issuance. A balance increase is net accumulation, not proof of purchases. Purchased NEAR held in a wallet is not burned.</p>`,
    }),
    traceCard(L),
    card({
      title: 'Actual supply change', query: L.queries?.supply,
      hero: { label: 'Total supply change', m: m.supply_change, fmt: (v) => `${v >= 0 ? '+' : ''}${nf0.format(v)} NEAR`, note: m.supply_end?.value != null ? `Supply now ${nf0.format(m.supply_end.value)} NEAR` : null },
      rows: [
        ['Minted', m.issuance],
        ['Burned (derived)', m.derived_burns],
      ],
      source: 'NEAR archival RPC (block headers)',
      how: `<p>Supply change = <code>total_supply</code> of the last block before the window end − that of the last block before the window start. It already includes burns.</p>
<p>Burns are derived: issuance − supply change. They are not subtracted again (no double counting). Buybacks do not appear here: NEAR bought and held in a treasury wallet stays in total supply, so treasury purchases are never counted as burns.</p>`,
    }),
  );
}
function traceCard(L) {
  const m = L.metrics; const t = L.onchain_trace; const f = t?.funding_sources || {};
  const n0 = (v) => nf0.format(v);
  const vp = m.verified_purchases; const daily = vp?.daily;
  const note = daily
    ? `${n0(vp.swaps)} swaps by the accounts that fund the wallet; ${n0(vp.sold_near)} NEAR sold. Updated daily from BigQuery (data to ${fmtDay(daily.latest_block_utc)}).`
    : (t ? `${n0(t.swaps)} swaps by the accounts that fund the wallet, paid with ${t.paid_with_examples.slice(0, 3).join(', ')} and others; ${n0(t.near_sold_in_swaps)} NEAR sold` : null);
  return card({
    title: 'On-chain buyback trace', query: L.queries?.trace,
    hero: { label: 'NEAR bought in on-chain swaps (lower bound)', m: vp, note },
    rows: [
      ['Delivered to the buyback wallet', m.trace_withdrawn_to_wallet],
      ['Not matched to a swap', m.trace_untraced_near],
      ['Verified purchases ÷ issuance', m.coverage_verified, { fmt: (v) => fmtPct(v, 1) }],
    ],
    source: 'BigQuery public NEAR dataset (intents.near event logs)',
    how: t ? `<p>The wallet is funded by <code>native_withdraw</code> intents signed by many accounts inside NEAR Intents (at least ${n0(t.withdrawing_accounts_min)} in this window). The SQL finds every such withdrawal to <code>${escapeHtml(L.wallet?.account_id || 'the wallet')}</code>, then every <code>token_diff</code> swap by those accounts. NEAR they gained in swaps is counted as <strong>verified purchases</strong>; the token they gave up shows what they paid with.</p>
<p><strong>Cross-check:</strong> the ${n0(t.withdrawals)} withdrawals total ${n0(t.near_withdrawn_to_wallet)} NEAR, within 0.3% of the wallet's balance change from the archival RPC. The solvers' transfers to these accounts (${n0(f.solvers_near)} NEAR) match the swaps to within 1%.</p>
<p><strong>Why it is a lower bound:</strong> most of the remaining NEAR reached these accounts by transfer from one high-volume account (${n0(f.hub_near)} NEAR in ${n0(f.hub_transfers)} transfers). That account moved ${(f.hub_total_outflow_near / 1e6).toFixed(1)}M NEAR to many accounts in the window, was funded mainly by <code>${escapeHtml(f.hub_main_source || '')}</code>, and made no swaps. That fits market-maker fills, but the payment side is not visible, so it is not counted.</p>
${daily ? `<p><strong>Updated daily.</strong> The refresh workflow queries each new UTC day in BigQuery (about 1.2 GB per day, signed in with Workload Identity Federation, so no keys are stored) and keeps the daily totals in <a href="data/bigquery-daily.json">data/bigquery-daily.json</a>. An account counts from the first day it sent NEAR to the wallet; ${n0(daily.accounts_known)} accounts so far. The Query panel shows the daily SQL.</p>` : ''}<p>The funding breakdown above comes from a one-off trace run on ${escapeHtml(t.run_on)} for one 30-day window, compared with issuance measured for that same window. Results: <a href="https://github.com/Damianonyx/NEARparity/blob/main/docs/bigquery-results.json">docs/bigquery-results.json</a>; SQL: <a href="https://github.com/Damianonyx/NEARparity/tree/main/queries/bigquery">queries/bigquery</a>. It ran in the free BigQuery sandbox (about 35 GB per query).</p>` : '<p>No on-chain trace is configured.</p>',
  });
}
const eval_rate = (s) => { const [a, b] = String(s).split('/').map(Number); return b ? a / b : null; };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- simulator ----------
/** Sensitivity: which assumption moves the parity requirement most? Each row varies one input (low/high) and
 *  holds the others at the 30-day defaults. Same formula as the calculator; every cell is a conditional scenario. */
function renderSensitivity(L) {
  const box = $('#sensitivity'); if (!box) return; box.textContent = '';
  const d = L.simulator?.defaults || {}; const obs = d.observed_avg_daily_volume_usd;
  const base = { iss: d.daily_issuance_near, price: d.price_usd, bps: d.net_revenue_capture_bps, pct: d.buyback_allocation_pct };
  if (Object.values(base).some((v) => v == null) || !obs) return;
  const req = (x) => parityRequiredDailyVolume({ dailyIssuanceNear: x.iss, priceUsd: x.price, captureRate: x.bps / 10_000, allocation: x.pct / 100 });
  const cell = (x) => { const r = req(x); return r.finite ? `${nf2.format(r.value / obs)}×` : 'no finite volume'; };
  const rows = [
    ['NEAR price', 'price', [base.price * 0.5, base.price * 2], (v) => `${nf2.format(v)}`],
    ['Net revenue capture', 'bps', [base.bps * 0.5, base.bps * 2], (v) => `${nf2.format(v)} bps`],
    ['Buyback allocation', 'pct', [base.pct * 0.5, Math.min(100, base.pct * 2)], (v) => `${nf0.format(v)}%`],
    ['Daily issuance', 'iss', [base.iss * 0.64, base.iss * 1.2], (v) => `${nf0.format(v)} NEAR`],
  ];
  const table = el('table', {},
    el('thead', {}, el('tr', {}, ['Assumption', 'Low', 'Base', 'High'].map((t, i) => el('th', { class: i ? 'n' : null }, t)))),
    el('tbody', {}, rows.map(([label, key, [lo, hi], f]) => el('tr', {}, el('th', { scope: 'row' }, label),
      el('td', { class: 'n' }, `${f(lo)} → ${cell({ ...base, [key]: lo })}`),
      el('td', { class: 'n' }, `${f(base[key])} → ${cell(base)}`),
      el('td', { class: 'n' }, `${f(hi)} → ${cell({ ...base, [key]: hi })}`)))));
  box.append(
    el('h3', {}, 'Which assumption matters most?'),
    el('p', { class: 'small' }, `Volume needed for parity, as a multiple of the observed 30-day average (${fmtUsd(obs)}/day), varying one input at a time and holding the others at their 30-day values. Price and capture rate scale the answer directly; allocation is already ${nf0.format(base.pct)}%, so it cannot rise much. Issuance “low” is 0.64× today (roughly the 1.6% target rate in HSP-029, a proposal not in effect). Every cell is a conditional scenario, not a forecast. The conclusion would change only if some combination brought the multiple to about 1× or below.`),
    el('div', { class: 'table-scroll' }, table),
  );
}

function setupSimulator(L) {
  const d = L.simulator?.defaults || {};
  const inputs = { price: $('#sim-price'), capture: $('#sim-capture'), alloc: $('#sim-alloc') };
  const reset = () => {
    inputs.price.value = d.price_usd != null ? d.price_usd.toFixed(3) : '';
    inputs.capture.value = d.net_revenue_capture_bps != null ? d.net_revenue_capture_bps.toFixed(2) : '';
    inputs.alloc.value = d.buyback_allocation_pct != null ? Math.round(d.buyback_allocation_pct) : '';
    compute();
  };
  $('#sim-issuance').textContent = d.daily_issuance_near != null ? nf0.format(d.daily_issuance_near) : 'Unavailable';
  $('#sim-defaults-note').textContent = `Defaults: latest price (DefiLlama), 30-day net revenue ÷ volume, and 30-day labelled buyback share (proxy)${L.simulator?.defaults_stale ? '; some defaults are stale' : ''}.`;

  function compute() {
    const out = $('#sim-out');
    out.textContent = '';
    const raw = { price: inputs.price.value, capture: inputs.capture.value, alloc: inputs.alloc.value };
    const num = (s) => (s === '' || s == null ? NaN : Number(s));
    const price = num(raw.price); const bps = num(raw.capture); const pct = num(raw.alloc);
    if (d.daily_issuance_near == null) { out.append(el('p', {}, 'Daily issuance is unavailable, so no scenario can be computed.')); return; }
    if ([price, bps, pct].some((x) => !Number.isFinite(x) || x < 0)) { out.append(el('p', {}, 'Enter non-negative numbers in all three fields.')); return; }
    if (pct > 100) { out.append(el('p', {}, 'Buyback allocation cannot exceed 100% of net revenue.')); return; }
    const r = parityRequiredDailyVolume({ dailyIssuanceNear: d.daily_issuance_near, priceUsd: price, captureRate: bps / 10_000, allocation: pct / 100 });
    const obs = d.observed_avg_daily_volume_usd;
    if (!r.finite) {
      out.append(el('p', { class: 'nofinite' }, r.reason));
    } else {
      out.append(
        el('p', { class: 'small' }, 'Daily Intents volume required for purchases to match daily issuance'),
        el('div', { class: 'big' }, `${fmtUsd(r.value)} per day`),
        el('p', { class: 'small muted' }, `${fmtUsdFull(r.value)} = ${nf0.format(d.daily_issuance_near)} NEAR × $${nf2.format(price)} ÷ (${nf2.format(bps)} bps × ${nf0.format(pct)}%)`),
      );
    }
    const implied = obs != null && price > 0 ? (obs * (bps / 10_000) * (pct / 100)) / (d.daily_issuance_near * price) : null;
    out.append(el('div', { class: 'compare' },
      el('div', {}, el('span', { class: 'label' }, 'Observed 30-day average volume'), el('span', { class: 'num' }, obs != null ? `${fmtUsd(obs)}/day` : 'Unavailable')),
      el('div', {}, el('span', { class: 'label' }, r.finite && obs ? 'Required ÷ observed' : 'Implied coverage at observed volume'),
        el('span', { class: 'num' }, r.finite && obs ? `${nf2.format(r.value / obs)}×` : implied != null ? fmtPct(implied) : '—')),
    ));
    if (implied != null && r.finite) out.append(el('p', { class: 'small' }, `At the observed average volume and these inputs, purchases would equal ${fmtPct(implied)} of daily issuance. Conditional on the inputs; it says nothing about future volume, price or supply.`));
    const pAvg = L.metrics?.price_avg?.value;
    if (pAvg) out.append(el('p', { class: 'small muted' }, `Price assumption: ${nf2.format(price)} (default: today’s price). The hero illustration scales measured coverage, which converts each day’s revenue at that day’s price (window average ${nf2.format(pAvg)}); that is why its parity multiple differs from this one.`));
  }
  for (const i of Object.values(inputs)) i.addEventListener('input', compute);
  $('#sim-reset').addEventListener('click', reset);
  $('#sim-form').addEventListener('submit', (e) => e.preventDefault());
  reset();
  renderSensitivity(L);
}

// ---------- chart (inline SVG) ----------
const SVGNS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const step0 = span / count; const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => span / x <= count) || 10 * mag;
  const ticks = [];
  // Always end on a tick at or above max, so no mark can rise above the plot.
  for (let t = Math.floor(min / step) * step; ; t += step) { ticks.push(t); if (t >= max - 1e-9) break; }
  return ticks;
}
const compactNear = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${Math.round(v / 1e3)}k` : `${Math.round(v)}`);

// A bar with a rounded data end and a square baseline end.
function barPath(x, y0, y1, w, r) {
  const up = y1 < y0; const h = Math.abs(y1 - y0);
  r = Math.min(r, w / 2, h);
  if (h < 0.5) return '';
  if (up) return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

// Phones: 41 weekly columns are too thin to read, so start with the last 12 weeks.
let chartRange = matchMedia('(max-width: 600px)').matches ? '12' : 'all';
// Wallet bars exclude transfers between NEAR's own revenue wallets; fall back to the raw change if unavailable.
const walletVal = (r) => r.wallet_net_excl_internal_near ?? r.wallet_net_near;
function renderLegend() {
  const sw = (fill) => { const svg = s('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true' }); svg.append(s('rect', { x: 1, y: 1, width: 12, height: 12, rx: 2, style: fill })); return svg; };
  const hatchSw = () => { const svg = s('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true' }); svg.append(hatchDefs('lg-hatch'), s('rect', { x: 1, y: 1, width: 12, height: 12, rx: 2, fill: 'url(#lg-hatch)', style: 'stroke: var(--bar-wallet); stroke-width: 1' })); return svg; };
  const ul = $('#legend'); ul.textContent = '';
  ul.append(
    el('li', {}, sw('fill: var(--bar-issuance)'), 'Issuance (measured)'),
    el('li', {}, sw('fill: var(--bar-proxy)'), 'Buyback proxy (DefiLlama revenue ÷ price)'),
    el('li', {}, hatchSw(), 'Wallet net accumulation, excl. internal transfers (not purchases)'),
  );
}
function hatchDefs(id) {
  const defs = s('defs');
  const p = s('pattern', { id, width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  p.append(s('rect', { width: 4, height: 4, style: 'fill: var(--surface)' }), s('line', { x1: 0, y1: 0, x2: 0, y2: 4, style: 'stroke: var(--bar-wallet); stroke-width: 2.4' }));
  defs.append(p);
  return defs;
}

function renderChart(L) {
  const all = L.series_weekly || [];
  const rows = chartRange === 'all' ? all : all.slice(-Number(chartRange));
  const box = $('#chart'); box.textContent = '';
  if (!rows.length) { box.append(el('p', {}, 'Weekly series unavailable.')); return; }
  const W = Math.max(300, box.clientWidth); const H = Math.round(Math.min(320, Math.max(220, W * 0.48)));
  const m = { l: 44, r: 6, t: 22, b: 28 };
  const pw = W - m.l - m.r; const ph = H - m.t - m.b;
  const vals = rows.flatMap((r) => [r.issuance_near, r.buyback_proxy_near, walletVal(r)]).filter((v) => v != null);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(...vals) * 1.04, 4);
  const y0v = ticks[0]; const y1v = ticks.at(-1);
  const y = (v) => m.t + ph - ((v - y0v) / (y1v - y0v)) * ph;
  const bw = pw / rows.length;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  svg.append(hatchDefs('ch-hatch'));
  const grid = s('g', { class: 'grid' }); const axis = s('g', { class: 'axis' });
  for (const t of ticks) {
    grid.append(s('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
    const tx = s('text', { x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end' }); tx.textContent = compactNear(t); axis.append(tx);
  }
  const unit = s('text', { x: 0, y: 10, 'text-anchor': 'start' }); unit.textContent = 'NEAR per week'; axis.append(unit);
  svg.append(grid);

  let lastMonth = null; let lastLabelX = -1e9;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  rows.forEach((r, i) => {
    const x = m.l + i * bw; const g = s('g', { class: 'col', 'data-i': i });
    const outer = Math.max(1, bw - 2); // 2px surface gap between columns
    const ix = x + 1;
    if (r.issuance_near != null) {
      g.append(s('path', { d: barPath(ix, y(0), y(r.issuance_near), outer, 3), style: `fill: var(--bar-issuance)${r.partial ? '; opacity: .55' : ''}` }));
    }
    const inner = Math.max(1, (outer - 2) * 0.38);
    const cx = ix + outer / 2;
    if (r.buyback_proxy_near != null) g.append(s('path', { d: barPath(cx - inner - 0.5, y(0), y(r.buyback_proxy_near), inner, 2), style: 'fill: var(--bar-proxy)' }));
    const wv = walletVal(r);
    if (wv != null) g.append(s('path', { d: barPath(cx + 0.5, y(0), y(wv), inner, 2), fill: 'url(#ch-hatch)', style: 'stroke: var(--bar-wallet); stroke-width: 0.75' }));
    g.append(s('rect', { class: 'hit', x, y: m.t, width: bw, height: ph }));
    const mo = r.period_start.slice(0, 7);
    if (mo !== lastMonth) {
      lastMonth = mo;
      if (x - lastLabelX >= 30) { // skip a label that would collide with the previous one
        const tx = s('text', { x: x + 1, y: H - 10, 'text-anchor': 'start' }); tx.textContent = MONTHS[new Date(r.period_start).getUTCMonth()]; axis.append(tx);
        lastLabelX = x;
      }
    }
    g.addEventListener('pointerenter', () => showTip(i, r, g));
    g.addEventListener('click', () => showTip(i, r, g));
    svg.append(g);
  });
  svg.append(s('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }));
  svg.append(axis);
  svg.addEventListener('pointerleave', hideTip);
  box.append(svg);
}

function showTip(i, r, g) {
  document.querySelectorAll('.chart .col.active').forEach((n) => n.classList.remove('active'));
  g.classList.add('active');
  const tip = $('#tooltip'); tip.textContent = '';
  const share = (v) => (v != null && r.issuance_near ? ` (${fmtPct(v / r.issuance_near)})` : '');
  tip.append(...[
    el('div', { class: 't' }, `${fmtDayShort(r.period_start)} – ${fmtDayShort(lastDay(r.period_end))}${r.partial ? ` · partial (${r.days} days)` : ''}`),
    el('div', { class: 'r' }, el('span', {}, 'Issuance'), el('span', {}, r.issuance_near != null ? fmtNear(r.issuance_near) + (r.chain_stale ? ' (stale)' : '') : `unavailable${r.chain_integrity_issue ? ` (${r.chain_integrity_issue})` : ''}`)),
    el('div', { class: 'r' }, el('span', {}, 'Proxy'), el('span', {}, r.buyback_proxy_near != null ? fmtNear(r.buyback_proxy_near) + share(r.buyback_proxy_near) + (r.buyback_proxy_stale ? ' (stale)' : '') : 'unavailable')),
    el('div', { class: 'r' }, el('span', {}, 'Wallet net*'), el('span', {}, walletVal(r) != null ? fmtNear(walletVal(r)) + share(walletVal(r)) + (r.wallet_stale ? ' (stale)' : '') : 'unavailable')),
    Math.abs(r.wallet_internal_near ?? 0) >= 1 ? el('div', { class: 'small' }, `*Excludes ${fmtNear(r.wallet_internal_near)} moved in from NEAR's other revenue wallets (raw change ${fmtNear(r.wallet_net_near)}).`) : null,
    el('div', { class: 'r' }, el('span', {}, 'Supply change'), el('span', {}, r.supply_change_near != null ? fmtNear(r.supply_change_near) : 'unavailable')),
    META.wallet_created_at && r.period_end <= META.wallet_created_at ? el('div', { class: 'small' }, `Wallet created ${META.wallet_created_at.slice(0, 10)}; zero before.`) : null,
    META.holders_revenue_labelled_from && r.period_end.slice(0, 10) <= META.holders_revenue_labelled_from ? el('div', { class: 'small' }, `DefiLlama labels buyback revenue from ${META.holders_revenue_labelled_from}.`) : null,
  ].filter(Boolean));
  tip.hidden = false;
  const panel = tip.parentElement.getBoundingClientRect(); const gb = g.getBoundingClientRect();
  const tw = tip.offsetWidth;
  let left = gb.left - panel.left + gb.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, panel.width - tw - 8));
  tip.style.left = `${left}px`;
  tip.style.top = `${gb.top - panel.top - tip.offsetHeight + 30}px`;
}
function hideTip() { $('#tooltip').hidden = true; document.querySelectorAll('.chart .col.active').forEach((n) => n.classList.remove('active')); }

function renderSeriesTable(L) {
  const t = $('#series-table'); t.textContent = '';
  t.append(el('thead', {}, el('tr', {}, ['Week (UTC)', 'Issuance', 'Proxy', 'Wallet net excl. internal', 'Wallet net (raw)', 'Supply change', 'Burns (derived)'].map((h, i) => el('th', { class: i ? 'n' : null }, h)))));
  const tb = el('tbody');
  for (const r of L.series_weekly || []) {
    tb.append(el('tr', {},
      el('td', {}, `${fmtDayShort(r.period_start)} – ${fmtDayShort(lastDay(r.period_end))}${r.partial ? ' (partial)' : ''}`),
      ...[r.issuance_near, r.buyback_proxy_near, walletVal(r), r.wallet_net_near, r.supply_change_near, r.derived_burns_near].map((v) => el('td', { class: 'n' }, v == null ? 'unavailable' : nf0.format(v))),
    ));
  }
  t.append(tb);
}

// ---------- claims ----------
function renderClaims(L) {
  const m = L.metrics; const v = (k) => (m[k]?.status !== 'unavailable' ? m[k]?.value : null);
  const sup = $('#supports'); const cant = $('#cannot'); sup.textContent = ''; cant.textContent = '';
  const add = (ul, ...parts) => ul.append(el('li', {}, ...parts));
  if (v('issuance') != null) add(sup, `New issuance is measurable on-chain: ${fmtNear(v('issuance'))} in the window (${nf0.format(v('daily_issuance'))} NEAR/day), an observed ${fmtPct(v('issuance_annualised_rate'), 2)} annualised rate, below the ${m.issuance?.reference_cap?.max_inflation_rate ?? ''} protocol cap.`);
  if (v('supply_change') != null) add(sup, `Total supply still grew by ${fmtNear(v('supply_change'))}. Derived protocol burns (${fmtNear(v('derived_burns'))}) offset ${fmtPct(v('derived_burns') / v('issuance'))} of issuance.`);
  if (v('coverage_proxy') != null || v('coverage_wallet') != null) {
    const both = [v('coverage_proxy'), v('coverage_wallet')].filter((x) => x != null);
    const below = both.every((x) => x < 1);
    add(sup, `Buyback-related NEAR ${below ? 'is well below' : 'is not below'} new issuance on both available measures: the revenue proxy equals ${fmtPct(v('coverage_proxy'))} and the listed revenue wallet's net accumulation ${fmtPct(v('coverage_wallet'))} of issuance.`);
  }
  const d = L.simulator?.default_result; const obs = L.simulator?.defaults?.observed_avg_daily_volume_usd;
  if (d?.finite && obs) add(sup, `Under the latest inputs, parity would need about ${fmtUsd(d.value)}/day of Intents volume, ${nf2.format(d.value / obs)}× the observed 30-day average (a conditional scenario).`);
  add(cant, 'That NEAR was bought on the open market: no swap-level verification is available, so verified purchases are unavailable.');
  add(cant, 'That buybacks reduce supply: purchased NEAR held in a wallet is not burned and stays in total supply.');
  add(cant, 'Zero inflation or price appreciation, even if purchases matched issuance.');
  add(cant, 'Future volume, fee capture, allocation or price: the simulator is conditional, not a forecast.');
  add(cant, "Why the wallet's on-chain balance differs from the official dashboard's figure, or whether other wallets also hold buyback NEAR.");
  add(cant, 'The accuracy of third-party DefiLlama aggregates; they are reported as published.');
}

// ---------- wallet ----------
function renderWallet(L) {
  const box = $('#wallet'); box.textContent = '';
  const w = L.wallet; if (!w) { box.append(el('p', {}, 'No wallet configured.')); return; }
  const wm = L.metrics.wallet_net_excl_internal;
  $('#wallet-summary').textContent = `${w.account_id} is listed on NEAR's official revenue dashboard. Over the last 30 days it accumulated ${wm?.value != null ? fmtNear(wm.value) : 'an unavailable amount'} net of internal transfers. That is accumulation, not proof of purchases.`;
  const src = w.official_source;
  box.append(el('p', {}, el('code', {}, w.account_id), ' · ', el('strong', {}, w.label_used || w.label)));
  if (src) {
    box.append(el('p', { class: 'small' }, 'Official listing: ', el('a', { href: src.url }, src.url), ` — section ${src.section}, row “${src.quoted_row}” (checked ${fmtTime(src.checked_at)}).`));
  }
  if (w.not_confirmed?.length) box.append(el('p', { class: 'small' }, 'Not confirmed: ', w.not_confirmed.join(' ')));
  const d = L.official_dashboard;
  if (d?.wallet_row) {
    box.append(el('div', { class: 'table-scroll' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Figure'), el('th', { class: 'n' }, 'NEAR'), el('th', {}, 'Source'))),
      el('tbody', {},
        el('tr', {}, el('td', {}, 'Dashboard, all-time wallet breakdown'), el('td', { class: 'n' }, nf0.format(d.wallet_row.near_amount)), el('td', {}, `revenue.near.org, ${fmtTime(d.fetched_at)}${d.stale ? ' (stale)' : ''}`)),
        d.onchain_now ? el('tr', {}, el('td', {}, 'On-chain holdings (native + wNEAR + intents)'), el('td', { class: 'n' }, nf0.format(d.onchain_now.total_near)), el('td', {}, `archival RPC, block ${d.onchain_now.block_height}`)) : null,
        d.difference_near != null ? el('tr', {}, el('td', {}, 'Difference'), el('td', { class: 'n' }, nf0.format(d.difference_near)), el('td', {}, 'unexplained here')) : null,
      ))));
  }
  const t = L.wallet_transfers;
  if (t) {
    const cps = Object.entries(t.inbound_by_counterparty || {});
    box.append(el('p', { class: 'small' }, `Transfers in the window (NearBlocks, ${t.complete_history ? 'complete history' : 'partial history'}, ${nf0.format(t.receipts_cached)} receipts cached${t.stale ? ', stale' : ''}): ${t.inbound_count} inbound, ${t.outbound_count} outbound.`));
    if (cps.length) box.append(el('ul', { class: 'sources' }, cps.map(([k, c]) => el('li', {}, el('code', {}, k.length > 24 ? `${k.slice(0, 10)}…${k.slice(-6)}` : k), `: ${c.count} transfers, ≈${nf0.format(c.deposit_near_approx)} NEAR (approximate)`))));
    box.append(el('p', { class: 'small' }, t.note));
  }
}

// ---------- sources ----------
function renderSources(L, S) {
  const t = $('#status-table'); t.textContent = '';
  t.append(el('thead', {}, el('tr', {}, el('th', {}, 'Source'), el('th', {}, 'Last run'), el('th', { class: 'n' }, 'HTTP'), el('th', {}, 'Fetched'), el('th', {}, 'Error'))));
  const tb = el('tbody');
  for (const [k, v] of Object.entries(S?.sources || {})) {
    tb.append(el('tr', {}, el('td', {}, k), el('td', { class: v.ok ? 'ok' : 'bad' }, v.ok ? 'ok' : 'failed'), el('td', { class: 'n' }, v.http_status ?? '—'), el('td', {}, v.fetched_at ? fmtTime(v.fetched_at) : '—'), el('td', {}, v.error || '')));
  }
  t.append(tb);
  const ul = $('#sources'); ul.textContent = '';
  for (const src of L.sources || []) ul.append(el('li', {}, el('a', { href: src.url }, src.name), ` — ${src.used_for}`));
}

// ---------- theme ----------
function setupTheme() {
  const root = document.documentElement;
  try { const saved = localStorage.getItem('np-theme'); if (saved) root.dataset.theme = saved; } catch { /* storage unavailable */ }
  $('#theme-toggle').addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('np-theme', root.dataset.theme); } catch { /* ignore */ }
  });
}


// ---------- chart takeaways ----------
function renderChartNotes(L) {
  const rows = (L.series_weekly || []).filter((r) => r.issuance_near != null);
  const tot = (f) => rows.reduce((a, r) => a + (r[f] ?? 0), 0);
  const iss = tot('issuance_near'); const px = tot('buyback_proxy_near');
  const best = rows.reduce((b, r) => (r.buyback_proxy_near != null && r.issuance_near && r.buyback_proxy_near / r.issuance_near > (b?.c ?? -1) ? { c: r.buyback_proxy_near / r.issuance_near, w: r.period_start } : b), null);
  const parityWeeks = rows.filter((r) => r.buyback_proxy_near != null && r.buyback_proxy_near >= r.issuance_near).length;
  $('#chart-takeaway').textContent = rows.length && iss
    ? `Since ${fmtDay(rows[0].period_start)}, the buyback proxy equalled ${fmtPct(px / iss)} of issuance (${fmtNear(px)} against ${fmtNear(iss)}); its best week, starting ${fmtDayShort(best.w)}, reached ${fmtPct(best.c)}, and ${parityWeeks ? `${parityWeeks} week(s) reached parity` : 'no week reached parity'}.`
    : '';
  const wq = $('#weekly-query'); wq.textContent = '';
  const q = queryBlock(L.queries?.weekly); if (q) wq.append(q);
}

// ---------- network usage ----------
const indexTo100 = (vals) => { const base = vals.find((v) => v != null && v !== 0); return vals.map((v) => (v == null || base == null ? null : (v / base) * 100)); };
const signedPct = (x) => (x == null ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(1)}%`);

function renderUsage(L) {
  const m = L.metrics;
  const tiles = $('#usage-tiles'); tiles.textContent = '';
  const tile = (label, mm, fmt) => el('div', { class: 'tile' },
    el('p', { class: 'tile-label' }, label),
    el('div', { class: 'tile-value' }, mm && mm.status !== 'unavailable' && mm.value != null ? fmt(mm.value) : 'Unavailable'),
    el('p', { class: 'tile-change' }, mm?.change_pct != null ? `${signedPct(mm.change_pct)} vs previous 30 days` : (mm?.reason || '')),
    el('div', {}, ...pill(mm)));
  tiles.append(
    tile('Intents volume / day', m.avg_daily_volume ? { ...m.avg_daily_volume, change_pct: m.intents_volume?.change_pct } : m.intents_volume, fmtUsd),
    tile('Active accounts / day', m.usage_active_accounts, (v) => nf0.format(v)),
    tile('Transactions / day', m.usage_txns, (v) => nf0.format(v)),
    tile('Active contracts / day', m.usage_active_contracts, (v) => nf0.format(v)),
    ...(m.usage_function_calls?.value != null ? [tile('Contract calls / day', m.usage_function_calls, (v) => nf0.format(v))] : []),
  );
  const src = L.meta?.usage_source || 'NearBlocks';
  $('#usage-intro').textContent = `Is the activity behind the buyback growing? On-chain usage from ${src === 'BigQuery' ? 'the NEAR BigQuery public dataset (SQL filtered on block_date; NearBlocks kept as a cross-check)' : 'NearBlocks'}, next to NEAR Intents swap volume from DefiLlama. Last 30 days compared with the 30 before.`;
  renderLeadTest(L);
  const ch = (k) => m[k]?.change_pct;
  $('#usage-takeaway').textContent = [ch('intents_volume'), ch('usage_active_accounts'), ch('usage_txns')].every((x) => x != null)
    ? `Over the last 30 days against the 30 before, Intents volume moved ${signedPct(ch('intents_volume'))}, daily active accounts ${signedPct(ch('usage_active_accounts'))} and daily transactions ${signedPct(ch('usage_txns'))}.`
    : '';
  const br = L.meta?.usage_largest_txn_drop;
  $('#usage-break').textContent = br
    ? `Largest one-day change since ${fmtDay(L.meta.backfill_from)}: on ${fmtDay(br.to)}, transactions went from ${nf0.format(br.txns_before)} to ${nf0.format(br.txns_after)} (${signedPct(br.change)}) and active contracts from ${nf0.format(br.active_contracts_before)} to ${nf0.format(br.active_contracts_after)}, while active accounts went from ${nf0.format(br.active_accounts_before)} to ${nf0.format(br.active_accounts_after)}. The step is in activity per account, not in the number of accounts; its cause is not verified here.`
    : '';
  renderUsageChart(L);
  const t = $('#usage-table'); t.textContent = '';
  t.append(el('thead', {}, el('tr', {}, ['Week (UTC)', 'Intents volume / day', 'Active accounts / day', 'Transactions / day', 'Active contracts / day'].map((h, i) => el('th', { class: i ? 'n' : null }, h)))));
  const tb = el('tbody');
  for (const r of L.series_weekly || []) {
    tb.append(el('tr', {}, el('td', {}, `${fmtDayShort(r.period_start)} – ${fmtDayShort(lastDay(r.period_end))}${r.partial ? ' (partial)' : ''}`),
      el('td', { class: 'n' }, r.intents_volume_usd == null ? 'unavailable' : fmtUsd(r.intents_volume_usd / r.days)),
      ...[r.active_accounts_avg, r.txns_avg, r.active_contracts_avg].map((v) => el('td', { class: 'n' }, v == null ? 'unavailable' : nf0.format(v)))));
  }
  t.append(tb);
  const uq = $('#usage-query'); uq.textContent = '';
  const q = queryBlock(L.queries?.usage); if (q) uq.append(q);
}

/** The track hypothesis, tested: does Intents volume lead network usage better than NEAR price? */
function renderLeadTest(L) {
  const box = $('#usage-lead'); box.textContent = '';
  const li = L.meta?.leading_indicator; const a = li?.active_accounts;
  if (!a) return;
  const f2 = (v) => (v == null ? '–' : v.toFixed(2));
  const cell = (x) => el('td', { class: `n${x.r != null && x.rho != null && x.r > x.band && x.rho > x.band ? ' sig' : ''}` }, `${f2(x.r)} / ${f2(x.rho)}`);
  const table = el('table', {},
    el('thead', {}, el('tr', {}, ['Lead (weeks)', 'Volume → active accounts', 'Price → active accounts', 'Volume → transactions', 'Price → transactions', 'Noise band'].map((t, i) => el('th', { class: i ? 'n' : null }, t)))),
    el('tbody', {}, a.volume.map((v, i) => el('tr', {}, el('td', {}, i === 0 ? '0 (same week)' : String(v.lag)),
      cell(v), cell(a.price[i]), cell(li.txns.volume[i]), cell(li.txns.price[i]), el('td', { class: 'n' }, `±${f2(v.band)}`)))));
  box.append(
    el('h3', {}, 'Does Intents volume lead usage better than price?'),
    el('p', { class: 'takeaway' }, !a.verdict.supports_hypothesis && !li.txns.verdict.supports_hypothesis && /^Neither/.test(a.verdict.text) && /^Neither/.test(li.txns.verdict.text)
      ? 'Neither Intents volume nor NEAR price leads daily active accounts or daily transactions: no lag of 1–4 weeks is above the noise band on both measures.'
      : `${a.verdict.text} ${li.txns.verdict.text}`),
    el('p', { class: 'small' }, `Correlation of week-over-week changes (Pearson r / Spearman ρ) between this week's Intents volume or NEAR price and usage 0–4 weeks later, ${li.weeks} full weeks from ${fmtDay(li.first_week)}, usage from ${li.usage_source}. A lead counts only if both are positive and above the noise band (about 95%). Descriptive, not causal.`),
    el('details', { class: 'table-view' }, el('summary', {}, 'Show the lead-lag table'), el('div', { class: 'table-scroll' }, table)),
  );
}

function usageSeries(L) {
  const rows = L.series_weekly || [];
  const vol = rows.map((r) => (r.intents_volume_usd != null ? r.intents_volume_usd / r.days : null));
  const acc = rows.map((r) => r.active_accounts_avg ?? null);
  const tx = rows.map((r) => r.txns_avg ?? null);
  return { rows, series: [
    { label: 'Intents volume', src: 'DefiLlama', idx: indexTo100(vol), raw: vol, fmt: (v) => `${fmtUsd(v)}/day`, style: 'stroke: var(--accent); stroke-width: 2.5', dash: '' },
    { label: 'Active accounts', src: L.meta?.usage_source || 'NearBlocks', idx: indexTo100(acc), raw: acc, fmt: (v) => `${nf0.format(v)}/day`, style: 'stroke: var(--ink-2); stroke-width: 2', dash: '7 4' },
    { label: 'Transactions', src: L.meta?.usage_source || 'NearBlocks', idx: indexTo100(tx), raw: tx, fmt: (v) => `${nf0.format(v)}/day`, style: 'stroke: var(--muted); stroke-width: 2', dash: '2 3' },
  ] };
}

function renderUsageLegend(series) {
  const ul = $('#usage-legend'); ul.textContent = '';
  for (const sr of series) {
    const svg = s('svg', { width: 26, height: 10, viewBox: '0 0 26 10', 'aria-hidden': 'true' });
    svg.append(s('line', { x1: 1, x2: 25, y1: 5, y2: 5, style: sr.style, 'stroke-dasharray': sr.dash, 'stroke-linecap': 'round' }));
    ul.append(el('li', {}, svg, `${sr.label} (${sr.src})`));
  }
}

function renderUsageChart(L) {
  const { rows, series } = usageSeries(L);
  renderUsageLegend(series);
  const box = $('#usage-chart'); box.textContent = '';
  if (!rows.length || series.every((sr) => sr.idx.every((v) => v == null))) { box.append(el('p', {}, 'Usage series unavailable.')); return; }
  const W = Math.max(300, box.clientWidth); const H = Math.round(Math.min(300, Math.max(210, W * 0.45)));
  const m = { l: 40, r: 74, t: 22, b: 28 };
  const pw = W - m.l - m.r; const ph = H - m.t - m.b;
  const all = series.flatMap((sr) => sr.idx).filter((v) => v != null);
  const ticks = niceTicks(0, Math.max(110, ...all) * 1.04, 4);
  const y = (v) => m.t + ph - (v / ticks.at(-1)) * ph;
  const step = rows.length > 1 ? pw / (rows.length - 1) : 0;
  const x = (i) => m.l + i * step;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  const grid = s('g', { class: 'grid' }); const axis = s('g', { class: 'axis' });
  for (const t of ticks) {
    grid.append(s('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
    const tx = s('text', { x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end' }); tx.textContent = String(t); axis.append(tx);
  }
  const unit = s('text', { x: 0, y: 10 }); unit.textContent = 'Index, week of 1 Feb = 100'; axis.append(unit);
  svg.append(grid, s('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: y(100), y2: y(100), 'stroke-dasharray': '3 3' }));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let lastMonth = null; let lastLabelX = -1e9;
  rows.forEach((r, i) => {
    const mo = r.period_start.slice(0, 7);
    if (mo !== lastMonth) { lastMonth = mo; if (x(i) - lastLabelX >= 30) { const t = s('text', { x: x(i), y: H - 10, 'text-anchor': 'start' }); t.textContent = MONTHS[new Date(r.period_start).getUTCMonth()]; axis.append(t); lastLabelX = x(i); } }
  });
  const ends = [];
  for (const sr of series) {
    let d = ''; let pen = false;
    sr.idx.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    svg.append(s('path', { d, fill: 'none', style: sr.style, 'stroke-dasharray': sr.dash, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const li = sr.idx.findLastIndex((v) => v != null);
    if (li >= 0) ends.push({ sr, yv: y(sr.idx[li]), v: sr.idx[li], xv: x(li) });
  }
  // Direct end labels, nudged apart so they never overlap.
  ends.sort((a, b) => a.yv - b.yv);
  for (let i = 1; i < ends.length; i++) if (ends[i].yv - ends[i - 1].yv < 13) ends[i].yv = ends[i - 1].yv + 13;
  for (const e of ends) { const t = s('text', { x: e.xv + 6, y: e.yv + 4, class: 'end-label' }); t.textContent = `${e.sr.label.split(' ')[0]} ${Math.round(e.v)}`; axis.append(t); }
  svg.append(axis);
  // Hover/tap targets per week.
  rows.forEach((r, i) => {
    const g = s('g', { class: 'col' });
    g.append(s('rect', { class: 'hit', x: x(i) - step / 2, y: m.t, width: Math.max(step, 6), height: ph }));
    const show = () => {
      const tip = $('#usage-tooltip'); tip.textContent = '';
      tip.append(...[el('div', { class: 't' }, `${fmtDayShort(r.period_start)} – ${fmtDayShort(lastDay(r.period_end))}${r.partial ? ' · partial' : ''}`),
        ...series.map((sr) => el('div', { class: 'r' }, el('span', {}, sr.label), el('span', {}, sr.raw[i] == null ? 'unavailable' : `${sr.fmt(sr.raw[i])} · ${Math.round(sr.idx[i])}`)))]);
      tip.hidden = false;
      const panel = tip.parentElement.getBoundingClientRect(); const gb = g.getBoundingClientRect();
      tip.style.left = `${Math.max(8, Math.min(gb.left - panel.left + gb.width / 2 - tip.offsetWidth / 2, panel.width - tip.offsetWidth - 8))}px`;
      tip.style.top = `${box.getBoundingClientRect().top - panel.top - 8}px`;
    };
    g.addEventListener('pointerenter', show); g.addEventListener('click', show);
    svg.append(g);
  });
  svg.addEventListener('pointerleave', () => { $('#usage-tooltip').hidden = true; });
  box.append(svg);
}

// ---------- hero: bitmap headline + scanline scale ----------
const GLYPHS = {
  N: ['10001', '11001', '10101', '10101', '10011', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  A: ['01110', '11011', '10001', '11111', '10001', '10001', '10001'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
};
function renderPixelTitle(lines = ['NEAR', 'PARITY']) {
  const cols = Math.max(...lines.map((l) => l.length * 6 - 1)); const rows = lines.length * 7 + (lines.length - 1) * 3;
  const ds = lines.map(() => '');
  lines.forEach((line, li) => [...line].forEach((ch, ci) => (GLYPHS[ch] || []).forEach((bits, ry) => {
    const y = li * 10 + ry; const x = ci * 6;
    for (const run of bits.matchAll(/1+/g)) ds[li] += `M${x + run.index} ${y}h${run[0].length}v1h-${run[0].length}z`;
  })));
  const svg = s('svg', { viewBox: `0 0 ${cols} ${rows}`, 'shape-rendering': 'crispEdges', 'aria-hidden': 'true' });
  ds.forEach((d, i) => svg.append(s('path', { d, class: i === ds.length - 1 ? 'accent-path' : '' })));
  $('#pixel-title').append(svg);
}

// Deterministic PRNG for the decorative streaks.
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax; const dy = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// ---------- hero: interactive buyback simulation (canvas) ----------
// The scale weighs newly issued NEAR (left) against the revenue-based buyback (right). The slider asks
// "what if Intents volume were k× today's?" holding capture rate, allocation and price fixed:
// coverage(k) = measured proxy coverage × k. Tokens fall into each pan at rates proportional to issuance
// and to buybacks. Conditional illustration only; the measured figures are in the cards below.
function startHeroSim(L) {
  const c0 = L?.metrics?.coverage_proxy?.status !== 'unavailable' ? L?.metrics?.coverage_proxy?.value : null;
  const canvas = $('#hero-canvas'); const ctx = canvas.getContext('2d');
  const slider = $('#hero-k'); const playBtn = $('#hero-play');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const KMIN = 0.5; const KMAX = 12;
  const tToK = (t) => KMIN * (KMAX / KMIN) ** t; const kToT = (k) => Math.log(k / KMIN) / Math.log(KMAX / KMIN);
  const kStar = c0 ? 1 / c0 : null;
  let k = 1; let theta = null; let autoplay = !reduce && c0 != null; let phase = 0; let last = performance.now();
  const tokens = []; let spawnL = 0; let spawnR = 0;
  slider.value = String(kToT(1));
  const Wd = 64; const Ht = 46;
  const css = () => { const cs = getComputedStyle(document.documentElement); return { ink: cs.getPropertyValue('--ink').trim(), accent: cs.getPropertyValue('--accent-fill').trim(), streak: cs.getPropertyValue('--streak').trim(), muted: cs.getPropertyValue('--muted').trim() }; };
  let colors = css(); matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { colors = css(); });
  new MutationObserver(() => { colors = css(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function geometry(cov) {
    const c = Math.max(0, cov);
    const target = c <= 1 ? 0.28 * (1 - c) : -0.28 * Math.min(1, (c - 1) / 2);
    return { target, kR: Math.sqrt(Math.min(c, 3)) };
  }
  function layout(th) {
    const P = { x: 32, y: 9 }; const arm = 22;
    const Lend = { x: P.x - arm * Math.cos(th), y: P.y + arm * Math.sin(th) };
    const Rend = { x: P.x + arm * Math.cos(th), y: P.y - arm * Math.sin(th) };
    return { P, Lend, Rend, pans: [Lend, Rend].map((e) => ({ x: e.x, y: e.y + 14, e })) };
  }
  function draw(th, kR) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth; const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const u = w / Wd;
    const { P, Lend, Rend, pans } = layout(th);
    const wL = { w: 12, h: 8 }; const wR = { w: Math.max(1.5, 12 * Math.min(kR, 1.25)), h: Math.max(1.5, 8 * Math.min(kR, 1.25)) };
    const shade = (x, y) => {
      if (Math.hypot(x - P.x, y - P.y) <= 2.3) return [1, 'ink'];
      if (segDist(x, y, Lend.x, Lend.y, Rend.x, Rend.y) <= 1.05) return [1, 'ink'];
      for (const [i, pan] of pans.entries()) {
        const wt = i === 0 ? wL : wR;
        if (x >= pan.x - wt.w / 2 && x < pan.x + wt.w / 2 && y >= pan.y - wt.h && y < pan.y) return [0.95, i === 0 ? 'ink' : 'accent'];
        const ex = (x - pan.x) / 9.5; const ey = (y - pan.y) / 3.4;
        if (y >= pan.y && ex * ex + ey * ey <= 1) return [0.7, 'ink'];
        if (segDist(x, y, pan.e.x, pan.e.y, pan.x - 8.5, pan.y) <= 0.45 || segDist(x, y, pan.e.x, pan.e.y, pan.x + 8.5, pan.y) <= 0.45) return [0.4, 'ink'];
      }
      if (x >= 30.9 && x < 33.1 && y >= P.y && y < 41) return [0.8, 'ink'];
      if (y >= 41 && y < 45 && Math.abs(x - 32) <= 4 + (y - 41) * 2.6) return [0.85, 'ink'];
      return null;
    };
    // background streaks
    ctx.fillStyle = colors.streak;
    const rand = rng(7);
    for (let i = 0; i < 12; i++) { const y = Math.floor(rand() * 9); const len = 5 + Math.floor(rand() * 16); const x0 = Math.floor(rand() * Math.max(1, 27 - len)); ctx.fillRect(x0 * u, y * u + u * 0.4, len * u, Math.max(1, u * 0.15)); }
    ctx.fillRect(0, 45 * u + u * 0.3, Wd * u, Math.max(1, u * 0.15));
    for (let y = 0; y < Ht; y++) {
      let x = 0;
      while (x < Wd) {
        const sh = shade(x + 0.5, y + 0.5); if (!sh) { x++; continue; }
        const q = Math.round(sh[0] * 4) / 4; let x2 = x + 1;
        while (x2 < Wd) { const s2 = shade(x2 + 0.5, y + 0.5); if (!s2 || Math.round(s2[0] * 4) / 4 !== q || s2[1] !== sh[1]) break; x2++; }
        const hh = u * (0.22 + 0.58 * q);
        ctx.fillStyle = sh[1] === 'accent' ? colors.accent : colors.ink;
        ctx.fillRect(x * u, y * u + (u - hh) / 2, (x2 - x) * u, hh);
        x = x2;
      }
    }
    // tokens
    for (const tk of tokens) { ctx.fillStyle = tk.side ? colors.accent : colors.ink; ctx.globalAlpha = tk.a; ctx.fillRect(tk.x * u, tk.y * u, u * 0.9, u * 0.9); }
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.muted; ctx.font = `600 ${Math.max(9, u * 1.4)}px ui-monospace, Menlo, monospace`; ctx.textAlign = 'center';
    ctx.fillText('ISSUED', pans[0].x * u, Math.min(Ht, pans[0].y + 6.2) * u);
    ctx.fillText('BUYBACKS', pans[1].x * u, Math.min(Ht, pans[1].y + 6.2) * u);
    return pans;
  }
  function readout(cov) {
    $('#ro-k').textContent = `${k.toFixed(1)}×`;
    $('#ro-cov').textContent = cov == null ? 'unavailable' : fmtPct(cov);
    $('#ro-parity').hidden = !(cov != null && cov >= 1);
    const pAvg = L?.metrics?.price_avg?.value;
    $('#ro-need').textContent = kStar ? `The revenue proxy reaches parity at ≈${kStar.toFixed(1)}× today’s Intents volume, at the window’s average price${pAvg ? ` (${nf2.format(pAvg)})` : ''}; capture and allocation held fixed. The calculator below uses today’s price, so its multiple differs. Conditional, not a forecast.` : 'Coverage unavailable.';
  }
  // Pause the loop while the hero is off screen (battery); resume where it left off.
  let visible = true;
  new IntersectionObserver(([e]) => {
    const was = visible; visible = e.isIntersecting;
    if (visible && !was && !reduce) requestAnimationFrame((t) => { last = t; frame(t); });
  }).observe(canvas);
  function frame(now) {
    if (!visible && !reduce) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (autoplay && kStar) { // demo: sweep from today's volume up to parity and back
      phase += dt / 12;
      const tA = kToT(1); const tB = kToT(Math.min(KMAX, kStar * 1.05));
      const p = (1 - Math.cos(2 * Math.PI * (phase % 1))) / 2;
      slider.value = String(tA + (tB - tA) * Math.min(1, p * 1.15));
      k = tToK(Number(slider.value));
    }
    const cov = c0 == null ? null : c0 * k;
    const { target, kR } = geometry(cov ?? 0);
    theta = theta == null ? target : theta + (target - theta) * Math.min(1, dt * 4);
    // token flow: issuance rate fixed; buyback rate ∝ coverage
    if (!reduce && c0 != null) {
      spawnL += dt * 2.2; spawnR += dt * 2.2 * Math.min(cov, 3);
      const { pans } = layout(theta);
      while (spawnL >= 1) { spawnL -= 1; tokens.push({ side: 0, x: pans[0].x - 5 + Math.random() * 10, y: -1, v: 10 + Math.random() * 6, a: 1 }); }
      while (spawnR >= 1) { spawnR -= 1; tokens.push({ side: 1, x: pans[1].x - 5 + Math.random() * 10, y: -1, v: 10 + Math.random() * 6, a: 1 }); }
      for (const tk of tokens) {
        const pan = pans[tk.side]; tk.y += tk.v * dt;
        const top = pan.y - (tk.side ? 3 : 8);
        if (tk.y >= top) { tk.y = top; tk.a -= dt * 4; }
      }
      for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i].a <= 0) tokens.splice(i, 1);
    }
    draw(theta, kR); readout(cov);
    if (!reduce || Math.abs(target - theta) > 1e-3) requestAnimationFrame(frame);
  }
  const stopDemo = () => { autoplay = false; playBtn.textContent = 'Play demo'; playBtn.setAttribute('aria-pressed', 'false'); };
  slider.addEventListener('input', () => { stopDemo(); k = tToK(Number(slider.value)); if (reduce) requestAnimationFrame(frame); });
  slider.addEventListener('pointerdown', stopDemo);
  playBtn.addEventListener('click', () => {
    autoplay = !autoplay; playBtn.textContent = autoplay ? 'Pause demo' : 'Play demo'; playBtn.setAttribute('aria-pressed', String(autoplay));
    if (autoplay) { phase = 0; if (reduce) requestAnimationFrame(frame); }
  });
  if (reduce) { playBtn.textContent = 'Play demo'; playBtn.setAttribute('aria-pressed', 'false'); }
  window.addEventListener('resize', () => requestAnimationFrame((t) => draw(theta ?? 0, geometry(c0 == null ? 0 : c0 * k).kR)));
  const m = L?.metrics || {};
  $('#scale-caption').textContent = c0 == null
    ? 'Coverage is unavailable, so nothing is weighed.'
    : `At today’s volume the scale is drawn to data: left pan = NEAR issued in the last 30 days (${fmtNear(m.issuance?.value)}, measured); right pan = revenue-based buyback proxy (${fmtNear(m.buyback_proxy_near?.value)}, proxy). The slider is a conditional scenario, not a forecast.`;
  requestAnimationFrame((t) => { last = t; frame(t); });
}

// ---------- data validation, staleness, resilient rendering ----------
let META = {};
const STALE_AFTER_HOURS = 36;

/** Structural checks on latest.json. Returns a list of problems (empty when the shape is as expected). */
function validateLatest(L) {
  const problems = [];
  if (!L || typeof L !== 'object') return ['latest.json is not an object'];
  if (typeof L.schema_version !== 'number') problems.push('missing schema_version');
  if (!L.window?.start || !L.window?.end) problems.push('missing window');
  if (!L.metrics || typeof L.metrics !== 'object') problems.push('missing metrics');
  for (const [k, m] of Object.entries(L.metrics || {})) {
    if (k === 'epoch_checks') continue;
    if (!['measured', 'estimate', 'proxy', 'unavailable'].includes(m?.status)) problems.push(`metrics.${k}: bad status`);
    else if (m.status === 'unavailable' && (m.value !== null || !m.reason)) problems.push(`metrics.${k}: unavailable needs value null and a reason`);
    else if (m.status !== 'unavailable' && typeof m.value !== 'number') problems.push(`metrics.${k}: value must be a number`);
  }
  for (const k of ['issuance', 'supply_change', 'coverage_proxy', 'intents_volume']) if (!L.metrics?.[k]) problems.push(`metrics.${k} missing`);
  if (!Array.isArray(L.series_weekly)) problems.push('series_weekly missing');
  return problems;
}

/** Render one section; on failure, show a contained notice instead of breaking the page. */
function section(name, target, fn) {
  try { fn(); } catch (e) {
    console.error(`[${name}]`, e);
    const box = typeof target === 'string' ? $(target) : target;
    if (box) { box.textContent = ''; box.append(el('p', { class: 'section-error' }, `This section could not be rendered from the current data (${e.message}). The rest of the page is unaffected.`)); }
  }
}

function renderBanner(L, problems) {
  const host = $('#banner'); host.textContent = ''; host.hidden = true;
  const msgs = [];
  const last = Date.parse(L.last_successful_refresh || '');
  const ageH = Number.isFinite(last) ? (Date.now() - last) / 3.6e6 : Infinity;
  if (ageH > STALE_AFTER_HOURS) msgs.push(`Data may be stale: the last successful refresh was ${Number.isFinite(ageH) ? `${Math.round(ageH)} hours ago (${fmtTime(L.last_successful_refresh)})` : 'never recorded'}. Figures below are the last good values.`);
  if (L.partial_refresh) msgs.push(`The latest refresh was partial (${Object.keys(L.failed_groups || {}).join(', ') || 'a source failed'}); affected figures are marked stale.`);
  if (problems.length) msgs.push(`Data check: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '…' : ''}. Affected sections show as unavailable.`);
  if (!msgs.length) return;
  host.hidden = false;
  host.append(el('strong', {}, 'Heads up. '), msgs.join(' '));
}

// ---------- boot ----------
setupTheme();
renderPixelTitle();
renderLegend();
let loaded = null;
try { loaded = await load(); } catch (e) {
  $('#refresh-meta').textContent = 'Data could not be loaded.';
  section('scale', '#hero-canvas', () => startHeroSim(null));
  $('#main').prepend(el('div', { class: 'error' }, `Could not load data/latest.json (${e.message}). If you opened index.html from disk, run: node scripts/serve.mjs`));
}
if (loaded) {
  const { latest, status } = loaded;
  latest.metrics ||= {};
  META = latest.meta || {};
  const problems = validateLatest(latest);
  if (problems.length) console.warn('latest.json problems:', problems);
  section('banner', '#banner', () => renderBanner(latest, problems));
  section('meta', '#refresh-meta', () => renderMeta(latest));
  section('scale', '#hero-canvas', () => startHeroSim(latest));
  section('answer', '#answer', () => renderAnswer(latest));
  section('cards', '#cards', () => renderCards(latest));
  section('simulator', '#sim-out', () => setupSimulator(latest));
  section('chart', '#chart', () => renderChart(latest));
  section('chart-notes', '#chart-takeaway', () => renderChartNotes(latest));
  section('table', '#series-table', () => renderSeriesTable(latest));
  section('usage', '#usage-tiles', () => renderUsage(latest));
  section('simulator-query', '#simulator', () => { const q = queryBlock(latest.queries?.simulator, 'Formula as code'); if (q) $('#simulator').append(q); });
  section('claims', '#supports', () => renderClaims(latest));
  section('wallet', '#wallet', () => renderWallet(latest));
  section('sources', '#sources', () => renderSources(latest, status));
  document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.range === chartRange)));
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    chartRange = b.dataset.range;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    hideTip(); section('chart', '#chart', () => renderChart(latest));
  }));
  let rt; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { section('chart', '#chart', () => renderChart(latest)); section('usage-chart', '#usage-chart', () => renderUsageChart(latest)); }, 120); }).observe($('#chart'));
  document.addEventListener('click', (e) => { if (!e.target.closest('.chart')) { hideTip(); $('#usage-tooltip').hidden = true; } });
  document.documentElement.dataset.ready = '1';
}
