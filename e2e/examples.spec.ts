import { expect, test, type Page } from '@playwright/test';
import { API, open, pdfText, pickRecord, resetAll } from './helpers';

/**
 * EX: the two example documents with their own data (D106) — Northwind Energy (dual-fuel bill) and Meridian Wealth
 * (quarterly portfolio statement) — walked through every part of the studio, in English and Spanish, without errors.
 */

const NW = 'northwind-energy-demo';
const MW = 'meridian-wealth-demo';

test.beforeEach(async ({ request }) => { await resetAll(request); });

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return errors;
}
const screenOk = async (page: Page) => {
  await page.waitForTimeout(300);
  expect(await page.locator('#main .error-state').count()).toBe(0);
};

test('EX01 the gallery lists the four samples with their kinds; Restore all samples keeps its place', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/projects');
  const cards = page.locator('[data-testid^="project-card-"]');
  await expect(page.getByTestId(`project-card-${NW}`)).toContainText('Utility bill');
  await expect(page.getByTestId(`project-card-${NW}`)).toContainText('Northwind Energy');
  await expect(page.getByTestId(`project-card-${MW}`)).toContainText('Portfolio statement');
  await expect(page.getByTestId(`project-card-${MW}`)).toContainText('Meridian Wealth');
  const ids = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  // Wave 5: the Lakeshore variant of Northwind sits right under its base.
  expect(ids.slice(0, 5)).toEqual(['project-card-aster-card-demo', 'project-card-harborcare-demo', `project-card-${NW}`, 'project-card-northwind-energy-lakeshore', `project-card-${MW}`]);
  await expect(page.getByTestId('reset-demo')).toHaveText(/Restore all samples/);
  await page.getByTestId('reset-demo').click();
  await page.getByTestId('confirm-reset-demo').click();
  await expect(page.getByTestId(`project-card-${NW}`)).toContainText('Sample');
  expect(errors).toEqual([]);
});

test('EX02 Northwind Energy: overview, page design, rules and data, explore, check, outputs, releases, library and mapping', async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);

  await open(page, NW, 'overview');
  await expect(page.getByTestId('overview-screen')).toContainText('Northwind Energy bill');
  await expect(page.getByTestId('overview-screen')).toContainText('Release 1');
  await screenOk(page);

  // Design: US Letter with a Last page template for the payment slip.
  await open(page, NW, 'design');
  await page.getByTestId('open-page-panel').click();
  await expect(page.getByTestId('page-panel')).toBeVisible();
  await expect(page.getByTestId('page-paper')).toHaveValue('US-Letter');
  await expect(page.getByTestId('page-last-toggle')).toBeChecked();
  await screenOk(page);

  // Rules and data: rules, calculations, lookup tables and the dates timeline.
  await open(page, NW, 'rules-data');
  await expect(page.getByTestId('rules-data-view')).toContainText('Overdue account');
  await open(page, NW, 'calculations');
  await expect(page.getByTestId('calc-list')).toContainText('Total amount due');
  await expect(page.getByTestId('calc-list')).toContainText('Electricity delivery charge');
  await open(page, NW, 'lookup-tables');
  await expect(page.getByTestId('lookup-tables-screen')).toContainText('Electricity delivery rate by monthly use');
  await expect(page.getByTestId('lookup-tables-screen')).toContainText('Late fee by rate plan');
  await open(page, NW, 'dates');
  await expect(page.getByTestId('dates-timeline')).toContainText('1 Dec 2026');
  await screenOk(page);

  // Explore: the payment message exploded into its five versions, and the cube.
  await open(page, NW, 'exploded/payment-message');
  await expect(page.getByTestId('exploded-view')).toContainText('Your account is past due');
  await expect(page.getByTestId('exploded-view')).toContainText('Your account is in credit');
  await open(page, NW, 'cube');
  await expect(page.getByTestId('cube-view')).toBeVisible();
  await screenOk(page);

  // Check: exactly the intended blockers — the credit message's draft Spanish, the customer whose data does not
  // reconcile, and the known data problem set aside.
  await open(page, NW, 'blockers');
  const blockers = page.getByTestId('blockers-screen');
  await expect(blockers).toContainText('No approved Spanish text for “Your account is in credit”');
  await expect(blockers).toContainText('“Total amount due” cannot be worked out for some customers');
  await expect(blockers).toContainText('Known data problem');
  await expect(blockers).toContainText('3 causes');
  await open(page, NW, 'validate');
  await expect(page.getByTestId('validate-view')).toBeVisible();
  await screenOk(page);

  // Preview & export, and the composed PDF: the long list runs to a second page and the payment slip is on the last.
  await open(page, NW, 'outputs');
  await expect(page.getByTestId('outputs-view')).toBeVisible();
  const pdf = await request.post(`${API}/compose/pdf`, { data: { projectId: NW, recordId: 'NWE-60019' } });
  expect(pdf.ok()).toBeTruthy();
  const { pages } = await pdfText(Buffer.from(await pdf.body()));
  expect(pages.length).toBeGreaterThanOrEqual(3);
  expect(pages[pages.length - 1]).toContain('Payment slip');
  expect(pages.slice(0, -1).join(' ')).not.toContain('Payment slip');
  expect(pages[1]).toContain('Your charges this period');
  expect(pages[pages.length - 1]).toContain('(continued)');

  // Releases: release 1 in Production, Before & after against it, and the proof records produced from it.
  await open(page, NW, 'releases');
  await expect(page.getByTestId('releases-screen')).toContainText('Production');
  await open(page, NW, 'compare');
  await expect(page.getByTestId('before-after')).toBeVisible();
  await open(page, NW, 'proof');
  await expect(page.getByTestId('proof-lookup')).toContainText('NWE-60001');
  await screenOk(page);

  // Mapping: the complete print-house mapping and the portal mapping in progress.
  await open(page, NW, 'mapping');
  await expect(page.getByTestId('map-screen')).toContainText('Mapping for the print house');
  await expect(page.getByTestId('map-screen')).toContainText('Mapping for the customer portal');

  // Library: the house items, where they are used, and the update the bill has not taken yet.
  await page.goto('/library');
  await expect(page.getByTestId('library-screen')).toContainText('Customer rights notice (utilities)');
  await expect(page.getByTestId('library-screen')).toContainText('Electricity delivery rate bands');
  // Wave 5: Northwind and its Lakeshore variant both hold the rights notice at version 1.
  await expect(page.getByTestId('library-screen').getByTestId('lib-usage').filter({ hasText: '2 behind' })).toHaveCount(1);
  await screenOk(page);
  expect(errors).toEqual([]);
});

test('EX03 Northwind in Spanish: a Spanish-speaking customer gets the approved Spanish bill', async ({ page, request }) => {
  const errors = watchErrors(page);
  await open(page, NW, 'design');
  await pickRecord(page, 'NWE-60003');
  await expect(page.locator('#main')).toContainText('Su factura de energía');
  const pdf = await request.post(`${API}/compose/pdf`, { data: { projectId: NW, recordId: 'NWE-60003' } });
  const { pages } = await pdfText(Buffer.from(await pdf.body()));
  expect(pages[0]).toContain('Su factura de energía');
  expect(pages[pages.length - 1]).toContain('Talón de pago');
  expect(pages.join(' ')).not.toMatch(/Your energy bill|undefined|NaN/);
  expect(errors).toEqual([]);
});

test('EX04 Meridian Wealth: two columns on the first page, holdings over two pages, every part of the studio', async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  await open(page, MW, 'overview');
  await expect(page.getByTestId('overview-screen')).toContainText('Meridian Wealth quarterly statement');
  await open(page, MW, 'design');
  await page.getByTestId('open-page-panel').click();
  await expect(page.getByTestId('page-columns')).toHaveValue('2');
  await open(page, MW, 'calculations');
  await expect(page.getByTestId('calc-list')).toContainText('Investment return (%)');
  await open(page, MW, 'lookup-tables');
  await expect(page.getByTestId('lookup-tables-screen')).toContainText('Management fee by portfolio value');
  await open(page, MW, 'dates');
  await expect(page.getByTestId('dates-timeline')).toContainText('1 Dec 2026');
  await open(page, MW, 'exploded/commentary');
  await expect(page.getByTestId('exploded-view')).toContainText('This quarter for growth investors');
  await open(page, MW, 'blockers');
  await expect(page.getByTestId('blockers-screen')).toContainText('3 causes');
  await expect(page.getByTestId('blockers-screen')).toContainText('Known data problem');
  await open(page, MW, 'mapping');
  await expect(page.getByTestId('map-screen')).toContainText('Mapping for the client portal');
  await open(page, MW, 'releases');
  await expect(page.getByTestId('releases-screen')).toBeVisible();
  await screenOk(page);

  // The composed pages: two columns on the first page, the 40-fund portfolio's holdings continued on the next page.
  const composed = await (await request.post(`${API}/compose/pages`, { data: { projectId: MW, recordId: 'MWS-60011' } })).json();
  const metrics = composed.metrics ?? composed;
  expect(metrics.pages[0].columns).toBe(2);
  expect(metrics.pages.length).toBeGreaterThanOrEqual(3);
  const pdf = await request.post(`${API}/compose/pdf`, { data: { projectId: MW, recordId: 'MWS-60011' } });
  const { pages } = await pdfText(Buffer.from(await pdf.body()));
  expect(pages[0]).toContain('Account summary');
  expect(pages[0]).toContain('Asset allocation');
  expect(pages[1]).toContain('Your holdings at the end of the quarter (continued)');

  // Preview & export, and a Spanish-speaking client in the document.
  await open(page, MW, 'outputs');
  await expect(page.getByTestId('outputs-view')).toBeVisible();
  await open(page, MW, 'design');
  await pickRecord(page, 'MWS-60003');
  await expect(page.locator('#main')).toContainText('Estado de cuenta trimestral');
  expect(errors).toEqual([]);
});
