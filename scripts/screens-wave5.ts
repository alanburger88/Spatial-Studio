// Captures evidence screenshots of roadmap wave 5 (v0.16) from the running app: variants by brand or region (the
// gallery, a variant's update and what differs, Before & after with the update, the mark and the lock in Design Studio,
// the family), richer data shapes (the shape of the data, a repeating section, the nested customer, a rule about items)
// and message experiments (the experiment on a message, the two versions, the results panel).
// Usage: npx tsx scripts/screens-wave5.ts [outDir]     (best on a clean stack with a fresh data folder, sign-in off)
// The household statement is a test-only example: it is stored here as a project of its own and deleted afterwards.
// The Lakeshore variant and Northwind are reset before and after. Everything shown is synthetic.
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { buildHousehold, householdCustomers } from '../packages/model/src/samples/index';

const out = process.argv[2] ?? 'reports/evidence/screens';
mkdirSync(out, { recursive: true });
const API = `${process.env.E2E_API ?? 'http://127.0.0.1:3001'}/api/v1`;
const B = process.env.E2E_WEB ?? 'http://127.0.0.1:5173';
const call = (method: string, path: string, body?: unknown) => fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as any }));
const NW = 'northwind-energy-demo';
const LAKE = 'northwind-energy-lakeshore';
for (const id of [NW, LAKE]) await call('POST', `/projects/${id}/reset`, { confirm: true });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => { try { localStorage.setItem('iss.tour.offered', '1'); } catch { /* ignore */ } });
const p = await ctx.newPage();
const errors: string[] = [];
p.on('pageerror', (e) => errors.push(`${p.url()}: ${e.message}`));
const ready = (page: Page) => page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready', null, { timeout: 60000 });
const shot = async (name: string) => { await p.waitForTimeout(900); await p.screenshot({ path: `${out}/w5-${name}.png` }); console.log(`saved w5-${name}.png`); };
const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e: any) { console.log(`SKIPPED ${name}: ${String(e.message).split('\n')[0]}`); await p.keyboard.press('Escape').catch(() => {}); } };
const open = async (project: string, screen: string) => { await p.goto(`${B}/studio/${project}/${screen}`, { waitUntil: 'domcontentloaded' }); await ready(p); };
const into = async (testId: string) => { const el = p.getByTestId(testId).first(); await el.waitFor({ timeout: 30000 }); await el.scrollIntoViewIfNeeded(); };
let household = '';
try {
  /* ------------------------------------------------------------ variants by brand or region */
  await step('gallery', async () => {
    await p.goto(`${B}/projects`, { waitUntil: 'networkidle' });
    await into(`variant-chip-${LAKE}`);
    await shot('01-gallery-variant-under-its-base');
  });
  await step('variant overview', async () => {
    await open(LAKE, 'overview');
    await into('variant-update');
    await shot('02-variant-update-available');
    await into('variant-differences');
    await shot('03-variant-what-differs');
  });
  await step('before and after with the update', async () => {
    await p.goto(`${B}/studio/${LAKE}/compare?before=working&after=update`, { waitUntil: 'domcontentloaded' }); await ready(p);
    await p.waitForTimeout(6000);
    await shot('04-before-and-after-with-the-update');
  });
  await step('design studio lock', async () => {
    await open(LAKE, 'design');
    await p.evaluate(() => (window as any).__iss.store.getState().select('greeting'));
    await into('variant-node-note');
    await shot('05-design-studio-differs-and-lock');
  });
  await step('family', async () => {
    await open(NW, 'overview');
    await into('variant-family-panel');
    await shot('06-family-on-the-base');
  });

  /* ------------------------------------------------------------ richer data shapes */
  const made = await call('POST', '/projects/import', { file: buildHousehold() });
  household = made.json.project?.projectId ?? '';
  if (!household) throw new Error(`the household example could not be stored (${made.status})`);
  await call('POST', '/records/import', { projectId: household, scope: 'project', format: 'json', data: householdCustomers().map((c) => ({ customer: c.customer, custom: c.custom })) });
  const customers = (await call('GET', `/records?documentType=custom&full=1&projectId=${household}`)).json.records as any[];
  const four = customers.find((c) => c.custom?.accounts?.length === 4)?.recordId;
  await step('data fields', async () => {
    await open(household, 'rules-data');
    await p.getByTestId('open-data-fields').first().click();
    await into('df-tree');
    await shot('07-the-shape-of-the-data');
    await p.keyboard.press('Escape');
  });
  await step('repeating section', async () => {
    await open(household, 'design');
    if (four) await p.evaluate((id) => (window as any).__iss.store.getState().setRecord(id), four);
    await p.evaluate(() => (window as any).__iss.store.getState().select('accounts-section'));
    await into('repeat-accounts-section');
    await shot('08-a-repeating-section');
  });
  await step('nested customer', async () => {
    await open(household, 'data');
    await p.waitForTimeout(1500);
    await shot('09-a-customer-with-accounts-and-transactions');
  });
  await step('rule about items', async () => {
    await open(household, 'rules-data');
    await p.waitForTimeout(1500);
    await shot('10-a-rule-about-the-items-of-a-list');
  });

  /* ------------------------------------------------------------ message experiments */
  await step('experiment on a message', async () => {
    await open(LAKE, 'design');
    await p.evaluate(() => (window as any).__iss.store.getState().select('payment-message'));
    await into('experiment-section');
    await shot('11-an-experiment-on-a-message');
  });
  await step('experiments and results', async () => {
    await open(LAKE, 'rules-data');
    await p.getByTestId('tab-experiments').click();
    await into('experiment-results');
    await p.getByTestId('experiment-sample-results').click();
    await p.getByTestId('experiment-totals').waitFor({ timeout: 30000 });
    await shot('12-experiment-results-from-a-file');
  });
} finally {
  await b.close();
  if (household) await call('DELETE', `/projects/${household}`);
  for (const id of [NW, LAKE]) await call('POST', `/projects/${id}/reset`, { confirm: true });
}
if (errors.length) console.log('page errors:', JSON.stringify(errors.slice(0, 5), null, 1));
