#!/usr/bin/env node
// Project lint: strict typecheck plus guardrail checks that encode build-contract rules.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
let failed = 0;
const tsc = spawnSync('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (tsc.status) { console.error('✗ typecheck failed'); failed++; } else console.log('✓ typecheck');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? (f === 'node_modules' || f === 'dist' ? [] : walk(p)) : [p]; });
const files = ['apps', 'packages'].flatMap(walk).filter((f) => /\.(ts|tsx)$/.test(f));
const rules = [
  { re: /VITE_[A-Z_]*(KEY|SECRET|TOKEN)/, msg: 'secrets must never be exposed to the browser bundle', scope: (f) => true },
  { re: /\beval\s*\(|new Function\s*\(/, msg: 'no dynamic code execution (rules are typed ASTs)', scope: (f) => !f.includes('paginator-source') },
  { re: /download=\{?["'`][^"'`]*\.afp/, msg: 'AFP is simulation-only; never offer .afp downloads', scope: (f) => true },
  { re: /console\.log\(/, msg: 'no console.log in shipped app code', scope: (f) => f.includes(`apps${path.sep}web`) },
  { re: /oracle\/reference_resolver|reference_resolver\.py/, msg: 'the Python oracle must never be imported by the app', scope: (f) => true },
];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const r of rules) if (r.scope(f) && r.re.test(src)) { console.error(`✗ ${f}: ${r.msg}`); failed++; }
}
console.log(failed ? `lint: ${failed} problem(s)` : `✓ guardrails (${files.length} files)`);
process.exit(failed ? 1 : 0);
