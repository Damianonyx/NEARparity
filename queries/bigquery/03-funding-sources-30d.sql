-- NEAR Parity · BigQuery check 3: where did the rest of the withdrawn NEAR come from?
-- For the same accounts and window as check 2, sums the wNEAR credited to them inside NEAR Intents by
-- nep245 mt_transfer (from another Intents account) and mt_mint (a deposit from outside), by source.
WITH logs AS (
  SELECT SUBSTR(l.element, 12) AS j
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes` eo,
       UNNEST(eo.logs.list) AS l
  WHERE eo.block_date >= '2026-10-15' AND eo.block_date < '2026-11-14'
    AND eo.executor_account_id = 'intents.near'
    AND eo.status NOT LIKE '%FAIL%'
    AND STARTS_WITH(l.element, 'EVENT_JSON:')
    AND (l.element LIKE '%"event":"native_withdraw"%'
         OR (l.element LIKE '%wrap.near%'
             AND (l.element LIKE '%"event":"mt_transfer"%' OR l.element LIKE '%"event":"mt_mint"%')))
),
ev AS (
  SELECT JSON_VALUE(j, '$.event') AS event, d
  FROM logs, UNNEST(JSON_QUERY_ARRAY(j, '$.data')) AS d
),
accts AS (
  SELECT DISTINCT JSON_VALUE(d, '$.account_id') AS account
  FROM ev
  WHERE event = 'native_withdraw'
    AND JSON_VALUE(d, '$.receiver_id') = 'buybacks.multisignature.near'
),
credits AS (
  SELECT event,
         COALESCE(JSON_VALUE(d, '$.new_owner_id'), JSON_VALUE(d, '$.owner_id')) AS to_acct,
         COALESCE(JSON_VALUE(d, '$.old_owner_id'), 'deposit') AS from_acct,
         CAST(JSON_VALUE_ARRAY(d, '$.amounts')[OFFSET(i)] AS BIGNUMERIC) / 1e24 AS near
  FROM ev, UNNEST(JSON_VALUE_ARRAY(d, '$.token_ids')) AS tok WITH OFFSET i
  WHERE event IN ('mt_transfer', 'mt_mint') AND tok = 'nep141:wrap.near'
)
SELECT event, from_acct, COUNT(*) AS n, SUM(near) AS near
FROM credits JOIN accts ON to_acct = account
GROUP BY event, from_acct
ORDER BY near DESC
LIMIT 15
