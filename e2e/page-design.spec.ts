import { test, expect, type Page } from '@playwright/test';
import { API, open, resetAll } from './helpers';
import { gotoScreen } from './nav-helper';

/** Page design (roadmap wave 2): the Page panel, page templates, zones on the canvas, columns, undo, paper in the PDF. */

const paged = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().project.presentationProfiles.find((p: any) => p.id === 'paged-pdf'));
const past = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().past.length as number);
const mediaBox = (pdf: Buffer) => { const m = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString('latin1')); return m ? [Number(m[1]), Number(m[2])] : null; };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => { await resetAll(request); });
test.afterAll(async ({ request }) => { await resetAll(request); });

test('PD01: Page panel, page templates, dragging and typing a zone, keyboard nudge, undo', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  await page.getByTestId('fit-page').click();
  await page.getByTestId('open-page-panel').click();
  await expect(page.getByTestId('page-panel')).toBeVisible();
  await expect(page.getByTestId('page-paper')).toHaveValue('US-Letter');
  await expect(page.getByTestId('page-flow-y')).toHaveValue('184');

  // Switch page templates: Following pages, then turn on a Last page and show it.
  await page.getByTestId('page-template-following').first().click();
  await expect(page.locator('.pv-wrap')).toHaveAttribute('data-template', 'following');
  await expect(page.getByTestId('page-flow-y')).toHaveValue('84');
  await expect(page.getByTestId('page-template-last').first()).toBeDisabled();
  await page.getByTestId('page-last-toggle').check();
  await page.getByTestId('page-template-last').first().click();
  await expect(page.locator('.pv-wrap')).toHaveAttribute('data-template', 'last');
  expect((await paged(page)).pageTemplates).toEqual({ last: {} });

  // Drag the bottom edge of the first page's flow area up: one command, snapped or rounded.
  await page.getByTestId('page-template-first').first().click();
  const before = await past(page);
  const handle = page.getByTestId('zone-flow-bottom');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await paged(page)).pageTemplates?.first?.flowArea?.hPt).toBeLessThan(554);
  expect(await past(page)).toBe(before + 1);

  // Keyboard: the letterhead zone's bottom edge (= flow area top) moves 1 pt per arrow press, with a visible focus.
  const top = page.getByTestId('zone-letterhead-bottom');
  await top.focus();
  await expect(top).toHaveCSS('outline-style', 'solid');
  const y0 = (await paged(page)).pageTemplates.first.flowArea.yPt;
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await paged(page)).pageTemplates.first.flowArea.yPt).toBe(y0 + 1);

  // Typing a measurement: one command; undo restores it.
  await page.getByTestId('page-flow-h').fill('500');
  await page.getByTestId('page-flow-h').press('Enter');
  await expect.poll(async () => (await paged(page)).pageTemplates.first.flowArea.hPt).toBe(500);
  await page.getByTestId('undo').click();
  await expect.poll(async () => (await paged(page)).pageTemplates.first.flowArea.hPt).not.toBe(500);
  await expect(page.getByTestId('page-flow-h')).not.toHaveValue('500');
});

test('PD02: columns on the following pages show in the composed pages (Page Composition Stack)', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  await page.getByTestId('open-page-panel').click();
  await page.getByTestId('page-template-following').first().click();
  await page.getByTestId('page-columns').selectOption('2');
  await expect.poll(async () => (await paged(page)).pageTemplates?.following?.columns).toBe(2);
  // A long table so the following pages exist: the 250-row stress case from the Page Composition Stack.
  await page.evaluate(() => {
    const s = (window as any).__iss.store.getState();
    const tx = Array.from({ length: 120 }, (_, i) => ({ id: `PD-${String(i + 1).padStart(4, '0')}`, date: '2026-10-15', merchant: `Column test ${i + 1}`, amountCents: 100 }));
    s.patchOverrides({ card: { transactions: tx } });
  });
  await gotoScreen(page, 'S06');
  const stack = page.getByTestId('page-stack-view');
  await expect(stack.locator('.page[data-template="following"]').first()).toBeAttached({ timeout: 60000 });
  await expect(stack.locator('.page[data-template="following"] .iss-col[data-column="2"]').first()).toBeAttached();
});

test('PD03: paper size and orientation reach the PDF', async ({ page, request }) => {
  await open(page, 'aster-card-demo', 'design');
  await page.getByTestId('open-page-panel').click();
  await page.getByTestId('page-paper').selectOption('A4');
  await expect.poll(async () => (await paged(page)).paper).toBe('A4');
  await expect(page.locator('.pv-wrap')).toHaveAttribute('data-paper', 'A4');
  let project = await page.evaluate(() => (window as any).__iss.store.getState().project);
  let r = await request.post(`${API}/compose/pdf`, { data: { projectId: 'aster-card-demo', recordId: 'CARD-0001', project, allowDraft: true } });
  expect(r.ok()).toBeTruthy();
  let mb = mediaBox(await r.body());
  expect(mb![0]).toBeCloseTo(595.3, 0);
  expect(mb![1]).toBeCloseTo(841.9, 0);
  expect(r.headers()['x-pdf-page-count']).toBe(r.headers()['x-page-count']);

  await page.getByTestId('page-orientation-landscape').click();
  await expect.poll(async () => (await paged(page)).orientation).toBe('landscape');
  project = await page.evaluate(() => (window as any).__iss.store.getState().project);
  r = await request.post(`${API}/compose/pdf`, { data: { projectId: 'aster-card-demo', recordId: 'CARD-0001', project, allowDraft: true } });
  mb = mediaBox(await r.body());
  expect(mb![0]).toBeGreaterThan(mb![1]);
  expect(r.headers()['x-pdf-page-count']).toBe(r.headers()['x-page-count']);
  // The fixed footer moved with the bottom edge: still on the landscape page.
  const footer = project.nodes.find((n: any) => n.id === 'page-footer').layout.paged;
  expect(footer.yPt + footer.hPt).toBeLessThanOrEqual(595.3);

  // The keep-together setting is in the Inspector's layout tab; turning it on is one command.
  await page.getByTestId('close-page-panel').click();
  await page.getByTestId('design-canvas').getByTestId('node-spend-chart').click();
  await page.getByTestId('insp-tab-layout').click();
  await page.getByTestId('layout-keep-together').check();
  await expect.poll(() => page.evaluate(() => (window as any).__iss.store.getState().project.nodes.find((n: any) => n.id === 'spend-chart').layout.paged.keepTogether)).toBe(true);
});
