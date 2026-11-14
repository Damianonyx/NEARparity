// Phase 0 only: read-only access probes, not a tokenomics dataset.
// Node 22.21+ supports --use-env-proxy; no packages or API keys are needed.
import { appendFile, readFile, writeFile } from 'node:fs/promises';

const wallet = JSON.parse(await readFile(new URL('../config/buyback-wallet.json', import.meta.url), 'utf8'));
const startedAt = new Date().toISOString();
const day = 86_400_000;
const periodEnd = new Date(startedAt);
periodEnd.setUTCHours(0, 0, 0, 0);
const periodStart = new Date(periodEnd.getTime() - 30 * day);
const startSeconds = periodStart.getTime() / 1000;
const results = [];
const timeoutMs = 25_000;

const requireShape = (condition, message) => {
  if (!condition) throw new Error(message);
};
const isUnsignedInteger = (value) => typeof value === 'string' && /^\d+$/.test(value);
const blockShape = (body) => {
  const header = body.result?.header;
  requireShape(header && Number.isSafeInteger(header.height)
    && typeof header.hash === 'string' && typeof header.prev_hash === 'string'
    && isUnsignedInteger(header.total_supply) && isUnsignedInteger(header.timestamp_nanosec),
  'Missing block header, supply string, or timestamp string');
};
const validatorsShape = (body) => {
  requireShape(Number.isSafeInteger(body.result?.epoch_start_height), 'Missing epoch_start_height');
};
const protocolShape = (body) => {
  requireShape(body.result?.max_inflation_rate != null, 'Missing max_inflation_rate');
};
const accountShape = (body) => {
  requireShape(isUnsignedInteger(body.result?.amount), 'Missing native balance string');
};
const tokenBalanceShape = (body) => {
  requireShape(Array.isArray(body.result?.result), 'Missing contract return bytes');
  const value = JSON.parse(Buffer.from(body.result.result).toString('utf8'));
  requireShape(isUnsignedInteger(value), 'Contract did not return an unsigned integer string');
  // Validate exact yoctoNEAR representation without conversion to Number.
  BigInt(value);
};
const seriesShape = (body) => {
  requireShape(Array.isArray(body.totalDataChart) && body.totalDataChart.length > 0,
    'No nonempty totalDataChart returned');
};

function printResult(result) {
  console.log(`\n${result.name}\n${result.method} ${result.url}`);
  if (result.request) console.log(`Request: ${JSON.stringify(result.request)}`);
  console.log(`HTTP status: ${result.http_status ?? 'unavailable (no HTTP response)'}`);
  console.log(`First 300 response characters: ${JSON.stringify(result.response_preview)}`);
  console.log(`Result: ${result.status}${result.error ? ` — ${result.error}` : ''}`);
}

async function probe(name, url, { request, validate } = {}) {
  const result = {
    name, url, method: request ? 'POST' : 'GET', request: request ?? null,
    fetched_at: new Date().toISOString(), http_status: null,
    status: 'failed', error: null, response_preview: null,
  };
  let body = null;
  try {
    const response = await fetch(url, {
      method: result.method,
      headers: {
        accept: 'application/json',
        ...(request ? { 'content-type': 'application/json' } : {}),
      },
      ...(request ? { body: JSON.stringify(request) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    result.http_status = response.status;
    const raw = await response.text();
    result.response_preview = raw.slice(0, 300);
    requireShape(response.ok, `HTTP ${response.status} ${response.statusText}`);
    body = JSON.parse(raw);
    requireShape(body && typeof body === 'object', 'Response is not a JSON object');
    requireShape(!body.error, `API error: ${JSON.stringify(body.error)}`);
    if (request) requireShape(Object.hasOwn(body, 'result'), 'JSON-RPC result missing');
    validate?.(body);
    result.status = 'ok';
  } catch (error) {
    result.error = [error.message, error.cause?.message].filter(Boolean).join(': ');
  }
  results.push(result);
  printResult(result);
  return result.status === 'ok' ? body : null;
}

function skip(name, url, reason) {
  const result = {
    name, url, method: 'POST', request: null, fetched_at: new Date().toISOString(),
    http_status: null, status: 'skipped', error: reason, response_preview: null,
  };
  results.push(result);
  printResult(result);
}

function rpc(name, url, method, params, validate) {
  return probe(name, url, {
    request: { jsonrpc: '2.0', id: 'near-parity-access-check', method, params }, validate,
  });
}

async function balances(prefix, url, blockReference) {
  await rpc(`${prefix}: query view_account (${wallet.label})`, url, 'query', {
    request_type: 'view_account', account_id: wallet.account_id, ...blockReference,
  }, accountShape);
  for (const [accountId, methodName, args] of [
    ['wrap.near', 'ft_balance_of', { account_id: wallet.account_id }],
    ['intents.near', 'mt_balance_of', { account_id: wallet.account_id, token_id: 'nep141:wrap.near' }],
  ]) {
    await rpc(`${prefix}: query ${accountId}.${methodName} (${wallet.label})`, url, 'query', {
      request_type: 'call_function', account_id: accountId, method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), ...blockReference,
    }, tokenBalanceShape);
  }
}

async function probeRpc(prefix, url, archival = false) {
  await rpc(`${prefix}: block (final)`, url, 'block', { finality: 'final' }, blockShape);
  const validators = await rpc(`${prefix}: validators (current epoch)`, url, 'validators', [null], validatorsShape);
  await rpc(`${prefix}: EXPERIMENTAL_protocol_config (final)`, url,
    'EXPERIMENTAL_protocol_config', { finality: 'final' }, protocolShape);
  await balances(`${prefix} final`, url, { finality: 'final' });
  if (!archival) return;

  // A real boundary/prev_hash traversal tests the proposed issuance access path.
  // This is a recent historical sample, not a backfill or proof of archive depth.
  const boundaryName = `${prefix}: block (epoch_start_height)`;
  const boundary = validators
    ? await rpc(boundaryName, url, 'block', { block_id: validators.result.epoch_start_height }, blockShape)
    : null;
  if (!validators) skip(boundaryName, url, 'Current validators lookup failed; epoch_start_height is unavailable');
  const historicalNames = [
    `${prefix}: block (boundary prev_hash)`,
    `${prefix}: validators (previous epoch via prev_hash)`,
    `${prefix}: EXPERIMENTAL_protocol_config (boundary prev_hash)`,
    `${prefix} historical: query view_account (${wallet.label})`,
    `${prefix} historical: query wrap.near.ft_balance_of (${wallet.label})`,
    `${prefix} historical: query intents.near.mt_balance_of (${wallet.label})`,
  ];
  if (!boundary) {
    for (const name of historicalNames) skip(name, url, 'Epoch boundary block unavailable; no prev_hash to query');
    return;
  }
  const blockReference = { block_id: boundary.result.header.prev_hash };
  await rpc(historicalNames[0], url, 'block', blockReference, blockShape);
  await rpc(historicalNames[1], url, 'validators', [blockReference.block_id], validatorsShape);
  await rpc(historicalNames[2], url, 'EXPERIMENTAL_protocol_config', blockReference, protocolShape);
  await balances(`${prefix} historical`, url, blockReference);
}

// Backfill depth: the issuance method needs archival blocks and validators back to 2026-02-01.
// The height is estimated from the current block rate; this is an access probe, not a lookup.
async function probeArchiveDepth(url) {
  const name = 'FastNEAR archival: header walk near 2026-02-01 (backfill depth)';
  const final = await rpc('FastNEAR archival: block (final, for depth estimate)', url, 'block', { finality: 'final' }, blockShape);
  if (!final) return skip(name, url, 'Final block unavailable; cannot estimate a 2026-02-01 height');
  const nowS = Number(BigInt(final.result.header.timestamp_nanosec) / 1_000_000_000n);
  const target = final.result.header.height - Math.round((nowS - Date.UTC(2026, 1, 1) / 1000) / 0.6);
  const old = await rpc(`${name}: block ~${target}`, url, 'block', { block_id: target }, blockShape);
  if (!old) return skip(`${name}: epoch walk`, url, 'Old block unavailable');
  console.log(`Old block timestamp: ${new Date(Number(BigInt(old.result.header.timestamp_nanosec) / 1_000_000n)).toISOString()}`);
  // `validators` returns UNKNOWN_EPOCH for epochs this old, so the data build walks block headers:
  // next_epoch_id of a block is the hash of the previous epoch's last block.
  await rpc(`${name}: block(next_epoch_id) = previous epoch's last block`, url, 'block', { block_id: old.result.header.next_epoch_id }, blockShape);
  await rpc(`${name}: EXPERIMENTAL_protocol_config at that block`, url, 'EXPERIMENTAL_protocol_config', { block_id: old.result.header.hash }, protocolShape);
}

// Official-source check for the candidate buyback wallet. revenue.near.org is NEAR's revenue
// dashboard. This probe only reports whether the page or its same-origin scripts mention the
// account; a human must still read the context before the wallet is labelled confirmed.
async function probeOfficialWalletSource() {
  const base = 'https://revenue.near.org/';
  const name = `Official source: ${base} mentions ${wallet.account_id}`;
  const result = { name, url: base, method: 'GET', request: null, fetched_at: new Date().toISOString(),
    http_status: null, status: 'failed', error: null, response_preview: null, mentions: [] };
  try {
    const page = await fetch(base, { signal: AbortSignal.timeout(timeoutMs) });
    result.http_status = page.status;
    const html = await page.text();
    result.response_preview = html.slice(0, 300);
    requireShape(page.ok, `HTTP ${page.status}`);
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|json)[^"]*)"/g)].map((m) => new URL(m[1], base).href)
      .filter((u) => u.startsWith(base)).slice(0, 30);
    const texts = [[base, html]];
    for (const asset of assets) {
      try { const r = await fetch(asset, { signal: AbortSignal.timeout(timeoutMs) }); if (r.ok) texts.push([asset, await r.text()]); } catch {}
    }
    for (const [source, text] of texts) {
      let i = text.indexOf(wallet.account_id);
      while (i > -1 && result.mentions.length < 8) {
        result.mentions.push({ source, context: text.slice(Math.max(0, i - 200), i + 200) });
        i = text.indexOf(wallet.account_id, i + 1);
      }
    }
    // Visible text around the first mention in the page (tags stripped), to read headings and labels.
    const first = html.indexOf(wallet.account_id);
    if (first > -1) {
      result.page_text_context = html.slice(Math.max(0, first - 6000), first + 1500)
        .replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(-2500);
      console.log(`Visible text before/around the first mention:\n  ${result.page_text_context}`);
    }
    const headings = [...html.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
    console.log(`Page headings: ${JSON.stringify(headings)}`);
    console.log(`Searched ${texts.length} documents (page + same-origin scripts).`);
    for (const m of result.mentions) console.log(`Mention in ${m.source}:\n  ${JSON.stringify(m.context)}`);
    requireShape(result.mentions.length > 0, 'Account not found in page or same-origin scripts (may be loaded from another API)');
    result.status = 'ok';
  } catch (error) {
    result.error = [error.message, error.cause?.message].filter(Boolean).join(': ');
  }
  results.push(result);
  printResult(result);
}

async function probeLlama() {
  await probe('DefiLlama: Intents swap volume', 'https://api.llama.fi/summary/dexs/near-intents', { validate: seriesShape });
  for (const dataType of ['dailyFees', 'dailyRevenue', 'dailyHoldersRevenue']) {
    await probe(`DefiLlama: ${dataType}${dataType === 'dailyHoldersRevenue' ? ' (proxy only)' : ''}`,
      `https://api.llama.fi/summary/fees/near-intents?dataType=${dataType}`, { validate: seriesShape });
  }
}

async function probePrices() {
  await probe('DefiLlama: daily NEAR price chart',
    `https://coins.llama.fi/chart/coingecko:near?start=${startSeconds}&span=30&period=1d&searchWidth=600`, {
      validate: (body) => {
        const prices = body.coins?.['coingecko:near']?.prices;
        requireShape(Array.isArray(prices) && prices.length > 0, 'No daily price samples returned');
      },
    });
  await probe('DefiLlama: current NEAR price', 'https://coins.llama.fi/prices/current/coingecko:near', {
    validate: (body) => requireShape(Number.isFinite(body.coins?.['coingecko:near']?.price), 'Missing numeric price'),
  });
}

async function probeNearBlocks() {
  for (const path of ['txns', 'ft-txns']) {
    await probe(`NearBlocks: ${path} (${wallet.label}; first page only)`,
      `https://api.nearblocks.io/v1/account/${wallet.account_id}/${path}?page=1&per_page=1`, {
        validate: (body) => requireShape(Array.isArray(body.txns), 'Missing txns array'),
      });
  }
}

console.log(`NEAR Parity Phase 0 access check — ${startedAt}\nRuntime: ${process.version}`);
console.log(`Price-chart request window: ${periodStart.toISOString()} to ${periodEnd.toISOString()} (UTC)`);
console.log('Candidate wallet: unconfirmed wallet. Successful access is not verification of purchases or burns.');

// Independent hosts run concurrently; requests to each host run sequentially.
const groups = await Promise.allSettled([
  probeRpc('FastNEAR mainnet', 'https://rpc.mainnet.fastnear.com'),
  probeRpc('FastNEAR archival', 'https://archival-rpc.mainnet.fastnear.com', true),
  probeLlama(),
  probePrices(),
  probe('CoinGecko: daily NEAR price fallback',
    'https://api.coingecko.com/api/v3/coins/near/market_chart?vs_currency=usd&days=30&interval=daily', {
      validate: (body) => requireShape(Array.isArray(body.prices) && body.prices.length > 0, 'Missing price series'),
    }),
  probeNearBlocks(),
  probeArchiveDepth('https://archival-rpc.mainnet.fastnear.com'),
  probeOfficialWalletSource(),
]);
const unexpectedErrors = groups.filter((group) => group.status === 'rejected').map((group) => String(group.reason));
const report = {
  started_at: startedAt, completed_at: new Date().toISOString(), node_version: process.version,
  requested_price_window: { period_start: periodStart.toISOString(), period_end: periodEnd.toISOString() },
  wallet, results, unexpected_errors: unexpectedErrors,
};
if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);

const cell = (value) => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
const summary = [
  '## NEAR Parity — Phase 0 API access', '',
  `Checked ${startedAt} with ${process.version}. No API keys.`, '',
  '| Probe | HTTP | Result | Error / limitation |',
  '| --- | --- | --- | --- |',
  ...results.map((result) => `| ${cell(result.name)} | ${cell(result.http_status)} | ${cell(result.status)} | ${cell(result.error)} |`),
  '', 'The logs and JSON artifact include each URL, request body, HTTP status, and first 300 response characters.',
  'HTTP 200 with an API error or missing expected fields is a failed probe.',
  'Archive probes cover a recent epoch boundary and one block near 2026-02-01; full series completeness is checked by the data build.',
  'The revenue.near.org probe only reports mentions of the wallet; a person must read the context before labelling it confirmed.',
  'The wallet is unconfirmed; balances are not verified purchases. DefiLlama holders revenue is a proxy only.',
  ...unexpectedErrors.map((error) => `Unexpected runner error: ${cell(error)}`), '',
].join('\n');
console.log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
if (results.some((result) => result.status !== 'ok') || unexpectedErrors.length) process.exitCode = 1;
