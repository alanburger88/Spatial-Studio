#!/usr/bin/env node
// Cross-platform Python launcher: Windows installs usually provide `py` or `python`, not `python3`.
// Usage: node scripts/run-python.mjs <python args…>
import { spawnSync } from 'node:child_process';
const candidates = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
for (const [cmd, pre] of candidates) {
  const probe = spawnSync(cmd, [...pre, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { stdio: 'ignore', shell: false });
  if (probe.error || probe.status !== 0) continue;
  const r = spawnSync(cmd, [...pre, ...process.argv.slice(2)], { stdio: 'inherit', shell: false });
  process.exit(r.status ?? 1);
}
console.error('Python 3.10+ was not found. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH"), then open a new terminal.');
process.exit(1);
