#!/usr/bin/env node
// Starts the local stack: API on :3001 and web on :5173.
//   node scripts/dev.mjs            → API + Vite dev server (hot reload)
//   node scripts/dev.mjs --preview  → API + production build served by `vite preview`
import { spawn, spawnSync } from 'node:child_process';
const preview = process.argv.includes('--preview');
const run = (cmd, args, name) => {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', env: process.env });
  p.on('exit', (code) => { console.log(`[${name}] exited ${code}`); process.exit(code ?? 0); });
  return p;
};
if (preview) {
  const b = spawnSync('pnpm', ['--filter', '@iss/web', 'build'], { stdio: 'inherit' });
  if (b.status) process.exit(b.status);
}
const procs = [run('pnpm', ['--filter', '@iss/api', 'start'], 'api'), run('pnpm', ['--filter', '@iss/web', preview ? 'preview' : 'dev'], 'web')];
const stop = () => { procs.forEach((p) => p.kill('SIGTERM')); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
console.log('\nInfoSlips Spatial Studio → http://127.0.0.1:5173/projects  (API http://127.0.0.1:3001/api/v1/health)\n');
