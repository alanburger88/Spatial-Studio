/**
 * Browser tests for the interactive HTML as a web experience: reflow at phone/desktop widths, sticky header, section menu,
 * collapsible sections, table paging/sort/search/quick filter, chart-driven filter, JavaScript-off completeness and the
 * studio's Phone / Tablet / Desktop device frame. The HTML is fetched from the real API like AT-25.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, open, resetAll } from './helpers';

const compose = async (request: APIRequestContext, projectId: string, recordId: string) => {
  const r = await request.post(`${API}/compose/html`, { data: { projectId, recordId, outputContext: { profileId: 'html-responsive' } } });
  expect(r.status()).toBe(200);
  return r.text();
};
const load = async (page: Page, html: string, width: number, height = 900) => {
  await page.setViewportSize({ width, height });
  await page.setContent(html);
  await page.waitForFunction(() => document.documentElement.getAttribute('data-interactive-ready') === '1');
};
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const TABLE = 'table[data-table-id="transaction-table"]';
const visibleRows = (page: Page) => page.locator(`${TABLE} tbody tr[data-row-id]:not([hidden])`).count();
const total = (page: Page) => page.locator('[data-table-total-cents]').getAttribute('data-table-total-cents');

test.describe('layout, sticky header, menu', () => {
  for (const [projectId, recordId] of [['aster-card-demo', 'CARD-0001'], ['harborcare-demo', 'EOB-0001']] as const) {
    for (const width of [390, 768, 1200]) {
      test(`W01 ${projectId} reflows at ${width}px: no horizontal overflow, no clipped tiles`, async ({ page, request }) => {
        await load(page, await compose(request, projectId, recordId), width);
        // open every collapsible section so all content is laid out
        await page.evaluate(() => document.querySelectorAll('details.iss-secd').forEach((d) => ((d as HTMLDetailsElement).open = true)));
        expect(await overflow(page)).toBeLessThanOrEqual(1);
        const clipped = await page.evaluate(() => Array.from(document.querySelectorAll('.iss-metric-value')).filter((e) => e.scrollWidth > e.clientWidth + 1).length);
        expect(clipped).toBe(0);
        const tiles = await page.locator('.iss-row').first().locator('.iss-metric').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size);
        const count = await page.locator('.iss-row').first().locator('.iss-metric').count();
        if (width === 390) expect(tiles).toBeGreaterThanOrEqual(Math.ceil(count / 2)); // two-up on phones
        if (width === 1200) expect(tiles).toBe(1);
        const sticky = await page.locator('[data-iss-bar]').evaluate((e) => getComputedStyle(e).position);
        expect(sticky).toBe('sticky');
      });
    }
  }

  test('W02 tiles go one-up below 340px', async ({ page, request }) => {
    await load(page, await compose(request, 'aster-card-demo', 'CARD-0001'), 320);
    const lefts = await page.locator('.iss-row').first().locator('.iss-metric').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size);
    expect(lefts).toBe(1);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });

  for (const width of [390, 1200]) {
    test(`W03 sticky header stays visible after scrolling and the menu anchors work at ${width}px`, async ({ page, request }) => {
      await load(page, await compose(request, 'aster-card-demo', 'CARD-0001'), width, width === 390 ? 844 : 800);
      const bar = page.locator('[data-iss-bar]');
      await expect(bar).toContainText('Minimum payment due');
      await expect(bar).toContainText('$45.00');
      await expect(bar).toContainText('Nov 25, 2026');
      await expect(bar.getByRole('link', { name: 'Review payment options' })).toHaveAttribute('href', 'https://example.com/aster/payments');
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(300);
      expect((await bar.boundingBox())!.y).toBeLessThanOrEqual(1);
      await expect(bar).toBeInViewport();
      const nav = page.getByRole('navigation', { name: 'Sections' });
      await expect(nav.getByRole('link')).toHaveText(['Summary', 'Message', 'Transactions', 'Notices']);
      await nav.getByRole('link', { name: 'Transactions' }).click();
      await page.waitForTimeout(800);
      const top = await page.locator('#sec-data').evaluate((e) => e.getBoundingClientRect().top);
      const barH = (await bar.boundingBox())!.height;
      expect(top).toBeGreaterThanOrEqual(0);
      // lands just under the sticky bar, unless the page cannot scroll any further (short last sections)
      const atEnd = await page.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2);
      if (!atEnd) expect(top).toBeLessThan(barH + 60);
      expect(top).toBeGreaterThan(barH - 1);
      await expect(nav.getByRole('link', { name: 'Transactions' })).toHaveAttribute('aria-current', 'location');
      await expect(page.locator('#sec-data details.iss-secd')).toHaveJSProperty('open', true);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement && document.activeElement !== document.body)).toBe(true);
    });
  }

  test('W04 phone: sections collapse natively (Summary and Message open); disclosures stay open and uncollapsible; touch targets 44px', async ({ page, request }) => {
    await load(page, await compose(request, 'aster-card-demo', 'CARD-0001'), 390, 844);
    await expect(page.locator('#sec-summary details.iss-secd')).toHaveJSProperty('open', true);
    await expect(page.locator('#sec-message details.iss-secd')).toHaveJSProperty('open', true);
    await expect(page.locator('#sec-data details.iss-secd')).toHaveJSProperty('open', false);
    await expect(page.locator('#sec-notices details')).toHaveCount(await page.locator('#sec-notices details.iss-expl').count());
    await expect(page.locator('#sec-notices .iss-disclosure')).toBeVisible();
    await page.locator('#sec-data summary').click();
    await expect(page.locator('#sec-data details.iss-secd')).toHaveJSProperty('open', true);
    await expect(page.locator(TABLE)).toBeVisible();
    await page.locator('#sec-summary summary').click();
    await expect(page.locator('#sec-summary details.iss-secd')).toHaveJSProperty('open', false);
    const small = await page.evaluate(() => Array.from(document.querySelectorAll('.iss-menu a, .iss-bar-action, details.iss-secd > summary, .iss-btn:not([hidden]), .iss-sort'))
      .filter((e) => (e as HTMLElement).offsetParent && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 43.5).map((e) => e.className + ':' + Math.round(e.getBoundingClientRect().height)));
    expect(small).toEqual([]);
  });

  test('W05 EOB guarded liability is never a number in the sticky header', async ({ page, request }) => {
    await load(page, await compose(request, 'harborcare-demo', 'EOB-0002'), 390);
    const bar = page.locator('[data-iss-bar]');
    await expect(bar).toContainText('This is not a bill');
    await expect(bar).toContainText(/under review/i);
    expect(await bar.innerText()).not.toMatch(/\$\d/);
    await load(page, await compose(request, 'harborcare-demo', 'EOB-0001'), 1200);
    await expect(page.locator('[data-iss-bar]')).toContainText('$50.00');
  });
});

test.describe('table and chart interaction', () => {
  test('W06 ten rows at a time; show more / show all; sort; search; totals never change', async ({ page, request }) => {
    await load(page, await compose(request, 'aster-card-demo', 'CARD-0002'), 1200);
    const t0 = await total(page);
    expect(Number(t0)).toBe(46000);
    const status = page.locator('[data-table-status="transaction-table"]');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    expect(await visibleRows(page)).toBe(10);
    await expect(status).toContainText('Showing 10 of 45 items. Totals always reflect all 45 items.');
    expect(await page.locator(`${TABLE} tbody tr[data-row-id]`).count()).toBe(45); // hidden rows stay in the DOM
    await page.getByRole('button', { name: 'Show more' }).click();
    expect(await visibleRows(page)).toBe(20);
    await page.getByRole('button', { name: 'Show all' }).click();
    expect(await visibleRows(page)).toBe(45);
    await expect(page.getByRole('button', { name: 'Show more' })).toBeHidden();
    // sort
    const th = page.locator(`${TABLE} th[data-key="amountCents"]`);
    await page.getByRole('button', { name: 'Sort by Amount' }).click();
    await expect(th).toHaveAttribute('aria-sort', 'ascending');
    const amounts = async () => page.locator(`${TABLE} tbody tr[data-row-id] td[data-sort][data-cents]`).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-cents'))));
    let a = await amounts();
    expect(a).toEqual([...a].sort((x, y) => x - y));
    await page.getByRole('button', { name: 'Sort by Amount' }).click();
    await expect(th).toHaveAttribute('aria-sort', 'descending');
    a = await amounts();
    expect(a).toEqual([...a].sort((x, y) => y - x));
    await expect(status).toContainText('Sorted by Amount, descending.');
    // search spans all rows, including ones beyond the first ten
    await page.getByLabel('Filter Transactions this period').fill('pharmacy');
    const n = await visibleRows(page);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(45);
    await expect(status).toContainText(`of 45 items (`);
    expect(await total(page)).toBe(t0);
    await page.getByLabel('Filter Transactions this period').fill('');
    expect(await visibleRows(page)).toBe(10);
  });

  test('W07 merchant quick filter and chart bar filter (mouse and keyboard) with Clear filter chip', async ({ page, request }) => {
    await load(page, await compose(request, 'aster-card-demo', 'CARD-0002'), 1200);
    const t0 = await total(page);
    const status = page.locator('[data-table-status="transaction-table"]');
    const select = page.locator('[data-table-quick="transaction-table"]');
    await select.selectOption('Harbor Fuel');
    const rows = await page.locator(`${TABLE} tbody tr[data-row-id]:not([hidden]) td:nth-child(2)`).allTextContents();
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.trim()))).toEqual(new Set(['Harbor Fuel']));
    await page.getByRole('button', { name: 'Clear filter' }).click();
    expect(await visibleRows(page)).toBe(10);
    await expect(page.getByRole('button', { name: 'Clear filter' })).toBeHidden();

    // chart bar: click
    const bar = page.locator('.iss-chart rect[data-label]').first();
    const label = (await bar.getAttribute('data-label'))!;
    await expect(bar).toHaveAttribute('role', 'button');
    await bar.click();
    await expect(bar).toHaveAttribute('aria-pressed', 'true');
    const merchants = await page.locator(`${TABLE} tbody tr[data-row-id]:not([hidden]) td:nth-child(2)`).allTextContents();
    expect(merchants.length).toBeGreaterThan(0);
    expect(new Set(merchants.map((m) => m.trim()))).toEqual(new Set([label]));
    await expect(page.getByRole('button', { name: 'Clear filter' })).toBeVisible();
    await expect(status).toContainText('match');
    expect(await total(page)).toBe(t0);
    await page.getByRole('button', { name: 'Clear filter' }).click();
    await expect(bar).toHaveAttribute('aria-pressed', 'false');
    // chart bar: keyboard Enter and Space
    const second = page.locator('.iss-chart rect[data-label]').nth(1);
    await second.focus();
    await page.keyboard.press('Enter');
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press(' ');
    await expect(second).toHaveAttribute('aria-pressed', 'false');
    expect(await visibleRows(page)).toBe(10);
    // the chart data table alternative is still there
    await page.getByRole('button', { name: 'Show chart data' }).click();
    await expect(page.locator('#chart-data-spend-chart')).toBeVisible();
  });

  test('W08 explanations still expand; expand-all works', async ({ page, request }) => {
    await load(page, await compose(request, 'aster-card-demo', 'CARD-0001'), 1200);
    const d = page.locator('details.iss-expl').first();
    await d.locator('summary').click();
    await expect(d).toHaveJSProperty('open', true);
    await page.getByRole('button', { name: /Collapse all explanations|Expand all explanations/ }).click();
  });

  test('W09 with JavaScript off everything is readable and complete', async ({ browser, request }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.setContent(await compose(request, 'aster-card-demo', 'CARD-0002'));
    await expect(page.locator(`${TABLE} tbody tr[data-row-id]:not([hidden])`)).toHaveCount(45);
    await expect(page.locator('[data-table-filter]')).toBeHidden();
    await expect(page.locator('[data-table-more="transaction-table"]')).toBeHidden();
    await expect(page.locator('#chart-data-spend-chart')).toBeVisible();
    await expect(page.locator('details.iss-secd[open]')).toHaveCount(await page.locator('details.iss-secd').count());
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await ctx.close();
  });

  test('W10 reduced motion: no smooth scrolling', async ({ page, request }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await load(page, await compose(request, 'aster-card-demo', 'CARD-0001'), 1200);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
  });
});

test.describe('studio device frame', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('W11 Design Studio: Interactive HTML sits in a Phone / Tablet / Desktop frame that scrolls inside', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'aster-card-demo', 'design');
    await page.getByTestId('select-profile').selectOption('html-responsive');
    const frame = page.getByTestId('html-profile-frame');
    await expect(frame).toBeVisible();
    for (const [id, w] of [['phone', 390], ['tablet', 768], ['desktop', 1200]] as const) {
      await page.getByTestId(`html-device-${id}`).click();
      await expect(page.getByTestId(`html-device-${id}`)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.html-dev')).toHaveAttribute('data-device', id);
      const inner = await frame.evaluate((f: HTMLIFrameElement) => f.contentWindow!.innerWidth);
      expect(inner).toBe(w);
      const h = (await frame.boundingBox())!.height;
      expect(h).toBeLessThan(900);
    }
    await page.getByTestId('html-device-phone').click();
    const scrolled = await frame.evaluate(async (f: HTMLIFrameElement) => { f.contentWindow!.scrollTo(0, 600); await new Promise((r) => setTimeout(r, 300)); return f.contentWindow!.scrollY; });
    expect(scrolled).toBeGreaterThan(100);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });

  test('W12 Preview & Export: HTML tab defaults to Desktop and offers Phone / Tablet / Desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'aster-card-demo', 'outputs');
    await page.getByTestId('tab-html').click();
    await expect(page.getByTestId('html-iframe')).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId('html-device-desktop')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('html-preview')).toBeVisible();
    await page.getByTestId('html-device-phone').click();
    await expect(page.locator('.ox-device')).toHaveAttribute('data-device', 'phone');
    await expect(page.getByTestId('html-iframe')).toHaveAttribute('title', /390px/);
    await page.getByTestId('html-device-tablet').click();
    await expect(page.locator('.ox-device')).toHaveAttribute('data-device', 'tablet');
    await expect(page.getByTestId('device-mobile')).toBeVisible();
  });
});
