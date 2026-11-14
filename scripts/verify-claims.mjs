#!/usr/bin/env node
// Verifies the primary sources cited in THESIS.md §6 and saves dated evidence. Node 22 built-ins only; no keys.
//
// Each check fetches a source and requires specific text to be present. A check passes only if the request
// succeeds AND every required term is found. Checks marked `required` back a claim in THESIS.md: if any of them
// fails, the script exits 1, so the claim must be re-examined before publication. Optional checks are context.
// Evidence (status, SHA-256 of the response body, the passages around each term) is written to
// docs/verification/<UTC date>.json.
// Usage: node scripts/verify-claims.mjs   (behind a proxy: node --use-env-proxy …)
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const CHECKS = [
  { id: 'gov-41140', claim: 'The governance proposal to cut maximum inflation to 2.5% (THESIS §6)', required: true,
    url: 'https://gov.near.org/t/reduce-inflation-for-near-protocol/41140.json', must: ['2.5%'] },
  { id: 'gov-42644-hsp029', claim: 'HSP-029 proposes an issuance ramp to a 1.6% target rate (THESIS §3, §6)', required: true,
    url: 'https://gov.near.org/t/42644.json?print=true', must: ['1.6'] },
  { id: 'revenue-dashboard', claim: 'NEAR’s revenue dashboard lists the buyback wallet (THESIS §2.5)', required: true,
    url: 'https://revenue.near.org/', must: ['buybacks.multisignature.near'] },
  { id: 'nearone-2.9.0', claim: 'Context: nearcore release notes on the inflation change', required: false,
    url: 'https://blog.nearone.org/announcement/2025/10/21/enhancing-near-tokenomics.html', must: ['inflation'] },
  { id: 'intents-fees-docs', claim: 'Context: NEAR Intents fee documentation', required: false,
    url: 'https://docs.near-intents.org/near-intents/fees', must: ['fee'] },
];

const strip = (s) => s.replace(/<script[\s\S]*?<\/script>/g, (m) => (m.includes('self.__next_f') ? m : ' ')).replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

const results = [];
for (const c of CHECKS) {
  const r = { id: c.id, claim: c.claim, url: c.url, required: c.required, ok: false, http_status: null, body_sha256: null, found: {}, error: null };
  try {
    const res = await fetch(c.url, { headers: { 'user-agent': 'near-parity-verify', accept: 'text/html,application/json' }, signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    r.http_status = res.status; r.body_sha256 = createHash('sha256').update(body).digest('hex');
    let text = body;
    if (body.startsWith('{')) {
      try {
        const j = JSON.parse(body);
        const posts = j.post_stream?.posts?.map((p) => `[post ${p.post_number} ${p.created_at}] ${p.cooked}`) || [];
        text = [j.title ? `TITLE: ${j.title}` : '', ...posts].join('\n') || body;
      } catch { /* not JSON after all */ }
    }
    const plain = strip(text);
    for (const term of c.must) {
      const i = plain.indexOf(term);
      r.found[term] = i > -1 ? plain.slice(Math.max(0, i - 200), i + 200) : null;
    }
    r.ok = res.ok && c.must.every((t) => r.found[t] != null);
    if (!res.ok) r.error = `HTTP ${res.status}`;
    else if (!r.ok) r.error = `required text not found: ${c.must.filter((t) => r.found[t] == null).join(', ')}`;
  } catch (e) {
    r.error = e.message;
  }
  results.push(r);
  console.log(`${r.ok ? 'PASS' : r.required ? 'FAIL' : 'warn'}  ${c.id}  ${r.error ?? ''}`);
}

const date = new Date().toISOString().slice(0, 10);
await mkdir(new URL('../docs/verification/', import.meta.url), { recursive: true });
const out = { checked_at: new Date().toISOString(), passed: results.filter((r) => r.ok).length, failed_required: results.filter((r) => r.required && !r.ok).map((r) => r.id), results };
await writeFile(new URL(`../docs/verification/${date}.json`, import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nEvidence saved to docs/verification/${date}.json`);
if (out.failed_required.length) {
  console.log(`${out.failed_required.length} required check(s) failed: ${out.failed_required.join(', ')}. Re-examine these claims before publishing.`);
  process.exitCode = 1;
}
