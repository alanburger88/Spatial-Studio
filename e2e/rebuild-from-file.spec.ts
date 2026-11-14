/**
 * Browser tests for "Rebuild from a file" (New project). Every file is built by the test from invented values
 * (apps/api/test/fixtures/import/makeFiles.ts). The test servers run WITHOUT a live AI model on purpose: the model path
 * is SIMULATED by faking the AI status and fulfilling the propose call with a setup the real server built, so what is
 * checked is the page: the consent step, what would be sent, and what the page sends. The read, the setup review and
 * the create calls are real; created documents are deleted again.
 */
import { test, expect, type Page } from '@playwright/test';
import { API } from './helpers';
import { INVENTED, letterDocx, scannedPdf, statementPdf } from '../apps/api/test/fixtures/import/makeFiles';

const created: string[] = [];
test.beforeEach(() => { created.length = 0; });
test.afterEach(async ({ request }) => { for (const id of created) await request.delete(`${API}/projects/${id}`); });

const pdfFile = (name: string, buffer: Buffer) => ({ name, mimeType: 'application/pdf', buffer });
const docxFile = (name: string, buffer: Buffer) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer });
const idFromUrl = (page: Page) => new URL(page.url()).pathname.split('/')[2];

async function openFlow(page: Page) {
  await page.goto('/projects');
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('rebuild-entry')).toContainText('Rebuild from a file');
  await page.getByTestId('rebuild-open').click();
  await expect(page.getByTestId('rebuild-step-choose')).toBeVisible();
}
async function readFiles(page: Page, files: Array<{ name: string; mimeType: string; buffer: Buffer }>) {
  await page.getByTestId('rebuild-file-input').setInputFiles(files);
  await expect(page.getByTestId('rebuild-file')).toHaveCount(files.length);
  await page.getByTestId('rebuild-read').click();
  await expect(page.getByTestId('rebuild-step-found')).toBeVisible();
}
async function createAndCheck(page: Page, request: import('@playwright/test').APIRequestContext) {
  await page.getByTestId('setup-create').click();
  await page.waitForURL(/\/studio\/[^/]+\/overview/);
  const id = idFromUrl(page);
  created.push(id);
  await page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready');
  const recs = (await (await request.get(`${API}/records?documentType=custom&full=1&projectId=${id}`)).json()).records;
  expect(recs.length).toBeGreaterThan(0);
  const pages = await (await request.post(`${API}/compose/pages`, { data: { projectId: id, recordId: recs[0].recordId } })).json();
  expect(pages.pageCount).toBeGreaterThan(0);
  return { id, recs };
}

test('RB01 a PDF through the whole flow without AI: what was found, no key, the review with what was not brought across, a created document with fields, a customer and a composed page', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFlow(page);
  await expect(page.getByTestId('rebuild-privacy')).toContainText('not by an AI model');
  await readFiles(page, [pdfFile('statement-jane.pdf', statementPdf())]);

  const found = page.getByTestId('rebuild-step-found');
  await expect(page.getByTestId('rebuild-summary')).toContainText('statement-jane.pdf');
  await expect(page.getByTestId('rebuild-summary')).toContainText('a PDF file, 1 page, A4');
  await expect(found.getByTestId('rebuild-found-block')).toHaveCount(8);
  await expect(found.locator('[data-testid="rebuild-found-block"][data-kind="table"] th')).toHaveText(['Date', 'Description', 'Amount']);
  await expect(found.getByTestId('rebuild-mark-span').first()).toBeVisible();
  await expect(page.getByTestId('rebuild-images')).toContainText('120 × 40 pt');
  await expect(page.getByTestId('rebuild-title')).toHaveValue('Membership statement');
  await page.getByTestId('rebuild-title').fill('Rebuilt statement RB01');
  await page.getByTestId('rebuild-next').click();

  const send = page.getByTestId('rebuild-step-send');
  await expect(send).toBeVisible();
  await expect(send.getByTestId('assist-needs-ai')).toBeVisible();
  await expect(page.getByTestId('rebuild-mode-ai')).toBeDisabled();
  await expect(page.getByTestId('rebuild-mode-builtin')).toBeChecked();
  await expect(page.getByTestId('rebuild-outline')).toHaveCount(0);
  await page.getByTestId('rebuild-propose').click();

  const review = page.getByTestId('setup-step-review');
  await expect(review).toBeVisible();
  await expect(review.getByTestId('assist-source')).toHaveAttribute('data-source', 'builtin');
  await expect(page.getByTestId('setup-message')).toContainText('without an AI model');
  await expect(page.getByTestId('setup-not-brought')).toContainText('Pictures:');
  await expect(page.getByTestId('setup-not-brought')).toContainText('One sample shows one customer’s copy');
  await expect(page.getByTestId('setup-field')).toHaveCount(6);
  await expect(page.locator('[data-testid="setup-field"][data-label="Amount due"]')).toBeVisible();
  await expect(page.getByTestId('setup-no-blocking')).toBeVisible();
  // Back returns to what will be sent, and forward again keeps the review
  await page.getByTestId('setup-back').click();
  await expect(page.getByTestId('rebuild-step-send')).toBeVisible();
  await page.getByTestId('rebuild-propose').click();
  await expect(page.getByTestId('setup-step-review')).toBeVisible();

  const { id } = await createAndCheck(page, request);
  const p = await (await request.get(`${API}/projects/${id}`)).json();
  const proj = p.project ?? p;
  expect(proj.customFields.map((f: any) => f.label)).toEqual(expect.arrayContaining(['Member number', 'Amount due', 'Due date', 'Charges this month']));
  const audit = (await (await request.get(`${API}/audit?action=file.read`)).json()).events;
  expect(audit[0].detail).toMatchObject({ files: 1, kinds: ['pdf'], ai: false, placeholders: false });
  expect(JSON.stringify(audit[0])).not.toContain('statement-jane');
  // The document opens in the studio with a page drawn for its customer.
  await page.goto(`/studio/${id}/design`);
  await expect(page.locator('#main section.screen').first()).toBeVisible();
  await expect(page.getByText('Membership statement').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('RB02 a Word file without AI: headings, a list and a table found, macros and links reported, created', async ({ page, request }) => {
  await openFlow(page);
  await readFiles(page, [docxFile('policy.docx', letterDocx({ macros: true, externalLink: true }))]);
  await expect(page.getByTestId('rebuild-summary')).toContainText('a Word file, about 1 page, A4');
  await expect(page.locator('[data-testid="rebuild-found-block"][data-kind="list"]')).toContainText('Accidental damage');
  await expect(page.locator('[data-testid="rebuild-found-block"][data-kind="table"]')).toContainText('$31.20');
  await expect(page.getByTestId('rebuild-ignored')).toContainText('macros. They were ignored and never run');
  await page.getByTestId('rebuild-title').fill('Policy renewal RB02');
  await page.getByTestId('rebuild-next').click();
  await page.getByTestId('rebuild-propose').click();
  await expect(page.getByTestId('setup-step-review')).toBeVisible();
  await expect(page.getByTestId('setup-not-brought')).toContainText('Left out for safety:');
  await createAndCheck(page, request);
});

test('RB03 with a (simulated) model: the consent blocks until ticked, the placeholder choice changes what would be sent, and the page sends exactly what it showed', async ({ page, request }) => {
  // A setup the real server proposes for this file, returned as if the model had written it.
  const files = [{ data: statementPdf().toString('base64') }];
  const real = await (await request.post(`${API}/projects/rebuild/propose`, { data: { files, useAi: false, title: 'Rebuilt by AI RB03' } })).json();
  expect(real.mode).toBe('proposal');
  // Without the confirmation the server refuses before calling any model.
  const refused = await request.post(`${API}/projects/rebuild/propose`, { data: { files, useAi: true, placeholders: true, outline: 'anything' } });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error.code).toBe('CONSENT_REQUIRED');

  let sent: any = null;
  await page.route('**/api/v1/assistant/status', (route) => route.fulfill({ json: { mode: 'external', label: 'Simulated AI model', model: 'simulated' } }));
  await page.route('**/api/v1/projects/rebuild/propose', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ json: { ...real, source: 'ai', providerStatus: 'Simulated AI model', message: 'Rebuilt by an AI model from the outline you saw, and checked by the studio.' } });
  });
  await openFlow(page);
  await readFiles(page, [pdfFile('statement.pdf', statementPdf())]);
  await page.getByTestId('rebuild-title').fill('Rebuilt by AI RB03');
  await page.getByTestId('rebuild-next').click();

  await expect(page.getByTestId('rebuild-mode-ai')).toBeChecked();
  await expect(page.getByTestId('rebuild-placeholders-on')).toBeChecked();
  const outline = page.getByTestId('rebuild-outline');
  await expect(outline).toContainText('Amount due: {{Amount due}}');
  await expect(outline).toContainText('{{First name}} {{Last name}}');
  await expect(outline).not.toContainText('$54.50');
  await expect(outline).not.toContainText('Jane');
  await expect(outline).toContainText('picture not read');
  await expect(page.getByTestId('rebuild-propose')).toBeDisabled();
  await expect(page.getByTestId('rebuild-consent-why')).toBeVisible();

  await page.getByTestId('rebuild-placeholders-off').check();
  await expect(outline).toContainText('Amount due: $54.50');
  await expect(outline).toContainText('Ms Jane Example');
  await page.getByTestId('rebuild-placeholders-on').check();
  await expect(outline).not.toContainText('$54.50');

  // Keyboard: tick the confirmation with Space.
  await page.getByTestId('rebuild-consent').focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('rebuild-propose')).toBeEnabled();
  const shown = await outline.textContent();
  await page.getByTestId('rebuild-propose').click();
  await expect(page.getByTestId('setup-step-review')).toBeVisible();
  expect(sent).toMatchObject({ useAi: true, confirmNoCustomerData: true, placeholders: true });
  expect(sent.outline).toBe(shown);
  expect(JSON.stringify(sent)).not.toContain('statement.pdf');
  await expect(page.getByTestId('setup-step-review').getByTestId('assist-source')).toHaveAttribute('data-source', 'ai');
  await createAndCheck(page, request);
});

test('RB04 two samples: where they differ is shown before anything is proposed', async ({ page }) => {
  await openFlow(page);
  await readFiles(page, [pdfFile('jane.pdf', statementPdf(INVENTED[0])), pdfFile('ben.pdf', statementPdf(INVENTED[1]))]);
  const cmp = page.getByTestId('rebuild-compare');
  await expect(cmp).toBeVisible();
  await expect(cmp.locator('[data-testid="rebuild-compare-row"][data-kind="different"]')).toHaveCount(1);
  await expect(cmp.locator('[data-testid="rebuild-compare-row"][data-kind="different"]')).toContainText('Thank you for staying with us.');
  await expect(cmp.locator('[data-testid="rebuild-compare-row"][data-kind="same"]').first()).toBeVisible();
  await expect(cmp.locator('[data-testid="rebuild-compare-row"][data-kind="values"]').first()).toBeVisible();
  await page.getByTestId('rebuild-sample-tab').nth(1).click();
  await expect(page.getByTestId('rebuild-summary')).toContainText('ben.pdf');
  await expect(page.getByTestId('rebuild-step-found')).toContainText('Your last payment failed.');
});

test('RB05 a scanned PDF and a file of another kind are refused with a plain explanation', async ({ page }) => {
  await openFlow(page);
  await page.getByTestId('rebuild-file-input').setInputFiles([pdfFile('scan.pdf', scannedPdf())]);
  await page.getByTestId('rebuild-read').click();
  await expect(page.getByTestId('rebuild-error')).toContainText('“scan.pdf”: This PDF has no text layer');
  await expect(page.getByTestId('rebuild-error')).toContainText('does not read text from pictures');
  await expect(page.getByTestId('rebuild-step-choose')).toBeVisible();
  await page.getByTestId('rebuild-file-remove').click();
  await page.getByTestId('rebuild-file-input').setInputFiles([{ name: 'list.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2') }]);
  await expect(page.getByTestId('rebuild-file-error')).toContainText('is not a PDF or a Word (.docx) file');
});
