import { expect, test, type Page } from '@playwright/test';
import { open, resetAll } from './helpers';
import { gotoScreen } from './nav-helper';

/**
 * Ask about all customers (wave 4, item 7), on the four example documents. The test stack has no AI key: every question
 * here is read by the built-in reader, and every answer is worked out by the engine from every synthetic customer.
 */

test.beforeEach(async ({ request }) => { await resetAll(request); });
test.afterAll(async ({ request }) => { await resetAll(request); });

async function askPanel(page: Page, project: string, view = 'overview') {
  await open(page, project, view);
  await page.getByTestId('assist-open').click();
  await page.getByTestId('assist-tab-all').click();
  await expect(page.getByTestId('ask-all')).toBeVisible();
}
async function ask(page: Page, question: string) {
  await page.getByTestId('ask-input').fill(question);
  await page.getByTestId('ask-submit').click();
}
const answer = (page: Page) => page.getByTestId('ask-answer');

test('AQ01 Aster Card: who gets the payment support offer, and who is stopped — the same count as the Blockers screen, each blocker one click away', async ({ page }) => {
  await askPanel(page, 'aster-card-demo');
  // Examples made from this document's own names.
  const examples = page.getByTestId('ask-example');
  expect(await examples.count()).toBeGreaterThanOrEqual(3);
  await expect(examples.filter({ hasText: 'Who is stopped, and by what?' })).toHaveCount(1);

  await ask(page, 'who gets the payment support offer');
  await expect(answer(page)).toHaveAttribute('data-count', '0');
  await expect(answer(page)).toHaveAttribute('data-total', '70');
  await expect(page.getByTestId('ask-understood')).toContainText('Which customers get “Payment support” in Payment guidance?');
  await expect(page.getByTestId('ask-read-by')).toHaveAttribute('data-source', 'builtin');
  await expect(page.getByTestId('ask-count')).toHaveText('0 of 70 synthetic customers');
  await expect(page.getByTestId('ask-open-landscape')).toBeDisabled();

  await examples.filter({ hasText: 'Who is stopped, and by what?' }).click();
  await expect(page.getByTestId('ask-count')).toHaveText('6 of 70 synthetic customers');
  await expect(page.getByTestId('ask-reason')).toHaveCount(4);
  await expect(page.getByTestId('ask-customer')).toHaveCount(6);
  // The Blockers screen says the same.
  const first = page.getByTestId('ask-open-blocker').first();
  const id = await first.getAttribute('data-blocker');
  await first.click();
  await expect(page.getByTestId('blockers-screen')).toBeVisible();
  await expect(page.getByTestId('bl-stopped')).toHaveText('6');
  await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', id!);
});

test('AQ02 Northwind: who gets the winter heating help in Spanish — 7 of 34, with the reason; Landscape and Data Explorer open on the same 7', async ({ page }) => {
  await askPanel(page, 'northwind-energy-demo');
  await ask(page, 'who gets the winter heating help in Spanish');
  await expect(page.getByTestId('ask-count')).toHaveText('7 of 34 synthetic customers');
  await expect(page.getByTestId('ask-understood')).toContainText('Which customers get the section “Winter heating help”, among customers whose language is Spanish?');
  await expect(page.getByTestId('ask-reason').first()).toContainText('Shown when services on the account is one of');
  await expect(page.getByTestId('ask-note').first()).toContainText('whose language is Spanish are counted: 10 of 34');
  const ids = await page.getByTestId('ask-customer').evaluateAll((els) => els.map((e) => e.getAttribute('data-record')));
  expect(ids).toHaveLength(7);

  await page.getByTestId('ask-open-landscape').click();
  await expect(page.getByTestId('landscape-view')).toBeVisible();
  await expect(page.getByTestId('landscape-only')).toHaveAttribute('data-n', '7');
  await expect(page.getByTestId('landscape-evaluated')).toContainText('7 synthetic scenarios');
  await expect(page).toHaveURL(new RegExp(`customers=${encodeURIComponent(ids.join(','))}`));
  await page.getByTestId('landscape-only-clear').click();
  await expect(page.getByTestId('landscape-only')).toHaveCount(0);
  await expect(page.getByTestId('landscape-evaluated')).toContainText('34 synthetic scenarios');

  await page.goBack();
  await page.goBack();
  await askPanel(page, 'northwind-energy-demo');
  await ask(page, 'who gets the winter heating help in Spanish');
  await page.getByTestId('ask-open-data').click();
  await expect(page.getByTestId('data-explorer')).toBeVisible();
  await expect(page.getByTestId('dx-only')).toHaveAttribute('data-n', '7');
  const rows = page.getByTestId('dx-list').getByRole('option');
  await expect(rows).toHaveCount(7);
  expect((await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).sort()).toEqual([...ids].sort());
  await page.getByTestId('dx-only-clear').click();
  await expect(rows).toHaveCount(34);
});

test('AQ03 Meridian: who gets the concentration notice but not the fall notice — the overlap is left out and said; “show all” lists every customer', async ({ page }) => {
  await askPanel(page, 'meridian-wealth-demo');
  await ask(page, 'who gets the concentration notice but not the fall notice');
  await expect(page.getByTestId('ask-count')).toHaveText('16 of 34 synthetic customers');
  await expect(page.getByTestId('ask-understood')).toContainText('but not the section “Fall in value notice”');
  await expect(page.getByTestId('ask-note').first()).toHaveText('1 customer who gets it also gets the section “Fall in value notice”, so is left out.');
  await expect(page.getByTestId('ask-customer')).toHaveCount(10);
  await page.getByTestId('ask-show-all').click();
  await expect(page.getByTestId('ask-customer')).toHaveCount(16);
});

test('AQ04 HarborCare: who is stopped — nobody of 30; a “why” about one customer comes from the engine’s trace', async ({ page }) => {
  await askPanel(page, 'harborcare-demo');
  await ask(page, 'who is stopped');
  await expect(page.getByTestId('ask-count')).toHaveText('0 of 30 synthetic customers');
  await expect(page.getByTestId('ask-open-data')).toBeDisabled();
  await ask(page, 'why does EOB-0002 get the claim under review');
  const why = page.getByTestId('ask-why');
  await expect(why).toBeVisible();
  await expect(why).toHaveAttribute('data-gets', /yes|no/);
  await expect(page.getByTestId('ask-understood')).toContainText('Why does');
});

test('AQ05 an ambiguous name is asked back with the candidates as buttons; a request to change something, or a sentence the reader cannot read, is said plainly', async ({ page }) => {
  await askPanel(page, 'northwind-energy-demo');
  await ask(page, 'who gets the electricity rate');
  const back = page.getByTestId('ask-askback');
  await expect(back).toContainText('Which one?');
  expect(await back.getByTestId('ask-choice').count()).toBeGreaterThanOrEqual(2);
  await expect(answer(page)).toHaveCount(0);
  await back.getByTestId('ask-choice').first().click();
  await expect(answer(page)).toBeVisible();
  await expect(page.getByTestId('ask-understood')).toContainText('Rate notice');

  await ask(page, 'delete every customer in Spanish');
  await expect(page.getByTestId('ask-notread')).toHaveAttribute('data-kind', 'refused');
  await expect(page.getByTestId('ask-notread')).toContainText('does not change, approve or send anything');
  await ask(page, 'which of them is most likely to complain');
  await expect(page.getByTestId('ask-notread')).toHaveAttribute('data-kind', 'unknown');
  await expect(page.getByTestId('ask-notread')).toContainText('Free sentences need an AI key');
});

test('AQ06 the answer follows the open document: switching off the rule that shows a section brings the count to 0 at once', async ({ page }) => {
  await askPanel(page, 'aster-card-demo');
  await ask(page, 'how many get the relationship team');
  await expect(page.getByTestId('ask-count')).toHaveText('11 of 70 synthetic customers');
  await expect(page.getByTestId('ask-reason').first()).toContainText('Premium tier — show relationship team');
  const rule = await page.evaluate(() => (window as any).__iss.store.getState().project.rules.find((r: any) => r.id === 'R06'));
  const r = await page.evaluate((x) => (window as any).__iss.store.getState().dispatch({ type: 'UPSERT_RULE', rule: { ...x, enabled: false } }), rule);
  expect(r.ok).toBe(true);
  await expect(page.getByTestId('ask-count')).toHaveText('0 of 70 synthetic customers');
});

test('AQ07 the AI Assistant screen has the same card, and the panel tabs move with the arrow keys', async ({ page }) => {
  await open(page, 'aster-card-demo', 'overview');
  await gotoScreen(page, 'S12');
  const card = page.getByTestId('ai-ask-all');
  await expect(card.getByTestId('ask-all')).toBeVisible();
  await card.getByTestId('ask-input').fill('who matches rule R07');
  await card.getByTestId('ask-submit').click();
  await expect(card.getByTestId('ask-count')).toHaveText('6 of 70 synthetic customers');

  await open(page, 'harborcare-demo', 'overview');
  await page.getByTestId('assist-open').click();
  await page.getByTestId('assist-tab-help').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('assist-tab-all')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('assist-tab-all')).toBeFocused();
});
