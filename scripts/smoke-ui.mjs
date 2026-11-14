#!/usr/bin/env node
import { readFileSync } from 'node:fs';
// UI smoke test with no dependencies: serves the site, renders it in headless Chrome (--dump-dom),
// and checks the rendered DOM. Runs twice: with the real data, and with deliberately degraded data
// (missing metrics and series) to prove that sections fail independently instead of blanking the page.
// Usage: node scripts/smoke-ui.mjs   (set CHROME_BIN to override the browser path)
import { execFile, spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CANDIDATES = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium/chrome-linux64/chrome'].filter(Boolean);
const CHROME = CANDIDATES.find((p) => existsSync(p));
if (!CHROME) { console.error('No Chrome/Chromium found; set CHROME_BIN.'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function dumpDom(url) {
  return new Promise((resolve, reject) => {
    execFile(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=15000', '--window-size=390,844', '--dump-dom', url],
      { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)));
  });
}
async function serve(dir, port) {
  const child = spawn(process.execPath, [join(dir, 'scripts/serve.mjs'), String(port)], { stdio: 'ignore' });
  await sleep(600);
  return child;
}
const count = (html, re) => (html.match(re) || []).length;

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

async function run(label, dir, port, expectations) {
  const child = await serve(dir, port);
  try {
    const html = await dumpDom(`http://127.0.0.1:${port}/`);
    console.log(`\n# ${label}`);
    expectations(html);
  } finally { child.kill(); }
}

// 1) Real data.
await run('real data', ROOT, 8731, (html) => {
  check('page finished booting', html.includes('data-ready="1"'));
  check('no global load error', !html.includes('class="error"'));
  check('five cards rendered', count(html, /<article class="card"/g) === 5, `${count(html, /<article class="card"/g)} cards`);
  check('on-chain trace card shown', html.includes('On-chain buyback trace') && html.includes('lower bound'));
  check('headline coverage rendered', /class="big">[^<]*%/.test(html));
  check('chart SVG rendered', /<div class="chart" id="chart"[^>]*>\s*<svg/.test(html));
  check('hero simulation running', /id="hero-canvas"/.test(html) && /id="ro-cov">[0-9.]+%</.test(html) && /id="ro-need">Parity needs/.test(html));
  check('simulator result rendered', /id="sim-out"[\s\S]{0,400}(per day|No finite volume)/.test(html));
  check('no section errors', !html.includes('class="section-error"'));
  { const n = count(html, /<div class="tile">/g); const L = JSON.parse(readFileSync(new URL('../data/latest.json', import.meta.url), 'utf8')); const want = L.metrics?.usage_function_calls?.value != null ? 5 : 4; check('usage tiles rendered', n === want, `${n} tiles, expected ${want}`); }
  check('leading-indicator test shown when computed', !JSON.parse(readFileSync(new URL('../data/latest.json', import.meta.url), 'utf8')).meta?.leading_indicator || html.includes('Does Intents volume lead usage better than price?'));
  check('usage chart rendered', /id="usage-chart"[^>]*>\s*<svg/.test(html));
  check('chart takeaways rendered', /id="chart-takeaway">[^<]{20,}/.test(html) && /id="usage-takeaway">[^<]{20,}/.test(html));
  check('a query behind every section', count(html, /<details class="query">/g) >= 7, `${count(html, /<details class="query">/g)} query blocks`);
});

// 2) Degraded data: remove metrics and the weekly series; the page must still render the rest.
const tmp = await mkdtemp(join(tmpdir(), 'near-parity-smoke-'));
try {
  for (const f of ['index.html', 'app.js', 'style.css', 'scripts', 'data/status.json']) await cp(join(ROOT, f), join(tmp, f), { recursive: true });
  const latest = JSON.parse(await readFile(join(ROOT, 'data/latest.json'), 'utf8'));
  delete latest.metrics.issuance; delete latest.metrics.coverage_proxy; latest.series_weekly = null; latest.wallet = null;
  latest.last_successful_refresh = '2020-01-01T00:00:00.000Z';
  await writeFile(join(tmp, 'data/latest.json'), JSON.stringify(latest));
  await run('degraded data', tmp, 8732, (html) => {
    check('page still boots', html.includes('data-ready="1"'));
    check('still five cards', count(html, /<article class="card"/g) === 5);
    check('missing figures shown as Unavailable', html.includes('Unavailable'));
    check('staleness banner shown', /id="banner"(?![^>]*hidden)[^>]*>[\s\S]{0,200}Data may be stale/.test(html));
    check('data-check warning shown', html.includes('Data check:'));
  });
} finally { await rm(tmp, { recursive: true, force: true }); }

console.log(`\n${failures ? `${failures} check(s) failed` : 'all UI checks passed'}`);
process.exitCode = failures ? 1 : 0;
