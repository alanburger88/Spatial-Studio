#!/usr/bin/env node
// Cross-platform equivalent of scripts/verify-all.sh (works in Windows PowerShell / cmd as well as bash).
//   node scripts/verify-all.mjs         → pack validation only
//   node scripts/verify-all.mjs --app   → pack + live app check + lint + typecheck + unit + browser tests + build
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const win = process.platform === 'win32';
const step = (label, cmd, args) => {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: win });
  if (r.status !== 0) { console.error(`✗ ${label} failed`); process.exit(r.status ?? 1); }
};
const py = (label, ...args) => step(label, process.execPath, ['scripts/run-python.mjs', ...args]);
py('Pack validation', 'scripts/verify_pack.py');
if (process.argv.includes('--app')) {
  if (!existsSync('package.json')) { console.error('FAIL: no application package.json'); process.exit(1); }
  py('Live app check', 'scripts/verify_app.py', '--base-url', process.env.API_URL ?? 'http://127.0.0.1:3001', '--web-url', process.env.WEB_URL ?? 'http://127.0.0.1:5173');
  for (const s of ['lint', 'typecheck', 'test', 'e2e', 'build']) step(`pnpm ${s}`, 'pnpm', [s]);
}
console.log('\n✓ all requested gates passed');
