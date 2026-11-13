/** Rules & Data assistants: describe a rule, review my rules, coverage gaps. */
import { test, expect, type Page } from '@playwright/test';
import { demoTool, open, resetAll } from './helpers';

const SHOTS = process.env.SHOTS_DIR; // optional: write screenshots here
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

test.beforeEach(async ({ request }) => { await resetAll(request); });

const ruleCount = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().project.rules.length as number);
const testCount = (page: Page) => page.evaluate(() => ((window as any).__iss.store.getState().project.testCases ?? []).length as number);

async function describe(page: Page, sentence: string) {
  await page.getByTestId('rule-describe-button').click();
  await page.getByTestId('rule-describe-input').fill(sentence);
  await page.getByTestId('rule-describe-submit').click();
  await expect(page.getByTestId('rule-describe-result')).toBeVisible();
}

test('describe a rule: restated, impact shown, opens as an unsaved draft, saving adds it and Undo removes it', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  const before = await ruleCount(page);
  await describe(page, 'When the new balance is over $500, show the payment reminder');
  const result = page.getByTestId('rule-describe-result');
  await expect(result).toHaveAttribute('data-mode', 'builtin');
  await expect(result).toHaveAttribute('data-has-rule', 'true');
  await expect(page.getByTestId('rule-describe-restatement')).toContainText(/balance/i);
  await expect(page.getByTestId('rule-describe-restatement')).toContainText(/\$500/);
  await expect(result.getByTestId('assist-source')).toHaveAttribute('data-source', 'builtin');
  await expect(result.getByTestId('assist-source')).toHaveText('Built-in');
  await shot(page, 'describe-result');
  // nothing saved yet
  expect(await ruleCount(page)).toBe(before);

  await page.getByTestId('rule-describe-open').click();
  await expect(page.getByTestId('rule-describe')).toHaveCount(0);
  await expect(page.getByTestId('draft-chip')).toContainText('not in model');
  await expect(page.getByTestId('cond-0-op')).toHaveValue('gt');
  await expect(page.getByTestId('cond-0-value').locator('input')).toHaveValue('50000');
  await expect(page.getByTestId('action-op')).toHaveValue('selectVariant');
  await expect(page.getByTestId('action-variant')).toContainText(/reminder/i);
  await expect(page.getByTestId('rule-impact')).toBeVisible();
  expect(await ruleCount(page)).toBe(before);

  await page.getByTestId('apply-rule-change').click();
  expect(await ruleCount(page)).toBe(before + 1);
  await page.getByTestId('undo').click();
  expect(await ruleCount(page)).toBe(before);
});

test('describe a rule: an ambiguous sentence shows what it could mean and no rule', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await describe(page, 'If the balance is over $500, show the payment reminder');
  const result = page.getByTestId('rule-describe-result');
  await expect(result).toHaveAttribute('data-has-rule', 'false');
  await expect(result).toContainText(/could mean/i);
  await expect(page.getByTestId('rule-describe-open')).toHaveCount(0);
  // the text is kept so it can be rephrased
  await expect(page.getByTestId('rule-describe-input')).toHaveValue('If the balance is over $500, show the payment reminder');
  await shot(page, 'describe-ambiguous');
});

test('describe a rule: a sentence the built-in reader cannot read shows the needs-AI state', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await describe(page, 'Customers who seem anxious about money should feel reassured by something kind near the top');
  await expect(page.getByTestId('rule-describe-result')).toHaveAttribute('data-has-rule', 'false');
  await expect(page.getByTestId('assist-needs-ai')).toBeVisible();
  await expect(page.getByTestId('assist-needs-ai')).toContainText('AI');
  await expect(page.getByTestId('rule-describe-open')).toHaveCount(0);
  await shot(page, 'describe-needs-ai');
});

test('review my rules: the untouched sample has no blocking items; a tie is reported and its fix removes it', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await page.getByTestId('rules-review').click();
  const summary = page.getByTestId('rules-review-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toHaveAttribute('data-blocking', '0');
  await expect(page.locator('[data-testid="rules-review-item"][data-severity="blocking"]')).toHaveCount(0);
  // the rules validation reports as not reached are listed
  const unreachable = page.locator('[data-testid="rules-review-item"][data-kind="unreachable"]');
  expect(await unreachable.count()).toBeGreaterThan(0);
  await shot(page, 'review-clean');
  await page.keyboard.press('Escape');

  await demoTool(page, 'seed-d01');
  await page.getByTestId('rules-review').click();
  const tie = page.locator('[data-testid="rules-review-item"][data-kind="tie"][data-severity="blocking"]');
  await expect(tie.first()).toBeVisible();
  await shot(page, 'review-tie');
  const apply = tie.first().getByTestId('assist-apply');
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.locator('[data-testid="rules-review-item"][data-kind="tie"]')).toHaveCount(0);
  await expect(page.getByTestId('rules-review-summary')).toHaveAttribute('data-blocking', '0');
});

test('coverage: lists the unreached rules, previews a scenario in the top bar, pins a passing test, one Undo removes it', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await page.getByTestId('coverage-open').click();
  await expect(page.getByTestId('coverage-summary')).toBeVisible();
  await expect(page.getByTestId('coverage-summary')).toContainText('are exercised by the');
  const ruleGaps = page.locator('[data-testid="coverage-gap"][data-kind="rule"]');
  expect(await ruleGaps.count()).toBe(2); // the two rules validation already reports as not reached
  await shot(page, 'coverage-panel');

  const first = ruleGaps.first();
  const target = (await first.getAttribute('data-target'))!;
  await expect(first.getByTestId('coverage-scenario')).toBeVisible();
  const before = await testCount(page);
  await first.getByTestId('coverage-pin').click();
  await expect(first.getByTestId('coverage-pinned')).toHaveText('Pinned');
  expect(await testCount(page)).toBe(before + 1);
  // Undo is in the top bar, behind the dialog: close the dialog first. One Undo removes the pinned test.
  await page.keyboard.press('Escape');
  await page.getByTestId('undo').click();
  expect(await testCount(page)).toBe(before);

  // pin again, then preview
  await page.getByTestId('coverage-open').click();
  const row = page.locator(`[data-testid="coverage-gap"][data-target="${target}"]`);
  await row.getByTestId('coverage-pin').click();
  await expect(row.getByTestId('coverage-pinned')).toBeVisible();
  await row.getByTestId('coverage-preview').click();
  await expect(page.getByTestId('coverage-panel')).toHaveCount(0);
  await expect(page.getByTestId('coverage-preview-note')).toBeVisible();
  const recordNow = await page.getByTestId('record-selector').getAttribute('data-value');
  const scenario = await page.evaluate(() => (window as any).__iss.store.getState().ctx);
  expect(recordNow).toBe(scenario.recordId);
  expect(recordNow).toBeTruthy();
  await expect(page.getByTestId(`rule-row-${target}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId(`trace-${target}`)).toContainText('Matched');
  await shot(page, 'coverage-preview');

  // the pinned test passes
  await page.getByTestId('rules-view-tests').click();
  const rows = page.getByTestId('test-row');
  await expect(rows).toHaveCount(before + 1);
  await expect(rows.last().getByTestId('test-status')).toContainText('Pass');
});
