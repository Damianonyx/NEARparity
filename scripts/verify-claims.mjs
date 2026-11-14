#!/usr/bin/env node
// Fetches the primary sources cited in THESIS.md and prints the passages around key terms,
// so every governance/security claim can be re-checked. Node 22 built-ins only; no keys.
// Usage: node scripts/verify-claims.mjs   (behind a proxy: node --use-env-proxy …)
const SOURCES = [
  { id: 'nearone-2.9.0', url: 'https://blog.nearone.org/announcement/2025/10/21/enhancing-near-tokenomics.html', terms: ['2.5%', 'inflation', 'vote', '80%', 'validators', 'activat'] },
  { id: 'gov-41140', url: 'https://gov.near.org/t/reduce-inflation-for-near-protocol/41140.json', terms: ['2.5%', '2/3', '66', 'vote', 'result', 'threshold'] },
  { id: 'linear-vote', url: 'https://vote.linearprotocol.org/', terms: ['%', 'yes', 'Yes', 'result', 'threshold'] },
  { id: 'gov-search-hsp029', url: 'https://gov.near.org/search.json?q=HSP-029', terms: ['HSP-029', '1.6', 'issuance'] },
  { id: 'hos-search', url: 'https://houseofstake.org/', terms: ['HSP', 'issuance', 'proposal'] },
  { id: 'revenue-dashboard', url: 'https://revenue.near.org/', terms: ['Emissions', 'B2B', 'Partners', 'capture rate', 'buyback', 'Buyback', 'deflation'] },
  { id: 'intents-fees-docs', url: 'https://docs.near-intents.org/near-intents/fees', terms: ['revenue share', '50/50', 'bps', 'partner', 'fee'] },
  { id: 'llama-hacks', url: 'https://api.llama.fi/hacks', terms: ['"NEAR Intents"'] },
];
const strip = (s) => s.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
for (const src of SOURCES) {
  console.log(`\n==== ${src.id}: ${src.url}`);
  try {
    const res = await fetch(src.url, { headers: { 'user-agent': 'near-parity-verify', accept: 'text/html,application/json' }, signal: AbortSignal.timeout(30000) });
    let text = await res.text();
    console.log(`HTTP ${res.status}, ${text.length} chars`);
    if (src.url.endsWith('.json') && text.startsWith('{')) {
      const j = JSON.parse(text);
      const posts = j.post_stream?.posts?.map((p) => `[post ${p.post_number} by ${p.username} ${p.created_at}] ${p.cooked}`) || [];
      const topics = j.topics?.map((t) => `[topic ${t.id} ${t.slug} ${t.created_at}] ${t.title}`) || [];
      const results = j.posts?.map((p) => `[search post topic ${p.topic_id} ${p.created_at}] ${p.blurb}`) || [];
      text = [j.title ? `TITLE: ${j.title}` : '', ...topics, ...results, ...posts].join('\n') || text;
    }
    const plain = strip(text);
    if (src.id === 'llama-hacks') {
      const hit = JSON.parse(text).filter((h) => h.name === 'NEAR Intents');
      console.log(JSON.stringify(hit, null, 1));
      continue;
    }
    let shown = 0;
    for (const term of src.terms) {
      let i = plain.indexOf(term); let n = 0;
      while (i > -1 && n < 3 && shown < 18) {
        console.log(`  …${plain.slice(Math.max(0, i - 240), i + 260)}…`);
        i = plain.indexOf(term, i + 260); n++; shown++;
      }
    }
    if (!shown) console.log(`  (no key terms found) start: ${plain.slice(0, 600)}`);
  } catch (e) {
    console.log(`  FAILED: ${e.message}`);
  }
}
