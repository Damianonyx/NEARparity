#!/usr/bin/env node
// Dependency-free lint: syntax-checks every JavaScript file with `node --check`, and flags a few
// project rules (no hard-coded 2026 dates in the UI script; no stray debugging statements).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', 'data']);
const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    if (SKIP.has(f)) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p); else if (/\.(mjs|js)$/.test(f)) files.push(p);
  }
})(ROOT);

let problems = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) {
    problems++; console.log(`syntax  ${relative(ROOT, f)}\n${e.stderr}`);
  }
  const src = readFileSync(f, 'utf8');
  if (!f.endsWith('lint.mjs') && /^\s*debugger;?\s*$/m.test(src)) { problems++; console.log(`rule    ${relative(ROOT, f)}: remove 'debugger'`); }
}
const app = readFileSync(join(ROOT, 'app.js'), 'utf8');
for (const m of app.matchAll(/'20\d\d-\d\d-\d\d'/g)) { problems++; console.log(`rule    app.js: hard-coded date ${m[0]} (derive it from data/latest.json meta)`); }
console.log(`${files.length} files checked, ${problems} problem(s)`);
process.exitCode = problems ? 1 : 0;
