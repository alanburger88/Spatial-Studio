/**
 * The assistant's engine explanation stays readable in the narrow side panel (stacked, in plain words, names not codes),
 * and the panel can be resized by dragging its left edge or with the keyboard; the width is remembered.
 */
import { test, expect, type Page } from '@playwright/test';
import { open, pickRecord, resetAll, setView } from './helpers';

test.beforeEach(async ({ request }) => { await resetAll(request); });

const panel = (page: Page) => page.getByTestId('assist-panel');
const widthOf = (page: Page) => panel(page).evaluate((el) => Math.round(el.getBoundingClientRect().width));

async function askForExplanation(page: Page) {
  await open(page, 'aster-card-demo', 'design');
  await pickRecord(page, 'CARD-0002');
  await page.evaluate(() => (window as any).__iss.store.getState().select('payment-guidance'));
  await page.locator('.screen-head').getByTestId('assist-open').click();
  await page.getByTestId('assist-tab-chat').click();
  await page.getByTestId('assistant-input').fill('Explain the selected variant');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('assistant-explanation').last()).toBeVisible();
}

test('X01 the explanation is stacked and in plain words at the panel\'s usual width: rule names, plain conditions, formatted values, nothing squashed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await askForExplanation(page);
  const card = page.getByTestId('assistant-explanation').last();
  await expect(card.getByTestId('assistant-explanation-headline')).toContainText('is decided by the rule “Customer asked for payment assistance”');
  const items = card.getByTestId('assistant-evidence');
  expect(await items.count()).toBeGreaterThan(2);
  const winner = card.locator('[data-testid="assistant-evidence"][data-outcome="selected"]');
  await expect(winner).toContainText('Customer asked for payment assistance');
  await expect(winner).toContainText('Applied');
  await expect(winner).toContainText('Assistance requested is yes');
  await expect(winner).toContainText('Assistance requested: yes');
  await expect(items.filter({ hasText: 'Did not apply' }).first()).toBeVisible();
  // names, not codes, in what is shown; the ids and raw paths are still there as collapsed proof
  const visible = await card.evaluate((el) => (el as HTMLElement).innerText);
  expect(visible).not.toMatch(/card\.[a-zA-Z]+/);
  expect(visible).not.toMatch(/\bR0\d\b/);
  await expect(card).toContainText('R04');
  await expect(card).toContainText(/deterministic resolver trace/i);
  // nothing is squashed or scrolls the conversation sideways
  const log = panel(page).locator('.ai-log');
  expect(await log.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const head = await winner.locator('.ai-ev-head strong').boundingBox();
  expect(head!.width).toBeGreaterThan(120);
  // Technical view opens the trace table, which scrolls inside its own box instead of breaking words
  await setView(page, 'technical');
  const table = page.getByTestId('assistant-explanation').last().locator('table.ai-evidence-table');
  await expect(table).toBeVisible();
  expect((await table.locator('th').first().boundingBox())!.height).toBeLessThan(40);
});

test('X02 the panel is resized by dragging its left edge or with the arrow keys; the width is remembered; double-click resets it', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await open(page, 'aster-card-demo', 'design');
  await page.locator('.screen-head').getByTestId('assist-open').click();
  await expect(panel(page)).toBeVisible();
  expect(await widthOf(page)).toBe(380);
  const handle = page.getByTestId('assist-resizer');
  await expect(handle).toHaveAttribute('aria-valuenow', '380');
  // the panel slides in; wait until its edge has settled before grabbing it
  await expect.poll(async () => Math.round((await handle.boundingBox())!.x)).toBeLessThanOrEqual(1600 - 380 - 3);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 260, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => widthOf(page)).toBe(640);
  await expect(handle).toHaveAttribute('aria-valuenow', '640');
  // keyboard
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => widthOf(page)).toBe(664);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => widthOf(page)).toBe(616);
  // it cannot be dragged narrower than its minimum or wider than most of the window
  await page.keyboard.press('End');
  await expect.poll(() => widthOf(page)).toBe(960);
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(() => widthOf(page)).toBe(340);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => widthOf(page)).toBe(388);
  // remembered after a reload
  await page.reload();
  await page.locator('.screen-head').getByTestId('assist-open').click();
  await expect.poll(() => widthOf(page)).toBe(388);
  // double-click returns to the usual width
  await page.getByTestId('assist-resizer').dblclick();
  await expect.poll(() => widthOf(page)).toBe(380);
});

test('X03 in a narrow window the panel is full width and has no resize handle', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await open(page, 'aster-card-demo', 'design');
  await page.locator('.screen-head').getByTestId('assist-open').click();
  await expect.poll(() => widthOf(page)).toBe(1000);
  await expect(page.getByTestId('assist-resizer')).toBeHidden();
});
