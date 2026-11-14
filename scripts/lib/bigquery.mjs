// BigQuery (public NEAR dataset) for the daily on-chain buyback trace. Node 22 built-ins only.
//
// Authentication without stored keys: in GitHub Actions the job's OIDC token is exchanged for a short-lived
// Google token (Workload Identity Federation → service account impersonation). Nothing secret is stored in the
// repository or in GitHub secrets. Locally, NEAR_PARITY_GCP_TOKEN can supply an access token instead.
//
// Cost control: each run queries only the complete UTC days not yet recorded in data/bigquery-daily.json, and every
// query carries maximumBytesBilled, so a mistake cannot exceed the cap (about 1.2 GB per day of data).
import { DAY_MS } from './calc.mjs';

export const DATASET = 'bigquery-public-data.crypto_near_mainnet_us';
const BQ = 'https://bigquery.googleapis.com/bigquery/v2';

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}: ${JSON.stringify(j?.error?.message ?? j).slice(0, 300)}`);
  return j;
}

/** Short-lived Google access token: env token, or GitHub OIDC → STS → service account. Null when not configured. */
export async function gcpAccessToken({ provider, serviceAccount }) {
  if (process.env.NEAR_PARITY_GCP_TOKEN) return process.env.NEAR_PARITY_GCP_TOKEN;
  const reqUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL; const reqTok = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!provider || !serviceAccount || !reqUrl || !reqTok) return null;
  const oidcRes = await fetch(`${reqUrl}&audience=${encodeURIComponent(`https://iam.googleapis.com/${provider}`)}`, { headers: { authorization: `bearer ${reqTok}` }, signal: AbortSignal.timeout(30_000) });
  const oidc = (await oidcRes.json().catch(() => null))?.value;
  if (!oidc) throw new Error(`GitHub OIDC token request failed (HTTP ${oidcRes.status}); the workflow needs permissions: id-token: write`);
  const sts = await postJson('https://sts.googleapis.com/v1/token', {
    audience: `//iam.googleapis.com/${provider}`, grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
    requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token', scope: 'https://www.googleapis.com/auth/cloud-platform',
    subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt', subjectToken: oidc,
  });
  const fed = sts.access_token ?? sts.accessToken;
  const sa = await postJson(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateAccessToken`,
    { scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '1800s' }, { authorization: `Bearer ${fed}` });
  return sa.accessToken;
}

const param = (name, value) => {
  if (Array.isArray(value)) {
    return { name, parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } }, parameterValue: { arrayValues: (value.length ? value : ['']).map((v) => ({ value: v })) } };
  }
  return { name, parameterType: { type: /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'DATE' : 'STRING' }, parameterValue: { value } };
};
const cell = (field, v) => {
  if (v == null) return null;
  if (field.mode === 'REPEATED') return v.map((x) => cell({ ...field, mode: 'NULLABLE' }, x.v));
  return v;
};

/** Run a standard-SQL query with named parameters and a hard byte cap. Returns { rows: [{col: value}], bytes }. */
export async function runQuery({ token, project, sql, params = {}, maxBytes }) {
  const auth = { authorization: `Bearer ${token}` };
  let r = await postJson(`${BQ}/projects/${project}/queries`, {
    query: sql, useLegacySql: false, parameterMode: 'NAMED', timeoutMs: 60_000,
    maximumBytesBilled: String(Math.ceil(maxBytes)), queryParameters: Object.entries(params).map(([k, v]) => param(k, v)),
  }, auth);
  const ref = r.jobReference;
  for (let i = 0; !r.jobComplete && i < 20; i++) {
    const res = await fetch(`${BQ}/projects/${ref.projectId}/queries/${ref.jobId}?timeoutMs=60000${ref.location ? `&location=${ref.location}` : ''}`, { headers: auth, signal: AbortSignal.timeout(90_000) });
    r = await res.json();
    if (!res.ok) throw new Error(`BigQuery job ${ref.jobId}: HTTP ${res.status} ${JSON.stringify(r?.error?.message ?? r).slice(0, 200)}`);
  }
  if (!r.jobComplete) throw new Error(`BigQuery job ${ref?.jobId} did not complete in time`);
  if (r.errors?.length) throw new Error(`BigQuery: ${r.errors[0].message}`);
  const fields = r.schema?.fields || [];
  const rows = (r.rows || []).map((row) => Object.fromEntries(fields.map((f, i) => [f.name, cell(f, row.f[i]?.v)])));
  return { rows, bytes: Number(r.totalBytesProcessed || 0), job_id: ref?.jobId };
}

export const FRESHNESS_SQL = `-- Latest block in the public dataset (decides which UTC days are complete)
SELECT UNIX_SECONDS(MAX(block_timestamp_utc)) AS latest
FROM \`${DATASET}.blocks\`
WHERE block_date >= @since`;

/** Daily trace for [@start, @end): NEAR withdrawn to the wallet, and swaps by every account that has funded it.
 *  An account counts from the first day it withdrew to the wallet (@known: accounts already seen, from earlier runs).
 *  Amounts are yoctoNEAR integer strings (BIGNUMERIC → STRING), so the build sums them with BigInt. */
export const DAILY_TRACE_SQL = `-- NEAR Parity daily on-chain buyback trace (BigQuery public NEAR dataset)
WITH ev AS (
  SELECT eo.block_date AS day,
         JSON_VALUE(SUBSTR(l.element, 12), '$.event') AS event, d
  FROM \`${DATASET}.execution_outcomes\` eo,
       UNNEST(eo.logs.list) AS l,
       UNNEST(JSON_QUERY_ARRAY(SUBSTR(l.element, 12), '$.data')) AS d
  WHERE eo.block_date >= @start AND eo.block_date < @end
    AND eo.executor_account_id = 'intents.near'
    AND eo.status NOT LIKE '%FAIL%'
    AND STARTS_WITH(l.element, 'EVENT_JSON:')
    AND (l.element LIKE '%"event":"token_diff"%' OR l.element LIKE '%"event":"native_withdraw"%')
),
wd AS (
  SELECT day, JSON_VALUE(d, '$.account_id') AS account, CAST(JSON_VALUE(d, '$.amount') AS BIGNUMERIC) AS yocto
  FROM ev WHERE event = 'native_withdraw' AND JSON_VALUE(d, '$.receiver_id') = @wallet
),
first_wd AS (SELECT account, MIN(day) AS first_day FROM wd GROUP BY account),
eligible AS (
  SELECT a AS account, DATE '1970-01-01' AS from_day FROM UNNEST(@known) AS a
  UNION ALL
  SELECT account, first_day FROM first_wd WHERE account NOT IN UNNEST(@known)
),
sw AS (
  SELECT day, JSON_VALUE(d, '$.account_id') AS account,
         CAST(JSON_VALUE(d, '$.diff."nep141:wrap.near"') AS BIGNUMERIC) AS yocto
  FROM ev WHERE event = 'token_diff'
),
d_w AS (SELECT day, COUNT(*) AS withdrawals, SUM(yocto) AS withdrawn FROM wd GROUP BY day),
d_s AS (
  SELECT s.day, COUNTIF(s.yocto > 0) AS swaps,
         SUM(IF(s.yocto > 0, s.yocto, 0)) AS bought, SUM(IF(s.yocto < 0, -s.yocto, 0)) AS sold
  FROM sw s JOIN eligible e ON s.account = e.account AND s.day >= e.from_day
  GROUP BY s.day
),
d_new AS (
  SELECT first_day AS day, ARRAY_AGG(account) AS new_accounts
  FROM first_wd WHERE account NOT IN UNNEST(@known) GROUP BY first_day
)
SELECT CAST(day AS STRING) AS day,
       IFNULL(withdrawals, 0) AS withdrawals, CAST(IFNULL(withdrawn, 0) AS STRING) AS withdrawn_yocto,
       IFNULL(swaps, 0) AS swaps, CAST(IFNULL(bought, 0) AS STRING) AS bought_yocto,
       CAST(IFNULL(sold, 0) AS STRING) AS sold_yocto, IFNULL(new_accounts, []) AS new_accounts
FROM d_w FULL JOIN d_s USING (day) FULL JOIN d_new USING (day)
ORDER BY day`;

const big = (v) => BigInt(String(v ?? '0').split('.')[0] || '0'); // BIGNUMERIC → STRING may carry a fractional part
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Which days to query: from the day after the last recorded one (or `from`), up to the last complete day in the
 *  dataset, at most `maxDays`. Returns { start, end } (end exclusive, YYYY-MM-DD) or null when nothing is new. */
export function daysToQuery({ lastDay, from, latestUnix, maxDays = 35 }) {
  const startMs = lastDay ? Date.parse(`${lastDay}T00:00:00Z`) + DAY_MS : Date.parse(`${from}T00:00:00Z`);
  const completeEndMs = Math.floor((latestUnix * 1000) / DAY_MS) * DAY_MS; // days before the latest block's day are complete
  const endMs = Math.min(completeEndMs, startMs + maxDays * DAY_MS);
  return endMs > startMs ? { start: isoDay(startMs), end: isoDay(endMs) } : null;
}

/** Merge query rows into the stored state; days in [start, end) with no row had no activity (recorded as zeros). */
export function mergeDaily(state, rows, { start, end }) {
  const out = { ...state, days: { ...(state.days || {}) }, accounts: { ...(state.accounts || {}) } };
  const by = new Map(rows.map((r) => [r.day, r]));
  for (let t = Date.parse(`${start}T00:00:00Z`); t < Date.parse(`${end}T00:00:00Z`); t += DAY_MS) {
    const day = isoDay(t); const r = by.get(day);
    out.days[day] = {
      withdrawals: Number(r?.withdrawals ?? 0), withdrawn_yocto: String(r?.withdrawn_yocto ?? '0'),
      swaps: Number(r?.swaps ?? 0), bought_yocto: String(r?.bought_yocto ?? '0'), sold_yocto: String(r?.sold_yocto ?? '0'),
    };
    for (const a of r?.new_accounts || []) if (a && !out.accounts[a]) out.accounts[a] = day;
  }
  out.last_day = isoDay(Date.parse(`${end}T00:00:00Z`) - DAY_MS);
  return out;
}

/** Sum the stored days over [start, end) (ISO timestamps). Null unless every day is present. */
export function sumDays(state, start, end) {
  const days = [];
  for (let t = Date.parse(start); t < Date.parse(end); t += DAY_MS) days.push(isoDay(t));
  if (!state?.days || days.some((d) => !state.days[d])) return null;
  const s = { withdrawals: 0, swaps: 0, withdrawn: 0n, bought: 0n, sold: 0n, days: days.length };
  for (const d of days) {
    const x = state.days[d];
    s.withdrawals += x.withdrawals; s.swaps += x.swaps;
    s.withdrawn += big(x.withdrawn_yocto); s.bought += big(x.bought_yocto); s.sold += big(x.sold_yocto);
  }
  return s;
}
