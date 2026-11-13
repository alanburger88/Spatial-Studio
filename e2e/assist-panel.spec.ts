import { expect, test, type Page } from '@playwright/test';
import { demoTool, open, pickRecord, resetAll } from './helpers';

/**
 * The assistant side panel ("Ask AI" on every studio screen), "Explain this", the change summary in history and review,
 * and the plain-words activity search. Everything here is computed by the studio itself (no AI key needed).
 */

const pid = 'aster-card-demo';
test.beforeEach(async ({ request }) => { await resetAll(request); });

const headerAsk = (page: Page) => page.locator('.screen-head').getByTestId('assist-open');
const panel = (page: Page) => page.getByTestId('assist-panel');

/** Two real edits in one saved version: a rule's priority and a piece of customer-visible wording. */
async function saveTwoEdits(page: Page) {
  await open(page, pid, 'design');
  const out = await page.evaluate(() => {
    const st = (window as any).__iss.store.getState();
    const rule = st.project.rules.find((r: any) => r.id === 'R04');
    const a = st.dispatch({ type: 'UPSERT_RULE', rule: { ...rule, priority: rule.priority + 20 } });
    const part = st.project.contentParts.find((c: any) => c.id === 'payment-assistance-requested') ?? st.project.contentParts[0];
    const b = (window as any).__iss.store.getState().dispatch({ type: 'UPSERT_CONTENT_PART', part: { ...part, approvedLocales: { ...part.approvedLocales, 'en-US': `${part.approvedLocales['en-US']} Call us any time.` } } });
    return { a: a.ok, b: b.ok };
  });
  expect(out).toEqual({ a: true, b: true });
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
}

test('A01 "Ask AI" is on every studio screen but the assistant screen; Escape closes the panel and focus returns; the context names screen, customer and selection', async ({ page }) => {
  const views = ['design', 'exploded/payment-guidance', 'cube', 'landscape', 'page-stack', 'rules-data', 'journey', 'validate', 'outputs', 'demo', 'content', 'activity', 'channels'];
  for (const v of views) {
    await open(page, pid, v);
    await expect(headerAsk(page), v).toHaveCount(1);
  }
  await open(page, pid, 'assistant');
  await expect(page.locator('.screen-head').getByTestId('assist-open')).toHaveCount(0);
  await page.goto('/projects');
  await expect(page.getByTestId('assist-open')).toHaveCount(0);

  await open(page, pid, 'design');
  await page.evaluate(() => (window as any).__iss.store.getState().select('payment-guidance'));
  const ask = headerAsk(page);
  await expect(ask).toHaveAttribute('aria-expanded', 'false');
  await ask.click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute('aria-label', 'Assistant');
  await expect(ask).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('assist-status')).toContainText('Built-in assistant · no AI key');
  const sees = page.getByTestId('assist-sees');
  await expect(sees).toContainText('Design Studio');
  await expect(sees).toContainText('Jordan Mercer');
  await expect(sees).toContainText('Payment guidance');
  await expect(page.locator('[data-testid="assist-action"][data-action="explain"]')).toBeVisible();
  await expect(page.locator('[data-testid="assist-action"][data-action="summary"]')).toBeVisible();
  const n = await page.getByTestId('assist-action').count();
  expect(n).toBeGreaterThanOrEqual(2);
  expect(n).toBeLessThanOrEqual(4);
  // focus is inside the panel; Escape closes it and puts focus back on the opener
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="assist-panel"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(ask).toBeFocused();
  // the panel keeps following the screen: Rules & Data offers its own actions
  await ask.click();
  await page.getByTestId('nav-S07').click();
  await expect(page.getByTestId('assist-sees')).toContainText('Rules & Data');
  await expect(page.locator('[data-testid="assist-action"][data-action="describe"]')).toBeVisible();
  await expect(page.locator('[data-testid="assist-action"][data-action="coverage"]')).toBeVisible();
  await page.getByTestId('assist-close').click();
  await expect(panel(page)).toHaveCount(0);
});

test('A02 Explain on the Exploded Document names the winning rule, follows the customer, and says why nothing is chosen after a tie', async ({ page }) => {
  await open(page, pid, 'exploded/payment-guidance');
  await page.getByTestId('explain-node').click();
  const card = page.getByTestId('assist-explanation');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('assist-explanation-headline')).toContainText('because the rule');
  expect(await page.getByTestId('assist-explanation-steps').locator('li').count()).toBeGreaterThanOrEqual(1);
  await expect(card.locator('[data-testid="assist-explanation-rule"][data-rule-id="R01"]')).toContainText('Customer is up to date');
  await expect(card.getByTestId('assist-source')).toContainText('Built-in');
  const first = await page.getByTestId('assist-explanation-headline').innerText();

  await pickRecord(page, 'CARD-0002');
  await expect(page.getByTestId('assist-explanation-headline')).not.toHaveText(first);
  await expect(card.locator('[data-rule-id="R03"], [data-rule-id="R04"]').first()).toBeVisible();

  await demoTool(page, 'seed-d01');
  const tied = page.getByTestId('assist-explanation-headline');
  await expect(tied).toContainText('Nothing can be chosen');
  await expect(tied).toContainText('two rules match with the same priority');

  await card.locator('[data-testid="assist-open-rule"]').first().click();
  await expect(page).toHaveURL(/rules-data\?rule=R0\d/);
  await expect(panel(page)).toHaveCount(0);
});

test('A03 the Ask tab shares its conversation with the AI Assistant screen', async ({ page }) => {
  await open(page, pid, 'design');
  await headerAsk(page).click();
  await page.getByTestId('assist-tab-chat').click();
  await page.getByTestId('assistant-input').fill('What rules apply?');
  await page.getByTestId('assistant-send').click();
  await expect(panel(page).getByTestId('assistant-reply').first()).toBeVisible();
  await page.getByTestId('nav-S12').click();
  await expect(page.getByTestId('assistant-view')).toBeVisible();
  await expect(panel(page)).toHaveCount(0); // the screen is the full-size version of the panel
  await expect(page.getByText('What rules apply?').first()).toBeVisible();
  await expect(page.getByTestId('assistant-reply').first()).toBeVisible();
  // and back: the panel (still open) shows the same single exchange
  await page.getByTestId('nav-S02').click();
  await expect(panel(page)).toBeVisible();
  await page.getByTestId('assist-tab-chat').click();
  await expect(panel(page).getByTestId('assistant-reply')).toHaveCount(1);
});

test('A04 change summary: both edits under the right areas with an impact line; no edits say "No changes"; review shows it too', async ({ page }) => {
  await saveTwoEdits(page);
  await page.getByTestId('open-history').click();
  const hist = page.getByTestId('history-panel');
  await expect(hist).toBeVisible();
  await expect(hist.getByTestId('history-version').first()).toBeVisible();
  await hist.getByTestId('summary-open').click();
  const sum = hist.getByTestId('change-summary');
  await expect(sum).toBeVisible();
  await expect(sum.locator('[data-area="rules"]')).toHaveCount(1);
  await expect(sum.locator('[data-area="wording"]')).toHaveCount(1);
  await expect(sum.getByTestId('summary-impact')).toContainText(/\d+ of \d+ synthetic customers get different messages or sections/);
  await expect(sum.getByTestId('assist-source')).toContainText('Built-in');
  // an example customer switches the top-bar customer
  const ex = sum.getByTestId('summary-example').first();
  if (await ex.count()) {
    const id = await ex.getAttribute('data-record-id');
    await ex.click();
    await expect(page.getByTestId('record-selector')).toHaveAttribute('data-value', id!);
  }
  await page.keyboard.press('Escape');
  await expect(hist).toHaveCount(0);

  // nothing changed since the last save: the panel's summary says so
  await headerAsk(page).click();
  await page.locator('[data-testid="assist-action"][data-action="summary"]').click();
  await expect(page.getByTestId('change-summary')).toContainText('No changes');

  // submit for review: the review panel shows the same summary above the actions
  await page.getByTestId('workflow-status').click();
  const review = page.getByTestId('review-panel');
  await expect(review).toBeVisible();
  // (a project reset does not clear the review state, so the document may already be in review from an earlier run)
  await expect(review.getByTestId('review-state')).toBeVisible();
  if ((await review.getByTestId('review-state').getAttribute('data-state')) !== 'in_review') {
    const submit = review.getByTestId('workflow-action-submit');
    await expect(submit).toBeEnabled();
    await submit.click();
  }
  await expect(review.getByTestId('review-state')).toHaveAttribute('data-state', 'in_review');
  await expect(review.getByTestId('review-summary').getByTestId('change-summary')).toBeVisible();
  await expect(review.getByTestId('review-summary')).toContainText(/Rule|rule/);
  const box = await review.getByTestId('review-summary').boundingBox();
  const act = await review.getByTestId('workflow-action-approve').boundingBox();
  expect(box!.y).toBeLessThan(act!.y);
});

test('A05 activity search: "saves today" shows the save with chips, a nonsense word is ignored, clearing restores the list', async ({ page }) => {
  await saveTwoEdits(page);
  await open(page, pid, 'activity');
  const save = page.locator('[data-testid="activity-row"][data-action="project.save"]');
  await expect(save.first()).toBeVisible();
  const resets = page.locator('[data-testid="activity-row"][data-action="project.reset"]');
  const before = await page.getByTestId('activity-row').count();

  await page.getByTestId('activity-search').fill('saves today');
  await page.getByTestId('activity-search').press('Enter');
  const chips = page.getByTestId('activity-understood');
  await expect(chips).toContainText('Area: Saves');
  await expect(chips).toContainText('From');
  await expect(save.first()).toBeVisible();
  await expect(resets).toHaveCount(0);
  await expect(page.getByTestId('activity-filter-action')).toHaveValue('project.save');

  await page.getByTestId('activity-search').fill('saves today zzqxv');
  await page.getByTestId('activity-search-go').click();
  await expect(page.getByTestId('activity-ignored')).toContainText('zzqxv');
  await expect(save.first()).toBeVisible();

  // a chip can be removed on its own
  await chips.locator('[data-facet="action"] button').click();
  await expect(chips).not.toContainText('Area: Saves');
  await expect(resets.first()).toBeVisible();

  await page.getByTestId('activity-search-clear').click();
  await expect(page.getByTestId('activity-understood')).toHaveCount(0);
  await expect(page.getByTestId('activity-ignored')).toHaveCount(0);
  await expect(page.getByTestId('activity-filter-action')).toHaveValue('');
  await expect(page.getByTestId('activity-row')).toHaveCount(before);

  // words are matched on the client within what was fetched
  await page.getByTestId('activity-search').fill('rule changes');
  await page.getByTestId('activity-search-go').click();
  await expect(page.getByTestId('activity-understood')).toContainText('Words:');
});

test('A06 at 1280x720 the panel stays between the top bar and the status bar and sits beside the Demo tools panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page, pid, 'design');
  await headerAsk(page).click();
  await expect(panel(page)).toBeVisible();
  await page.waitForTimeout(400);
  const p = (await panel(page).boundingBox())!;
  const top = (await page.locator('header.topbar').boundingBox())!;
  const dock = (await page.locator('footer.dock').boundingBox())!;
  expect(p.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
  expect(p.y + p.height).toBeLessThanOrEqual(dock.y + 1);
  expect(p.x + p.width).toBeLessThanOrEqual(1280 + 1);
  // the top bar's own controls are still clickable with the panel open
  await expect(page.getByTestId('save-project')).toBeVisible();
  await page.getByTestId('open-demo-tools').click();
  const demo = page.getByTestId('demo-tools');
  await expect(demo).toBeVisible();
  await page.waitForTimeout(300);
  const d = (await demo.boundingBox())!;
  expect(d.x + d.width).toBeLessThanOrEqual(p.x + 1);
  await expect(page.getByTestId('assist-close')).toBeVisible();
  await page.getByTestId('assist-close').click();
  await expect(panel(page)).toHaveCount(0);
});
