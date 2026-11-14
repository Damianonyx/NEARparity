-- NEAR Parity · BigQuery check 1: is the public NEAR dataset current?
-- Dataset: bigquery-public-data.crypto_near_mainnet_us (free BigQuery sandbox is enough).
-- Result on 14 Nov 2026: latest_day = 2026-11-14, blocks_since_march = 36,934,440 (282 MB processed).
SELECT MAX(block_date) AS latest_day, COUNT(*) AS blocks_since_march
FROM `bigquery-public-data.crypto_near_mainnet_us.blocks`
WHERE block_date >= '2026-03-01'
