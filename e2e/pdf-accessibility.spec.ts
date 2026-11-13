import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, open, resetAll } from './helpers';
import { gotoScreen } from './nav-helper';

/**
 * Accessible PDF, proven (wave 2): the PDF part of Validate & Compare with its two levels of proof, the document
 * setting "Accessible PDF is required" (Design, Page setup) that turns failed checks into blockers found by the full
 * check, the Overview full-check step, and the PDF accessibility record of a release. veraPDF is not installed on the
 * machines these tests run on, so the screens must say so; nothing may claim PDF/UA conformance.
 */

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => { await resetAll(request); });
test.afterAll(async ({ request }) => { await resetAll(request); });
// The single-customer view of Validate & Compare (the scope is remembered per browser).
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem('iss.validateScope', 'this')); });

const project = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().project);
const dispatch = (page: Page, cmd: unknown) => page.evaluate((c) => (window as any).__iss.store.getState().dispatch(c), cmd);

/** Validate & Compare, opened by address, or from the menu when the document has unsaved changes to keep. */
async function validate(page: Page, id: string, fromMenu = false) {
  if (fromMenu) await gotoScreen(page, 'S09');
  else await open(page, id, 'validate');
  await expect(page.getByTestId('pdf-a11y-panel')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('pdf-a11y-checks')).toBeVisible({ timeout: 90_000 });
  return page.getByTestId('pdf-a11y-panel');
}

test('PA01 Validate & Compare shows the PDF checks with the level of proof, each failure linked to the part of the document', async ({ page }) => {
  const panel = await validate(page, 'aster-card-demo');
  // The two levels, labelled exactly; veraPDF is not installed here and the screen says so.
  await expect(panel.getByTestId('pdf-a11y-level-studio')).toContainText('Checked by the studio');
  await expect(panel.getByTestId('pdf-a11y-level-studio')).toContainText('not validation against PDF/UA');
  await expect(panel.getByTestId('pdf-a11y-level-verapdf')).toContainText('Validated by veraPDF');
  await expect(panel.getByTestId('pdf-a11y-level-verapdf')).toContainText('veraPDF is not installed on this machine');
  // Eleven checks with their result; the card's continued table is the one failure.
  await expect(panel.locator('[data-testid^="pdf-a11y-check-"]')).toHaveCount(11);
  await expect(panel.getByTestId('pdf-a11y-check-tables')).toHaveAttribute('data-status', 'failed');
  for (const id of ['tagged', 'title', 'language', 'headings', 'pictures', 'links', 'lists', 'reading-order', 'contrast', 'untagged-text']) await expect(panel.getByTestId(`pdf-a11y-check-${id}`)).toHaveAttribute('data-status', 'passed');
  await expect(panel.getByTestId('pdf-a11y-summary')).toHaveText('1 of 11 checks failed');
  await expect(panel.getByTestId('pdf-a11y-limits')).toContainText('PDF/UA identifier');
  await expect(panel).toContainText('An accessible PDF is not required for this document');
  // Nothing on the screen claims conformance on the strength of the studio's own checks.
  await expect(page.locator('body')).not.toContainText(/PDF\/UA compliant|compliant with PDF\/UA/i);
  await expect(page.getByTestId('certification-note')).toContainText('not WCAG');
  await expect(page.getByTestId('certification-note')).toContainText('not validation against PDF/UA');

  // The failure links to the issue (warning: the setting is off) and to the component in Design.
  await panel.getByTestId('pdf-a11y-check-tables').getByTestId('pdf-a11y-show').click();
  const inspector = page.getByTestId('validation-inspector');
  await expect(inspector).toContainText('header row');
  await expect(page.getByTestId('issue-PDF_A11Y_TABLE_NO_HEADERS')).toBeVisible();
  await expect(page.getByTestId('issue-PDF_A11Y_TABLE_NO_HEADERS')).toContainText(/warning/i);

  const results = await new AxeBuilder({ page }).include('[data-testid="pdf-a11y-panel"]').analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

  await panel.getByTestId('pdf-a11y-check-tables').getByTestId('pdf-a11y-open').click();
  await expect(page).toHaveURL(/\/design$/);
  expect(await page.evaluate(() => (window as any).__iss.store.getState().ctx.selectedNodeId)).toBe('transaction-table');
});

test('PA02 the dark theme and a narrow window keep the panel readable', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.addInitScript(() => localStorage.setItem('iss.theme', 'dark'));
  const panel = await validate(page, 'harborcare-demo');
  await expect(panel.getByTestId('pdf-a11y-summary')).toHaveText('11 of 11 checks passed');
  const results = await new AxeBuilder({ page }).include('[data-testid="pdf-a11y-panel"]').analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  const overflow = await page.evaluate(() => { const el = document.querySelector('[data-testid="pdf-a11y-panel"]') as HTMLElement; return el.scrollWidth - el.clientWidth; });
  expect(overflow).toBeLessThanOrEqual(1);
});

test('PA03 "Accessible PDF is required" in Page setup: one undoable command; failures become blockers found by the full check', async ({ page }) => {
  test.setTimeout(300_000);
  await open(page, 'harborcare-demo', 'design');
  await page.getByTestId('open-page-panel').click();
  const box = page.getByTestId('accessible-pdf-required');
  await expect(box).not.toBeChecked();
  await box.check();
  expect((await project(page)).accessiblePdfRequired).toBe(true);
  await page.getByTestId('undo').click();
  await expect.poll(async () => (await project(page)).accessiblePdfRequired ?? false).toBe(false);
  await expect(box).not.toBeChecked();
  await box.check();
  // A brand text colour too pale to read: every customer's PDF fails the contrast check.
  await dispatch(page, { type: 'SET_BRAND', brand: { primary: '#277656', accent: '#4EAF60', text: '#BBBBBB' } });

  const panel = await validate(page, 'harborcare-demo', true);
  await expect(panel.getByTestId('pdf-a11y-check-contrast')).toHaveAttribute('data-status', 'failed');
  await expect(panel).toContainText('Accessible PDF is required');
  await expect(page.getByTestId('issue-PDF_A11Y_LOW_CONTRAST').first()).toContainText(/blocking/i);

  await gotoScreen(page, 'S17');
  await page.getByTestId('bl-run-full').click();
  await expect(page.getByTestId('bl-full-time')).toContainText(/from the full check at \d{1,2}:\d{2}/, { timeout: 280_000 });
  await expect(page.getByTestId('bl-speed-pdf')).toContainText('PDF accessibility, checked by the studio');
  await expect(page.getByTestId('bl-speed-pdf')).toContainText('An accessible PDF is required, so these are blockers');
  await expect(page.getByTestId('bl-kindcount-layout')).not.toHaveAttribute('data-count', '0');
  await expect(page.getByText('Text is hard to read against its background').first()).toBeVisible();

  // Overview's full-check step reports the PDF accessibility result of that full check.
  await page.getByTestId('nav-S19').click();
  await expect(page.locator('body')).toContainText('PDF accessibility, checked by the studio: the PDFs of 30 customers failed a check');
});

async function approvedCopy(request: APIRequestContext): Promise<string> {
  const r = await request.post(`${API}/projects/harborcare-demo/duplicate`, { data: { title: `PDF accessibility E2E ${Date.now().toString(36)}` } });
  expect(r.ok()).toBeTruthy();
  const id = (await r.json()).project.projectId as string;
  expect((await request.post(`${API}/projects/${id}/workflow`, { data: { action: 'submit' } })).ok()).toBeTruthy();
  const a = await request.post(`${API}/projects/${id}/workflow`, { data: { action: 'approve' } });
  expect(a.ok()).toBeTruthy();
  return id;
}

test('PA04 a release records the level of proof reached, on demand, and says when', async ({ page, request }) => {
  const id = await approvedCopy(request);
  try {
    await open(page, id, 'releases');
    const section = page.getByTestId('rel-pdf-a11y');
    await expect(section.getByTestId('rel-pdf-a11y-none')).toBeVisible();
    await section.getByTestId('rel-pdf-a11y-check').click();
    await expect(section.getByTestId('rel-pdf-a11y-record')).toBeVisible({ timeout: 60_000 });
    await expect(section.getByTestId('rel-pdf-a11y-level')).toHaveText('Checked by the studio');
    await expect(section).toContainText('11 of 11 checks passed, 0 failed');
    await expect(section.getByTestId('rel-pdf-a11y-verapdf')).toContainText('veraPDF is not installed on this machine');
    // Kept: reopening the release shows the same record.
    await page.reload();
    await expect(page.getByTestId('rel-pdf-a11y').getByTestId('rel-pdf-a11y-level')).toHaveText('Checked by the studio');
  } finally {
    await request.delete(`${API}/projects/${id}`);
  }
});
