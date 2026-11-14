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
  if (!m) return el('span', { class: 'pill pill-unavailable' }, 'unavailable');
  const frag = [el('span', { class: `pill pill-${m.status}`, title: statusHelp[m.status] }, m.derived ? 'measured · derived' : m.status)];
  if (m.stale) frag.push(' ', el('span', { class: 'pill pill-stale', title: m.stale_reason || '' }, `stale since ${fmtDay(m.stale_since)}`));
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
  $('#window-label').textContent = `· ${fmtDay(L.window.start)} – ${fmtDay(lastDay(L.window.end))}`;
}

function renderAnswer(L) {
  const m = L.metrics;
  const box = $('#answer');
  box.textContent = '';
  const proxy = m.coverage_proxy; const wallet = m.coverage_wallet; const verified = m.coverage_verified;
  box.append(
    el('p', { class: 'small' }, `Buyback coverage, ${fmtDay(L.window.start)} – ${fmtDay(lastDay(L.window.end))} (30 UTC days)`),
    el('div', { class: 'big' }, proxy?.value != null ? fmtPct(proxy.value) : 'Unavailable', ' ', ...pill(proxy)),
    el('p', {}, 'of newly issued NEAR, using the DefiLlama revenue-based buyback ', el('strong', {}, 'proxy'), '.'),
    el('p', { class: 'small' },
      'Verified coverage: ', el('strong', {}, verified?.value != null ? fmtPct(verified.value) : 'unavailable'), ' — ', verified?.reason || '',
      ' Wallet net accumulation covers ', el('strong', {}, wallet?.value != null ? fmtPct(wallet.value) : 'unavailable'), ' of issuance (net accumulation, not purchases).'),
  );
}

// ---------- cards ----------
function row(label, m, { fmt = fmtNear, headline = false, sub = null, statusPill = true } = {}) {
  const k = el('span', { class: 'k' }, label, statusPill && m ? [' ', ...pill(m)] : null);
  let v;
  if (!m || m.status === 'unavailable' || m.value == null) {
    v = el('span', { class: 'v' }, 'Unavailable', el('span', { class: 'reason' }, m?.reason || 'No data.'));
  } else {
    v = el('span', { class: 'v' }, fmt(m.value), sub ? el('small', {}, sub) : null);
  }
  return el('li', { class: headline ? 'headline' : null }, k, v);
}

function card({ title, period, rows, source, how }) {
  return el('article', { class: 'card' },
    el('h3', {}, title),
    el('p', { class: 'period' }, period),
    el('ul', { class: 'rows' }, rows),
    el('p', { class: 'src' }, 'Source: ', source),
    el('details', {}, el('summary', {}, 'How this is calculated'), el('div', { class: 'how', html: how })),
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
      title: 'Issuance', period: periodText(m.issuance),
      rows: [
        row('Newly minted NEAR', m.issuance, { headline: true, sub: m.issuance?.epochs_counted ? `${m.issuance.epochs_counted} epoch boundaries` : null }),
        row('Per day', m.daily_issuance, { fmt: (v) => `${nf0.format(v)} NEAR/day` }),
        row('Observed annualised rate', m.issuance_annualised_rate, { fmt: (v) => fmtPct(v, 2), sub: cap ? `Protocol cap ${cap.max_inflation_rate} = ${fmtPct(eval_rate(cap.max_inflation_rate), 1)}: a maximum, not measured issuance` : null }),
      ],
      source: m.issuance?.source || '—',
      how: `<p>NEAR mints new tokens at each epoch boundary (about every 7 hours). For every boundary whose first block falls in the window, the build reads <code>total_supply</code> of the first block and of the block before it, and adds back the protocol burns included in that first block: <code>mint = supply(first) − supply(previous) + burnt(first)</code>. These are exact yoctoNEAR integers, summed with BigInt.</p>
<p>Sanity checks: within each epoch supply must only fall (burns), and each mint should sit just under <code>supply × max_inflation_rate × epoch duration ÷ year</code>. ${checks ? `${checks.epochs_checked} epochs checked since February, ${checks.epochs_flagged} flagged` : ''}${ratio ? `; in this window mints were ${fmtPct(ratio[0])}–${fmtPct(ratio[1])} of that cap.` : '.'} The cap is shown for comparison only and is never used as issuance.</p>
<p>Epoch boundaries are cached in <a href="data/epochs.json">data/epochs.json</a>.</p>`,
    }),
    card({
      title: 'Intents economics', period: periodText(m.intents_volume),
      rows: [
        row('Swap volume', m.intents_volume, { fmt: fmtUsd, headline: true, sub: m.avg_daily_volume?.value != null ? `${fmtUsd(m.avg_daily_volume.value)}/day average` : null }),
        row('Gross fees', m.intents_gross_fees, { fmt: fmtUsd }),
        row('Net revenue captured', m.intents_net_revenue, { fmt: fmtUsd, sub: m.net_revenue_capture_rate?.value != null ? `${nf2.format(m.net_revenue_capture_rate.value)} bps of volume` : null }),
        row('Labelled buyback revenue', m.intents_holders_revenue, { fmt: fmtUsd, sub: m.buyback_allocation?.value != null ? `${nf0.format(m.buyback_allocation.value)}% of net revenue (DefiLlama label)` : null }),
      ],
      source: 'DefiLlama, protocol near-intents (dexs and fees APIs)',
      how: `<p>Daily DefiLlama values are summed over the same 30 UTC days. If any day is missing, the total is shown as unavailable rather than summed with a gap.</p>
<p><strong>Gross fees</strong>: protocol plus affiliate fees on swaps. <strong>Net revenue</strong>: NEAR's captured revenue after partner and front-end distributions (DefiLlama measures it as NEAR/wNEAR swept into NEAR's revenue wallets). <strong>Labelled buyback revenue</strong>: DefiLlama's “holders revenue”, which labels captured revenue from 2026-02-23 as buyback money. It is a label, not a record of purchases, so it is kept separate from verified purchases and marked proxy.</p>
<p>Capture rate = net revenue ÷ volume. Allocation = labelled buyback revenue ÷ net revenue.</p>`,
    }),
    card({
      title: 'Buyback coverage', period: periodText(m.coverage_proxy),
      rows: [
        row('Verified purchases ÷ issuance', m.coverage_verified, { fmt: (v) => fmtPct(v) }),
        row('Proxy ÷ issuance', m.coverage_proxy, { fmt: (v) => fmtPct(v), headline: true, sub: m.buyback_proxy_near?.value != null ? `${fmtNear(m.buyback_proxy_near.value)} proxy` : null }),
        row('Wallet net accumulation ÷ issuance', m.coverage_wallet, { fmt: (v) => fmtPct(v), sub: m.wallet_net_excl_internal?.value != null ? `${fmtNear(m.wallet_net_excl_internal.value)} net, excl. internal transfers` : null }),
      ],
      source: 'Measured issuance (NEAR chain) with DefiLlama revenue ÷ daily price, and wallet balances (archival RPC)',
      how: `<p><strong>Verified coverage</strong> would be verified NEAR purchased ÷ newly issued NEAR over the same period. It is unavailable: ${escapeHtml(m.verified_purchases?.reason || '')}</p>
<p><strong>Proxy</strong>: for each day, DefiLlama labelled buyback revenue (USD) ÷ that day's NEAR price, summed and divided by measured issuance over the same 30 days.</p>
<p><strong>Wallet net accumulation</strong>: change in NEAR held by <code>${escapeHtml(L.wallet?.account_id || '')}</code> (native + wNEAR + wNEAR inside intents.near) between the window's boundary blocks, minus transfers from NEAR's other listed revenue wallets (${escapeHtml((L.wallet?.related_revenue_wallets?.accounts || []).join(', '))}; ${m.wallet_internal_transfers?.value != null ? fmtNear(m.wallet_internal_transfers.value) : 'unavailable'} in this window), ÷ measured issuance. A balance increase is net accumulation, not proof of purchases. Purchased NEAR held in a wallet is not burned.</p>`,
    }),
    card({
      title: 'Actual supply change', period: periodText(m.supply_change),
      rows: [
        row('Total supply change', m.supply_change, { headline: true, fmt: (v) => `${v >= 0 ? '+' : ''}${nf0.format(v)} NEAR` }),
        row('Issuance (minted)', m.issuance),
        row('Protocol burns (derived)', m.derived_burns),
        row('Supply at window end', m.supply_end),
      ],
      source: m.supply_change?.source || '—',
      how: `<p>Supply change = <code>total_supply</code> of the last block before the window end − that of the last block before the window start. It already includes burns.</p>
<p>Burns are derived: issuance − supply change. They are not subtracted again (no double counting). Buybacks do not appear here: NEAR bought and held in a treasury wallet stays in total supply, so treasury purchases are never counted as burns.</p>`,
    }),
  );
}
const eval_rate = (s) => { const [a, b] = String(s).split('/').map(Number); return b ? a / b : null; };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- simulator ----------
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
  }
  for (const i of Object.values(inputs)) i.addEventListener('input', compute);
  $('#sim-reset').addEventListener('click', reset);
  $('#sim-form').addEventListener('submit', (e) => e.preventDefault());
  reset();
}

// ---------- chart (inline SVG) ----------
const SVGNS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const step0 = span / count; const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => span / x <= count) || 10 * mag;
  const ticks = [];
  for (let t = Math.floor(min / step) * step; t <= max + 1e-9; t += step) ticks.push(t);
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

let chartRange = 'all';
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

  let lastMonth = null;
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
      const lbl = new Date(r.period_start).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
      const tx = s('text', { x: x + 1, y: H - 10, 'text-anchor': 'start' }); tx.textContent = lbl; axis.append(tx);
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
    el('div', { class: 'r' }, el('span', {}, 'Issuance'), el('span', {}, fmtNear(r.issuance_near))),
    el('div', { class: 'r' }, el('span', {}, 'Proxy'), el('span', {}, r.buyback_proxy_near != null ? fmtNear(r.buyback_proxy_near) + share(r.buyback_proxy_near) : 'unavailable')),
    el('div', { class: 'r' }, el('span', {}, 'Wallet net*'), el('span', {}, walletVal(r) != null ? fmtNear(walletVal(r)) + share(walletVal(r)) : 'unavailable')),
    Math.abs(r.wallet_internal_near ?? 0) >= 1 ? el('div', { class: 'small' }, `*Excludes ${fmtNear(r.wallet_internal_near)} moved in from NEAR's other revenue wallets (raw change ${fmtNear(r.wallet_net_near)}).`) : null,
    el('div', { class: 'r' }, el('span', {}, 'Supply change'), el('span', {}, fmtNear(r.supply_change_near))),
    r.period_end <= '2026-03-18' ? el('div', { class: 'small' }, 'Wallet created 2026-03-18; zero before.') : null,
    r.period_end <= '2026-02-23' ? el('div', { class: 'small' }, 'DefiLlama labels buyback revenue from 2026-02-23.') : null,
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
  if (v('issuance') != null) add(sup, `New issuance is measurable on-chain: ${fmtNear(v('issuance'))} in the window (${nf0.format(v('daily_issuance'))} NEAR/day), an observed ${fmtPct(v('issuance_annualised_rate'), 2)} annualised rate, below the ${m.issuance.reference_cap?.max_inflation_rate ?? ''} protocol cap.`);
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
  for (const src of L.sources || []) ul.append(el('li', {}, el('strong', {}, src.name), ': ', el('a', { href: src.url }, src.url), ` — ${src.used_for}`));
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

// ---------- boot ----------
setupTheme();
renderLegend();
try {
  const { latest, status } = await load();
  renderMeta(latest);
  renderAnswer(latest);
  renderCards(latest);
  setupSimulator(latest);
  renderChart(latest);
  renderSeriesTable(latest);
  renderClaims(latest);
  renderWallet(latest);
  renderSources(latest, status);
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    chartRange = b.dataset.range;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    hideTip(); renderChart(latest);
  }));
  let rt; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => renderChart(latest), 120); }).observe($('#chart'));
  document.addEventListener('click', (e) => { if (!e.target.closest('.chart')) hideTip(); });
} catch (e) {
  $('#refresh-meta').textContent = 'Data could not be loaded.';
  $('#main').prepend(el('div', { class: 'error' }, `Could not load data/latest.json (${e.message}). If you opened index.html from disk, run: node scripts/serve.mjs`));
}
