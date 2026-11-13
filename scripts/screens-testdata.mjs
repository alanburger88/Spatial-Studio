// Captures evidence screenshots of generated test customers and the assistant panel changes (v0.8) from the running app.
// Usage: node scripts/screens-testdata.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] ?? 'reports/evidence/screens';
mkdirSync(out, { recursive: true });
const API = `${process.env.E2E_API ?? 'http://127.0.0.1:3001'}/api/v1`;
const B = process.env.E2E_WEB ?? 'http://127.0.0.1:5173';
const P = 'aster-card-demo';
const call = (method, path, body) => fetch(`${API}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
await call('POST', `/projects/${P}/reset`, { confirm: true });
await call('DELETE', `/projects/${P}/test-data`);
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
const shot = async (name) => { await p.waitForTimeout(900); await p.screenshot({ path: `${out}/testdata-${name}.png` }); console.log('captured', name); };
try {
  // 1. What generating would create, before anything is stored.
  await p.goto(`${B}/studio/${P}/rules-data`, { waitUntil: 'networkidle' });
  await p.getByTestId('testdata-open').click();
  await p.getByTestId('testdata-plan-count').waitFor({ timeout: 30000 });
  await shot('01-plan');
  // 2. After generating: what each customer covers.
  await p.getByTestId('testdata-generate').click();
  await p.getByTestId('testdata-done').waitFor({ timeout: 60000 });
  await p.getByRole('tab', { name: /covers/i }).click().catch(() => p.getByText('What each one covers').click());
  await shot('02-what-each-covers');
  await p.keyboard.press('Escape');
  // 3. The customer picker with the generated group.
  await p.getByTestId('record-selector').click();
  await p.getByTestId('record-group-generated').scrollIntoViewIfNeeded();
  await shot('03-customer-picker');
  await p.keyboard.press('Escape');
  // 4. The assistant's explanation in the side panel, in plain words.
  await p.goto(`${B}/studio/${P}/exploded/payment-guidance`, { waitUntil: 'networkidle' });
  await p.locator('.screen-head').getByTestId('assist-open').click();
  await p.getByTestId('assist-tab-chat').click();
  await p.getByTestId('assistant-input').fill('Explain the selected variant');
  await p.getByTestId('assistant-send').click();
  await p.getByTestId('assistant-explanation').last().waitFor();
  await p.getByTestId('assistant-explanation').last().scrollIntoViewIfNeeded();
  await shot('04-assistant-explanation');
} finally {
  await b.close();
  await call('DELETE', `/projects/${P}/test-data`);
  await call('POST', `/projects/${P}/reset`, { confirm: true });
}
console.log('page errors:', JSON.stringify(errors));
