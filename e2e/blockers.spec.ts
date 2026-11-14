import { expect, test } from '@playwright/test';
import { open, pickRecord, resetAll } from './helpers';

test.beforeEach(async ({ request }) => { await resetAll(request); });

test('B01 All customers lists blockers across every synthetic customer, blocking first, with a pre-filled detail panel', async ({ page }) => {
  await open(page, 'aster-card-demo', 'validate');
  await page.evaluate(() => localStorage.removeItem('iss.validateScope'));
  await page.reload();
  await expect(page.getByTestId('scope-this')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('blockers-all')).toHaveCount(0);

  await page.getByTestId('scope-all').click();
  await expect(page.getByTestId('scope-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('blockers-all')).toBeVisible();
  const summary = page.getByTestId('blockers-summary');
  await expect(summary).toContainText(/blocking issues? affects? \d+ of \d+ synthetic customers/, { timeout: 30_000 });
  await expect(summary).toContainText(/are clear|is clear/);

  const groups = page.getByTestId('blocker-group');
  await expect(groups.first()).toBeVisible();
  const sev = await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-severity')));
  expect(sev[0]).toBe('blocking');
  const codes = await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-code')));
  expect(codes).toContain('REQUIRED_TRANSLATION_MISSING');
  const rank = sev.map((s) => (s === 'blocking' || s === 'error' ? 0 : 1));
  expect(rank).toEqual([...rank].sort());
  await expect(groups.first()).toContainText(/\d+ of \d+ synthetic customers/);

  // detail panel is pre-filled (never empty) and lists affected customers by name
  const inspector = page.getByTestId('validation-inspector');
  await expect(inspector).toHaveAttribute('data-side', 'right');
  await expect(inspector).not.toContainText('Select');
  await expect(page.getByTestId('blocker-customers')).toBeVisible();
  expect(await page.getByTestId('blocker-open-customer').count()).toBeGreaterThan(0);
  await expect(page.getByTestId('go-to-source')).toBeVisible();

  // choice is remembered
  await page.reload();
  await expect(page.getByTestId('scope-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('blockers-all')).toBeVisible();
});

test('B02 the Blocking only toggle hides warnings; the translation blocker names the Spanish-preferred customers', async ({ page }) => {
  await open(page, 'aster-card-demo', 'validate');
  await page.getByTestId('scope-all').click();
  const only = page.getByTestId('blockers-only');
  await expect(only).toBeChecked({ timeout: 30_000 });
  const blockingOnly = await page.locator('[data-testid="blocker-group"]:not([data-severity="blocking"]):not([data-severity="error"])').count();
  expect(blockingOnly).toBe(0);
  await page.locator('[data-testid="blocker-group"][data-code="REQUIRED_TRANSLATION_MISSING"]').first().click();
  const list = page.getByTestId('blocker-customers');
  await expect(list).toContainText(/\w+ \w+/);
  await only.uncheck();
  await expect(page.getByTestId('blocker-group').first()).toHaveAttribute('data-severity', /blocking|error/);
});

test('B03 "Preview this customer" switches the top-bar customer and returns to This customer with the issue selected', async ({ page }) => {
  await open(page, 'aster-card-demo', 'validate');
  await pickRecord(page, 'CARD-0001');
  await page.getByTestId('scope-all').click();
  await expect(page.getByTestId('blocker-group').first()).toBeVisible({ timeout: 30_000 });
  const g = page.locator('[data-testid="blocker-group"][data-code="REQUIRED_TRANSLATION_MISSING"]').first();
  await g.click();
  const node = (await g.getAttribute('data-node'))!;
  const row = page.getByTestId('blocker-customers').locator('li').first();
  const id = (await row.getAttribute('data-record'))!;
  expect(id).not.toBe('CARD-0001');
  await row.getByTestId('blocker-open-customer').click();
  await expect(page.getByTestId('record-selector')).toHaveAttribute('data-value', id);
  await expect(page.getByTestId('scope-this')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('blockers-all')).toHaveCount(0);
  await expect(page.getByTestId('validation-list')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('validate-view')).toContainText(/up to date/, { timeout: 90_000 });
  await expect(page.getByTestId('validation-inspector')).toContainText(/translation/i, { timeout: 30_000 });
  const current = page.locator('[data-testid="issue-REQUIRED_TRANSLATION_MISSING"][aria-current="true"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute('data-issue', new RegExp(node));
});
