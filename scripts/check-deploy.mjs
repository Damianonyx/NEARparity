#!/usr/bin/env node
// Deployment check: does the live site serve the same dataset and app code as this checkout?
// Compares SHA-256 hashes of data/latest.json, app.js and index.html with the deployed copies.
// Usage: node scripts/check-deploy.mjs [https://nearparity.vercel.app]   (exit 1 on any mismatch)
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = (process.argv[2] || 'https://nearparity.vercel.app').replace(/\/$/, '');
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
let bad = 0;
for (const path of ['data/latest.json', 'app.js', 'index.html']) {
  const local = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const res = await fetch(`${base}/${path}?t=${Date.now()}`, { signal: AbortSignal.timeout(30_000) });
  const live = await res.text();
  const ok = res.ok && sha(local) === sha(live);
  if (!ok) bad++;
  console.log(`${ok ? 'match   ' : 'MISMATCH'} ${path}  local ${sha(local)}  live ${res.ok ? sha(live) : `HTTP ${res.status}`}`);
  if (path === 'data/latest.json' && res.ok) {
    try { console.log(`         generated_at local ${JSON.parse(local).generated_at}  live ${JSON.parse(live).generated_at}`); } catch { /* not JSON */ }
  }
}
process.exitCode = bad ? 1 : 0;
