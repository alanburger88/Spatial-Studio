#!/usr/bin/env node
// Starts a SECOND, isolated local stack so several people (or agents) can run browser tests at the same time
// without resetting each other's sample projects:
//   node scripts/dev-isolated.mjs <slot>      slot 1..9 → API on :310<slot>, web on :520<slot>, own data folder
// Then run tests against it:
//   E2E_API=http://127.0.0.1:310<slot> E2E_WEB=http://127.0.0.1:520<slot> pnpm exec playwright test --trace off <files>
// and screenshots:
//   E2E_API=http://127.0.0.1:310<slot> node scripts/shot.mjs http://127.0.0.1:520<slot>/studio/aster-card-demo/design out.png
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const slot = Number(process.argv[2]);
if (!Number.isInteger(slot) || slot < 1 || slot > 9) { console.error('usage: node scripts/dev-isolated.mjs <slot 1..9>'); process.exit(2); }
const apiPort = 3100 + slot, webPort = 5200 + slot;
const dataDir = process.env.DATA_DIR ?? mkdtempSync(path.join(tmpdir(), `iss-slot${slot}-`));
const run = (args, env, name) => {
  const p = spawn('pnpm', args, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } });
  p.on('exit', (code) => { console.log(`[${name}] exited ${code}`); process.exit(code ?? 0); });
  return p;
};
const procs = [
  // Test stacks use the built-in assistant unless LIVE_AI=1 is set on purpose: tests must not spend against a real key.
  run(['--filter', '@iss/api', 'dev'], { API_PORT: String(apiPort), DATA_DIR: dataDir, ...(process.env.LIVE_AI === '1' ? {} : { AI_PROVIDER: 'offline', AI_API_KEY: '', ANTHROPIC_API_KEY: '' }) }, 'api'),
  run(['--filter', '@iss/web', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { API_URL: `http://127.0.0.1:${apiPort}` }, 'web'),
];
const stop = () => { procs.forEach((p) => p.kill('SIGTERM')); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
console.log(`\nIsolated stack ${slot}: web http://127.0.0.1:${webPort}/projects · API http://127.0.0.1:${apiPort}/api/v1/health · data ${dataDir}\nE2E_API=http://127.0.0.1:${apiPort} E2E_WEB=http://127.0.0.1:${webPort}\n`);
