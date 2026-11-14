import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, open, plainCopy, resetAll, state } from './helpers';
import { gotoScreen } from './nav-helper';
import { resolve, type RNode } from '../packages/resolver/src/index';
import type { Project, SyntheticRecord } from '../packages/model/src/index';

/**
 * The document's date, effective periods and the timeline (S24 Dates and everywhere the preview date reaches).
 * Every test works on its own copy of the card as the fixtures build it (no dates; the stored sample has one since D106)
 * and deletes it afterwards;
 * date sources and periods are set through the screens (or, for the set-up of a check, the store's command bus).
 */

const BEFORE = '2026-12-31';
const ON = '2027-01-01';
const ASSISTED = 'CARD-0002'; // asked for payment assistance: rule R04 chooses "payment-assistance-requested"
const UNDER_REVIEW = 'EOB-0002'; // HarborCare: rule R14 chooses "under review"

let pid = '';
const made: string[] = [];
async function duplicate(request: APIRequestContext, sample: 'aster-card-demo' | 'harborcare-demo'): Promise<string> {
  // The stored card sample has the statement issue date as its date since D106: card tests start from the built-in card
  // starter (the sample as the fixtures build it, without dates). The explanation of benefits still has no date.
  if (sample === 'aster-card-demo') { const { projectId } = await plainCopy(request, sample, `Dates E2E ${Date.now().toString(36)}`); made.push(projectId); return projectId; }
  const r = await request.post(`${API}/projects/${sample}/duplicate`, { data: { title: `Dates E2E ${Date.now().toString(36)}` } });
  expect(r.ok()).toBeTruthy();
  const id = (await r.json()).project.projectId as string;
  made.push(id);
  return id;
}
test.beforeEach(async ({ request }) => {
  await resetAll(request);
  pid = await duplicate(request, 'aster-card-demo');
});
test.afterEach(async ({ request }) => { while (made.length) await request.delete(`${API}/projects/${made.pop()}`); });

const dispatch = (page: Page, cmd: unknown) => page.evaluate((c) => (window as any).__iss.store.getState().dispatch(c), cmd);
const project = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().project) as Promise<Project>;
const dirty = (page: Page) => page.evaluate(() => { const s = (window as any).__iss.store.getState(); return (window as any).__iss.digest() !== s.savedDigest; });
const undo = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().undo());
const setRecord = (page: Page, id: string) => page.evaluate((r) => (window as any).__iss.store.getState().setRecord(r), id);
const runId = (page: Page) => page.evaluate(() => {
  const s = (window as any).__iss.store.getState();
  return s.ctx.recordId;
});

/** Open a screen from the menu, the way a person does (no reload: unsaved edits stay). */
const go = (page: Page, screen: string) => gotoScreen(page, screen).then(() => expect(page.locator('#main section.screen').first()).toBeVisible());

/** Open the blocker about the document's date on the Blockers screen and return its detail. */
async function openDateBlocker(page: Page) {
  const row = page.locator('[data-blocker]').filter({ hasText: /date/i }).first();
  await row.click();
  return page.getByTestId('bl-detail');
}

/** Choose "Given for each run" on the Dates screen. */
async function useRunDate(page: Page) {
  await open(page, pid, 'dates');
  await page.getByTestId('dates-source-run').check();
  await expect(page.getByTestId('dates-source')).toHaveAttribute('data-value', 'run');
}

/** Put rule R04 in effect from 1 Jan 2027 in the rule editor. */
async function datedRule(page: Page) {
  await go(page, 'S07');
  await expect(page.getByTestId('rule-row-R04')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('rule-period-from').fill(ON);
  await expect(page.getByTestId('rule-period-chip-R04')).toHaveText('from 1 Jan 2027');
}

test('D01 a document without dates is unchanged: no date controls, no status-bar date, the same run', async ({ page }) => {
  await open(page, pid, 'dates');
  await expect(page.getByTestId('dates-screen')).toBeVisible();
  await expect(page.getByTestId('dates-empty')).toContainText('does not use dates');
  await expect(page.getByTestId('dates-empty')).toContainText('never from today’s date');
  await expect(page.getByTestId('dates-source')).toHaveAttribute('data-value', 'none');
  const before = await page.evaluate(() => (window as any).__iss.store.getState().ctx);
  const res0 = await page.evaluate(() => { const s = (window as any).__iss.store.getState(); return s.project.modelVersion; });
  // Even with a preview date in the store, a document without a date source ignores it everywhere.
  await page.evaluate((d) => (window as any).__iss.store.getState().setIssueDate(d), ON);
  await expect(page.getByTestId('dock-issue-date')).toHaveCount(0);
  await open(page, pid, 'rules-data?rule=R04');
  await expect(page.getByTestId('rule-editor')).toBeVisible();
  await expect(page.getByTestId('rule-period')).toHaveCount(0);
  await expect(page.getByTestId('rule-period-chip-R04')).toHaveCount(0);
  await expect(page.getByTestId('trace-document-date')).toHaveCount(0);
  await open(page, pid, 'design');
  await expect(page.getByTestId('variants-editor')).toBeVisible();
  await expect(page.locator('[data-testid^="variant-period-"]')).toHaveCount(0);
  await open(page, pid, 'overview');
  await expect(page.getByTestId('glance-dates')).toHaveCount(0);
  expect(await dirty(page)).toBe(false);
  expect(res0).toBeGreaterThan(0);
  expect(before.recordId).toBeTruthy();
});

test('D02 choosing a date source is one undoable change; a customer without the date is stopped, shown on Blockers with Data Explorer and Dates', async ({ page }) => {
  await open(page, pid, 'dates');
  // A date field of the document's own (the sample customers have no value for it).
  await dispatch(page, { type: 'SET_CUSTOM_FIELDS', fields: [{ key: 'noticeDate', label: 'Notice date', type: 'date' }] });
  await expect(page.getByTestId('dates-source-field-select')).toBeVisible();
  await page.getByTestId('dates-source-field-select').selectOption('custom.noticeDate');
  await page.getByTestId('dates-source-field').check();
  await expect(page.getByTestId('dates-source')).toHaveAttribute('data-value', 'field');
  expect((await project(page)).documentDate).toEqual({ source: 'field', path: 'custom.noticeDate' });
  await expect(page.getByTestId('dates-source-words')).toContainText('each customer’s “Notice date”');
  // A rule with a period: now the date decides something, so a customer without it is stopped.
  await dispatch(page, { type: 'SET_RULE_PERIOD', ruleId: 'R04', period: { from: ON } });
  // "None" is refused while a period exists, in the engine's words.
  await page.getByTestId('dates-source-none').click();
  await expect(page.getByTestId('dates-source-error')).toContainText('The document’s date is still used (1 period)');
  await expect(page.getByTestId('dates-source')).toHaveAttribute('data-value', 'field');

  await go(page, 'S17');
  const detail = await openDateBlocker(page);
  await expect(detail).toHaveAttribute('data-kind', 'customer-data');
  await expect(detail.getByTestId('bl-detail-kind')).toContainText(/customer/i);
  await expect(detail.getByTestId('bl-open-data')).toBeVisible();
  await expect(detail.getByTestId('bl-open-dates')).toBeVisible();

  // Undo the period and the source: back to a document without dates.
  await undo(page); // the rule period
  await undo(page); // the source
  expect((await project(page)).documentDate).toBeUndefined();
  expect((await project(page)).rules.find((r) => r.id === 'R04')!.effective).toBeUndefined();
});

test('D03 periods on a rule and an alternative, "As issued on" the day before and the day itself, everywhere; the status bar; clearing; never unsaved', async ({ page }) => {
  await useRunDate(page);
  await datedRule(page);
  // Undo the rule period, then put it back with redo: one step each.
  await undo(page);
  await expect(page.getByTestId('rule-period-chip-R04')).toHaveCount(0);
  await page.evaluate(() => (window as any).__iss.store.getState().redo());
  await expect(page.getByTestId('rule-period-chip-R04')).toHaveText('from 1 Jan 2027');
  // The engine's order check, in its words.
  await page.getByTestId('rule-period-until').fill('2026-06-01');
  await expect(page.getByTestId('rule-period-error')).toContainText('The period must end after it starts');

  // An alternative in effect from the same day, in the Design Studio's alternatives editor.
  await page.evaluate(() => (window as any).__iss.store.getState().select('payment-guidance'));
  await go(page, 'S02');
  await page.getByTestId('variant-period-payment-reminder-from').fill(ON);
  await expect(page.getByTestId('variant-period-chip-payment-reminder')).toHaveText('from 1 Jan 2027');
  const p1 = await project(page);
  expect(p1.nodes.find((n) => n.id === 'payment-guidance')!.variantPeriods).toEqual({ 'payment-reminder': { from: ON } });
  await undo(page);
  expect((await project(page)).nodes.find((n) => n.id === 'payment-guidance')!.variantPeriods).toBeUndefined();
  await page.evaluate(() => (window as any).__iss.store.getState().redo());

  // Save, so "unsaved" can be checked against the preview date.
  expect(await page.evaluate(() => (window as any).__iss.store.getState().save())).toBe(true);
  expect(await dirty(page)).toBe(false);

  await setRecord(page, ASSISTED);
  await go(page, 'S24');
  await page.getByTestId(`dates-pick-before-${ON}`).click();
  await expect(page.getByTestId('dock-issue-date')).toContainText('As issued on 31 Dec 2026');
  expect(await dirty(page)).toBe(false);
  expect(await runId(page)).toBe(ASSISTED);

  // The day before: R04 is not in effect, everywhere.
  await go(page, 'S07');
  await expect(page.getByTestId('rule-state-R04')).toHaveText('Not in effect');
  await expect(page.getByTestId('rule-off-R04')).toHaveText('Not in effect on 31 Dec 2026');
  await expect(page.getByTestId('trace-document-date')).toHaveText('As issued on 31 Dec 2026');
  await expect(page.getByTestId('trace-R04')).toContainText('Not in effect on 31 Dec 2026: starts 1 Jan 2027.');
  await go(page, 'S03');
  await expect(page.getByTestId('exploded-explanation')).toContainText('Not in effect on 31 Dec 2026: starts 1 Jan 2027.');
  await expect(page.getByTestId('exploded-explanation')).toContainText('as issued on 31 Dec 2026');
  await go(page, 'S16');
  await expect(page.getByTestId('dx-outcome-date')).toHaveAttribute('data-value', BEFORE);
  const offMessage = (await page.getByTestId('dx-msg-payment-guidance').textContent()) ?? '';
  expect(offMessage).not.toContain('assistance');

  // The day itself: R04 applies again.
  await go(page, 'S24');
  await page.getByTestId(`dates-pick-${ON}`).click();
  await expect(page.getByTestId('dock-issue-date')).toContainText('As issued on 1 Jan 2027');
  await go(page, 'S07');
  await expect(page.getByTestId('rule-state-R04')).toHaveText('Selected');
  await expect(page.getByTestId('rule-off-R04')).toHaveCount(0);
  await go(page, 'S03');
  await expect(page.getByTestId('exploded-explanation')).not.toContainText('Not in effect');
  await go(page, 'S16');
  await expect(page.getByTestId('dx-outcome-date')).toHaveAttribute('data-value', ON);
  await expect(page.getByTestId('dx-msg-payment-guidance')).not.toHaveText(offMessage);

  // Preview & Export composes with the date: the request carries it and the server's run is the dated one.
  const composed = page.waitForRequest((r) => /\/api\/v1\/compose\//.test(r.url()) && r.method() === 'POST');
  await go(page, 'S10');
  const req = await composed;
  expect(req.postDataJSON().issueDate).toBe(ON);

  // Clearing it from the status bar.
  await page.getByTestId('dock-issue-date-clear').click();
  await expect(page.getByTestId('dock-issue-date')).toHaveCount(0);
  expect(await dirty(page)).toBe(false);
  expect(await page.evaluate(() => (window as any).__iss.store.getState().ctx.issueDate)).toBeNull();
});

/** What the timeline counts as "reached", worked out here with the engine directly (not the timeline function). */
function reachedOn(p: Project, records: SyntheticRecord[], day: string, dayBefore: string): number {
  const sig = (issueDate: string) => (record: SyntheticRecord) => {
    const r = resolve({ project: p, record, issueDate, profileId: 'paged-pdf' });
    const visible: string[] = [];
    const walk = (n: RNode) => { if (n.visible) visible.push(n.id); n.children.forEach(walk); };
    walk(r.root);
    return JSON.stringify([r.result.selectedVariants, visible, r.result.matchedRuleIds, [...new Set(r.findings.filter((f) => f.severity === 'blocking').map((f) => f.code))].sort()]);
  };
  return records.filter((r) => r.documentType === p.documentType).filter((r) => sig(day)(r) !== sig(dayBefore)(r)).length;
}

test('D04 the timeline lists each day with what starts and ends and the customers it reaches (the engine’s count); gaps and overlaps are reported', async ({ page, request }) => {
  await useRunDate(page);
  await dispatch(page, { type: 'SET_RULE_PERIOD', ruleId: 'R04', period: { from: ON } });
  await dispatch(page, { type: 'SET_VARIANT_PERIOD', nodeId: 'payment-guidance', variantId: 'payment-reminder', period: { from: '2027-03-01', until: '2027-06-01' } });
  const timeline = page.getByTestId('dates-timeline');
  await expect(timeline.locator('> li')).toHaveCount(3);
  const days = await timeline.locator('> li').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('dates-boundary-', '')));
  expect(days).toEqual([ON, '2027-03-01', '2027-06-01']);
  await expect(page.getByTestId(`dates-boundary-${ON}`)).toContainText('Rule “Customer asked for payment assistance” starts to apply');
  await expect(page.getByTestId('dates-boundary-2027-06-01')).toContainText('Ends');
  await expect(page.getByTestId('dates-strip')).toBeVisible();

  const p = await project(page);
  const records = (await (await request.get(`${API}/records?documentType=credit-statement&full=1&projectId=${pid}`)).json()).records as SyntheticRecord[];
  const prev = (d: string) => { const [y, m, dd] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, dd) - 86400000); return t.toISOString().slice(0, 10); };
  for (const d of days) {
    const want = reachedOn(p, records, d, prev(d));
    await expect(page.getByTestId(`dates-boundary-${d}`)).toHaveAttribute('data-reached', String(want));
    await expect(page.getByTestId(`dates-boundary-reached-${d}`)).toContainText(`Reaches ${want} of`);
  }
  expect(reachedOn(p, records, ON, BEFORE)).toBeGreaterThan(0);

  // Choosing a day from the list (keyboard) sets "As issued on".
  await page.getByTestId(`dates-use-${ON}`).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dock-issue-date')).toHaveAttribute('data-value', ON);

  // A gap: the fallback message is in effect only until 2028; an overlap: R02 at R04's priority, tying only from 1 Jan 2027.
  await dispatch(page, { type: 'SET_VARIANT_PERIOD', nodeId: 'payment-guidance', variantId: 'payment-standard', period: { until: '2028-01-01' } });
  const r02 = p.rules.find((r) => r.id === 'R02')!;
  await dispatch(page, { type: 'UPSERT_RULE', rule: { ...r02, priority: 400 } });
  const gap = page.getByTestId('dates-problem-gap').first();
  await expect(gap).toHaveAttribute('data-from', '2028-01-01');
  await expect(gap).toContainText('from 1 Jan 2028 on');
  await expect(gap.getByTestId('dates-problem-open-payment-guidance')).toBeVisible();
  const overlap = page.getByTestId('dates-problem-overlap');
  await expect(overlap).toHaveAttribute('data-from', ON);
  await expect(overlap).toContainText('have the same priority and are both in effect from 1 Jan 2027 on');
  await overlap.getByTestId('dates-problem-open-rule-R02').click();
  await expect(page).toHaveURL(/rules-data\?rule=R02/);
});

/** Submit and approve the saved document (auth is off: the local admin may), which makes release 1. */
async function approve(request: APIRequestContext) {
  expect((await request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'submit' } })).ok()).toBeTruthy();
  const r = await request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'approve' } });
  expect(r.ok(), await r.text()).toBeTruthy();
}

test('D05 Before & after compares as issued on the chosen day; coverage and generate test customers say which day; a pinned test keeps its day', async ({ page, request }) => {
  // The HarborCare sample can be approved as it is: release 1 has no dates. The working version puts R14 in effect from 1 Jan 2027.
  pid = await duplicate(request, 'harborcare-demo');
  await approve(request);
  await useRunDate(page);
  await dispatch(page, { type: 'SET_RULE_PERIOD', ruleId: 'R14', period: { from: ON } });
  await page.evaluate((d) => (window as any).__iss.store.getState().setIssueDate(d), BEFORE);
  await go(page, 'S20');
  await expect(page.getByTestId('cmp-issue-date')).toContainText('as issued on 31 Dec 2026');
  await expect(page.getByTestId('cmp-who-total')).toBeVisible();
  const changedBefore = await page.getByTestId('cmp-customer').evaluateAll((els) => els.map((e) => e.getAttribute('data-record')));
  await expect.poll(async () => (await page.locator(`[data-testid="cmp-group-message"] [data-record="${UNDER_REVIEW}"]`).count())).toBe(1);
  await page.getByTestId(`cmp-issue-date-${ON}`).click();
  await expect(page.getByTestId('cmp-issue-date')).toContainText('as issued on 1 Jan 2027');
  await expect.poll(async () => (await page.locator(`[data-testid="cmp-group-message"] [data-record="${UNDER_REVIEW}"]`).count())).toBe(0);
  expect(changedBefore.length).toBeGreaterThan(0);

  await go(page, 'S07');
  await page.getByTestId('coverage-open').click();
  await expect(page.getByTestId('coverage-issue-date')).toContainText('Coverage is worked out as issued on 1 Jan 2027');
  await expect(page.getByTestId('coverage-summary')).toContainText('as issued on 1 Jan 2027');
  await page.getByTestId(`coverage-issue-date-${BEFORE}`).click();
  await expect(page.getByTestId('coverage-summary')).toContainText('as issued on 31 Dec 2026');
  await page.keyboard.press('Escape');
  await page.getByTestId('testdata-open').click();
  await expect(page.getByTestId('testdata-issue-date')).toContainText('as issued on 31 Dec 2026');

  // A pinned test records the day it was pinned with.
  await page.keyboard.press('Escape');
  await page.getByTestId('rules-view-tests').click();
  await page.getByTestId('pin-test').click();
  await page.getByTestId('pin-confirm').click();
  await expect(page.getByTestId('test-issue-date').first()).toHaveText('as issued on 31 Dec 2026');
  expect((await project(page)).testCases!.at(-1)!.issueDate).toBe(BEFORE);
  await gotoScreen(page, 'S24');
  await expect(page.getByTestId('dates-screen')).toBeVisible();
  const st = await state(page);
  expect(st.ctx.issueDate).toBe(BEFORE);
});
