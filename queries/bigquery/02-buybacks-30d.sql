-- NEAR Parity · BigQuery check 2: what did the accounts that fund the buyback wallet buy?
-- Window: the dashboard's 30-day UTC window, 2026-10-15 (inclusive) to 2026-11-14 (exclusive).
-- 1. Finds every dip4 native_withdraw intent to buybacks.multisignature.near (the wallet's NEAR inflows).
-- 2. Takes the accounts that signed them and sums their dip4 token_diff (swap) events in the same window:
--    wNEAR gained = NEAR bought, wNEAR lost = NEAR sold, the token they gave up = what they paid with.
-- Amounts are yocto (10^-24) strings, so they are cast to BIGNUMERIC, never FLOAT.
WITH ev AS (
  SELECT eo.block_timestamp_utc AS ts,
         JSON_VALUE(SUBSTR(l.element, 12), '$.event') AS event,
         JSON_QUERY_ARRAY(SUBSTR(l.element, 12), '$.data') AS data
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes` eo,
       UNNEST(eo.logs.list) AS l
  WHERE eo.block_date >= '2026-10-15' AND eo.block_date < '2026-11-14'
    AND eo.executor_account_id = 'intents.near'
    AND eo.status NOT LIKE '%FAIL%'
    AND STARTS_WITH(l.element, 'EVENT_JSON:')
    AND (l.element LIKE '%"event":"token_diff"%' OR l.element LIKE '%"event":"native_withdraw"%')
),
wd AS (
  SELECT ts, JSON_VALUE(d, '$.account_id') AS account,
         CAST(JSON_VALUE(d, '$.amount') AS BIGNUMERIC) / 1e24 AS near
  FROM ev, UNNEST(data) AS d
  WHERE event = 'native_withdraw'
    AND JSON_VALUE(d, '$.receiver_id') = 'buybacks.multisignature.near'
),
accts AS (SELECT DISTINCT account FROM wd),
sw AS (
  SELECT ev.ts, JSON_VALUE(d, '$.account_id') AS account,
         CAST(JSON_VALUE(d, '$.diff."nep141:wrap.near"') AS BIGNUMERIC) / 1e24 AS n,
         REGEXP_EXTRACT(JSON_QUERY(d, '$.diff'), r'"([^"]+)"\s*:\s*"-') AS paid
  FROM ev, UNNEST(data) AS d
  WHERE event = 'token_diff'
),
m_w AS (
  SELECT FORMAT_TIMESTAMP('%Y-%m', ts) AS month, COUNT(*) AS withdrawals,
         COUNT(DISTINCT account) AS withdraw_accounts, SUM(near) AS near_withdrawn
  FROM wd GROUP BY month
),
m_b AS (
  SELECT FORMAT_TIMESTAMP('%Y-%m', ts) AS month,
         COUNTIF(n > 0) AS buys, SUM(IF(n > 0, n, 0)) AS near_bought,
         SUM(IF(n < 0, -n, 0)) AS near_sold,
         STRING_AGG(DISTINCT IF(n > 0, paid, NULL), ', ' LIMIT 6) AS paid_with
  FROM sw JOIN accts USING (account) GROUP BY month
)
SELECT * FROM m_w FULL JOIN m_b USING (month) ORDER BY month
