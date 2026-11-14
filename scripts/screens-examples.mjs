// Captures evidence screenshots of the four example documents (v0.14) from the running app: the gallery, the house
// library, and the screens where each example shows the features added to it.
// Usage: node scripts/screens-examples.mjs [outDir]      (best on a clean stack with a fresh data folder)
// It only reads: the four samples are restored first and nothing is saved.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] ?? 'reports/evidence/screens';
mkdirSync(out, { recursive: true });
const API = `${process.env.E2E_API ?? 'http://127.0.0.1:3001'}/api/v1`;
const B = process.env.E2E_WEB ?? 'http://127.0.0.1:5173';
const SAMPLES = ['aster-card-demo', 'harborcare-demo', 'northwind-energy-demo', 'meridian-wealth-demo'];
for (const id of SAMPLES) await fetch(`${API}/projects/${id}/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(`${p.url()}: ${e.message}`));
const shot = async (url, name, opts = {}) => {
  await p.goto(B + url, { waitUntil: 'networkidle' });
  if (opts.before) await opts.before();
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${out}/ex-${name}.png`, fullPage: !!opts.full });
  console.log(`saved ex-${name}.png`);
};
try {
  await shot('/projects', '01-gallery-four-samples', { full: true });
  await shot('/library', '02-house-library', { before: async () => { await p.getByText('Customer rights notice (utilities)').first().click().catch(() => {}); } });
  await shot('/studio/northwind-energy-demo/overview', '03-northwind-overview');
  await shot('/studio/northwind-energy-demo/design', '04-northwind-design');
  await shot('/studio/northwind-energy-demo/dates', '05-northwind-dates');
  await shot('/studio/northwind-energy-demo/blockers', '06-northwind-blockers');
  await shot('/studio/meridian-wealth-demo/design', '07-meridian-design');
  await shot('/studio/meridian-wealth-demo/calculations', '08-meridian-calculations');
  await shot('/studio/aster-card-demo/calculations', '09-aster-calculations');
  await shot('/studio/aster-card-demo/mapping', '10-aster-mapping');
  await shot('/studio/harborcare-demo/lookup-tables', '11-harborcare-lookup-table');
  await shot('/studio/harborcare-demo/content', '12-harborcare-wording-rules', { before: async () => { const t = p.getByTestId('wr-panel-toggle'); if (await t.count() && !(await p.locator('details.wr-panel[open]').count())) await t.click(); } });
} finally {
  await b.close();
}
if (errors.length) console.log('page errors:', JSON.stringify(errors.slice(0, 5), null, 1));
