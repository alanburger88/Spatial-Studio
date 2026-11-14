/**
 * Browser tests for the v0.2 features: Business/Technical view, theme, command palette, help,
 * project duplicate/rename/delete, record import with column matching, custom data fields,
 * impact preview, batch runs, the image library and status-dock consistency.
 * Runs against the real local stack, like acceptance.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { API, cardAction, demoTool, open, pickRecord, resetAll, setView } from './helpers';
import { gotoScreen } from './nav-helper';

test.beforeEach(async ({ request }) => {
  await resetAll(request);
  await request.delete(`${API}/records/imported`);
  const { projects } = await (await request.get(`${API}/projects`)).json();
  for (const p of projects) if (!p.sample) await request.delete(`${API}/projects/${p.projectId}`);
});

test('F01 Business view speaks plainly; Technical view shows engine internals; theme toggles', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data?rule=R04');
  await setView(page, 'business');
  await expect(page.getByTestId('rule-summary')).toContainText('When Assistance requested is yes');
  await expect(page.getByTestId('rule-reads-as')).toHaveCount(0);
  await setView(page, 'technical');
  await expect(page.getByTestId('rule-reads-as')).toContainText('card.assistanceRequested = true');
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const before = await theme();
  await page.getByTestId('open-settings').click();
  await page.getByTestId(before === 'dark' ? 'theme-light' : 'theme-dark').click();
  expect(await theme()).not.toBe(before);
  await page.reload();
  expect(await theme()).not.toBe(before);
});

test('F02 Ctrl+K finds a rule by ID and opens it; ? opens the shortcuts sheet', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('palette-input').fill('R04');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/rules-data\?rule=R04/);
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts-sheet')).toBeVisible();
  await expect(page.getByTestId('shortcuts-sheet')).toContainText('Ctrl');
});

test('F03 Duplicate, rename and delete a project from the gallery; samples cannot be deleted', async ({ page }) => {
  await page.goto('/projects');
  await expect(page.getByTestId('delete-aster-card-demo')).toHaveCount(0);
  await cardAction(page, 'duplicate', 'aster-card-demo');
  await page.getByTestId('project-title-input').fill('Spanish pilot');
  await page.getByTestId('confirm-title').click();
  const card = page.getByTestId('project-card-spanish-pilot');
  await expect(card).toContainText('Your project');
  await cardAction(page, 'rename', 'spanish-pilot');
  await page.getByTestId('project-title-input').fill('Spanish pilot v2');
  await page.getByTestId('confirm-title').click();
  await expect(card).toContainText('Spanish pilot v2');
  await page.getByTestId('open-spanish-pilot').click();
  await expect(page).toHaveURL(/\/studio\/spanish-pilot\/overview$/);
  await gotoScreen(page, 'S02');
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await page.goto('/projects');
  await cardAction(page, 'delete', 'spanish-pilot');
  await page.getByTestId('confirm-delete').click();
  await expect(card).toHaveCount(0);
});

test('F04 Import CSV with everyday column names: columns are matched, the record appears everywhere, and can be removed', async ({ page }) => {
  await page.goto('/projects');
  await page.getByTestId('import-records').click();
  await page.getByRole('button', { name: 'Healthcare EOB' }).click();
  await page.getByText('…or paste data').click();
  await page.getByTestId('import-text').fill('Member,Given name,Family name,Preferred locale,Plan name,Member ID,Claim ID,Claim status,Network status,Billed amount\nM-1,Robin,Quill,en-US,HarborCare Select,HC-9,HC-500,appeal-filed,in-network,12000\n');
  await expect(page.getByTestId('import-mapping')).toContainText('9 of 10 columns used');
  await page.getByTestId('import-check').click();
  await expect(page.getByTestId('import-result')).toContainText('1 valid');
  await page.getByTestId('import-commit').click();
  await expect(page.getByTestId('clear-imported')).toBeVisible();
  await open(page, 'harborcare-demo', 'design');
  await pickRecord(page, 'EOB-5001');
  await expect(page.getByTestId('record-selector')).toContainText('Robin Quill');
  const sel = await page.evaluate(() => (window as any).__iss.store.getState().ctx.recordId);
  expect(sel).toBe('EOB-5001');
  await page.goto('/projects');
  await page.getByTestId('clear-imported').click();
  await expect(page.getByTestId('clear-imported')).toHaveCount(0);
});

test('F05 Data fields: add a custom choice field; it becomes available to rules', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data?rule=R06');
  await page.getByTestId('open-data-fields').click();
  await page.getByTestId('df-tab-custom').click();
  await page.getByTestId('df-add').click();
  await page.getByTestId('df-label').fill('Customer segment');
  await expect(page.getByTestId('df-key')).toHaveValue('customerSegment');
  await page.getByTestId('df-type').selectOption('enum');
  await page.getByTestId('df-values').fill('gold, standard');
  await page.getByTestId('save-data-fields').click();
  const custom = await page.evaluate(() => (window as any).__iss.store.getState().project.customFields);
  expect(custom).toEqual([{ key: 'customerSegment', label: 'Customer segment', type: 'enum', enumValues: ['gold', 'standard'] }]);
  await page.getByTestId('open-data-fields').click();
  await page.getByTestId('df-tab-standard').click();
  await expect(page.getByTestId('data-fields')).toContainText('Payment status');
});

test('F06 Impact preview: disabling a rule reports which synthetic customers change, with undo', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data?rule=R04');
  await page.getByTestId('rule-enabled-toggle').click();
  const impact = page.getByTestId('rule-impact');
  await expect(impact).toContainText(/Changes \d+ of 70 synthetic customers/);
  await impact.getByRole('button', { name: /show details/i }).click();
  await expect(impact.getByTestId('impact-row').first()).toBeVisible();
  await impact.getByTestId('impact-undo').click();
  const enabled = await page.evaluate(() => (window as any).__iss.store.getState().project.rules.find((r: any) => r.id === 'R04').enabled);
  expect(enabled).toBe(true);
});

test('F07 Batch run: compose all synthetic card customers into one ZIP with a run report', async ({ page, request }) => {
  test.setTimeout(240_000);
  await open(page, 'aster-card-demo', 'outputs');
  await page.getByTestId('tab-batch').click();
  await expect(page.getByTestId('batch-count')).toContainText('70');
  await page.getByTestId('batch-start').click();
  await expect(page.getByTestId('batch-summary')).toBeVisible({ timeout: 200_000 });
  const href = await page.getByTestId('batch-download').getAttribute('href');
  const zip = await request.get(href!);
  expect(zip.headers()['content-type']).toBe('application/zip');
  const body = await zip.body();
  expect(body.subarray(0, 4).toString('hex')).toBe('504b0304');
  expect(body.includes(Buffer.from('run-report.csv'))).toBe(true);
  expect(await page.getByTestId('batch-row').count()).toBeGreaterThan(0);
});

function tinyPng(): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 78, 175, 96, 29, 89, 65]))), chunk('IEND', Buffer.alloc(0))]);
}

test('F08 Image library: upload a PNG, use it for the issuer logo; the image is embedded in the model', async ({ page, request }) => {
  const { assets } = await (await request.get(`${API}/assets`)).json();
  for (const a of assets) await request.delete(`${API}/assets/${a.assetId}`, { data: {} });
  await open(page, 'aster-card-demo', 'design');
  await page.evaluate(() => (window as any).__iss.store.getState().select('issuer-logo'));
  await page.getByTestId('choose-image').click();
  await expect(page.getByTestId('asset-library')).toBeVisible();
  await page.getByTestId('asset-file-input').setInputFiles({ name: 'brand-mark.png', mimeType: 'image/png', buffer: tinyPng() });
  await expect(page.getByTestId('asset-item')).toHaveCount(1);
  await page.getByTestId('asset-pick').first().click();
  await expect.poll(() => page.evaluate(() => (window as any).__iss.store.getState().project.nodes.find((n: any) => n.id === 'issuer-logo').image.src)).toMatch(/^data:image\/png;base64,/);
});

test('F09 Status dock and Validate & Compare agree on blocking counts', async ({ page }) => {
  await open(page, 'aster-card-demo', 'validate');
  await demoTool(page, 'seed-d01');
  const dock = page.getByTestId('dock-status');
  await expect(dock).toContainText(/2 blocking/);
  await page.getByTestId('run-validation').click();
  await expect(page.getByTestId('validation-list')).toBeVisible({ timeout: 90_000 });
  await expect(dock).toContainText(/Full validation: 2 blocking/);
});
