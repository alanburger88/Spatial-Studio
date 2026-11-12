/**
 * InfoSlips Spatial Studio — browser + API acceptance suite for AT-01 … AT-36
 * (contracts/ACCEPTANCE_MATRIX.json). Every test drives the real running application.
 */
import { test, expect } from '@playwright/test';
import { API, EXPECTED, dragAfter, node, open, pdfText, resetAll, state } from './helpers';
import type { Page } from '@playwright/test';

async function layer(page: Page, id: string) {
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByTestId(`layer-${id}`).click();
}


test.beforeEach(async ({ request }) => { await resetAll(request); });

test('AT-01 open Aster and reload: same node IDs, record, selection and profile persist', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  await page.getByTestId('record-selector').selectOption('CARD-0002');
  await page.getByTestId('select-profile').selectOption('paged-afp-sim');
  await page.getByTestId('design-canvas').getByTestId('node-billing-summary').click();
  const before = await state(page);
  await page.reload();
  await page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready');
  const after = await state(page);
  expect(after.nodeIds).toEqual(before.nodeIds);
  expect(after.digest).toBe(before.digest);
  expect(await page.getByTestId('record-selector').inputValue()).toBe('CARD-0002');
  expect(await page.getByTestId('select-profile').inputValue()).toBe('paged-afp-sim');
  await expect(page.getByTestId('dock-selected')).toHaveText('billing-summary');
});

test('AT-02 drag C02 Rich Text into the flow region; saved model contains a real editable node', async ({ page, request }) => {
  await open(page, 'aster-card-demo', 'design');
  const before = await state(page);
  await dragAfter(page, 'palette-rich-text', 'node-greeting');
  const after = await state(page);
  const added = after.nodeIds.filter((id) => !before.nodeIds.includes(id));
  expect(added).toHaveLength(1);
  expect(after.modelVersion).toBe(before.modelVersion + 1);
  const n = await node(page, added[0]);
  expect(n.type).toBe('rich-text');
  const root = await node(page, 'doc-root');
  expect(root.children.indexOf(added[0])).toBe(root.children.indexOf('greeting') + 1);
  // edit it in place, then save
  await page.getByTestId(`node-${added[0]}`).dblclick();
  await page.getByTestId('rich-text-editor').press('End');
  await page.keyboard.type(' Edited in the browser.');
  await page.getByTestId('rich-text-done').click();
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  const saved = await (await request.get(`${API}/projects/aster-card-demo`)).json();
  const sn = saved.project.nodes.find((x: any) => x.id === added[0]);
  expect(sn.type).toBe('rich-text');
  expect(JSON.stringify(sn.content)).toContain('Edited in the browser');
});

test('AT-03 resize, align and nudge a C06 Bound Field; undo/redo restores geometry', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  await page.getByTestId('insert-bound-field').click();
  const id = (await state(page)).ctx.selectedNodeId as string;
  await page.getByTestId('insp-tab-layout').click();
  await page.getByTestId('layout-mode').selectOption('fixed');
  expect((await node(page, id)).layout.paged).toMatchObject({ mode: 'fixed', xPt: 40, yPt: 60 });
  // keyboard nudge
  await page.getByTestId(`node-${id}`).click();
  await page.getByTestId('design-canvas').focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown');
  expect((await node(page, id)).layout.paged).toMatchObject({ xPt: 42, yPt: 70 });
  // pointer resize via the corner handle
  const handle = page.locator(`[data-testid="node-${id}"] .pv-handle-se`);
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + 5, hb.y + 5); await page.mouse.down(); await page.mouse.move(hb.x + 65, hb.y + 25, { steps: 6 }); await page.mouse.up();
  const resized = (await node(page, id)).layout.paged;
  expect(resized.wPt).toBeGreaterThan(200);
  // align to page centre
  await page.getByRole('button', { name: 'Align page centre' }).click();
  const centred = (await node(page, id)).layout.paged;
  expect(centred.xPt).toBe(Math.round((612 - centred.wPt) / 2));
  // undo returns to the resized position, redo re-applies centring
  await page.getByTestId('undo').click();
  expect((await node(page, id)).layout.paged.xPt).toBe(42);
  await page.getByTestId('redo').click();
  expect((await node(page, id)).layout.paged.xPt).toBe(centred.xPt);
  // HTML profile geometry untouched by paged edits
  expect((await node(page, id)).layout.html).toMatchObject({ area: 'main', span: 6 });
});

test('AT-04 dropping into a protected disclosure is blocked with a reason; model unchanged', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  const before = await state(page);
  await page.getByTestId('design-canvas').getByTestId('node-sample-disclosure-set').scrollIntoViewIfNeeded();
  await dragAfter(page, 'palette-rich-text', 'node-sample-disclosure-set', 'center');
  await expect(page.getByTestId('toast-error')).toContainText(/protected disclosure/i);
  const after = await state(page);
  expect(after.digest).toBe(before.digest);
  expect(after.modelVersion).toBe(before.modelVersion);
});

test('AT-05 insert {{customer.givenName}} token: fixture value renders with correct lineage', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  await page.getByTestId('insert-rich-text').click();
  const id = (await state(page)).ctx.selectedNodeId as string;
  await page.getByTestId('edit-rich-text').click();
  await page.getByTestId('rich-text-editor').press('End');
  await page.getByTestId('token-customer.givenName').click();
  await page.getByTestId('rich-text-done').click();
  const n = await node(page, id);
  expect(JSON.stringify(n.content).match(/customer\.givenName/g)!.length).toBe(2);
  await expect(page.getByTestId(`node-${id}`)).toContainText('Jordan');
  await page.getByTestId('insp-tab-data').click();
  await expect(page.getByTestId('component-inspector')).toContainText('customer.givenName');
  await expect(page.getByTestId('component-inspector')).toContainText('"Jordan"');
});

test('AT-06 unknown token path is caught by binding validation', async ({ page, request }) => {
  await open(page, 'aster-card-demo', 'design');
  await layer(page, 'page-footer');
  const textInput = page.getByTestId('component-inspector').getByLabel('Text (tokens allowed)');
  await textInput.fill('Footer {{customer.secretScore}}');
  await textInput.press('Enter');
  await page.getByTestId('insp-tab-data').click();
  await expect(page.getByTestId('node-finding')).toContainText('INVALID_BINDING');
  const project = await page.evaluate(() => (window as any).__iss.store.getState().project);
  const v = await (await request.post(`${API}/validate`, { data: { projectId: 'aster-card-demo', recordId: 'CARD-0001', project, suites: ['bindings'] } })).json();
  expect(v.issues.some((i: any) => i.code === 'INVALID_BINDING' && i.nodeId === 'page-footer')).toBe(true);
});

test('AT-07 create 3 variants for a Conditional Region; all appear in editor and Exploded view', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  await page.getByTestId('insert-conditional-region').click();
  const id = (await state(page)).ctx.selectedNodeId as string;
  const add = async (title: string, path?: string, op?: string, value?: string) => {
    await page.getByTestId('new-variant-title').fill(title);
    await page.getByTestId('new-variant-text').fill(`${title} message for {{customer.givenName}}.`);
    if (path) { await page.getByTestId('new-variant-cond-path').selectOption(path); await page.getByTestId('new-variant-cond-op').selectOption(op!); await page.getByTestId('new-variant-cond-value').fill(value!); }
    await page.getByTestId('add-variant').click();
  };
  await add('Premium welcome', 'card.tier', 'eq', 'premium');
  await add('Overdue nudge', 'card.paymentStatus', 'eq', 'overdue');
  await add('General note');
  const n = await node(page, id);
  expect(n.variantIds).toHaveLength(3);
  await expect(page.getByTestId('variants-editor').locator('li')).toHaveCount(3);
  await page.getByTestId('explore-variants').click();
  await expect(page.getByTestId('exploded-view')).toBeVisible();
  await expect(page.getByTestId('variant-list').locator('li')).toHaveCount(3);
  await expect(page.locator('.ex-panel')).toHaveCount(3);
});

test('AT-08 switch persona P01 → P04: assistance variant selected and trace explains why', async ({ page }) => {
  await open(page, 'aster-card-demo', 'exploded/payment-guidance');
  await expect(page.getByTestId('exploded-explanation')).toContainText('R01');
  await page.getByTestId('record-selector').selectOption('CARD-0002');
  await expect(page.getByTestId('exploded-explanation')).toContainText('R04 matched');
  await expect(page.getByTestId('exploded-explanation')).toContainText('card.assistanceRequested = true');
  await expect(page.getByTestId('variant-item-payment-assistance-requested')).toContainText('Active in this scenario');
});

test('AT-09 forced R03/R04 tie at equal priority is a blocking finding with no winner', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await page.getByTestId('record-selector').selectOption('CARD-0002');
  await page.getByTestId('inject-d01').click();
  await expect(page.getByTestId('trace-findings')).toContainText('EXCLUSIVE_PRIORITY_TIE');
  const sel = await page.evaluate(() => { const s = (window as any).__iss.store.getState(); return s.project.rules.find((r: any) => r.id === 'R03').priority; });
  expect(sel).toBe(400);
  await page.getByTestId('nav-S03').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Unresolved' }).first()).toBeVisible();
});

test('AT-10 removing the exclusive fallback with no rule match is a blocking no-match', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await page.getByTestId('remove-fallback').click();
  await page.getByTestId('no-match-scenario').click();
  await expect(page.getByTestId('trace-findings')).toContainText('NO_VARIANT_MATCH');
});

test('AT-11 unrelated chart style change leaves financial digest values unchanged', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  const facts = () => page.evaluate(async () => {
    const s = (window as any).__iss.store.getState();
    const res = await fetch('/api/v1/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: s.project.projectId, recordId: s.ctx.recordId, project: s.project }) }).then((r) => r.json());
    return { money: res.semanticManifest.money, digest: res.contentDigest, model: (window as any).__iss.digest() };
  });
  const before = await facts();
  await layer(page, 'spend-chart');
  await page.getByTestId('component-inspector').getByRole('combobox', { name: 'Kind' }).selectOption('donut');
  const after = await facts();
  expect(after.model).not.toBe(before.model);
  expect(after.money).toEqual(before.money);
  expect(after.digest).toBe(before.digest);
});

test('AT-12 select a variant in Exploded, return to Design: same semantic node selected', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  await page.getByTestId('design-canvas').getByTestId('node-payment-guidance').click();
  await page.getByRole('button', { name: /explore variants/i }).click();
  await expect(page.getByTestId('selected-node')).toHaveText(/payment-guidance/);
  await page.getByTestId('panel-payment-reminder').click();
  await expect(page.getByTestId('selected-variant')).toContainText('payment-reminder');
  await page.getByTestId('collapse-exploded').click();
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await expect(page.getByTestId('dock-selected')).toHaveText('payment-guidance');
  await expect(page.getByTestId('design-canvas').getByTestId('node-payment-guidance')).toHaveClass(/is-selected/);
});

test('AT-13 repeated expand/collapse under reduced motion: no lost edits, flat alternative works', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, 'aster-card-demo', 'design');
  await page.getByTestId('insert-rich-text').click();
  const before = await state(page);
  for (let i = 0; i < 3; i++) {
    await layer(page, 'payment-guidance');
    await page.getByTestId('explore-variants').click();
    await expect(page.locator('.ex-panel')).toHaveCount(5);
    await page.getByTestId('collapse-exploded').click();
    await expect(page.getByTestId('design-canvas')).toBeVisible();
  }
  expect((await state(page)).digest).toBe(before.digest);
  await layer(page, 'payment-guidance');
  await page.getByTestId('explore-variants').click();
  await page.getByTestId('flat-alternative').click();
  await expect(page.locator('.ex-flat .ex-card')).toHaveCount(5);
  await ctx.close();
});

test('AT-14 Cube persona × language × journey recomputes intersections, labels and filters', async ({ page }) => {
  await open(page, 'aster-card-demo', 'cube');
  await page.getByTestId('cube-axis-y').selectOption('language');
  await page.getByTestId('cube-axis-z').selectOption('journey');
  await expect(page.getByTestId('cube-flat-table')).toContainText('es-US');
  await expect(page.getByTestId('cube-flat-table')).toContainText('Day 30');
  const axes = await page.evaluate(() => (window as any).__iss.store.getState().ctx.cubeAxes);
  expect(axes).toEqual(['persona', 'language', 'journey']);
});

test('AT-15 Cube empty intersection shows an honest "No matching fixture" state', async ({ page }) => {
  await open(page, 'aster-card-demo', 'cube');
  await page.getByTestId('cube-axis-y').selectOption('language');
  const empty = page.getByTestId('cube-cell-empty').first();
  await empty.click();
  await expect(page.getByTestId('cube-empty-cell')).toContainText(/No matching fixture/i);
  await expect(page.getByTestId('cube-open-rep')).toBeDisabled();
});

test('AT-16 Landscape cluster counts reconcile with seeded records; synthetic label visible', async ({ page }) => {
  await open(page, 'aster-card-demo', 'landscape');
  await expect(page.getByTestId('landscape-evaluated')).toContainText('70');
  await expect(page.getByTestId('landscape-reconcile')).toContainText(/reconcile/i);
  await expect(page.getByTestId('landscape-view')).toContainText(/synthetic/i);
  expect(await page.getByTestId('landscape-row').count()).toBeGreaterThan(1);
});

test('AT-17 Landscape "show defects only" contains only scenarios with recorded findings', async ({ page }) => {
  await open(page, 'aster-card-demo', 'landscape');
  const all = await page.getByTestId('landscape-row').count();
  await page.getByTestId('landscape-show-defects').click();
  await expect(page.getByTestId('landscape-show-defects')).toHaveAttribute('aria-pressed', 'true');
  const rows = page.getByTestId('landscape-row');
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan(all);
  for (let i = 0; i < n; i++) await expect(rows.nth(i)).toContainText(/blocking|warning/i);
});

test('AT-18 250-row card scenario: real continuation pages with repeated headings', async ({ page, request }) => {
  const c = EXPECTED['card-250-rows'];
  const r = await request.post(`${API}/compose/pdf`, { data: { projectId: 'aster-card-demo', recordId: c.recordId, overrides: c.overrides, outputContext: { profileId: 'paged-pdf' } } });
  expect(r.status()).toBe(200);
  const pages = Number(r.headers()['x-page-count']);
  expect(pages).toBeGreaterThan(1);
  expect(Number(r.headers()['x-pdf-page-count'])).toBe(pages);
  const { pages: text } = await pdfText(await r.body());
  const all = text.join('\n');
  for (let i = 1; i <= 250; i++) expect(all).toContain(`STRESS-${String(i).padStart(4, '0')}`);
  expect(text.slice(1).every((t) => t.includes('Transactions this period (continued)') && t.includes('Description'))).toBe(true);
  expect(all).toContain('$508.00');
  // and in the UI Page Stack
  await open(page, 'aster-card-demo', 'page-stack');
  await page.getByTestId('stress-250').click();
  await expect(page.getByTestId('page-count')).toContainText(`${pages} pages`, { timeout: 60000 });
  await expect(page.getByTestId('page-flat-list')).toContainText(/repeated/i);
});

test('AT-19 disabling continuation on an overflowing region yields a real overflow finding', async ({ page }) => {
  await open(page, 'aster-card-demo', 'page-stack');
  await page.getByTestId('stress-250').click();
  await expect(page.getByTestId('page-count')).toContainText('8 pages', { timeout: 60000 });
  await page.getByTestId('disable-continuation').click();
  await expect(page.getByTestId('page-flat-list')).toContainText('FLOW_OVERFLOW_NO_CONTINUATION', { timeout: 60000 });
  await expect(page.getByTestId('page-flat-list')).toContainText('transaction-table');
  expect((await node(page, 'transaction-table')).flowContinuation).toBe(false);
});

test('AT-20 es-US with missing required copy is a blocking error; no silent translation', async ({ page, request }) => {
  const r = await request.post(`${API}/compose/pdf`, { data: { projectId: 'aster-card-demo', recordId: 'CARD-0001', overrides: { customer: { locale: 'es-US' } } } });
  expect(r.status()).toBe(422);
  const body = await r.json();
  expect(body.error.issues.filter((i: any) => i.code === 'REQUIRED_TRANSLATION_MISSING').map((i: any) => i.nodeId).sort()).toEqual(['billing-summary', 'payment-due', 'payment-standard', 'sample-disclosure-set']);
  await open(page, 'aster-card-demo', 'validate');
  await page.getByTestId('seed-d02').click();
  await page.getByTestId('run-validation').click();
  await expect(page.getByTestId('validation-list')).toContainText('REQUIRED_TRANSLATION_MISSING', { timeout: 60000 });
});

test('AT-21/AT-22 Day 30 then Day 45 events: future previews change; Day 1 issued snapshot unchanged', async ({ page }) => {
  await open(page, 'aster-card-demo', 'journey');
  await expect(page.getByTestId('issued-snapshot-hash')).toHaveText(/[0-9a-f]{12}/, { timeout: 30000 });
  const issued = (await page.getByTestId('issued-snapshot-hash').textContent())!.trim();
  await page.getByTestId('trigger-event').click(); // Day 1 (issued)
  await page.getByTestId('trigger-event').click(); // Day 30
  await expect(page.getByTestId('journey-view')).toContainText('payment-reminder');
  await expect(page.getByTestId('issued-snapshot-hash')).toHaveText(/[0-9a-f]{12}/, { timeout: 30000 });
  expect((await page.getByTestId('issued-snapshot-hash').textContent())!.trim()).toBe(issued);
  const p30 = (await page.getByTestId('preview-snapshot-hash').textContent())!.trim();
  await page.getByTestId('trigger-event').click(); // Day 45
  await expect(page.getByTestId('journey-explanation')).toContainText('R04');
  await expect(page.getByTestId('journey-view')).toContainText('payment-assistance-requested');
  expect((await page.getByTestId('preview-snapshot-hash').textContent())!.trim()).not.toBe(p30);
  await expect(page.getByTestId('issued-snapshot-hash')).toHaveText(/[0-9a-f]{12}/, { timeout: 30000 });
  expect((await page.getByTestId('issued-snapshot-hash').textContent())!.trim()).toBe(issued);
});

test('AT-23 reorder and replay an event: new deterministic snapshot sequence matches evaluated state', async ({ page, request }) => {
  await open(page, 'aster-card-demo', 'journey');
  await page.getByRole('button', { name: /Move Assistance requested earlier/ }).click();
  const events = await page.evaluate(() => (window as any).__iss.store.getState().project.journey.events.map((e: any) => e.eventId));
  expect(events).toEqual(['card-day1', 'card-day45', 'card-day30', 'card-day60']);
  await page.getByTestId('replay-journey').click();
  await expect(page.getByTestId('journey-timeline')).toContainText(/skipped/i);
  const project = await page.evaluate(() => (window as any).__iss.store.getState().project);
  const a = await (await request.post(`${API}/journeys/replay`, { data: { projectId: 'aster-card-demo', recordId: 'CARD-0001', project } })).json();
  const b = await (await request.post(`${API}/journeys/replay`, { data: { projectId: 'aster-card-demo', recordId: 'CARD-0001', project } })).json();
  expect(a.snapshots.map((s: any) => s.contentDigest)).toEqual(b.snapshots.map((s: any) => s.contentDigest));
  expect(a.snapshots.find((s: any) => s.eventId === 'card-day45').kind).toBe('skipped');
});

test('AT-24 PDF from CARD-0001: valid PDF, account suffix, $1,248 total, pages recorded', async ({ request }) => {
  const r = await request.post(`${API}/compose/pdf`, { data: { projectId: 'aster-card-demo', recordId: 'CARD-0001', overrides: {}, outputContext: { profileId: 'paged-pdf' } } });
  expect(r.status()).toBe(200);
  const bytes = await r.body();
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const { pages } = await pdfText(bytes);
  expect(pages.length).toBe(Number(r.headers()['x-page-count']));
  const all = pages.join('\n').replace(/\s+/g, ' ');
  expect(all).toContain('1842');
  expect(all).toContain('$1,248.00');
  expect(all).toMatch(/Jordan Mercer/);
  const arts = await (await request.get(`${API}/artifacts?runId=${r.headers()['x-run-id']}`)).json();
  expect(arts.artifacts.find((a: any) => a.kind === 'pdf').pageCount).toBe(pages.length);
});

test('AT-25 interactive HTML from the same run: sort, filter, expand; totals preserved', async ({ page, request }) => {
  const r = await request.post(`${API}/compose/html`, { data: { projectId: 'aster-card-demo', recordId: 'CARD-0002', outputContext: { profileId: 'html-responsive' } } });
  expect(r.status()).toBe(200);
  await page.setContent(await r.text());
  await page.waitForFunction(() => document.documentElement.getAttribute('data-interactive-ready') === '1');
  const total = await page.locator('[data-table-total-cents]').getAttribute('data-table-total-cents');
  const firstRow = () => page.locator('table[data-table-id="transaction-table"] tbody tr').first().getAttribute('data-row-id');
  const initial = await firstRow();
  await page.getByRole('button', { name: 'Sort by Reference' }).click();
  await page.getByRole('button', { name: 'Sort by Reference' }).click();
  expect(await firstRow()).not.toBe(initial);
  await page.getByLabel('Filter Transactions this period').fill('Pharmacy');
  const visible = await page.locator('table[data-table-id="transaction-table"] tbody tr:not([hidden])').count();
  expect(visible).toBeGreaterThan(0);
  expect(visible).toBeLessThan(45);
  await expect(page.locator('[data-table-status="transaction-table"]')).toContainText(`of 45`);
  expect(await page.locator('[data-table-total-cents]').getAttribute('data-table-total-cents')).toBe(total);
  const details = page.locator('details.iss-expl').first();
  await details.locator('summary').click();
  expect(await details.evaluate((d: HTMLDetailsElement) => d.open)).toBe(true);
  expect(Number(total)).toBe(46000);
});

test('AT-26 PDF/HTML semantic manifests: disclosures and amounts match; differences documented', async ({ page, request }) => {
  for (const [projectId, recordId] of [['aster-card-demo', 'CARD-0001'], ['harborcare-demo', 'EOB-0001']]) {
    const p = await (await request.post(`${API}/parity`, { data: { projectId, recordId } })).json();
    expect(p.report.ok).toBe(true);
    expect(p.report.checks.filter((c: any) => c.status === 'mismatch')).toEqual([]);
    expect(p.report.allowedDifferences.length).toBeGreaterThan(0);
  }
  await open(page, 'aster-card-demo', 'outputs');
  await page.getByTestId('run-parity').click();
  await expect(page.getByTestId('parity-status')).toContainText('OK', { timeout: 60000 });
});

test('AT-27 AFP simulation: no AFP binary; explicit simulation warning visible', async ({ page, request }) => {
  const r = await request.post(`${API}/compose/afp-sim`, { data: { projectId: 'aster-card-demo', recordId: 'CARD-0001', outputContext: { profileId: 'paged-afp-sim' } } });
  expect(r.headers()['content-type']).toContain('application/json');
  const sim = await r.json();
  expect(sim.simulationOnly).toBe(true);
  expect(sim.afpBytesGenerated).toBe(0);
  await open(page, 'aster-card-demo', 'outputs');
  await page.getByTestId('tab-afp').click();
  await expect(page.getByTestId('afp-sim-label')).toContainText('AFP simulation only — no MO:DCA / AFP print stream generated');
  await page.getByTestId('view-afp-simulation').click();
  await expect(page.getByTestId('outputs-view')).toContainText(/page sequence/i);
  await expect(page.locator('a[download$=".afp"]')).toHaveCount(0);
});

test('AT-28 EOB-0001: billed/allowed/plan/member reconcile; NOT A BILL visible', async ({ page, request }) => {
  const res = await (await request.post(`${API}/resolve`, { data: { projectId: 'harborcare-demo', recordId: 'EOB-0001' } })).json();
  const f = res.result.documentFacts;
  expect(f).toMatchObject({ billedCents: 40000, allowedCents: 25000, planPaidCents: 20000, patientResponsibilityCents: 5000, notABill: true });
  expect(f.allowedCents).toBe(f.planPaidCents + f.patientResponsibilityCents);
  const pdf = await request.post(`${API}/compose/pdf`, { data: { projectId: 'harborcare-demo', recordId: 'EOB-0001' } });
  const all = (await pdfText(await pdf.body())).pages.join('\n');
  for (const s of ['THIS IS NOT A BILL', '$400.00', '$250.00', '$200.00', '$50.00', 'HC-10428']) expect(all).toContain(s);
  await open(page, 'harborcare-demo', 'design');
  await expect(page.getByTestId('design-canvas').getByTestId('node-not-a-bill-banner')).toContainText('THIS IS NOT A BILL');
});

test('AT-29 EOB-0002 with "$300 owed" and unconfirmed liability is blocked by domain validation', async ({ page, request }) => {
  const c = EXPECTED['eob-unconfirmed-liability'];
  const res = await (await request.post(`${API}/resolve`, { data: { projectId: 'harborcare-demo', recordId: 'EOB-0002', overrides: c.overrides } })).json();
  expect(res.result.diagnostics).toEqual(c.expected.diagnostics);
  const blocked = await request.post(`${API}/compose/pdf`, { data: { projectId: 'harborcare-demo', recordId: 'EOB-0002', overrides: c.overrides } });
  expect(blocked.status()).toBe(422);
  // Author inserts an "amount owed" metric in the UI
  await open(page, 'harborcare-demo', 'design');
  await page.getByTestId('record-selector').selectOption('EOB-0002');
  await page.getByTestId('insert-summary-metric').click();
  await page.getByTestId('field-label').fill('Amount you owe');
  await page.getByTestId('field-label').press('Enter');
  await page.getByTestId('binding-select').selectOption('claim.amountUnderReviewCents');
  await page.getByTestId('insp-tab-data').click();
  await expect(page.getByTestId('node-finding')).toContainText('UNCONFIRMED_DEBT_LANGUAGE');
  const project = await page.evaluate(() => (window as any).__iss.store.getState().project);
  const r = await request.post(`${API}/compose/pdf`, { data: { projectId: 'harborcare-demo', recordId: 'EOB-0002', project } });
  expect(r.status()).toBe(422);
  expect((await r.json()).error.issues.map((i: any) => i.code)).toContain('UNCONFIRMED_DEBT_LANGUAGE');
});

test('AT-30 ask AI to select the assistance persona: validated tool call; trace from engine', async ({ page }) => {
  await open(page, 'aster-card-demo', 'assistant');
  await page.getByTestId('assistant-input').fill('Choose assistance case CARD-0002');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('action-select_scenario')).toBeVisible();
  await page.getByTestId('action-apply').first().click();
  await expect(page.getByTestId('record-selector')).toHaveValue('CARD-0002');
  await page.getByTestId('assistant-input').fill('Explain the selected variant');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('assistant-explanation').last()).toContainText('R04');
  await expect(page.getByTestId('assistant-explanation').last()).toContainText(/deterministic resolver trace/i);
});

test('AT-31 AI proposes a rule change; declining leaves the approved model version unchanged', async ({ page }) => {
  await open(page, 'aster-card-demo', 'assistant');
  const before = await state(page);
  await page.getByTestId('assistant-input').fill('Change R04 priority to 420');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('proposal-card')).toBeVisible();
  await page.getByTestId('proposal-decline').click();
  await expect(page.getByTestId('proposal-proof')).toContainText('unchanged');
  const after = await state(page);
  expect(after.digest).toBe(before.digest);
  expect(after.modelVersion).toBe(before.modelVersion);
});

test('AT-32 provider disconnected: labelled offline fallback still performs scenario/trace actions', async ({ page }) => {
  await open(page, 'aster-card-demo', 'assistant');
  await page.getByTestId('force-offline').check();
  await page.getByTestId('assistant-input').fill('Show me a Spanish-speaking cardholder who has missed two payments and requests assistance');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('assistant-reply').last()).toContainText(/Offline assistant/);
  await expect(page.getByTestId('ai-mode')).toContainText(/offline/i);
  await expect(page.getByTestId('scenario-preview').last()).toContainText('payment-assistance-requested');
  await page.getByTestId('action-apply').last().click();
  const ov = await page.evaluate(() => (window as any).__iss.store.getState().ctx.overrides);
  expect(ov).toMatchObject({ customer: { locale: 'es-US' }, card: { missedPayments: 2, assistanceRequested: true } });
});

test('AT-33 keyboard: navigate node tree and spatial alternative without the 3D camera', async ({ page }) => {
  await open(page, 'aster-card-demo', 'design');
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByTestId('layer-doc-root').focus();
  for (let i = 0; i < 40 && !(await page.getByTestId('layer-payment-guidance').evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dock-selected')).toHaveText('payment-guidance');
  await page.getByTestId('explore-variants').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('flat-alternative').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('variant-item-payment-support-offer').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('selected-variant')).toContainText('payment-support-offer');
  await expect(page.getByTestId('exploded-explanation')).toBeVisible();
});

test('AT-34 automated accessibility checks: results with source nodes; no certification claim', async ({ page }) => {
  await open(page, 'aster-card-demo', 'validate');
  await page.getByTestId('run-validation').click();
  await expect(page.getByTestId('suite-accessibility')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('suite-accessibility')).not.toContainText(/not run/i);
  await expect(page.getByTestId('certification-note')).toContainText(/not WCAG/i);
});

test('AT-35 reload after edit and save: edit persists; default fixture can be restored', async ({ page, request }) => {
  await open(page, 'aster-card-demo', 'design');
  await layer(page, 'greeting');
  await page.getByTestId('insp-tab-layout').click();
  await page.getByTestId('align-center').click();
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  await page.reload();
  await page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready');
  expect((await node(page, 'greeting')).layout.paged.align).toBe('center');
  await page.goto('/projects');
  await page.getByTestId('restore-aster-card-demo').click();
  await page.getByTestId('confirm-restore').click();
  await expect(page.getByTestId('project-card-aster-card-demo')).toContainText('Approved sample');
  const saved = await (await request.get(`${API}/projects/aster-card-demo`)).json();
  expect(saved.project.nodes.find((n: any) => n.id === 'greeting').layout.paged.align).toBe('left');
});

test('AT-36 Guided demo start → finish → reset twice: no stale state, deterministic replay', async ({ page }) => {
  test.setTimeout(400_000);
  await open(page, 'aster-card-demo', 'demo');
  for (let run = 0; run < 2; run++) {
    await page.getByTestId('start-demo').click();
    for (let i = 0; i < 11; i++) {
      await expect(page.getByTestId('banner-next')).not.toHaveText(/Running/, { timeout: 90000 });
      await page.getByTestId('banner-next').click();
    }
    await expect(page.getByTestId('banner-next')).toHaveText('Finish', { timeout: 90000 });
    await page.getByTestId('nav-S11').click();
    await expect(page.locator('[data-testid^="checkpoint-"]')).toHaveCount(12);
    await expect(page.locator('[data-testid^="checkpoint-"]').filter({ hasText: 'failed' })).toHaveCount(0);
  }
  await expect(page.getByTestId('demo-deterministic')).toHaveText(/Identical/);
  await page.getByTestId('reset-demo').click();
  await expect(page.getByTestId('demo-status')).toHaveText('Ready', { timeout: 30000 });
  const s = await page.evaluate(() => { const st = (window as any).__iss.store.getState(); return { overrides: st.ctx.overrides, cursor: st.ctx.journeyCursor, record: st.ctx.recordId, nodes: st.project.nodes.length }; });
  expect(s).toEqual({ overrides: {}, cursor: null, record: 'CARD-0001', nodes: 30 });
});
