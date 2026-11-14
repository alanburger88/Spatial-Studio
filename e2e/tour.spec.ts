/**
 * The first-visit tour: offered once on Overview (never opened by itself), nine steps in the order of work, each pointing at
 * a real, visible element on the right screen. Runs against the real local stack (E2E_API / E2E_WEB); no AI is called.
 */
import { test, expect, type Page } from '@playwright/test';
import { open, resetAll } from './helpers';

/** What each step must show: the address it moves to and the element it points at. */
const STEPS: Array<{ id: string; url: RegExp; target: string }> = [
  { id: 'overview', url: /\/overview$/, target: 'overview-steps' },
  { id: 'customer', url: /\/overview$/, target: 'ctx-customer' },
  { id: 'design', url: /\/design$/, target: 'section-tabs' },
  { id: 'rules-data', url: /\/rules-data$/, target: 'nav-section-rules-data' },
  { id: 'explore', url: /\/exploded/, target: 'nav-section-explore' },
  { id: 'check', url: /\/blockers$/, target: 'nav-section-check' },
  { id: 'releases', url: /\/releases$/, target: 'nav-section-releases' },
  { id: 'assistant', url: /\/releases$/, target: 'assist-open' },
  { id: 'help', url: /\/activity$/, target: 'nav-section-help' },
];

test.beforeEach(async ({ request }) => { await resetAll(request); });

const card = (page: Page) => page.getByTestId('tour');
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Walk every step: right screen, right element visible, the highlight on it, the card inside the window. */
async function walk(page: Page) {
  const vp = page.viewportSize()!;
  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i];
    await expect(card(page)).toHaveAttribute('data-step', s.id);
    await expect(page.getByTestId('tour-count')).toHaveText(`Step ${i + 1} of ${STEPS.length}`);
    await expect(page).toHaveURL(s.url);
    const target = page.getByTestId(s.target).first();
    await expect(target).toBeVisible();
    await expect(card(page)).toHaveAttribute('data-target-found', 'true');
    // the text names the thing as well: the highlight is never the only cue
    await expect(card(page)).toContainText(/\w{4,}/);
    await expect.poll(async () => {
      const t = await target.boundingBox(); const sp = await page.getByTestId('tour-spot').boundingBox();
      return !!t && !!sp && overlaps(t, sp);
    }, { message: `the highlight sits on ${s.target}` }).toBe(true);
    await expect.poll(async () => {
      const c = (await card(page).boundingBox())!;
      return c.x >= 0 && c.y >= 0 && c.x + c.width <= vp.width && c.y + c.height <= vp.height;
    }, { message: 'the card is inside the window' }).toBe(true);
    // the card does not cover what it points at
    await expect.poll(async () => {
      const t = await target.boundingBox(); const c = await card(page).boundingBox();
      return !!t && !!c && !overlaps(t, c);
    }, { message: 'the card does not cover the highlighted element' }).toBe(true);
    if (i < STEPS.length - 1) await page.getByTestId('tour-next').click();
  }
  await expect(page.getByTestId('tour-next')).toHaveText('Done');
  await page.getByTestId('tour-next').click();
  await expect(card(page)).toHaveCount(0);
}

test('TR01 it is offered once, on the first visit to Overview, and nowhere else; it never opens by itself', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await expect(page.getByTestId('tour-prompt')).toHaveCount(0);
  await open(page, 'aster-card-demo', 'overview');
  const prompt = page.getByTestId('tour-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Take a two-minute tour');
  await expect(card(page)).toHaveCount(0);
  // non-modal and covering nothing: it sits above the screen, and the screen's own buttons are the ones that receive clicks
  const p = (await prompt.boundingBox())!;
  const steps = (await page.getByTestId('overview-steps').boundingBox())!;
  expect(p.y + p.height).toBeLessThanOrEqual(steps.y);
  const btn = page.getByTestId('overview-step-action-customers');
  const hit = await btn.evaluate((el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el || el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
  expect(hit).toBe(true);
  // remembered: not offered again, not even on Overview
  await page.reload();
  await expect(page.locator('#main section.screen').first()).toBeVisible();
  await expect(page.getByTestId('tour-prompt')).toHaveCount(0);
  const stored = await page.evaluate(() => localStorage.getItem('iss.tour.offered'));
  expect(stored).not.toBeNull();
});

test('TR02 "Not now" dismisses the offer and hands focus back to the page', async ({ page }) => {
  await open(page, 'aster-card-demo', 'overview');
  await page.getByTestId('tour-prompt-dismiss').click();
  await expect(page.getByTestId('tour-prompt')).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator('#main')).toBeFocused();
});

test('TR03 every step points at a real, visible element on the right screen (1440 wide)', async ({ page }) => {
  await open(page, 'aster-card-demo', 'overview');
  await page.getByTestId('tour-prompt-start').click();
  await expect(page.getByTestId('tour-prompt')).toHaveCount(0);
  await expect(card(page)).toBeVisible();
  await walk(page);
});

test('TR04 it works with the menu collapsed, and at 1000 and 1280 px wide', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('iss.navCollapsed', '1'); } catch { /* */ } });
  for (const [w, h] of [[1280, 720], [1000, 700]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await open(page, 'aster-card-demo', 'overview');
    await page.getByTestId('open-settings').click();
    await page.getByTestId('menu-take-tour').click();
    await expect(card(page)).toBeVisible();
    await walk(page);
  }
  await expect(page.getByTestId('nav-toggle')).toContainText('Expand menu');
});

test('TR05 Next, Back, Skip and Esc; focus is moved to the step and given back', async ({ page }) => {
  await open(page, 'aster-card-demo', 'overview');
  const settings = page.getByTestId('open-settings');
  await settings.click(); await page.getByTestId('menu-take-tour').click();
  await expect(card(page)).toBeFocused();
  await expect(page.getByTestId('tour-back')).toBeDisabled();
  await page.getByTestId('tour-next').click();
  await expect(card(page)).toHaveAttribute('data-step', 'customer');
  await expect(card(page)).toBeFocused();
  await page.getByTestId('tour-next').click();
  await expect(page).toHaveURL(/\/design$/);
  await page.getByTestId('tour-back').click();
  await expect(card(page)).toHaveAttribute('data-step', 'customer');
  await expect(page).toHaveURL(/\/overview$/);
  // Tab stays on the step
  for (let k = 0; k < 6; k++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid=tour]'))).toBe(true); }
  // Esc closes and focus goes back to where it was
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(settings).toBeFocused();
  // Skip closes too, from a later step on another screen
  await settings.click(); await page.getByTestId('menu-take-tour').click();
  await page.getByTestId('tour-next').click(); await page.getByTestId('tour-next').click(); await page.getByTestId('tour-next').click();
  await expect(page).toHaveURL(/\/rules-data$/);
  await page.getByTestId('tour-skip').click();
  await expect(card(page)).toHaveCount(0);
  await expect(settings).toBeFocused();
  // and it starts from the first step again
  await settings.click(); await page.getByTestId('menu-take-tour').click();
  await expect(card(page)).toHaveAttribute('data-step', 'overview');
  await expect(page).toHaveURL(/\/overview$/);
});

test('TR06 it can be restarted from Help and from the Help & activity tab row', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await page.keyboard.press('?');
  await expect(page.getByTestId('help-sheet')).toBeVisible();
  await page.getByTestId('help-start-tour').click();
  await expect(page.getByTestId('help-sheet')).toHaveCount(0);
  await expect(card(page)).toHaveAttribute('data-step', 'overview');
  await expect(page).toHaveURL(/\/overview$/);
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);

  await page.getByTestId('nav-section-help').click();
  await expect(page.getByTestId('section-tabs')).toBeVisible();
  await page.getByTestId('tour-restart').click();
  await expect(card(page)).toHaveAttribute('data-step', 'overview');
  await expect(page).toHaveURL(/\/overview$/);
  await page.getByTestId('tour-skip').click();
  await expect(card(page)).toHaveCount(0);
});

test('TR07 it respects reduced motion and the dark theme', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => { try { localStorage.setItem('iss.theme', 'dark'); } catch { /* */ } });
  await open(page, 'aster-card-demo', 'overview');
  await page.getByTestId('tour-prompt-start').click();
  await expect(page.getByTestId('tour-spot')).toBeVisible();
  const dur = await page.getByTestId('tour-spot').evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(dur.split(',').every((d) => parseFloat(d) === 0)).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const bg = await card(page).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgb(255, 255, 255)');
  await page.getByTestId('tour-skip').click();
});
