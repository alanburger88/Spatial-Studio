import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, demoTool, open, resetAll } from './helpers';

const P = 'aster-card-demo';
const H = 'harborcare-demo';
const TIE = 'priority-tie~R03+R04';
const SPANISH = 'required-translation-missing~billing-summary~es-US';
const OVERFLOW = 'flow-overflow-no-continuation~transaction-table';

test.beforeEach(async ({ request }) => { await resetAll(request); });
// Customers a test made (the document's own ones) are not removed by the project reset.
test.afterEach(async ({ request }) => {
  for (const [p, type] of [[P, 'credit-statement'], [H, 'eob']] as const) {
    const recs = (await (await request.get(`${API}/records?documentType=${type}&full=1&projectId=${p}`)).json()).records as any[];
    for (const r of recs.filter((x) => x.projectId)) await request.delete(`${API}/projects/${p}/records/${r.recordId}`);
  }
});

const store = <T = unknown>(page: Page, expr: string) => page.evaluate((e) => new Function(`return (${e})`)(), expr) as Promise<T>;
const state = (page: Page) => page.evaluate(() => { const s = (window as any).__iss.store.getState(); return { past: s.past.length, continuation: s.project.nodes.find((n: any) => n.id === 'transaction-table')?.flowContinuation }; });
const blockerParam = (page: Page) => new URL(page.url()).searchParams.get('blocker');
const cardRecords = async (request: APIRequestContext) => ((await (await request.get(`${API}/records?documentType=credit-statement&full=1&projectId=${P}`)).json()).records as any[]);

/** An editable copy of a sample customer, changed by `edit`. Returns its id. */
async function ownCopy(request: APIRequestContext, edit: (card: any) => any, sampleId = 'CARD-0001') {
  const made = await request.post(`${API}/projects/${P}/records`, { data: { copyOf: sampleId } });
  expect(made.status()).toBe(201);
  const rec = (await made.json()).record;
  const put = await request.put(`${API}/projects/${P}/records/${rec.recordId}`, { data: { record: { ...rec, card: edit(rec.card) } } });
  expect(put.ok()).toBeTruthy();
  return rec.recordId as string;
}
/** Seed D01 (two rules tie) as the demo tool does, then go to Blockers inside the app so the unsaved defect is kept. */
async function seedTieAndOpen(page: Page) {
  await open(page, P, 'rules-data');
  await demoTool(page, 'seed-d01');
  await page.getByTestId('demo-tools').getByRole('button', { name: 'Close demo tools' }).click();
  await page.getByTestId('nav-S17').click();
  await expect(page.getByTestId('blockers-screen')).toBeVisible();
  await expect(page.getByTestId(`bl-row-${TIE}`)).toBeVisible({ timeout: 30_000 });
}
/** A customer with 250 transactions, and a table that may not continue: only the composed pages can show that. */
async function seedOverflow(page: Page, request: APIRequestContext) {
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `T-${i}`, date: '2026-10-01', merchant: `Shop ${i}`, amountCents: 100 + i }));
  const id = await ownCopy(request, (card) => ({ ...card, transactions: many }));
  await open(page, P, 'rules-data');
  await store(page, `window.__iss.store.getState().dispatch({ type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { flowContinuation: false } })`);
  await page.getByTestId('nav-S17').click();
  await expect(page.getByTestId('blockers-screen')).toBeVisible();
  return id;
}

test('B01 a document nothing stops shows the empty state with the number of customers checked', async ({ page }) => {
  await open(page, H, 'blockers');
  const empty = page.getByTestId('bl-empty');
  await expect(empty).toBeVisible({ timeout: 30_000 });
  await expect(empty).toContainText('Nothing stops this document being issued to any of the 30 synthetic customers checked');
  await expect(empty).toContainText('A cause that none of these customers reaches is not listed');
  await expect(page.getByTestId('bl-checked')).toHaveText('30');
  await expect(page.getByTestId('bl-issuable')).toHaveText('30');
  await expect(page.getByTestId('bl-stopped')).toHaveText('0');
  await expect(page.getByTestId('bl-list')).toHaveCount(0);
  await expect(page.getByTestId('bl-generate')).toBeVisible();
  await expect(page.getByTestId('bl-empty-full')).toContainText('not been checked');
  await page.getByTestId('bl-generate').click();
  await expect(page).toHaveURL(/\/studio\/harborcare-demo\/rules-data/);
  await expect(page.getByTestId('testdata-dialog')).toBeVisible({ timeout: 10_000 });
});

test('B02 a priority tie is ONE Rules blocker with its customers; two fixes side by side; Apply clears it in place and Undo brings it back', async ({ page, request }) => {
  await seedTieAndOpen(page);
  const tied = (await cardRecords(request)).filter((r) => (r.card.missedPayments ?? 0) >= 2 && r.card.assistanceRequested === true);
  expect(tied.length).toBeGreaterThan(1);

  await expect(page.locator('[data-testid^="bl-row-priority-tie"]')).toHaveCount(1);
  const row = page.getByTestId(`bl-row-${TIE}`);
  await expect(row).toHaveAttribute('data-kind', 'rules');
  await expect(row.getByTestId('bl-count')).toHaveText(`${tied.length} customers stopped`);
  await expect(row).toContainText('Best fix: Raise the priority of');
  await expect(page.getByTestId('bl-kind-rules')).toContainText('Rules');
  await expect(row.getByTestId('bl-from-full')).toHaveCount(0);

  await row.click();
  expect(blockerParam(page)).toBe(TIE);
  const detail = page.getByTestId('bl-detail');
  await expect(detail).toHaveAttribute('data-blocker', TIE);
  await expect(detail.getByTestId('bl-customers').locator('li')).toHaveCount(tied.length);
  const fixes = detail.getByTestId('bl-fix').filter({ has: page.locator('[data-kind="change"]') });
  expect(await fixes.count()).toBeGreaterThanOrEqual(2);
  const first = fixes.first();
  await expect(first.getByTestId('assist-impact')).toContainText(/unblocks \d+ of \d+ synthetic customers/, { timeout: 30_000 });
  await expect(first.getByTestId('assist-impact')).toHaveAttribute('data-newly-blocked', '0');
  await expect(fixes.nth(1).getByTestId('assist-impact')).toBeVisible({ timeout: 30_000 });
  // the row's own line shows the effect of the best fix too
  await expect(row).toContainText(/unblocks \d+ of \d+ synthetic customers/, { timeout: 30_000 });

  const before = (await state(page)).past;
  await first.getByTestId('assist-apply').click();
  await expect(page.getByTestId(`bl-row-${TIE}`)).toHaveCount(0, { timeout: 30_000 });
  await expect(page).toHaveURL(/\/studio\/aster-card-demo\/blockers/);
  await expect(page.getByTestId('bl-resolved')).toContainText('no longer a blocker');
  expect((await state(page)).past).toBe(before + 1); // one undoable step
  // the screen moved on to the next blocker by itself
  await expect(page.getByTestId('bl-detail')).not.toHaveAttribute('data-blocker', TIE);

  await page.getByTestId('undo').click();
  await expect(page.getByTestId(`bl-row-${TIE}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`bl-row-${TIE}`).getByTestId('bl-count')).toHaveText(`${tied.length} customers stopped`);
});

test('B03 the missing Spanish text is one Wording blocker naming the Spanish-speaking customers; Open where this is fixed lands on Content & Translations', async ({ page, request }) => {
  const spanish = (await cardRecords(request)).filter((r) => r.customer.locale === 'es-US').map((r) => r.recordId).sort();
  expect(spanish.length).toBeGreaterThan(1);
  await open(page, P, 'blockers');
  const row = page.getByTestId(`bl-row-${SPANISH}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute('data-kind', 'wording');
  await expect(row).toContainText('No approved Spanish text for “New balance”');
  await expect(row.getByTestId('bl-count')).toHaveText(`${spanish.length} customers stopped`);
  await expect(page.getByTestId('bl-kind-wording')).toBeVisible();
  await row.click();
  const customers = page.getByTestId('bl-customers').locator('li');
  await expect(customers).toHaveCount(spanish.length);
  expect((await customers.evaluateAll((els) => els.map((e) => e.getAttribute('data-record')))).sort()).toEqual(spanish);
  // names in Business view, codes only in Technical view
  await expect(page.getByTestId('bl-detail')).not.toContainText('REQUIRED_TRANSLATION_MISSING');
  await expect(page.getByTestId('bl-detail')).not.toContainText('es-US');
  // a person has to do it: no Apply button, a link instead
  await expect(page.getByTestId('bl-detail').getByTestId('assist-apply')).toHaveCount(0);
  await page.getByTestId('bl-open').click();
  await expect(page).toHaveURL(/\/studio\/aster-card-demo\/content/);
  await expect(page.getByTestId('translations-view')).toBeVisible();
});

test('B04 a customer whose own data is wrong is a "customer’s data is wrong" blocker that opens Data Explorer on that customer', async ({ page, request }) => {
  const id = await ownCopy(request, (card) => ({ ...card, paymentStatus: 'current', missedPayments: 3 }));
  await open(page, P, 'blockers');
  const row = page.getByTestId('bl-row-inconsistent-payment-state~payment-guidance');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute('data-kind', 'customer-data');
  await expect(page.getByTestId('bl-kind-customer-data')).toContainText('The customer’s data is wrong');
  await expect(row.getByTestId('bl-count')).toHaveText('1 customer stopped');
  await row.click();
  await expect(page.getByTestId('bl-detail-kind')).toHaveText('The customer’s data is wrong');
  await expect(page.getByTestId('bl-datanote')).toContainText('The document is fine');
  // nothing in the document is proposed for change
  await expect(page.getByTestId('bl-detail').getByTestId('assist-apply')).toHaveCount(0);
  await page.getByTestId('bl-open-data').click();
  await expect(page).toHaveURL(new RegExp(`/studio/aster-card-demo/data\\?customer=${id}`));
  await expect(page.getByTestId('dx-record')).toHaveAttribute('data-record', id);
});

test('B05 the status bar opens the screen; Resolve in Blockers from Validate & Compare and from the Review panel select the same blocker', async ({ page }) => {
  await open(page, P, 'rules-data');
  await demoTool(page, 'seed-d01');
  await page.getByTestId('demo-tools').getByRole('button', { name: 'Close demo tools' }).click();
  // 1. the status bar count
  const dock = page.getByTestId('dock-status');
  await expect(dock).toContainText('blocking');
  await dock.click();
  await expect(page).toHaveURL(/\/studio\/aster-card-demo\/blockers/);
  await expect(page.getByTestId(`bl-row-${TIE}`)).toBeVisible({ timeout: 30_000 });

  // 2. Validate & Compare, This customer
  await page.evaluate(() => localStorage.setItem('iss.validateScope', 'this'));
  await page.getByTestId('nav-S09').click();
  await expect(page.getByTestId('validation-list')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('validate-view')).toContainText(/up to date/, { timeout: 90_000 });
  await page.locator('[data-testid^="issue-"][data-testid*="TIE"]').first().click();
  await page.getByTestId('resolve-in-blockers-detail').click();
  await expect(page).toHaveURL(/\/studio\/aster-card-demo\/blockers/);
  expect(blockerParam(page)).toBe(TIE);
  await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', TIE);

  // 3. Validate & Compare, All customers: a link on each row
  await page.getByTestId('nav-S09').click();
  await page.getByTestId('scope-all').click();
  const group = page.locator('[data-testid="blocker-group"][data-code="EXCLUSIVE_PRIORITY_TIE"]').first();
  await expect(group).toBeVisible({ timeout: 60_000 });
  await group.locator('xpath=..').getByTestId('resolve-in-blockers').click();
  expect(blockerParam(page)).toBe(TIE);
  await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', TIE);

  // 4. the Review panel (it reviews the saved model, so save first)
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 30_000 });
  await page.getByTestId('workflow-status').click();
  const item = page.getByTestId('review-panel').getByTestId('readiness-blocking').filter({ hasText: /priority/i }).first();
  await expect(item).toBeVisible({ timeout: 60_000 });
  await item.getByTestId('resolve-in-blockers').click();
  await expect(page.getByTestId('review-panel')).toHaveCount(0);
  await expect(page).toHaveURL(/\/studio\/aster-card-demo\/blockers/);
  expect(blockerParam(page)).toBe(TIE);
  await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', TIE);
});

test('B06 the summary names the two speeds; Run full check fills in the layout blockers and says they come from it', async ({ page, request }) => {
  test.setTimeout(180_000);
  const longId = await seedOverflow(page, request);
  const fast = page.getByTestId('bl-speed-fast');
  const full = page.getByTestId('bl-speed-full');
  await expect(fast).toContainText(/Rules, wording and data:\s*checked just now for all 71 synthetic customers/, { timeout: 30_000 });
  await expect(full).toContainText('Pages and PDF/web differences');
  await expect(full).toContainText('not run yet');
  await expect(page.locator('[data-testid^="bl-row-flow-overflow"]')).toHaveCount(0);

  await page.getByTestId('bl-run-full').click();
  await expect(page.getByTestId('bl-full-progress')).toBeVisible();
  await expect(page.getByTestId('bl-full-time')).toContainText(/from the full check at \d{1,2}:\d{2}/, { timeout: 150_000 });
  await expect(page.getByTestId('bl-run-full')).toContainText('Run full check again');

  const row = page.getByTestId(`bl-row-${OVERFLOW}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-speed', 'full-check');
  await expect(row.getByTestId('bl-from-full')).toHaveText('from the full check');
  // with the table unable to continue, every customer whose rows do not fit on one page is stopped, the one with 250 transactions among them
  await expect(row.getByTestId('bl-count')).toHaveText(/^\d+ customers stopped$/);
  expect(Number(await row.getByTestId('bl-count').getAttribute('data-n'))).toBeGreaterThan(1);
  await expect(page.getByTestId('bl-kind-layout')).toBeVisible();
  await row.click();
  await expect(page.getByTestId('bl-customers').locator(`li[data-record="${longId}"]`)).toHaveCount(1);
  // the fast blockers are not marked
  await expect(page.getByTestId(`bl-row-${SPANISH}`).getByTestId('bl-from-full')).toHaveCount(0);
  await expect(page.getByTestId('bl-full-stale')).toHaveCount(0);

  // a change to the document makes the stale note appear, and the detail of a full-check blocker says so
  await store(page, `window.__iss.store.getState().dispatch({ type: 'UPDATE_NODE', nodeId: 'billing-summary', patch: { name: 'New balance box' } })`);
  await expect(page.getByTestId('bl-full-stale')).toContainText('may be out of date');
  await expect(page.getByTestId('bl-detail')).toContainText('made before your last change');

  // applying its fix cannot be confirmed without the pages: the screen says to run the check again
  await page.getByTestId('bl-detail').getByTestId('bl-fix').first().getByTestId('assist-apply').click({ timeout: 30_000 });
  await expect(page.getByTestId('bl-unconfirmed')).toBeVisible();
  expect((await state(page)).continuation).not.toBe(false);
});

test('B07 a user who may not edit sees the fixes but cannot apply them, and is told why', async ({ page }) => {
  await open(page, P, 'rules-data');
  await demoTool(page, 'seed-d01');
  await page.getByTestId('demo-tools').getByRole('button', { name: 'Close demo tools' }).click();
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 30_000 });
  await page.route('**/api/v1/session', (route) => route.fulfill({ json: {
    authEnabled: true, user: { id: 'u-rev', name: 'Riley Reviewer', email: 'rev@example.test', role: 'reviewer' },
    permissions: ['view', 'comment'], roles: ['reviewer'], expiresAt: null,
  } }));
  await open(page, P, `blockers?blocker=${encodeURIComponent(TIE)}`);
  await expect(page.getByTestId(`bl-row-${TIE}`)).toBeVisible({ timeout: 30_000 });
  const detail = page.getByTestId('bl-detail');
  await expect(detail).toHaveAttribute('data-blocker', TIE);
  await expect(page.getByTestId('bl-readonly')).toContainText(/reviewers can comment but not edit/i);
  const fixes = detail.getByTestId('bl-fix').filter({ has: page.locator('[data-kind="change"]') });
  expect(await fixes.count()).toBeGreaterThanOrEqual(2);
  await expect(fixes.first().getByTestId('assist-impact')).toBeVisible({ timeout: 30_000 }); // they still see the effect
  await expect(fixes.first().getByTestId('assist-apply')).toBeDisabled();
  await expect(page.getByTestId('bl-open')).toBeEnabled(); // and can still go and look
  await expect(page.getByTestId('bl-fix-all-safe')).toBeVisible();
});

test('B08 Fix all safe issues works from the screen: one undoable step', async ({ page, request }) => {
  test.setTimeout(180_000);
  await seedOverflow(page, request);
  const all = page.getByTestId('bl-fix-all-safe');
  await expect(all).toBeDisabled(); // nothing safe to fix before the pages have been checked
  await page.getByTestId('bl-run-full').click();
  await expect(page.getByTestId(`bl-row-${OVERFLOW}`)).toBeVisible({ timeout: 150_000 });
  await expect(all).toBeEnabled({ timeout: 60_000 });
  const before = await state(page);
  expect(before.continuation).toBe(false);
  await all.click();
  const dialog = page.getByTestId('fix-all-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('one undoable step');
  expect(await dialog.getByTestId('fix-all-item').count()).toBeGreaterThan(0);
  await page.getByTestId('fix-all-apply').click();
  await expect(page.getByTestId('fix-all-dialog')).toHaveCount(0);
  const after = await state(page);
  expect(after.past).toBe(before.past + 1);
  expect(after.continuation).not.toBe(false);
  await page.getByTestId('undo').click();
  expect((await state(page)).continuation).toBe(false);
});

test('B09 deep links select a blocker and filter by kind; the list is keyboard-usable; Technical view adds the codes', async ({ page }) => {
  await open(page, P, `blockers?blocker=${encodeURIComponent(SPANISH)}&kind=wording`);
  await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', SPANISH, { timeout: 30_000 });
  await expect(page.getByTestId(`bl-row-${SPANISH}`)).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('bl-kindcount-wording')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('bl-kindcount-wording')).toHaveAttribute('data-count', '4');
  await page.getByTestId('bl-kindcount-rules').isDisabled();
  // arrow keys move the selection
  await page.getByTestId(`bl-row-${SPANISH}`).focus();
  const ids = await page.locator('[data-testid^="bl-row-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-blocker')));
  expect(ids.length).toBe(4);
  await page.keyboard.press('ArrowDown');
  const second = ids[(ids.indexOf(SPANISH) + 1) % ids.length];
  await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', second!);
  expect(blockerParam(page)).toBe(second);
  // a blocker that is not there says so instead of showing nothing
  await open(page, P, 'blockers?blocker=nothing~here');
  await expect(page.getByTestId('bl-resolved')).toContainText('no longer listed', { timeout: 30_000 });
  await expect(page.getByTestId('bl-detail')).toBeVisible();
  // Technical view
  await page.evaluate(() => localStorage.setItem('iss.viewMode', 'technical'));
  await open(page, P, `blockers?blocker=${encodeURIComponent(SPANISH)}`);
  await expect(page.getByTestId('bl-detail')).toContainText('REQUIRED_TRANSLATION_MISSING', { timeout: 30_000 });
  await expect(page.getByTestId('bl-detail')).toContainText(SPANISH);
});

test('B10 every place that shows a blocker links to it: Content & Translations, Data Explorer, the Design inspector', async ({ page, request }) => {
  // Content & Translations: the banner about blocked Spanish-speaking customers
  await open(page, P, 'content');
  const summary = page.getByTestId('tr-summary');
  await expect(summary).toContainText(/blocked until they are/, { timeout: 30_000 });
  await summary.getByTestId('resolve-in-blockers').click();
  await expect(page).toHaveURL(/\/studio\/aster-card-demo\/blockers/);
  expect(blockerParam(page)).toMatch(/^required-translation-missing~.+~es-US$/);
  await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', blockerParam(page)!);

  // Data Explorer: a blocked customer's "What this customer gets"
  const es = (await cardRecords(request)).find((r) => r.customer.locale === 'es-US')!.recordId as string;
  await open(page, P, `data?customer=${es}`);
  const blocking = page.getByTestId('dx-outcome-blocking');
  await expect(blocking).toBeVisible({ timeout: 30_000 });
  await blocking.getByTestId('resolve-in-blockers').first().click();
  await expect(page).toHaveURL(/\/studio\/aster-card-demo\/blockers/);
  expect(blockerParam(page)).toMatch(/^required-translation-missing~.+~es-US$/);

  // Design: the Review tab of a component that has a blocker
  await open(page, P, 'design');
  await store(page, `window.__iss.store.getState().select('billing-summary')`);
  await page.getByTestId('inspector-tab-comments').click();
  await expect(page.getByTestId('insp-blockers')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('insp-blockers').getByTestId('resolve-in-blockers').first().click();
  await expect(page).toHaveURL(/\/studio\/aster-card-demo\/blockers/);
  expect(blockerParam(page)).toBe(SPANISH);
  await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', SPANISH);
});

test('B11 a generated customer the document cannot be issued to links to the blockers that stop them', async ({ page, request }) => {
  await open(page, P, 'rules-data');
  await page.getByTestId('testdata-open').click();
  await expect(page.getByTestId('testdata-plan-count')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('testdata-generate').click();
  await expect(page.getByTestId('testdata-done')).toBeVisible({ timeout: 60_000 });
  // the Spanish-language customer is among them, and Spanish has no approved text
  const blocked = page.getByTestId('testdata-customer').filter({ has: page.getByTestId('testdata-blocked-customer') });
  expect(await blocked.count()).toBeGreaterThan(0);
  const id = (await blocked.first().getAttribute('data-record'))!;
  await blocked.first().getByTestId('resolve-in-blockers').click();
  await expect(page).toHaveURL(new RegExp(`/studio/aster-card-demo/blockers\\?customer=${id}`));
  await expect(page.getByTestId('bl-customer-filter')).toContainText('that stop');
  await expect(page.locator('[data-testid^="bl-row-"]').first()).toBeVisible({ timeout: 30_000 });
  for (const rowId of await page.locator('[data-testid^="bl-row-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-blocker')))) expect(rowId).toMatch(/^required-translation-missing~/);
  await page.getByTestId('bl-customer-clear').click();
  await expect(page.getByTestId('bl-customer-filter')).toHaveCount(0);
  await request.delete(`${API}/projects/${P}/test-data`);
});
