// Network-usage helpers (NearBlocks daily charts). Pure functions; covered by the offline tests.
import { DAY_MS, daysIn } from './calc.mjs';

export const USAGE_URL = 'https://api.nearblocks.io/v1/charts';
export const USAGE_FIELDS = ['txns', 'active_accounts', 'new_accounts', 'active_contracts'];

/** NearBlocks /v1/charts rows → [{ date: 'YYYY-MM-DD', txns, active_accounts, new_accounts, active_contracts }].
 *  Values are numbers; a field that is missing or not numeric is null (never 0). Rows before `from` are dropped. */
export function parseUsage(charts, from = '2025-01-01') {
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return (charts || [])
    .map((r) => ({ date: String(r.date).slice(0, 10), ...Object.fromEntries(USAGE_FIELDS.map((f) => [f, num(r[f])])) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date >= from)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Mean (or sum) of a field over [start, end). Any missing day makes the result null, with the missing days listed. */
export function windowStat(rows, field, start, end, agg = 'mean') {
  const by = new Map(rows.map((r) => [r.date, r[field]]));
  const days = daysIn(start, end);
  const missing = days.filter((d) => by.get(d) == null);
  if (missing.length) return { value: null, days: days.length, missing };
  const total = days.reduce((a, d) => a + by.get(d), 0);
  return { value: agg === 'sum' ? total : total / days.length, days: days.length, missing: [] };
}

/** The same window shifted back by its own length (the previous 30 days). */
export function priorWindow(start, end) {
  const len = new Date(end) - new Date(start);
  return { start: new Date(new Date(start) - len).toISOString(), end: new Date(start).toISOString() };
}

/** Relative change, or null when either side is unavailable or the base is zero. */
export const changePct = (now, before) => (now == null || before == null || before === 0 ? null : (now - before) / before);

/** Index a series to 100 at its first available value. Nulls stay null. */
export function indexTo100(values) {
  const base = values.find((v) => v != null && v !== 0);
  return values.map((v) => (v == null || base == null ? null : (v / base) * 100));
}

/** Sum a DefiLlama [unixSeconds, value] series over [start, end); null if any day is missing. */
export function llamaWindowSum(series, start, end) {
  const by = new Map((series || []).map(([ts, v]) => [new Date(ts * 1000).toISOString().slice(0, 10), v]));
  const days = daysIn(start, end);
  if (days.some((d) => typeof by.get(d) !== 'number')) return null;
  return days.reduce((a, d) => a + by.get(d), 0);
}

export { DAY_MS };

/** Pearson correlation of week-over-week % changes of two weekly series (pairs with any null are skipped). */
export function changeCorrelation(a, b) {
  const pct = (v) => v.slice(1).map((x, i) => (x == null || v[i] == null || v[i] === 0 ? null : (x - v[i]) / v[i]));
  const pa = pct(a); const pb = pct(b);
  const pairs = pa.map((x, i) => [x, pb[i]]).filter(([x, y]) => x != null && y != null);
  const n = pairs.length;
  if (n < 3) return { r: null, n };
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n; const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return { r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : null, n };
}
