-- NEAR Parity · BigQuery check 4: what does the hub account do?
-- Check 3 found one NEAR Intents account (51e8f94d…) that sent 191,434 wNEAR in 500 transfers to the accounts
-- that withdraw to the buyback wallet. This lists every wNEAR flow of that account in the same 30-day window:
-- swaps (and what it paid with), transfers in (by source), transfers out, deposits and withdrawals.
WITH logs AS (
  SELECT SUBSTR(l.element, 12) AS j
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes` eo,
       UNNEST(eo.logs.list) AS l
  WHERE eo.block_date >= '2026-10-15' AND eo.block_date < '2026-11-14'
    AND eo.executor_account_id = 'intents.near'
    AND eo.status NOT LIKE '%FAIL%'
    AND STARTS_WITH(l.element, 'EVENT_JSON:')
    AND l.element LIKE '%51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe%'
),
ev AS (
  SELECT JSON_VALUE(j, '$.event') AS event, d
  FROM logs, UNNEST(JSON_QUERY_ARRAY(j, '$.data')) AS d
),
sw AS (
  SELECT CAST(JSON_VALUE(d, '$.diff."nep141:wrap.near"') AS BIGNUMERIC) / 1e24 AS near,
         REGEXP_EXTRACT(JSON_QUERY(d, '$.diff'), r'"([^"]+)"\s*:\s*"-') AS paid
  FROM ev
  WHERE event = 'token_diff'
    AND JSON_VALUE(d, '$.account_id') = '51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe'
),
mv AS (
  SELECT event, JSON_VALUE(d, '$.old_owner_id') AS src, JSON_VALUE(d, '$.new_owner_id') AS dst,
         JSON_VALUE(d, '$.owner_id') AS own,
         CAST(JSON_VALUE_ARRAY(d, '$.amounts')[OFFSET(i)] AS BIGNUMERIC) / 1e24 AS near
  FROM ev, UNNEST(JSON_VALUE_ARRAY(d, '$.token_ids')) AS tok WITH OFFSET i
  WHERE event IN ('mt_transfer', 'mt_mint', 'mt_burn') AND tok = 'nep141:wrap.near'
)
SELECT flow, COUNT(*) AS n, SUM(near) AS near FROM (
  SELECT CONCAT('swap: bought NEAR, paid with ', IFNULL(paid, '?')) AS flow, near FROM sw WHERE near > 0
  UNION ALL SELECT 'swap: sold NEAR', -near FROM sw WHERE near < 0
  UNION ALL SELECT CONCAT('received from ', src), near FROM mv
    WHERE event = 'mt_transfer' AND dst = '51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe'
  UNION ALL SELECT 'sent to other accounts', near FROM mv
    WHERE event = 'mt_transfer' AND src = '51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe'
  UNION ALL SELECT 'deposited from outside (mint)', near FROM mv
    WHERE event = 'mt_mint' AND own = '51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe'
  UNION ALL SELECT 'withdrawn (burn)', near FROM mv
    WHERE event = 'mt_burn' AND own = '51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe'
)
GROUP BY flow
ORDER BY near DESC
LIMIT 20
