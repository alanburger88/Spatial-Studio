// Captures evidence screenshots of roadmap wave 2 (v0.12) from the running app: Calculations, Lookup tables, Dates
// (the timeline and "As issued on"), the Page panel, PDF accessibility on Validate, and the Library.
// Usage: node scripts/screens-wave2.mjs [outDir]      (best on a clean stack: node scripts/dev-isolated.mjs <slot>)
// Everything it adds to the sample document is unsaved working-version state, and the sample is reset afterwards.
// Library items it creates stay in the local data folder unless the stack allows LIBRARY_RESET.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] ?? 'reports/evidence/screens';
mkdirSync(out, { recursive: true });
const API = `${process.env.E2E_API ?? 'http://127.0.0.1:3001'}/api/v1`;
const B = process.env.E2E_WEB ?? 'http://127.0.0.1:5173';
const post = (path, body) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const A = 'aster-card-demo';
await post(`/projects/${A}/reset`, { confirm: true });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
const shot = async (name) => { await p.waitForTimeout(800); await p.screenshot({ path: `${out}/w2-${name}.png` }); console.log(`saved w2-${name}.png`); };
const dispatch = (cmd) => p.evaluate((c) => { const r = window.__iss.store.getState().dispatch(c); if (r && r.ok === false) throw new Error(`${c.type}: ${r.message}`); }, cmd);
const tab = async (id) => { const t = p.getByTestId(`nav-${id}`); if (!(await t.isVisible())) await p.getByTestId('nav-section-rules-data').click(); await t.click(); };
try {
  await p.goto(`${B}/studio/${A}/calculations`, { waitUntil: 'networkidle' });
  await p.getByTestId('calculations-screen').waitFor();

  // 1. Calculations: the worked examples the screen offers for this document, then the editor.
  const examples = p.locator('[data-testid^="calc-example-"]');
  const n = Math.min(await examples.count(), 2);
  for (let i = 0; i < n; i++) { await p.locator('[data-testid^="calc-example-"]').first().click(); await p.waitForTimeout(500); if (!(await p.getByTestId('calc-empty').count())) break; }
  await shot('01-calculations');

  // 2. A lookup table with number ranges (a gap on purpose, so the screen shows how problems read).
  await dispatch({ type: 'UPSERT_LOOKUP_TABLE', table: {
    id: 'interestByBalance', title: 'Interest by balance',
    keys: [{ key: 'balance', label: 'Balance', match: 'number-range', unit: 'money' }],
    columns: [{ key: 'rate', label: 'Rate', type: 'number' }],
    rows: [
      { keys: { balance: { from: 0, until: 100000 } }, values: { rate: 1.5 } },
      { keys: { balance: { from: 100000, until: 300000 } }, values: { rate: 2 } },
      { keys: { balance: { from: 400000 } }, values: { rate: 2.5 } },
    ],
  } });
  await tab('S23');
  await p.getByTestId('lookup-tables-screen').waitFor();
  await shot('02-lookup-table');

  // 3. Page design: the Page panel in Design Studio.
  await p.getByTestId('nav-section-design').click();
  await p.getByTestId('open-page-panel').click();
  await shot('03-page-setup');

  // 4. PDF accessibility on Validate & compare.
  await p.getByTestId('nav-section-check').click();
  await p.getByTestId('nav-S09').click();
  await p.getByTestId('pdf-a11y-panel').waitFor({ timeout: 120000 });
  await p.getByTestId('pdf-a11y-panel').scrollIntoViewIfNeeded();
  await shot('04-pdf-accessibility');

  // 5. Dates: a date given for each run, one rule in effect from 1 Jan 2027, previewed on that day.
  await dispatch({ type: 'SET_DOCUMENT_DATE', source: { source: 'run' } });
  const ruleId = await p.evaluate(() => window.__iss.store.getState().project.rules.find((r) => r.enabled !== false).id);
  await dispatch({ type: 'SET_RULE_PERIOD', ruleId, period: { from: '2027-01-01' } });
  await p.getByTestId('nav-section-rules-data').click();
  await p.getByTestId('nav-S24').click();
  await p.getByTestId('dates-timeline').waitFor();
  await p.getByTestId('dates-issue-date').fill('2027-01-01');
  await p.getByTestId('dates-issue-date').blur();
  await shot('05-dates-timeline');

  // 6. The Library: a notice taken from the sample document and approved, and a glossary left as a draft.
  const notice = await post('/library', { kind: 'wording', title: 'Payment due notice', description: 'The standard payment reminder used on every statement.', projectId: A, ref: 'payment-standard' });
  if (notice.item) await post(`/library/${notice.item.id}/approve`, { note: 'First version' });
  await post('/library', { kind: 'glossary', title: 'Aster Spanish terms', content: { entries: { 'es-US': [{ source: 'statement', target: 'estado de cuenta' }, { source: 'minimum payment', target: 'pago mínimo' }] } } });
  await p.goto(`${B}/library`, { waitUntil: 'networkidle' });
  await shot('06-library');
} finally {
  await b.close();
  await post(`/projects/${A}/reset`, { confirm: true });
}
if (errors.length) console.log('page errors:', JSON.stringify(errors.slice(0, 3)));
