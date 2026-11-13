/**
 * The left menu follows the stage of work: eight entries, and the screens of a stage are tabs across the top of the main area.
 * Every screen keeps its address and its heading. Runs against the real local stack (E2E_API / E2E_WEB for an isolated one).
 */
import { test, expect, type Page } from '@playwright/test';
import { open, resetAll } from './helpers';

test.beforeEach(async ({ request }) => { await resetAll(request); });

const SECTIONS: Array<{ id: string; label: string; tabs: string[]; ids: string[] }> = [
  { id: 'design', label: 'Design', tabs: ['Layout', 'Wording & translations', 'Email & SMS'], ids: ['S02', 'S13', 'S15'] },
  { id: 'rules-data', label: 'Rules & data', tabs: ['Rules', 'Customers', 'Journeys', 'Calculations', 'Lookup tables', 'Dates'], ids: ['S07', 'S16', 'S08', 'S22', 'S23', 'S24'] },
  { id: 'explore', label: 'Explore', tabs: ['Exploded', 'Cube', 'Landscape', 'Page stack'], ids: ['S03', 'S04', 'S05', 'S06'] },
  { id: 'check', label: 'Check', tabs: ['Blockers', 'Validate & compare', 'Preview & export'], ids: ['S17', 'S09', 'S10'] },
  { id: 'releases', label: 'Releases', tabs: ['Releases', 'Before & after', 'Proof'], ids: ['S18', 'S20', 'S21'] },
  { id: 'help', label: 'Help & activity', tabs: ['Guided demo', 'Assistant', 'Activity'], ids: ['S11', 'S12', 'S14'] },
];

/** Every screen: its tab test ID, address segment and the heading it has always had. */
const ROUTES: Array<{ id: string; path: RegExp; heading: string }> = [
  { id: 'S02', path: /\/design$/, heading: 'Design Studio' },
  { id: 'S13', path: /\/content$/, heading: 'Content & Translations' },
  { id: 'S15', path: /\/channels$/, heading: 'Email & SMS' },
  { id: 'S07', path: /\/rules-data$/, heading: 'Rules & Data' },
  { id: 'S16', path: /\/data$/, heading: 'Data Explorer' },
  { id: 'S08', path: /\/journey$/, heading: 'Journey Simulator' },
  { id: 'S22', path: /\/calculations$/, heading: 'Calculations' },
  { id: 'S23', path: /\/lookup-tables$/, heading: 'Lookup tables' },
  { id: 'S24', path: /\/dates$/, heading: 'Dates' },
  { id: 'S03', path: /\/exploded(\/[^/]+)?$/, heading: 'Exploded Document' },
  { id: 'S04', path: /\/cube$/, heading: 'Document Cube' },
  { id: 'S05', path: /\/landscape$/, heading: 'Scenario Landscape' },
  { id: 'S06', path: /\/page-stack$/, heading: 'Page Composition Stack' },
  { id: 'S17', path: /\/blockers$/, heading: 'Blockers' },
  { id: 'S09', path: /\/validate$/, heading: 'Validate & Compare' },
  { id: 'S10', path: /\/outputs$/, heading: 'Preview & Export' },
  { id: 'S18', path: /\/releases$/, heading: 'Releases' },
  { id: 'S20', path: /\/compare$/, heading: 'Before & after' },
  { id: 'S21', path: /\/proof$/, heading: 'Proof' },
  { id: 'S11', path: /\/demo$/, heading: 'Guided Demo' },
  { id: 'S12', path: /\/assistant$/, heading: 'AI Assistant' },
  { id: 'S14', path: /\/activity$/, heading: 'Activity' },
];

const nav = (page: Page) => page.getByRole('navigation', { name: 'Studio views' });
const heading = (page: Page) => page.locator('#main h1').first();

test('NV01 the menu has eight entries, each with an icon and a hint', async ({ page }) => {
  await open(page, 'aster-card-demo', 'overview');
  await expect(nav(page).getByRole('link')).toHaveCount(8);
  await expect(nav(page).locator('.nav-label')).toHaveText(['Projects', 'Overview', 'Design', 'Rules & data', 'Explore', 'Check', 'Releases', 'Help & activity']);
  const links = nav(page).getByRole('link');
  for (let i = 0; i < 8; i++) {
    await expect(links.nth(i).locator('svg').first()).toBeVisible();
    await expect(links.nth(i).locator('.nav-hint')).not.toHaveText('');
    await expect(links.nth(i)).toHaveAttribute('title', /—/);
  }
  // the old eighteen-entry menu is gone: only the eight entries are in the menu
  await expect(nav(page).getByRole('link', { name: 'Document Cube' })).toHaveCount(0);
});

test('NV02 each section shows its screens as tabs; single-screen sections show no tab row', async ({ page }) => {
  await open(page, 'aster-card-demo', 'overview');
  await expect(page.getByTestId('section-tabs')).toHaveCount(0);
  for (const sec of SECTIONS) {
    await page.getByTestId(`nav-section-${sec.id}`).click();
    const tabs = page.getByRole('navigation', { name: `${sec.label} screens` });
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole('link')).toHaveText(sec.tabs);
    // the first tab is the entry when nothing was used there before
    await expect(tabs.getByRole('link').first()).toHaveAttribute('aria-current', 'page');
    await expect(tabs.getByRole('link').first()).toHaveAttribute('data-testid', `nav-${sec.ids[0]}`);
    await expect(nav(page).locator(`[data-section=${sec.id}]`)).toHaveAttribute('aria-current', 'true');
  }
  await nav(page).getByTestId('nav-S19').click();
  await expect(page.getByTestId('section-tabs')).toHaveCount(0);
  await expect(page.getByTestId('nav-S19')).toHaveAttribute('aria-current', 'page');
  // Projects has two tabs, Projects and Library (the shared library), shown on the project list too.
  await nav(page).getByTestId('nav-section-projects').click();
  await expect(page).toHaveURL(/\/projects$/);
  const projectTabs = page.getByRole('navigation', { name: 'Projects screens' });
  await expect(projectTabs.getByRole('link')).toHaveText(['Projects', 'Library']);
  await expect(page.getByTestId('nav-S01')).toHaveAttribute('aria-current', 'page');
  await expect(nav(page).locator('[data-section=projects]')).toHaveAttribute('aria-current', 'true');
  await page.getByTestId('nav-S25').click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(heading(page)).toHaveText('Library');
  await expect(page.getByTestId('nav-S25')).toHaveAttribute('aria-current', 'page');
});

test('NV03 exactly one entry and one tab are current; moving to another tab moves both', async ({ page }) => {
  await open(page, 'aster-card-demo', 'cube');
  await expect(nav(page).locator('a[aria-current]')).toHaveCount(1);
  await expect(nav(page).locator('[data-section=explore]')).toHaveAttribute('aria-current', 'true');
  const tabs = page.getByRole('navigation', { name: 'Explore screens' });
  await expect(tabs.locator('a[aria-current=page]')).toHaveText('Cube');
  await tabs.getByRole('link', { name: 'Landscape' }).click();
  await expect(page).toHaveURL(/\/landscape$/);
  await expect(tabs.locator('a[aria-current=page]')).toHaveText('Landscape');
  await expect(tabs.locator('a[aria-current]')).toHaveCount(1);
});

test('NV04 a section opens on the tab last used there during this browser session', async ({ page }) => {
  await open(page, 'aster-card-demo', 'overview');
  await page.getByTestId('nav-section-design').click();
  await expect(page).toHaveURL(/\/design$/);
  await page.getByTestId('nav-S13').click();
  await expect(page).toHaveURL(/\/content$/);
  await page.getByTestId('nav-section-check').click();
  await expect(page).toHaveURL(/\/blockers$/);
  await page.getByTestId('nav-S10').click();
  await expect(page).toHaveURL(/\/outputs$/);
  await page.getByTestId('nav-S19').click();
  await expect(page).toHaveURL(/\/overview$/);
  await page.getByTestId('nav-section-design').click();
  await expect(page).toHaveURL(/\/content$/);
  await page.getByTestId('nav-section-check').click();
  await expect(page).toHaveURL(/\/outputs$/);
  // it is remembered for the session (a reload keeps it) ...
  await page.reload();
  await expect(page.locator('#main section.screen').first()).toBeVisible();
  await page.getByTestId('nav-section-design').click();
  await expect(page).toHaveURL(/\/content$/);
});

test('NV05 a new browser session opens every section on its first tab', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await open(page, 'aster-card-demo', 'overview');
  await page.getByTestId('nav-section-rules-data').click();
  await expect(page).toHaveURL(/\/rules-data$/);
  await page.getByTestId('nav-section-releases').click();
  await expect(page).toHaveURL(/\/releases$/);
  await page.getByTestId('nav-section-help').click();
  await expect(page).toHaveURL(/\/demo$/);
  await ctx.close();
});

test('NV06 every screen keeps its address and its heading, and is reached through its section', async ({ page }) => {
  await open(page, 'aster-card-demo', 'overview');
  await expect(heading(page)).toHaveText('Overview');
  for (const r of ROUTES) {
    const sec = SECTIONS.find((s) => s.ids.includes(r.id))!;
    if (!(await page.getByTestId(`nav-${r.id}`).isVisible())) await page.getByTestId(`nav-section-${sec.id}`).click();
    await page.getByTestId(`nav-${r.id}`).click();
    await expect(page, r.id).toHaveURL(new RegExp(`/studio/aster-card-demo${r.path.source}`));
    await expect(heading(page), r.id).toHaveText(r.heading);
    await expect(page.getByTestId(`nav-${r.id}`), r.id).toHaveAttribute('aria-current', 'page');
  }
});

test('NV07 the menu and the tabs work from the keyboard', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  // the menu entries are links: focus one and press Enter
  await nav(page).getByTestId('nav-section-explore').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/exploded/);
  // arrow keys move between tabs, Enter opens
  await page.getByTestId('nav-S03').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('nav-S04')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByTestId('nav-S06')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('nav-S03')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('nav-S06')).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/cube$/);
  await expect(page.getByTestId('nav-S04')).toHaveAttribute('aria-current', 'page');
  // the tabs have a visible focus ring
  await page.getByTestId('nav-S05').focus();
  expect(await page.getByTestId('nav-S05').evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
});

test('NV08 Alt+1 to Alt+8 open the menu entries in order, on the tab last used there; the palette reaches every screen', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  await page.keyboard.press('Alt+2');
  await expect(page).toHaveURL(/\/overview$/);
  await page.keyboard.press('Alt+5');
  await expect(page).toHaveURL(/\/exploded/);
  await page.getByTestId('nav-S05').click();
  await expect(page).toHaveURL(/\/landscape$/);
  await page.keyboard.press('Alt+3');
  await expect(page).toHaveURL(/\/design$/);
  await page.keyboard.press('Alt+5');
  await expect(page).toHaveURL(/\/landscape$/);
  await page.keyboard.press('Alt+7');
  await expect(page).toHaveURL(/\/releases$/);
  await page.keyboard.press('Alt+1');
  await expect(page).toHaveURL(/\/projects$/);

  await open(page, 'aster-card-demo', 'design');
  const reach: Array<[string, RegExp]> = [['Before & after', /\/compare$/], ['Proof', /\/proof$/], ['Overview', /\/overview$/], ['Journey Simulator', /\/journey$/], ['Data Explorer', /\/data$/], ['Email & SMS', /\/channels$/], ['Page Composition Stack', /\/page-stack$/]];
  for (const [text, url] of reach) {
    await page.keyboard.press('Control+k');
    await page.getByTestId('palette-input').fill(text);
    await page.keyboard.press('Enter');
    await expect(page, text).toHaveURL(url);
  }
});

test('NV09 the collapsed menu still names every entry, navigates and shows the tabs', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await open(page, 'aster-card-demo', 'design');
  await page.getByTestId('nav-toggle').click();
  await expect(page.getByTestId('nav-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(nav(page).locator('.nav-label').first()).toBeHidden();
  await expect(nav(page).getByRole('link', { name: 'Releases' })).toBeVisible();
  await page.getByTestId('nav-section-releases').click();
  await expect(page).toHaveURL(/\/releases$/);
  await expect(page.getByRole('navigation', { name: 'Releases screens' }).getByRole('link')).toHaveCount(3);
  await page.getByTestId('nav-section-check').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/blockers$/);
});

test('NV10 the tab row is readable at 1000 px wide in both themes: nothing is clipped', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  for (const theme of ['light', 'dark']) {
    await page.addInitScript((t) => { try { localStorage.setItem('iss.theme', t); } catch { /* ignore */ } }, theme);
    await open(page, 'aster-card-demo', 'validate');
    const row = page.getByTestId('section-tabs');
    await expect(row).toBeVisible();
    const box = (await row.boundingBox())!;
    const main = (await page.locator('#main').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 1);
    for (const l of await row.getByRole('link').all()) {
      const b = (await l.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(box.x - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
