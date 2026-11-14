// File and HTTP helpers shared by the data build. Node 22 built-ins only.
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';

/** JSON read/write relative to a root URL (the repository root). */
export function createStore(root) {
  const url = (rel) => new URL(rel, root);
  return {
    url,
    async readJson(rel, fallback) {
      try { return JSON.parse(await readFile(url(rel), 'utf8')); } catch { return fallback; }
    },
    async writeJson(rel, obj) {
      const u = url(rel);
      await mkdir(new URL('./', u), { recursive: true });
      await writeFile(u, `${JSON.stringify(obj, null, 2)}\n`);
    },
    async list(rel) {
      try { return await readdir(url(rel)); } catch { return []; }
    },
    async remove(rel) { await unlink(url(rel)); },
  };
}

/** Per-source status tracker. ok/error describe the latest call; failures counts every failed attempt. */
export function createStatus() {
  const status = {};
  function set(key, { ok, http_status = null, error = null, url = null }) {
    const s = status[key] || { calls: 0, failures: 0 };
    s.calls++;
    if (!ok) s.failures++;
    Object.assign(s, { url: url ?? s.url ?? null, http_status, fetched_at: new Date().toISOString(), ok, error: ok ? null : error });
    status[key] = s;
  }
  return { status, set };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Set NEAR_PARITY_FAST=1 (tests) to skip politeness delays; retries and backoff still apply. */
export const politeDelay = (ms) => (process.env.NEAR_PARITY_FAST ? Promise.resolve() : sleep(ms));

/** GET JSON with retries, recording the outcome under `key`. Throws the last error (with .http). */
export async function getJson(statusSet, key, url, { timeoutMs = 30_000, retries = 2, headers = {} } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await politeDelay(1500 * attempt);
    let http = null;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'near-parity-data-build', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      http = res.status;
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { http });
      const body = await res.json();
      statusSet(key, { ok: true, http_status: http, url });
      return body;
    } catch (e) { last = Object.assign(e, { http: e.http ?? http }); }
  }
  statusSet(key, { ok: false, http_status: last.http ?? null, error: last.message, url });
  throw last;
}

/** GET text (HTML) once, recording the outcome. */
export async function getText(statusSet, key, url, { timeoutMs = 30_000 } = {}) {
  let http = null;
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'near-parity-data-build' }, signal: AbortSignal.timeout(timeoutMs) });
    http = res.status;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    statusSet(key, { ok: false, http_status: http, error: e.message, url });
    throw Object.assign(e, { http });
  }
}
