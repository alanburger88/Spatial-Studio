// Captures evidence screenshots of all 12 screens from the running app.
// Usage: node scripts/screens.mjs [outDir] [width] [height] [zoom]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] ?? 'reports/evidence/screens';
const w = +(process.argv[3] ?? 1440), h = +(process.argv[4] ?? 900), zoom = +(process.argv[5] ?? 1);
mkdirSync(out, { recursive: true });
const B = 'http://127.0.0.1:5173';
await fetch('http://127.0.0.1:3001/api/v1/projects/aster-card-demo/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"confirm":true}' });
await fetch('http://127.0.0.1:3001/api/v1/projects/harborcare-demo/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"confirm":true}' });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: Math.round(w / zoom), height: Math.round(h / zoom) }, deviceScaleFactor: zoom });
const p = await ctx.newPage();
const errors = [];
const pick = async (id) => { await p.getByTestId('record-selector').click(); await p.getByTestId('record-search').fill(id); await p.getByTestId(`record-option-${id}`).click(); };
p.on('pageerror', (e) => errors.push(e.message));
const shots = [
  ['01', '/projects', null],
  ['02', '/studio/aster-card-demo/design', null],
  ['03', '/studio/aster-card-demo/exploded/payment-guidance', async () => { await pick('CARD-0002'); }],
  ['04', '/studio/aster-card-demo/cube', null],
  ['05', '/studio/aster-card-demo/landscape', null],
  ['06', '/studio/aster-card-demo/page-stack', async () => { await pick('CARD-0001'); await p.getByTestId('stress-250').click(); await p.getByTestId('page-count').filter({ hasText: 'pages' }).waitFor({ timeout: 60000 }); }],
  ['07', '/studio/aster-card-demo/rules-data?rule=R04', async () => { await pick('CARD-0002'); }],
  ['08', '/studio/aster-card-demo/journey', async () => { await pick('CARD-0001'); for (let i = 0; i < 3; i++) await p.getByTestId('trigger-event').click(); }],
  ['09', '/studio/aster-card-demo/validate', async () => { await p.getByTestId('open-demo-tools').click(); await p.getByTestId('seed-d01').click(); await p.getByTestId('run-validation').click(); await p.getByTestId('validation-list').waitFor(); await p.waitForTimeout(2500); }],
  ['10', '/studio/harborcare-demo/outputs', async () => { await pick('EOB-0002'); await p.getByTestId('tab-html').click(); await p.getByTestId('export-html').click(); await p.getByTestId('html-iframe').waitFor({ timeout: 60000 }); await p.getByTestId('run-parity').click(); await p.getByTestId('parity-status').waitFor({ timeout: 60000 }); }],
  ['11', '/studio/aster-card-demo/demo', null],
  ['12', '/studio/aster-card-demo/assistant', async () => { await pick('CARD-0001'); await p.getByTestId('assistant-input').fill('Show me a Spanish-speaking cardholder who has missed two payments and requests assistance'); await p.getByTestId('assistant-send').click(); await p.getByTestId('assistant-reply').first().waitFor(); await p.getByTestId('assistant-input').fill('Change R04 priority to 420'); await p.getByTestId('assistant-send').click(); await p.getByTestId('proposal-card').waitFor(); }],
];
for (const [id, url, prep] of shots) {
  await p.goto(B + url, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  if (prep) await prep();
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${out}/screen-${id}.png` });
  console.log('captured', id, url);
}
console.log('page errors:', JSON.stringify(errors));
await b.close();
