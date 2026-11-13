import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, demoTool, open, resetAll } from './helpers';

/** Blockers phase 3: resolve one by one, with a progress bar the engine works out, and a test pinned for what was fixed. */

const P = 'aster-card-demo';
const TIE = 'priority-tie~R03+R04';
const DATA = 'inconsistent-payment-state~payment-guidance';
const OVERFLOW = 'flow-overflow-no-continuation~transaction-table';

test.beforeEach(async ({ request }) => { await resetAll(request); });
test.afterEach(async ({ request }) => {
  const recs = (await (await request.get(`${API}/records?documentType=credit-statement&full=1&projectId=${P}`)).json()).records as any[];
  for (const r of recs.filter((x) => x.projectId)) await request.delete(`${API}/projects/${P}/records/${r.recordId}`);
  await resetAll(request);
});

const store = <T = any>(page: Page, expr: string) => page.evaluate((e) => new Function(`return (${e})`)(), expr) as Promise<T>;
const past = (page: Page) => store<number>(page, 'window.__iss.store.getState().past.length');
const tests = (page: Page) => store<Array<{ id: string; name: string; recordId: string }>>(page, 'window.__iss.store.getState().project.testCases ?? []');
const num = async (page: Page, testId: string) => Number(await page.getByTestId(testId).textContent());

/** Seed D01 (two rules tie) as the demo tool does, then go to Blockers inside the app so the unsaved defect is kept. */
async function seedTieAndOpen(page: Page) {
  await open(page, P, 'rules-data');
  await demoTool(page, 'seed-d01');
  await page.getByTestId('demo-tools').getByRole('button', { name: 'Close demo tools' }).click();
  await page.getByTestId('nav-S17').click();
  await expect(page.getByTestId(`bl-row-${TIE}`)).toBeVisible({ timeout: 30_000 });
}
async function badCopy(request: APIRequestContext) {
  const rec = (await (await request.post(`${API}/projects/${P}/records`, { data: { copyOf: 'CARD-0001' } })).json()).record;
  expect((await request.put(`${API}/projects/${P}/records/${rec.recordId}`, { data: { record: { ...rec, card: { ...rec.card, paymentStatus: 'current', missedPayments: 3 } } } })).ok()).toBeTruthy();
  return rec.recordId as string;
}
/** Skips steps until the pass shows `id`; returns the ids it went past. */
async function skipTo(page: Page, id: string) {
  const passed: string[] = [];
  for (let i = 0; i < 12; i++) {
    const step = page.getByTestId('bl-pass-step');
    await expect(step).toBeVisible();
    const at = await step.getAttribute('data-blocker');
    if (at === id) return passed;
    passed.push(at!);
    await page.getByTestId('bl-pass-skip').click();
    await expect(page.getByTestId('bl-pass-step').or(page.getByTestId('bl-pass-end'))).not.toHaveAttribute('data-blocker', at!);
  }
  throw new Error(`never reached ${id}`);
}

test('BR01 a guided pass: most customers first, fixes side by side, Apply is one undoable step, the progress is the engine’s, and a test is offered for what was fixed', async ({ page }) => {
  await seedTieAndOpen(page);
  const stoppedAtStart = await num(page, 'bl-stopped');
  await page.getByTestId('bl-resolve-start').click();
  const pass = page.getByTestId('bl-pass');
  await expect(pass).toBeVisible();
  await expect(page.getByTestId('bl-aside')).toHaveCount(0);
  // the progress and the counts come from the engine, with the number of customers checked and both speeds
  await expect(page.getByTestId('bl-pass-stopped')).toHaveText(String(stoppedAtStart));
  await expect(page.getByTestId('bl-pass-progress')).toContainText(`of 70 synthetic customers still stopped`);
  await expect(page.getByTestId('bl-pass-speeds')).toContainText('Rules, wording and data: checked just now for all 70 synthetic customers');
  await expect(page.getByTestId('bl-pass-speeds')).toContainText('Pages and PDF/web differences: not checked yet');

  // most customers first: every step stops at least as many customers as the next
  const first = page.getByTestId('bl-pass-step');
  const firstCount = Number(await first.getByTestId('bl-count').getAttribute('data-n'));
  await expect(first).toContainText('What is wrong and why');
  await expect(first).toContainText('Who is affected');
  const passed = await skipTo(page, TIE);
  const tieCount = Number(await page.getByTestId('bl-pass-step').getByTestId('bl-count').getAttribute('data-n'));
  expect(firstCount).toBeGreaterThanOrEqual(tieCount);

  // the tie: fixes side by side, each with its effect; Apply is one undoable step
  const step = page.getByTestId('bl-pass-step');
  await expect(page.getByTestId('bl-pass-title')).toContainText('tie');
  const fixes = step.getByTestId('bl-fix').filter({ has: page.locator('[data-kind="change"]') });
  expect(await fixes.count()).toBeGreaterThanOrEqual(2);
  await expect(fixes.first().getByTestId('assist-impact')).toContainText(/unblocks \d+ of \d+ synthetic customers/, { timeout: 30_000 });
  const before = await past(page);
  await fixes.first().getByTestId('assist-apply').click();
  await expect(page.getByTestId('bl-pass-step').or(page.getByTestId('bl-pass-end'))).not.toHaveAttribute('data-blocker', TIE, { timeout: 30_000 });
  expect(await past(page)).toBe(before + 1);
  // recomputed by the engine, the same number the summary shows
  await expect(page.getByTestId('bl-pass-stopped')).toHaveText(await page.getByTestId('bl-stopped').textContent() as string);
  expect(await num(page, 'bl-pass-stopped')).toBeLessThanOrEqual(stoppedAtStart);
  await expect(pass.locator('.bl-pass-head .sub')).toContainText('1 fixed');

  // skip the rest; at the end, a test is offered for the fixed blocker, ticked, and nothing is pinned until chosen
  for (let i = 0; i < 12 && await page.getByTestId('bl-pass-step').count(); i++) await page.getByTestId('bl-pass-skip').click();
  const end = page.getByTestId('bl-pass-end');
  await expect(end).toBeVisible();
  await expect(page.getByTestId('bl-pass-summary')).toContainText(/^1 blocker fixed, \d+ skipped\. \d+ of 70 synthetic customers (is|are) still stopped/);
  expect(Number((await page.getByTestId('bl-pass-summary').textContent())!.match(/(\d+) skipped/)![1])).toBeGreaterThanOrEqual(passed.length);
  const offer = page.getByTestId('bl-pin-offer');
  await expect(offer).toContainText('Pin a test so this problem cannot come back unnoticed');
  await expect(page.getByTestId(`bl-pin-${TIE}`)).toBeChecked();
  expect(await tests(page)).toEqual([]);
  // untick and tick again: still the person's choice
  await page.getByTestId(`bl-pin-${TIE}`).uncheck();
  await expect(page.getByTestId('bl-pin-confirm')).toBeDisabled();
  await page.getByTestId(`bl-pin-${TIE}`).check();
  const beforePin = await past(page);
  await page.getByTestId('bl-pin-confirm').click();
  await expect(page.getByTestId('bl-pass-pinned')).toContainText('1 test pinned');
  const pinned = await tests(page);
  expect(pinned).toHaveLength(1);
  expect(pinned[0].name).toMatch(/^Stays fixed: .+ tie/);
  expect(await past(page)).toBe(beforePin + 1);
  // the test holds now, and would fail if the tie came back: Rules & Data shows it passing
  await page.getByTestId('bl-pass-finish').click();
  await expect(page.getByTestId('bl-pass')).toHaveCount(0);
  await page.getByTestId('undo').click(); // the pinned test goes with one undo, like any edit
  expect(await tests(page)).toEqual([]);
});

test('BR02 the pass can be left and resumed where it was; leaving loses nothing', async ({ page }) => {
  await seedTieAndOpen(page);
  await page.getByTestId('bl-resolve-start').click();
  const firstId = await page.getByTestId('bl-pass-step').getAttribute('data-blocker');
  await page.getByTestId('bl-pass-skip').click();
  const secondId = await page.getByTestId('bl-pass-step').getAttribute('data-blocker');
  expect(secondId).not.toBe(firstId);
  await page.getByTestId('bl-pass-close').click();
  await expect(page.getByTestId('bl-pass')).toHaveCount(0);
  await expect(page.getByTestId('bl-aside')).toBeVisible();
  await expect(page.getByTestId('bl-resolve-start')).toContainText(/Resume one by one \(\d+ blockers? left\)/);
  // away and back: the pass resumes on the same step
  await page.getByTestId('nav-S17').click();
  await page.getByTestId('bl-resolve-start').click();
  await expect(page.getByTestId('bl-pass-step')).toHaveAttribute('data-blocker', secondId!);
});

test('BR03 a data problem in the pass offers Data Explorer and a known data problem, not a fix; setting it aside moves the pass on', async ({ page, request }) => {
  const id = await badCopy(request);
  await open(page, P, 'blockers');
  await expect(page.getByTestId(`bl-row-${DATA}`)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('bl-resolve-start').click();
  await skipTo(page, DATA);
  const step = page.getByTestId('bl-pass-step');
  await expect(step.getByTestId('assist-apply')).toHaveCount(0);
  await expect(page.getByTestId('bl-pass-open-data')).toBeVisible();
  const stopped = await num(page, 'bl-pass-stopped');
  await page.getByTestId('bl-pass-mark-known').click();
  await page.getByTestId('bl-known-reason').fill('A copy kept to show the problem');
  await page.getByTestId('bl-known-save').click();
  await expect(page.getByTestId('bl-pass-step').or(page.getByTestId('bl-pass-end'))).not.toHaveAttribute('data-blocker', DATA, { timeout: 30_000 });
  await expect(page.getByTestId('bl-pass-stopped')).toHaveText(String(stopped - 1));
  await expect(page.getByTestId('bl-pass-progress')).toContainText('1 set aside as known data problems');
  // and Open in Data Explorer lands on the customer with the fields highlighted
  await page.getByTestId('bl-pass-close').click();
  await page.getByTestId(`bl-row-${DATA}`).click();
  await page.getByTestId(`bl-customer-data-${id}`).click();
  await expect(page.getByTestId('dx-record')).toHaveAttribute('data-record', id);
  await expect(page.getByTestId('dx-blocker-known-status')).toContainText('A copy kept to show the problem');
});

test('BR04 a blocker fixed outside the pass is offered a pinned test too; nothing is pinned without choosing it', async ({ page }) => {
  await seedTieAndOpen(page);
  await page.getByTestId(`bl-row-${TIE}`).click();
  const fix = page.getByTestId('bl-detail').getByTestId('bl-fix').filter({ has: page.locator('[data-kind="change"]') }).first();
  await expect(fix.getByTestId('assist-impact')).toBeVisible({ timeout: 30_000 });
  await fix.getByTestId('assist-apply').click();
  await expect(page.getByTestId('bl-resolved')).toContainText('no longer a blocker', { timeout: 30_000 });
  await expect(page.getByTestId('bl-resolved').getByTestId('bl-pin-offer')).toBeVisible();
  await expect(page.getByTestId(`bl-pin-${TIE}`)).toBeChecked();
  expect(await tests(page)).toEqual([]);
  await page.getByTestId('bl-pin-confirm').click();
  await expect(page.getByTestId('bl-pinned')).toBeVisible();
  expect((await tests(page)).map((t) => t.name)).toEqual([expect.stringMatching(/^Stays fixed: /)]);
});

test('BR05 a layout blocker from the last full check says so in the pass and offers to run the full check', async ({ page, request }) => {
  test.setTimeout(300_000);
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `T-${i}`, date: '2026-10-01', merchant: `Shop ${i}`, amountCents: 100 + i }));
  const rec = (await (await request.post(`${API}/projects/${P}/records`, { data: { copyOf: 'CARD-0001' } })).json()).record;
  expect((await request.put(`${API}/projects/${P}/records/${rec.recordId}`, { data: { record: { ...rec, card: { ...rec.card, transactions: many } } } })).ok()).toBeTruthy();
  await open(page, P, 'rules-data');
  await store(page, `window.__iss.store.getState().dispatch({ type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { flowContinuation: false } })`);
  await page.getByTestId('nav-S17').click();
  await page.getByTestId('bl-run-full').click();
  await expect(page.getByTestId(`bl-row-${OVERFLOW}`)).toBeVisible({ timeout: 200_000 });
  await page.getByTestId('bl-resolve-start').click();
  await expect(page.getByTestId('bl-pass-speeds')).toContainText(/Pages and PDF\/web differences: from the full check at \d{1,2}:\d{2}/);
  await skipTo(page, OVERFLOW);
  await expect(page.getByTestId('bl-pass-fullcheck')).toContainText('This comes from the last full check');
  await expect(page.getByTestId('bl-pass-run-full')).toBeVisible();
  // applying a fix to it cannot be confirmed without the full check: the pass moves on and says so at the end
  const fix = page.getByTestId('bl-pass-step').getByTestId('bl-fix').filter({ has: page.locator('[data-kind="change"]') }).first();
  await expect(fix.getByTestId('assist-impact')).toBeVisible({ timeout: 30_000 });
  await fix.getByTestId('assist-apply').click();
  for (let i = 0; i < 12 && await page.getByTestId('bl-pass-step').count(); i++) {
    if (await page.getByTestId('bl-pass-step').getAttribute('data-blocker') === OVERFLOW) { await page.waitForTimeout(300); continue; }
    await page.getByTestId('bl-pass-skip').click();
  }
  await expect(page.getByTestId('bl-pass-summary')).toContainText('waiting for the full check to confirm');
  await expect(page.getByTestId('bl-pass-end').getByTestId('bl-pass-run-full')).toBeVisible();
});
