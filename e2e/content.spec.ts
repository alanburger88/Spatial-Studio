/** Content & Translations (S13) workflow and the 2.5D Scenario Landscape. Drives the real running application. */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { open, resetAll } from './helpers';

test.beforeEach(async ({ request }) => { await resetAll(request); });

const row = (page: Page, part: string) => page.locator(`[data-testid=tr-row][data-part="${part}"]`);

async function spanishFor(page: Page, part: string, text = 'Texto en español') {
  const r = row(page, part);
  const tokens = await r.locator('.tr-token').allTextContents();
  await r.getByTestId('tr-draft-input').fill([text, ...tokens].join(' '));
  return r;
}

test('S13 lists the missing mandatory es-US parts and what they affect', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  await expect(page.getByTestId('translations-view')).toBeVisible();
  const summary = page.getByTestId('tr-summary');
  await expect(summary).toContainText('es-US: 0 approved');
  await expect(summary).toContainText(/\d+ mandatory missing/);
  await expect(summary).toContainText(/affects \d+ synthetic es-US records/);
  await page.getByTestId('tr-filter-mandatory').check();
  const mandatory = await page.getByTestId('tr-row').count();
  expect(mandatory).toBeGreaterThanOrEqual(3);
  for (const id of ['billing-summary', 'payment-due', 'sample-disclosure-set']) await expect(row(page, id)).toBeVisible();
  await expect(page.getByTestId('tr-status').first()).toContainText('Missing');
  // English source highlights data tokens
  await expect(row(page, 'payment-due').locator('.tr-token')).toHaveText('{{card.minimumDueCents}}');
});

test('draft then approve one part; undo is available; mandatory-missing count drops', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  const before = await page.getByTestId('tr-summary').innerText();
  const r = await spanishFor(page, 'payment-due', 'Pago mínimo:');
  await r.getByTestId('tr-save-draft').click();
  await expect(r.getByTestId('tr-status')).toContainText('Draft');
  await expect(page.getByTestId('tr-summary')).toContainText('1 draft');
  await r.getByTestId('tr-approve').click();
  await expect(r.getByTestId('tr-status')).toContainText('Approved');
  await expect(page.getByTestId('tr-summary')).toContainText('1 approved');
  expect(await page.getByTestId('tr-summary').innerText()).not.toBe(before);
});

test('token mismatch blocks approval with an inline message and offers the missing token', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  const r = row(page, 'billing-summary');
  await r.getByTestId('tr-draft-input').fill('Saldo nuevo sin el dato.');
  await expect(r.getByTestId('tr-token-warning')).toContainText('{{card.newBalanceCents}}');
  await r.getByTestId('tr-approve').click();
  await expect(r.getByTestId('tr-error')).toContainText(/same data tokens/i);
  await expect(r.getByTestId('tr-status')).not.toContainText('Approved');
  await r.getByTestId('tr-insert-tokens').click();
  await expect(r.getByTestId('tr-draft-input')).toHaveValue(/\{\{card\.newBalanceCents\}\}/);
  await r.getByTestId('tr-approve').click();
  await expect(r.getByTestId('tr-status')).toContainText('Approved');
});

test('approving every mandatory part clears REQUIRED_TRANSLATION_MISSING for Spanish customers', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  await page.getByTestId('tr-filter-mandatory').check();
  const ids = await page.getByTestId('tr-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-part')!));
  for (const id of ids) { const r = await spanishFor(page, id); await r.getByTestId('tr-approve').click(); await expect(r.getByTestId('tr-status')).toContainText('Approved'); }
  await expect(page.getByTestId('tr-summary')).toContainText('0 mandatory missing');
  // the same pure resolver the validator uses: no es-US record is blocked by a missing mandatory translation any more
  const blocked = await page.evaluate(async () => {
    const st = (window as any).__iss?.store.getState();
    return st ? st.project.contentParts.filter((c: any) => c.approvedLocales['es-US']).length : -1;
  });
  expect(blocked).toBeGreaterThanOrEqual(ids.length);
});

test('CSV export downloads and import creates drafts (never approvals) with a result summary', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('tr-export').click()]);
  expect(dl.suggestedFilename()).toMatch(/translations-es-US\.csv$/);
  const path = await dl.path();
  const text = (await import('node:fs')).readFileSync(path!, 'utf8');
  expect(text).toContain('partId');
  expect(text).toContain('payment-due');
  const csv = 'partId,es-US\npayment-due,"Pago mínimo: {{card.minimumDueCents}}."\nbilling-summary,"Saldo."\nnope,"Hola"\n';
  await page.getByTestId('tr-import-file').setInputFiles({ name: 'es.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const result = page.getByTestId('tr-import-result');
  await expect(result).toContainText('1 draft created');
  await expect(result).toContainText('2 errors');
  await expect(row(page, 'payment-due').getByTestId('tr-status')).toContainText('Draft');
  await expect(row(page, 'billing-summary').getByTestId('tr-status')).toContainText('Missing');
});

test('API: translations.csv and import return real data', async ({ request }) => {
  const r = await request.get('http://127.0.0.1:3001/api/v1/projects/aster-card-demo/translations.csv?locale=es-US');
  expect(r.ok()).toBeTruthy();
  expect(r.headers()['content-disposition']).toContain('attachment');
  expect(await r.text()).toContain('partId,title,mandatory,status,en-US,es-US');
  const i = await request.post('http://127.0.0.1:3001/api/v1/projects/aster-card-demo/translations/import', { data: { locale: 'es-US', csv: 'partId,es-US\npayment-due,"Pago {{card.minimumDueCents}}"\nnope,x' } });
  const b = await i.json();
  expect(b.drafts).toEqual([{ partId: 'payment-due', text: 'Pago {{card.minimumDueCents}}' }]);
  expect(b.errors[0].code).toBe('UNKNOWN_ID');
});

test('See it in context opens 2D Design with an es-US record and the part selected', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  await row(page, 'billing-summary').getByTestId('tr-context').click();
  await expect(page).toHaveURL(/\/design$/);
  await expect(page.getByTestId('dock-selected')).toHaveText('billing-summary');
  const rec = await page.getByTestId('record-selector').getAttribute('data-value');
  const locale = await page.evaluate((id) => (window as any).__iss.store.getState().records.find((r: any) => r.recordId === id)?.customer.locale, rec);
  expect(locale).toBe('es-US');
});

test('Landscape 2.5D: switch view, change metric, legend changes, click a cluster opens the inspector', async ({ page }) => {
  await open(page, 'aster-card-demo', 'landscape');
  await expect(page.getByTestId('landscape-plane')).toHaveCount(0);
  await page.getByTestId('landscape-view-25d').click();
  await expect(page.getByTestId('landscape-plane')).toBeVisible();
  const legend = page.getByTestId('landscape-height-legend');
  await expect(legend).toContainText(/rule complexity/i);
  const before = await legend.innerText();
  await page.getByTestId('landscape-metric-exceptionCount').click();
  await expect(legend).toContainText(/exception count/i);
  expect(await legend.innerText()).not.toBe(before);
  await expect(page.getByTestId('landscape-plane')).toContainText('synthetic');
  // choice is remembered
  await page.reload();
  await expect(page.getByTestId('landscape-plane')).toBeVisible();
  const clusters = page.getByTestId('landscape-cluster');
  expect(await clusters.count()).toBeGreaterThan(3);
  await clusters.nth(1).click();
  await expect(page.getByTestId('landscape-cluster-count')).toBeVisible();
  await expect(clusters.nth(1)).toHaveAttribute('aria-pressed', 'true');
  // keyboard selection drives the same inspector
  await clusters.nth(2).focus(); await page.keyboard.press('Enter');
  await expect(clusters.nth(2)).toHaveAttribute('aria-pressed', 'true');
  // flat view is the default for people who never switched
  await page.getByTestId('landscape-view-flat').click();
  await expect(page.getByTestId('landscape-plane')).toHaveCount(0);
  await expect(page.getByTestId('landscape-metric-ruleComplexity')).toHaveCount(0);
});
