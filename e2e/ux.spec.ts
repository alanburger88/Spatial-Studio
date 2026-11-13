/**
 * Browser tests for the v0.4 UX pass: grouped menu, labelled top bar + settings menu, Demo tools panel,
 * automatic validation/preview, pre-selected detail panels, four inspector tabs, names-first Business view,
 * gallery card menu, narrow-window drawers and the small-screen notice.
 * Runs against the real local stack, like acceptance.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { API, demoTool, open, pickRecord, resetAll, setView } from './helpers';

test.beforeEach(async ({ request }) => { await resetAll(request); });

test('U01 menu is grouped by job and keeps every screen; top bar controls are labelled', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  const nav = page.getByRole('navigation', { name: 'Studio views' });
  for (const g of ['Build', 'Explore', 'Check & publish', 'Help & admin']) await expect(nav.getByRole('group', { name: g })).toBeVisible();
  await expect(nav.getByRole('link')).toHaveCount(14);
  await expect(nav.getByRole('group', { name: 'Build' }).getByRole('link')).toHaveText(['2D Design Studio', 'Rules & Data', 'Content & Translations']);
  await expect(nav.getByRole('group', { name: 'Check & publish' }).getByRole('link')).toHaveText(['Validate & Compare', 'Preview & Export']);
  await expect(page.getByTestId('nav-S09')).toHaveAttribute('title', /Check the document for problems/);
  const bar = page.getByRole('banner');
  await expect(bar.getByText('Previewing as')).toBeVisible();
  await expect(bar.getByText('Output', { exact: true })).toBeVisible();
  await expect(page.getByTestId('save-state')).toHaveText(/Saved · v\d+/);
});

test('U12 official InfoSlips logo: icon on a laptop-sized window, full logo on a wide one, artwork follows the theme', async ({ page }) => {
  const shown = () => page.locator('header.topbar img.brand-img').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).map((e) => ({ src: (e as HTMLImageElement).src, natural: (e as HTMLImageElement).naturalWidth, w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) })));
  await open(page, 'aster-card-demo', 'design');
  let imgs = await shown();
  expect(imgs).toHaveLength(1);
  expect(imgs[0].src).toContain('infoslips-icon');
  expect(imgs[0].natural).toBeGreaterThan(0);
  expect(imgs[0].w).toBeGreaterThanOrEqual(24); // brand minimum for the icon
  await page.setViewportSize({ width: 1700, height: 900 });
  await expect(page.getByTestId('brand-logo')).toBeVisible();
  imgs = await shown();
  expect(imgs).toHaveLength(1);
  expect(imgs[0].src).toContain('infoslips-logo-on-light');
  expect(imgs[0].w).toBeGreaterThanOrEqual(120); // brand minimum for the full logo
  expect(Math.abs(imgs[0].w / imgs[0].h - 576 / 136)).toBeLessThan(0.1); // never stretched
  await page.getByTestId('open-settings').click();
  await page.getByTestId('theme-dark').click();
  imgs = await shown();
  expect(imgs).toHaveLength(1);
  expect(imgs[0].src).toContain('infoslips-logo-on-dark');
  expect(imgs[0].natural).toBeGreaterThan(0);
  expect(await page.locator('link[rel=icon]').getAttribute('href')).toBe('/favicon.png');
  expect((await page.request.get('/favicon.png')).ok()).toBeTruthy();
});

test('U02 settings menu holds detail level, theme, tour and shortcuts; choices persist', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  await page.getByTestId('open-settings').click();
  const menu = page.getByTestId('settings-menu');
  await expect(menu).toContainText('Take the tour');
  await expect(menu).toContainText('Keyboard shortcuts');
  await menu.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await menu.getByTestId('view-technical').click();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId('open-settings')).toBeFocused();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('open-settings')).toHaveAttribute('data-view', 'technical');
});

test('U03 Demo tools: closed by default, not in the working screens; applying a defect is reported and reversible', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await expect(page.getByTestId('demo-tools')).toHaveCount(0);
  await expect(page.getByTestId('rules-data-view').getByTestId('seed-d01')).toHaveCount(0);
  await demoTool(page, 'seed-d01');
  await expect(page.getByTestId('open-demo-tools')).toContainText('1 applied');
  await expect(page.getByTestId('record-selector')).toHaveAttribute('data-value', 'CARD-0002');
  await expect(page.getByTestId('trace-findings')).toContainText('EXCLUSIVE_PRIORITY_TIE');
  await page.getByTestId('restore-r03').click();
  await expect(page.getByTestId('open-demo-tools')).not.toContainText('applied');
  await page.getByTestId('demo-tools').getByRole('button', { name: 'Close demo tools' }).click();
  await expect(page.getByTestId('demo-tools')).toHaveCount(0);
});

test('U04 Validate & Compare runs by itself, pre-selects an issue, and re-runs when the customer changes', async ({ page }) => {
  await open(page, 'aster-card-demo', 'validate');
  await expect(page.getByTestId('validation-list')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('validate-view')).toContainText(/up to date/);
  await expect(page.getByTestId('validation-inspector')).not.toContainText('Select an issue');
  await pickRecord(page, 'CARD-0002');
  await expect(page.getByTestId('validate-view')).toContainText(/up to date/, { timeout: 90_000 });
  await expect(page.getByTestId('dock-status')).toContainText('Full validation');
});

test('U05 Preview & Export builds the PDF without a click and a second visit adds nothing to the export history', async ({ page, request }) => {
  const count = async () => ((await (await request.get(`${API}/artifacts?projectId=aster-card-demo`)).json()).artifacts as unknown[]).length;
  await open(page, 'aster-card-demo', 'outputs');
  await expect(page.getByTestId('outputs-view')).toContainText(/up to date/, { timeout: 90_000 });
  await expect(page.getByTestId('parity-status')).toBeVisible({ timeout: 90_000 });
  const after = await count();
  await page.reload();
  await expect(page.getByTestId('outputs-view')).toContainText(/up to date/, { timeout: 90_000 });
  await expect(page.getByTestId('parity-status')).toBeVisible({ timeout: 90_000 });
  expect(await count()).toBe(after);
});

test('U06 detail panels open with something selected: Cube, Landscape and Page Stack', async ({ page }) => {
  await open(page, 'aster-card-demo', 'cube');
  await expect(page.getByTestId('cube-inspector')).not.toContainText('Select a cell');
  await expect(page.getByTestId('cube-inspector')).toContainText('Jordan Mercer');
  // 3D view: a crowded axis shows every persona's full name (slanted), not a code
  await page.getByTestId('cube-view-3d').click();
  await expect(page.locator('.cube-tick.tx span')).toHaveText([/^P01 Everyday$/, /^P02 Premier$/, /^P03 First Missed Payment$/, /^P04 Financial Assistance$/, /^P05 Spanish Preferred$/]);
  await open(page, 'aster-card-demo', 'landscape');
  await expect(page.getByTestId('landscape-inspector')).not.toContainText('Select a cluster');
  await expect(page.getByTestId('landscape-inspector')).toContainText('Blocking');
  await open(page, 'aster-card-demo', 'page-stack');
  await expect(page.getByTestId('page-inspector')).toContainText('1 of 2', { timeout: 60_000 });
});

test('U07 Design inspector has four tabs on one row; Business view shows names, Technical view shows codes', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  await page.getByTestId('design-canvas').getByTestId('node-payment-guidance').click();
  const insp = page.getByTestId('component-inspector');
  const tabs = insp.getByRole('tab');
  await expect(tabs).toHaveText([/Content/, /Data & rules/, /Layout/, /Review/]);
  const tops = await tabs.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await expect(page.getByTestId('dock-selected')).toHaveText('Payment guidance');
  await setView(page, 'technical');
  await expect(page.getByTestId('dock-selected')).toContainText('payment-guidance');
  // on a laptop-sized window the component list starts closed so the page shows near full size; the choice is remembered
  await expect(page.getByTestId('component-palette')).toHaveCount(0);
  expect(parseInt(await page.getByTestId('zoom-value').innerText(), 10)).toBeGreaterThanOrEqual(95);
  await page.getByTestId('toggle-palette').click();
  await expect(page.getByTestId('component-palette')).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready');
  await expect(page.getByTestId('component-palette')).toBeVisible();
  await page.getByTestId('toggle-palette').click();
  await expect(page.getByTestId('component-palette')).toHaveCount(0);
  // a large window with no stored choice starts with the list open
  await page.evaluate(() => localStorage.removeItem('iss.paletteCollapsed'));
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.reload();
  await page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready');
  await expect(page.getByTestId('component-palette')).toBeVisible();
});

test('U08 Gallery: one main button per card, the rest in a menu; restoring an unchanged sample keeps its version', async ({ page, request }) => {
  const version = async () => (await (await request.get(`${API}/projects/aster-card-demo`)).json()).project.modelVersion as number;
  const before = await version();
  await page.goto('/projects');
  const card = page.getByTestId('project-card-aster-card-demo');
  await expect(card.getByTestId('open-aster-card-demo')).toBeVisible();
  await expect(card.getByTestId('duplicate-aster-card-demo')).toHaveCount(0);
  await card.getByTestId('card-menu-aster-card-demo').click();
  await expect(page.getByRole('menu')).toContainText('Duplicate');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByTestId('project-gallery')).toContainText('Start here');
  await expect(page.getByTestId('synthetic-statement')).toContainText('fictional');
  await page.getByTestId('real-vs-simulated').locator('summary').click();
  await expect(page.getByTestId('real-vs-simulated')).toContainText('AFP');
  const r = await request.post(`${API}/projects/aster-card-demo/reset`, { data: { confirm: true } });
  expect((await r.json()).unchanged).toBe(true);
  expect(await version()).toBe(before);
});

test('U09 narrow window: side panels become drawers; below 900px the studio asks for a wider window', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await open(page, 'aster-card-demo', 'design');
  const insp = page.getByTestId('component-inspector');
  await expect(insp).not.toBeVisible();
  await page.getByTestId('side-toggle-right').click();
  await expect(insp).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(insp).not.toBeVisible();
  const overflow = await page.evaluate(() => { const b = document.querySelector('header.topbar')!; return b.scrollWidth - b.clientWidth; });
  expect(overflow).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 860, height: 700 });
  await expect(page.getByTestId('small-screen-notice')).toBeVisible();
  await page.getByTestId('small-screen-continue').click();
  await expect(page.getByTestId('small-screen-notice')).toHaveCount(0);
});

test('U10 Start here → "Show me where" opens the sample and focuses the customer picker once it has loaded', async ({ page }) => {
  await page.goto('/projects');
  await page.getByTestId('start-switch-customer').click();
  await expect(page).toHaveURL(/\/studio\/aster-card-demo\/design$/);
  await expect(page.getByTestId('record-selector')).toBeFocused();
  await expect(page.getByTestId('ctx-customer')).toHaveClass(/spot/);
});

test('U11 Demo tools stays closed when the guided demo starts; Design fits the page width with a whole-page option', async ({ page }) => {
  await open(page, 'aster-card-demo', 'demo');
  await page.getByTestId('start-demo').click();
  await expect(page.getByTestId('demo-banner')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('demo-tools')).toHaveCount(0);
  await open(page, 'aster-card-demo', 'design');
  await expect(page.getByTestId('fit-width')).toHaveAttribute('aria-pressed', 'true');
  const width = parseInt(await page.getByTestId('zoom-value').innerText(), 10);
  await page.getByTestId('fit-page').click();
  await expect(page.getByTestId('fit-page')).toHaveAttribute('aria-pressed', 'true');
  expect(parseInt(await page.getByTestId('zoom-value').innerText(), 10)).toBeLessThanOrEqual(width);
});
