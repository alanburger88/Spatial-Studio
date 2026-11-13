import { expect, test, type Page } from '@playwright/test';
import { API, open, resetAll } from './helpers';

const P = 'aster-card-demo';
test.beforeEach(async ({ request }) => { await resetAll(request); await request.delete(`${API}/projects/${P}/test-data`); });
test.afterEach(async ({ request }) => { await request.delete(`${API}/projects/${P}/test-data`); });

async function openDialog(page: Page) {
  await open(page, P, 'rules-data');
  await page.getByTestId('testdata-open').click();
  await expect(page.getByTestId('testdata-dialog')).toBeVisible();
  await expect(page.getByTestId('testdata-plan-count')).toBeVisible();
}
const planCount = async (page: Page) => Number(((await page.getByTestId('testdata-plan-count').textContent()) ?? '').match(/\d+/)![0]);
async function generate(page: Page) {
  await page.getByTestId('testdata-generate').click();
  await expect(page.getByTestId('testdata-done')).toBeVisible();
}
const generatedGroup = async (page: Page) => {
  await page.getByTestId('record-selector').click();
  await expect(page.getByTestId('record-group-generated')).toBeVisible();
};

test('G01 the dialog previews what would be created; edge values lower the count; one option stays on', async ({ page }) => {
  await openDialog(page);
  const both = await planCount(page);
  expect(both).toBeGreaterThan(5);
  await expect(page.getByTestId('testdata-plan-summary')).toContainText(/Outcomes reached: \d+ of \d+/);
  await expect(page.getByTestId('testdata-plan-summary')).toContainText(/Edge values reached: \d+ of \d+/);
  await page.getByTestId('testdata-edges').uncheck();
  await expect(page.getByTestId('testdata-plan-summary')).not.toContainText('Edge values');
  await expect.poll(() => planCount(page)).toBeLessThan(both);
  // the last option cannot be turned off
  await page.getByTestId('testdata-outcomes').click({ force: true });
  await expect(page.getByTestId('testdata-outcomes')).toBeChecked();
  await expect(page.getByTestId('testdata-unreachable')).toHaveCount(0);
  await page.getByTestId('testdata-edges').check();
  await expect(page.getByTestId('testdata-unreachable')).toContainText('cannot be less than 0');
});

test('G02 generating lists the customers, adds a picker group, previews one, and stays in this project', async ({ page }) => {
  await openDialog(page);
  const n = await planCount(page);
  await generate(page);
  await expect(page.getByTestId('testdata-customer')).toHaveCount(n);
  await page.keyboard.press('Escape');
  await generatedGroup(page);
  await expect(page.locator('[data-testid^="record-option-"] [data-testid="record-generated-chip"]')).toHaveCount(n);
  await page.keyboard.press('Escape');

  await page.getByTestId('testdata-open').click();
  await expect(page.getByTestId('testdata-existing')).toContainText(`${n} generated customers`);
  await page.getByTestId('testdata-plan-count').waitFor();
  await page.keyboard.press('Escape');

  // Preview from the success list
  await page.getByTestId('testdata-open').click();
  await page.getByTestId('testdata-generate').click();
  await expect(page.getByTestId('testdata-done')).toBeVisible();
  const row = page.getByTestId('testdata-customer').nth(2);
  const id = await row.getAttribute('data-record');
  await row.getByTestId('testdata-preview').click();
  await expect(page.getByTestId('testdata-dialog')).toHaveCount(0);
  await expect(page.getByTestId('record-selector')).toHaveAttribute('data-value', id!);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  const res = await page.evaluate(() => (window as any).__iss.store.getState().ctx.recordId);
  expect(res).toBe(id);

  const harbor = await page.request.get(`${API}/records?documentType=eob&full=1&projectId=harborcare-demo`);
  expect(((await harbor.json()).records as any[]).some((r) => r.generated)).toBe(false);
  await open(page, 'harborcare-demo', 'rules-data');
  await page.getByTestId('record-selector').click();
  await expect(page.getByTestId('record-group-generated')).toHaveCount(0);
});

test('G03 an edge value customer shows what the document did', async ({ page }) => {
  await openDialog(page);
  await generate(page);
  await page.getByTestId('testdata-tab-covers').click();
  const exact = page.getByTestId('testdata-target').filter({ hasText: 'exactly' }).first();
  await expect(exact).toBeVisible();
  await expect(exact.getByTestId('testdata-observed')).toContainText(/Gets|Shows|Hides|applies/);
  await expect(page.getByTestId('testdata-covers')).toContainText('Edge values');
});

test('G04 generating again with only outcomes replaces the earlier set', async ({ page }) => {
  await openDialog(page);
  const both = await planCount(page);
  await generate(page);
  const oldIds = await page.getByTestId('testdata-customer').evaluateAll((els) => els.map((e) => e.getAttribute('data-record')));
  await page.keyboard.press('Escape');
  await page.getByTestId('testdata-open').click();
  await expect(page.getByTestId('testdata-existing')).toBeVisible();
  await page.getByTestId('testdata-edges').uncheck();
  await expect.poll(() => planCount(page)).toBeLessThan(both);
  const fewer = await planCount(page);
  await generate(page);
  await expect(page.getByTestId('testdata-customer')).toHaveCount(fewer);
  await page.keyboard.press('Escape');
  await generatedGroup(page);
  await expect(page.locator('[data-testid^="record-option-"] [data-testid="record-generated-chip"]')).toHaveCount(fewer);
  const stillThere = await page.locator('[data-testid^="record-option-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('record-option-', '')));
  const gone = oldIds.filter((id) => !stillThere.includes(id!));
  expect(gone.length).toBeGreaterThanOrEqual(both - fewer);
});

test('G05 removing clears the group and leaves the samples', async ({ page }) => {
  await openDialog(page);
  await generate(page);
  await page.getByTestId('testdata-clear').click();
  await page.getByTestId('testdata-clear-confirm').click();
  await expect(page.getByTestId('testdata-done')).toHaveCount(0);
  await expect(page.getByTestId('testdata-existing')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByTestId('record-selector').click();
  await expect(page.getByTestId('record-group-generated')).toHaveCount(0);
  await page.getByTestId('record-search').fill('Jordan Mercer');
  await expect(page.locator('[data-testid^="record-option-"]').first()).toContainText('Jordan Mercer');
});

test('G06 without the right to edit, Generate is disabled with the reason and the plan is still shown', async ({ page }) => {
  await page.route('**/api/v1/session', (route) => route.fulfill({ json: {
    authEnabled: true, user: { id: 'u-rev', name: 'Riley Reviewer', email: 'rev@example.test', role: 'reviewer' },
    permissions: ['view', 'comment'], roles: ['reviewer'], expiresAt: null,
  } }));
  await openDialog(page);
  await expect(page.getByTestId('testdata-plan-summary')).toBeVisible();
  await expect(page.getByTestId('testdata-generate')).toBeDisabled();
  await expect(page.getByTestId('testdata-generate')).toHaveAttribute('title', /Reviewers can comment but not edit/);
  await expect(page.getByTestId('testdata-blocked')).toContainText('Reviewers can comment but not edit');
});

test('G07 the coverage dialog offers the generator', async ({ page }) => {
  await open(page, P, 'rules-data');
  await page.getByTestId('coverage-open').click();
  await expect(page.getByTestId('coverage-panel')).toBeVisible();
  await page.getByTestId('coverage-generate').click();
  await expect(page.getByTestId('coverage-panel')).toHaveCount(0);
  await expect(page.getByTestId('testdata-dialog')).toBeVisible();
});

test('G08 the assistant panel opens the generator', async ({ page }) => {
  await open(page, P, 'rules-data');
  await page.locator('.screen-head').getByTestId('assist-open').click();
  await page.getByTestId('assist-panel').getByRole('button', { name: /Generate test customers/ }).click();
  await expect(page.getByTestId('testdata-dialog')).toBeVisible();
});
