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
    el('p', { class: 'eyebrow' }, `Buyback coverage · ${fmtDay(L.window.start)} – ${fmtDay(lastDay(L.window.end))}`),
    el('div', { class: 'big' }, proxy?.value != null ? fmtPct(proxy.value) : 'Unavailable', ' ', ...pill(proxy)),
    el('p', { class: 'answer-line' }, 'of newly issued NEAR is matched by the revenue-based buyback proxy.'),
    el('p', { class: 'small muted' },
      `Verified coverage: ${verified?.value != null ? fmtPct(verified.value) : 'unavailable'}. Wallet net accumulation: ${wallet?.value != null ? fmtPct(wallet.value) : 'unavailable'} (not purchases).`),
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

function card({ title, hero, rows = [], source, how }) {
  const hm = hero.m; const ok = hm && hm.status !== 'unavailable' && hm.value != null;
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, title), el('span', { class: 'period' }, shortPeriod(hm))),
    el('p', { class: 'hero-label' }, hero.label),
    el('div', { class: 'hero-value' }, ok ? (hero.fmt || fmtNear)(hm.value) : 'Unavailable', ' ', ...pill(hm)),
    ok && hero.note ? el('p', { class: 'hero-note' }, hero.note) : (!ok ? el('p', { class: 'hero-note' }, hm?.reason || '') : null),
    rows.length ? el('ul', { class: 'rows' }, rows.map((r) => row(r[0], r[1], { ...(r[2] || {}), baseStatus: hm?.status }))) : null,
    el('p', { class: 'src' }, `Source: ${source}`),
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
      title: 'Issuance',
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
      title: 'Intents economics',
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
      title: 'Buyback coverage',
      hero: { label: 'Proxy ÷ issuance', m: m.coverage_proxy, fmt: (v) => fmtPct(v), note: m.buyback_proxy_near?.value != null ? `${fmtNear(m.buyback_proxy_near.value)} proxy vs ${fmtNear(m.issuance?.value)} issued` : null },
      rows: [
        ['Verified ÷ issuance', m.coverage_verified, { fmt: (v) => fmtPct(v) }],
        ['Wallet net ÷ issuance', m.coverage_wallet, { fmt: (v) => fmtPct(v) }],
      ],
      source: 'NEAR RPC · DefiLlama · daily price',
      how: `<p><strong>Verified coverage</strong> would be verified NEAR purchased ÷ newly issued NEAR over the same period. It is unavailable: ${escapeHtml(m.verified_purchases?.reason || '')}</p>
<p><strong>Proxy</strong>: for each day, DefiLlama labelled buyback revenue (USD) ÷ that day's NEAR price, summed and divided by measured issuance over the same 30 days.</p>
<p><strong>Wallet net accumulation</strong>: change in NEAR held by <code>${escapeHtml(L.wallet?.account_id || '')}</code> (native + wNEAR + wNEAR inside intents.near) between the window's boundary blocks, minus transfers from NEAR's other listed revenue wallets (${escapeHtml((L.wallet?.related_revenue_wallets?.accounts || []).join(', '))}; ${m.wallet_internal_transfers?.value != null ? fmtNear(m.wallet_internal_transfers.value) : 'unavailable'} in this window), ÷ measured issuance. A balance increase is net accumulation, not proof of purchases. Purchased NEAR held in a wallet is not burned.</p>`,
    }),
    card({
      title: 'Actual supply change',
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
    el('div', { class: 'r' }, el('span', {}, 'Issuance'), el('span', {}, fmtNear(r.issuance_near))),
    el('div', { class: 'r' }, el('span', {}, 'Proxy'), el('span', {}, r.buyback_proxy_near != null ? fmtNear(r.buyback_proxy_near) + share(r.buyback_proxy_near) : 'unavailable')),
    el('div', { class: 'r' }, el('span', {}, 'Wallet net*'), el('span', {}, walletVal(r) != null ? fmtNear(walletVal(r)) + share(walletVal(r)) : 'unavailable')),
    Math.abs(r.wallet_internal_near ?? 0) >= 1 ? el('div', { class: 'small' }, `*Excludes ${fmtNear(r.wallet_internal_near)} moved in from NEAR's other revenue wallets (raw change ${fmtNear(r.wallet_net_near)}).`) : null,
    el('div', { class: 'r' }, el('span', {}, 'Supply change'), el('span', {}, fmtNear(r.supply_change_near))),
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
  let d = '';
  lines.forEach((line, li) => [...line].forEach((ch, ci) => (GLYPHS[ch] || []).forEach((bits, ry) => {
    const y = li * 10 + ry; let x = ci * 6;
    for (const run of bits.matchAll(/1+/g)) d += `M${x + run.index} ${y}h${run[0].length}v1h-${run[0].length}z`;
  })));
  const svg = s('svg', { viewBox: `0 0 ${cols} ${rows}`, 'shape-rendering': 'crispEdges', 'aria-hidden': 'true' });
  svg.append(s('path', { d }));
  $('#pixel-title').append(svg);
}

// Deterministic PRNG for the decorative streaks.
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax; const dy = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/** Balance scale rasterised to a 64×46 grid and drawn as horizontal scanlines.
 *  Left pan = issuance (fixed weight); right pan = buyback proxy, weight ∝ coverage; tilt ∝ (1 − coverage). */
function renderScale(L) {
  const cov = L?.metrics?.coverage_proxy?.value ?? null;
  const c = cov == null ? null : Math.max(0, Math.min(1, cov));
  const Wd = 64; const Ht = 46; const u = 10;
  const theta = c == null ? 0 : 0.28 * (1 - c);
  const P = { x: 32, y: 9 }; const arm = 22;
  const Lend = { x: P.x - arm * Math.cos(theta), y: P.y + arm * Math.sin(theta) };
  const Rend = { x: P.x + arm * Math.cos(theta), y: P.y - arm * Math.sin(theta) };
  const pans = [Lend, Rend].map((e) => ({ x: e.x, y: e.y + 14, e }));
  const wL = { w: 12, h: 8 }; const k = c == null ? 0 : Math.sqrt(c);
  const wR = { w: Math.max(c ? 1.5 : 0, 12 * k), h: Math.max(c ? 1.5 : 0, 8 * k) };
  const shade = (x, y) => {
    if (Math.hypot(x - P.x, y - P.y) <= 2.3) return 1;
    if (segDist(x, y, Lend.x, Lend.y, Rend.x, Rend.y) <= 1.05) return 1;
    for (const [i, pan] of pans.entries()) {
      const wt = i === 0 ? wL : wR;
      if (wt.w && x >= pan.x - wt.w / 2 && x < pan.x + wt.w / 2 && y >= pan.y - wt.h && y < pan.y) return 0.95;
      const ex = (x - pan.x) / 9.5; const ey = (y - pan.y) / 3.4;
      if (y >= pan.y && ex * ex + ey * ey <= 1) return 0.7;
      if (segDist(x, y, pan.e.x, pan.e.y, pan.x - 8.5, pan.y) <= 0.45 || segDist(x, y, pan.e.x, pan.e.y, pan.x + 8.5, pan.y) <= 0.45) return 0.4;
    }
    if (x >= 30.9 && x < 33.1 && y >= P.y && y < 41) return 0.8;
    if (y >= 41 && y < 45 && Math.abs(x - 32) <= 4 + (y - 41) * 2.6) return 0.85;
    return 0;
  };
  const svg = s('svg', { viewBox: `0 0 ${Wd * u} ${(Ht + 1) * u}`, 'aria-hidden': 'true' });
  const rand = rng(7);
  for (let i = 0; i < 12; i++) { // decorative streaks, upper left (clear of the beam and pans)
    const y = Math.floor(rand() * 9); const len = 5 + Math.floor(rand() * 16); const x0 = Math.floor(rand() * Math.max(1, 27 - len));
    svg.append(s('rect', { class: 'streak', x: x0 * u, y: y * u + 4, width: len * u, height: 2 }));
  }
  for (let y = 0; y < Ht; y++) {
    let x = 0;
    while (x < Wd) {
      const sh = Math.round(shade(x + 0.5, y + 0.5) * 4) / 4;
      if (!sh) { x++; continue; }
      let x2 = x + 1;
      while (x2 < Wd && Math.round(shade(x2 + 0.5, y + 0.5) * 4) / 4 === sh) x2++;
      const h = u * (0.22 + 0.58 * sh);
      svg.append(s('rect', { class: 'ink', x: x * u, y: y * u + (u - h) / 2, width: (x2 - x) * u, height: h }));
      x = x2;
    }
  }
  svg.append(s('rect', { class: 'streak', x: 0, y: 45 * u + 3, width: Wd * u, height: 2 }));
  const label = (txt, x, y) => { const t = s('text', { x: x * u, y: y * u, 'text-anchor': 'middle', style: 'fill: var(--muted); font: 600 15px var(--mono); letter-spacing: 1px' }); t.textContent = txt; svg.append(t); };
  label('ISSUED', pans[0].x, Math.min(Ht, pans[0].y + 6.2));
  label(c == null ? 'PROXY N/A' : 'BUYBACK PROXY', pans[1].x, Math.min(Ht, pans[1].y + 6.2));
  const box = $('#scale-art'); box.textContent = ''; box.append(svg);
  const m = L?.metrics || {};
  $('#scale-caption').textContent = c == null
    ? 'Scale shown level only as an outline: buyback coverage is unavailable, so nothing is weighed.'
    : `Drawn to data, last 30 days: left pan = NEAR issued (${fmtNear(m.issuance?.value)}, measured); right pan = revenue-based buyback proxy (${fmtNear(m.buyback_proxy_near?.value)}, proxy). Weight area and tilt scale with proxy coverage (${fmtPct(cov)}); a level beam would mean parity.`;
  box.setAttribute('aria-label', `Balance scale: newly issued NEAR outweighs the buyback proxy; proxy coverage ${c == null ? 'unavailable' : fmtPct(cov)}.`);
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
  section('scale', '#scale-art', () => renderScale(null));
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
  section('scale', '#scale-art', () => renderScale(latest));
  section('answer', '#answer', () => renderAnswer(latest));
  section('cards', '#cards', () => renderCards(latest));
  section('simulator', '#sim-out', () => setupSimulator(latest));
  section('chart', '#chart', () => renderChart(latest));
  section('table', '#series-table', () => renderSeriesTable(latest));
  section('claims', '#supports', () => renderClaims(latest));
  section('wallet', '#wallet', () => renderWallet(latest));
  section('sources', '#sources', () => renderSources(latest, status));
  document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.range === chartRange)));
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    chartRange = b.dataset.range;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    hideTip(); section('chart', '#chart', () => renderChart(latest));
  }));
  let rt; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => section('chart', '#chart', () => renderChart(latest)), 120); }).observe($('#chart'));
  document.addEventListener('click', (e) => { if (!e.target.closest('.chart')) hideTip(); });
  document.documentElement.dataset.ready = '1';
}
