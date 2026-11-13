import { expect, test, type Page } from '@playwright/test';
import { demoTool, open, resetAll } from './helpers';

test.beforeEach(async ({ request }) => { await resetAll(request); });

const ready = async (page: Page) => {
  await expect(page.getByTestId('validation-list')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('validate-view')).toContainText(/up to date/, { timeout: 90_000 });
};
const dockText = (page: Page) => page.getByTestId('dock-status');

test('F01 a blocking priority tie gets a proposal whose effect is shown first; Apply removes the blocker and Undo brings it back', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await demoTool(page, 'seed-d01');
  await expect(dockText(page)).toContainText('blocking');
  await page.evaluate(() => localStorage.setItem('iss.validateScope', 'this'));
  await page.getByTestId('nav-S09').click(); // in-app navigation keeps the unsaved defect
  await ready(page);
  const tie = page.locator('[data-testid^="issue-"][data-testid*="TIE"]').first();
  await tie.click();
  const panel = page.getByTestId('fix-panel');
  await expect(panel).toBeVisible();
  const card = panel.getByTestId('assist-proposal').first();
  await expect(card.getByTestId('assist-source')).toHaveText('Built-in');
  const impact = card.getByTestId('assist-impact');
  await expect(impact).toBeVisible({ timeout: 30_000 });
  await expect(impact).toHaveAttribute('data-newly-blocked', '0');
  expect(Number(await impact.getAttribute('data-unblocked'))).toBeGreaterThan(0);
  await expect(impact).toContainText(/unblocks \d+ of \d+ synthetic customers/);
  await card.getByTestId('assist-apply').click();
  await expect(card.getByTestId('assist-applied')).toBeVisible();
  await expect(dockText(page)).not.toContainText('blocking', { timeout: 60_000 });
  await page.getByTestId('undo').click();
  await expect(dockText(page)).toContainText('blocking', { timeout: 60_000 });
});

test('F02 "No message matches": the fallback proposal resolves it', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await demoTool(page, 'remove-fallback');
  await demoTool(page, 'no-match-scenario');
  await page.getByTestId('demo-tools').getByRole('button', { name: 'Close demo tools' }).click();
  await page.evaluate(() => localStorage.setItem('iss.validateScope', 'this'));
  await page.getByTestId('nav-S09').click(); // in-app navigation keeps the unsaved defect
  await ready(page);
  const issue = page.locator('[data-testid^="issue-"][data-testid*="MATCH"], [data-testid^="issue-"][data-testid*="FALLBACK"]').first();
  await issue.click();
  const card = page.getByTestId('fix-panel').getByTestId('assist-proposal').first();
  await expect(card.getByTestId('assist-impact')).toHaveAttribute('data-resolves', 'yes', { timeout: 30_000 });
  await expect(card).toContainText(/fallback/i);
  await card.getByTestId('assist-apply').click();
  await expect(card.getByTestId('assist-applied')).toBeVisible();
  await expect(dockText(page)).not.toContainText('blocking', { timeout: 60_000 });
});

test('F03 table overflow: the proposal is low risk, Fix all safe issues lists it and applies it as one undoable step', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await demoTool(page, 'seed-d03');
  await page.evaluate(() => localStorage.setItem('iss.validateScope', 'this'));
  await page.getByTestId('nav-S09').click(); // in-app navigation keeps the unsaved defect
  await ready(page);
  await page.locator('[data-testid^="issue-"][data-testid*="FLOW_OVERFLOW"], [data-testid^="issue-"][data-testid*="TABLE_TOTAL"]').first().click();
  const card = page.getByTestId('fix-panel').getByTestId('assist-proposal').first();
  await expect(card).toHaveAttribute('data-risk', 'safe');
  await expect(card).toContainText('Low risk');

  const all = page.getByTestId('fix-all-safe');
  await expect(all).toBeEnabled({ timeout: 30_000 });
  const before = await page.evaluate(() => (window as any).__iss.store.getState().past.length);
  await all.click();
  const dialog = page.getByTestId('fix-all-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('one undoable step');
  expect(await dialog.getByTestId('fix-all-item').count()).toBeGreaterThan(0);
  await expect(dialog.getByTestId('assist-impact').first()).toBeVisible();
  await page.getByTestId('fix-all-apply').click();
  await expect(page.getByTestId('fix-all-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__iss.store.getState().past.length)).toBe(before + 1);
  const flow = () => page.evaluate(() => (window as any).__iss.store.getState().project.nodes.find((n: any) => n.id === 'transaction-table').flowContinuation);
  expect(await flow()).not.toBe(false);
  await page.getByTestId('undo').click();
  expect(await flow()).toBe(false);
  expect(await page.evaluate(() => (window as any).__iss.store.getState().past.length)).toBe(before);
});

test('F04 a missing translation offers a link to Content & Translations and no Apply button', async ({ page }) => {
  await open(page, 'aster-card-demo', 'validate');
  await page.evaluate(() => localStorage.setItem('iss.validateScope', 'all'));
  await page.reload();
  await expect(page.getByTestId('blocker-group').first()).toBeVisible({ timeout: 60_000 });
  await page.locator('[data-testid="blocker-group"][data-code="REQUIRED_TRANSLATION_MISSING"]').first().click();
  await page.getByTestId('blocker-customers').locator('li').first().getByTestId('blocker-open-customer').click();
  await expect(page.getByTestId('scope-this')).toHaveAttribute('aria-pressed', 'true');
  await ready(page);
  await expect(page.locator('[data-testid="issue-REQUIRED_TRANSLATION_MISSING"][aria-current="true"]')).toHaveCount(1, { timeout: 30_000 });
  const panel = page.getByTestId('fix-panel');
  const card = panel.getByTestId('assist-proposal').first();
  await expect(card).toHaveAttribute('data-kind', 'link');
  await expect(panel.getByTestId('assist-apply')).toHaveCount(0);
  await panel.getByTestId('assist-open').first().click();
  await expect(page).toHaveURL(/\/studio\/aster-card-demo\/content/);
});

test('F05 All customers shows proposals for a group, with the effect across the synthetic population', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await demoTool(page, 'seed-d01');
  await page.getByTestId('nav-S09').click();
  await page.getByTestId('scope-all').click();
  await expect(page.getByTestId('blocker-group').first()).toBeVisible({ timeout: 60_000 });
  await page.locator('[data-testid="blocker-group"][data-code="EXCLUSIVE_PRIORITY_TIE"]').first().click();
  const card = page.getByTestId('blocker-detail').getByTestId('fix-panel').getByTestId('assist-proposal').first();
  await expect(card).toBeVisible();
  await expect(card.getByTestId('assist-impact')).toContainText(/synthetic customers/, { timeout: 30_000 });
  await expect(card.getByTestId('assist-apply')).toBeEnabled();
  // Fix all safe issues is available in this view too
  await expect(page.getByTestId('fix-all-safe')).toBeVisible();
});

test('F06 with nothing to fix, Fix all safe issues is disabled and says why', async ({ page }) => {
  await open(page, 'aster-card-demo', 'validate');
  await ready(page);
  const all = page.getByTestId('fix-all-safe');
  await expect(all).toBeDisabled();
  await expect(page.locator('span[title*="No low-risk fixes available"]')).toHaveCount(1);
});
