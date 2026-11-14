// Pure calculation helpers shared by build-data.mjs, test.mjs and the dashboard.
// No I/O here. yoctoNEAR amounts are BigInt; they become Numbers only for display.

export const YOCTO_PER_NEAR = 10n ** 24n;
export const DAY_MS = 86_400_000;
// nearcore genesis `num_seconds_per_year` (mainnet), used in the epoch reward formula.
export const SECONDS_PER_YEAR = 31_556_952n;

/** Parse a yoctoNEAR decimal string (or BigInt) into BigInt, rejecting anything else. */
export function toYocto(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`Not a yoctoNEAR integer string: ${JSON.stringify(value)}`);
}

/** yoctoNEAR (BigInt or string) → NEAR as a Number, for display only. Exact to 1e-12 NEAR. */
export function yoctoToNear(value) {
  const y = toYocto(value);
  const sign = y < 0n ? -1 : 1;
  const abs = y < 0n ? -y : y;
  const whole = abs / YOCTO_PER_NEAR;
  const frac = (abs % YOCTO_PER_NEAR) / 10n ** 12n; // 12 decimal places
  return sign * (Number(whole) + Number(frac) / 1e12);
}

/** yoctoNEAR → exact decimal string in NEAR (no float rounding). */
export function yoctoToNearString(value, decimals = 24) {
  const y = toYocto(value);
  const neg = y < 0n;
  const abs = neg ? -y : y;
  const whole = abs / YOCTO_PER_NEAR;
  let frac = (abs % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/**
 * Tokens minted at one epoch boundary.
 * nearcore: total_supply(block) = total_supply(prev) + minted − Σ balance_burnt of chunks included in block.
 * So minted = supply(first block) − supply(prev block) + burnt in the first block.
 */
export function epochMint({ supplyPrev, supplyStart, boundaryBurnt = 0n }) {
  return toYocto(supplyStart) - toYocto(supplyPrev) + toYocto(boundaryBurnt);
}

/** Upper bound on the mint for one epoch: supply × max_inflation_rate × duration ÷ one year. */
export function expectedMaxMint({ supply, rate, durationNs }) {
  const [num, den] = rate.map(BigInt);
  return (toYocto(supply) * num * BigInt(durationNs)) / (den * SECONDS_PER_YEAR * 1_000_000_000n);
}

/**
 * Burn reconciliation over a period. Issuance is the sum of boundary mints inside the period;
 * supply change is measured between the period's boundary blocks. Burns are derived, never added
 * to the supply change again (that would double-count them). Treasury purchases are not burns.
 */
export function reconcileBurns({ mints, supplyStart, supplyEnd }) {
  const issuance = mints.reduce((a, m) => a + toYocto(m), 0n);
  const supplyChange = toYocto(supplyEnd) - toYocto(supplyStart);
  return { issuance, supplyChange, derivedBurns: issuance - supplyChange };
}

/**
 * Buyback parity scenario.
 * Required daily volume (USD) = daily issuance (NEAR) × price (USD) ÷ (capture rate × allocation).
 * Rates are decimal fractions. A zero (or non-positive) denominator has no finite answer.
 */
export function parityRequiredDailyVolume({ dailyIssuanceNear, priceUsd, captureRate, allocation }) {
  const inputs = { dailyIssuanceNear, priceUsd, captureRate, allocation };
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return { finite: false, value: null, reason: `Input ${k} must be a finite, non-negative number.` };
    }
  }
  const denominator = captureRate * allocation;
  if (denominator === 0) {
    return { finite: false, value: null, reason: 'No finite volume achieves parity under these assumptions.' };
  }
  return { finite: true, value: (dailyIssuanceNear * priceUsd) / denominator, reason: null };
}

/** UTC midnight (as a Date) of the day containing `date`. */
export function utcMidnight(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** The default comparison window: the `days` most recent complete UTC days, end exclusive. */
export function utcWindow(now, days = 30) {
  const end = utcMidnight(now);
  const start = new Date(end.getTime() - days * DAY_MS);
  return { start: start.toISOString(), end: end.toISOString(), days };
}

/** List of YYYY-MM-DD UTC days in [start, end). */
export function daysIn(start, end) {
  const out = [];
  for (let t = utcMidnight(start).getTime(); t < new Date(end).getTime(); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Sum a daily [unixSeconds, value] series over [start, end). Missing days are reported, never
 * filled with zero. Returns sum = null when any day is missing.
 */
export function sumDaily(series, start, end) {
  const byDay = new Map();
  for (const [ts, v] of series) {
    if (typeof v === 'number' && Number.isFinite(v)) byDay.set(new Date(ts * 1000).toISOString().slice(0, 10), v);
  }
  const days = daysIn(start, end);
  const missing = days.filter((d) => !byDay.has(d));
  const present = days.filter((d) => byDay.has(d));
  const partialSum = present.reduce((a, d) => a + byDay.get(d), 0);
  return { sum: missing.length ? null : partialSum, partialSum, daysExpected: days.length, daysPresent: present.length, missing };
}

/** Fixed 7-day buckets anchored at `anchor`, clipped to `end` (exclusive). Last may be partial. */
export function weeklyBuckets(anchor, end) {
  const out = [];
  const endMs = new Date(end).getTime();
  for (let t = new Date(anchor).getTime(); t < endMs; t += 7 * DAY_MS) {
    const bEnd = Math.min(t + 7 * DAY_MS, endMs);
    out.push({ start: new Date(t).toISOString(), end: new Date(bEnd).toISOString(), days: (bEnd - t) / DAY_MS, partial: bEnd - t < 7 * DAY_MS });
  }
  return out;
}

/** Ratio helper that refuses to divide by zero or by unavailable values. */
export function safeRatio(num, den) {
  if (num == null || den == null || !Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
}

/** Build a metric record in the shared shape. Unavailable metrics always carry value null and a reason. */
export function metric({ value, unit, period_start = null, period_end = null, source, method, status, reason = null, ...extra }) {
  if (!['measured', 'estimate', 'proxy', 'unavailable'].includes(status)) throw new Error(`Bad status ${status}`);
  if (status === 'unavailable') {
    if (!reason) throw new Error('Unavailable metric needs a reason');
    return { value: null, unit, period_start, period_end, source, method, status, reason, ...extra };
  }
  if (value == null || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error(`Metric with status ${status} needs a value`);
  }
  return { value, unit, period_start, period_end, source, method, status, reason, ...extra };
}
