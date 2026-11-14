import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { applyCommand, defaultNode, richFromMarkup, type Command, type Project } from '../packages/model/src/index';
import { API, open, plainCopy } from './helpers';

/**
 * The join-up of roadmap wave 2: the studio's one preview date on Calculations and Lookup tables, the links between
 * Rules & data, Data Explorer, Blockers, Dates, Calculations and Lookup tables, "Where it is used" with two parts of the
 * same name, the AFP view of a document with a page design, and a lookup table shared through the library.
 * Every test works on its own duplicate of the card sample (set up through the engine's commands and saved through the
 * API) and deletes it afterwards. Library items are studio-wide, so the library test uses names of its own.
 */

const made: string[] = [];
test.afterEach(async ({ request }) => { while (made.length) await request.delete(`${API}/projects/${made.pop()}`); });

const ok = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(r.message); return r.project; };

/** A duplicate of the card sample, changed by `commands` and saved. */
async function documentWith(request: APIRequestContext, title: string, commands: (p: Project) => Command[]): Promise<string> {
  // The card as the fixtures build it (the stored sample has its own calculations, table and date since D106).
  const start = (await plainCopy(request, 'aster-card-demo', `${title} ${Date.now().toString(36)}`)).project as Project;
  made.push(start.projectId);
  let p = start;
  for (const c of commands(p)) p = ok(p, c);
  const put = await request.put(`${API}/projects/${start.projectId}`, { data: { project: { ...p, modelVersion: start.modelVersion + 1 } }, headers: { 'if-match': `"${start.modelVersion}"` } });
  expect(put.ok(), await put.text()).toBeTruthy();
  return start.projectId;
}

/** Fee by tier (only "standard" has a row, no default), a dated rate table, three calculations, two rules on them, two parts named alike. */
const depth = (p: Project): Command[] => {
  const r04 = p.rules.find((r) => r.id === 'R04')!;
  return [
    { type: 'SET_DOCUMENT_DATE', source: { source: 'run' } },
    { type: 'UPSERT_LOOKUP_TABLE', table: { id: 'feeByTier', title: 'Fee by tier', keys: [{ key: 'tier', label: 'Account tier', match: 'text' }], columns: [{ key: 'fee', label: 'Fee', type: 'money' }], rows: [{ keys: { tier: 'standard' }, values: { fee: 1500 } }] } },
    { type: 'UPSERT_LOOKUP_TABLE', table: { id: 'rates', title: 'Bonus rate', keys: [{ key: 'period', label: 'In effect', match: 'date-range' }], columns: [{ key: 'rate', label: 'Rate', type: 'number' }], rows: [{ keys: { period: { from: '2027-01-01' } }, values: { rate: 2 } }] } },
    { type: 'UPSERT_CALCULATED_FIELD', field: { key: 'fee', label: 'Fee', type: 'money', expr: { op: 'lookup', table: 'feeByTier', column: 'fee', keys: [{ op: 'field', path: 'card.tier' }] } } },
    { type: 'UPSERT_CALCULATED_FIELD', field: { key: 'perMissed', label: 'Hundred per missed payment', type: 'number', expr: { op: 'div', a: { op: 'number', value: 100 }, b: { op: 'field', path: 'card.missedPayments' } } } },
    { type: 'UPSERT_CALCULATED_FIELD', field: { key: 'rate', label: 'Bonus rate', type: 'number', expr: { op: 'lookup', table: 'rates', column: 'rate', keys: [{ op: 'issueDate' }] } } },
    { type: 'UPSERT_RULE', rule: { ...r04, id: 'R90', title: 'Has a fee', priority: 5, when: { op: 'gt', path: 'calc.fee', value: 0 } } },
    { type: 'UPSERT_RULE', rule: { ...r04, id: 'R91', title: 'Few missed payments', priority: 6, when: { op: 'gt', path: 'calc.perMissed', value: 1 } } },
    { type: 'INSERT_NODE', node: { ...defaultNode('rich-text', 'fee-note-a', 'credit-statement', p), name: 'Fee note', content: richFromMarkup('Your fee: {{calc.fee}}.') }, parentId: p.rootNodeId },
    { type: 'INSERT_NODE', node: { ...defaultNode('rich-text', 'fee-note-b', 'credit-statement', p), name: 'Fee note', content: richFromMarkup('Again, your fee: {{calc.fee}}.') }, parentId: p.rootNodeId },
  ];
};

const ctx = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().ctx);
const setIssueDate = (page: Page, day: string | null) => page.evaluate((d) => (window as any).__iss.store.getState().setIssueDate(d), day);

test('W01 Calculations and Lookup tables use the studio’s preview date (the status bar’s), with a link to Dates', async ({ page, request }) => {
  const pid = await documentWith(request, 'Wave 2 dates', depth);
  await open(page, pid, 'calculations?calc=rate');
  const field = page.getByTestId('calc-asof');
  await expect(field).toBeVisible();
  await expect(page.getByTestId('calc-asof-words')).toContainText('needs a preview date');
  await page.getByTestId('calc-asof-input').fill('2026-06-01');
  await expect.poll(async () => (await ctx(page)).issueDate).toBe('2026-06-01');
  await expect(page.getByTestId('dock-issue-date')).toHaveAttribute('data-value', '2026-06-01');
  await expect(page.getByTestId('calc-row-value-rate')).toHaveText('No value');
  // Set from elsewhere (the store, as Dates does): this screen follows.
  await setIssueDate(page, '2027-01-02');
  await expect(page.getByTestId('calc-asof')).toHaveAttribute('data-value', '2027-01-02');
  await expect(page.getByTestId('calc-asof-input')).toHaveValue('2027-01-02');
  await expect(page.getByTestId('calc-row-value-rate')).toHaveAttribute('data-raw', '2');
  await expect(page.getByTestId('calc-asof-words')).toContainText('as issued on 2 Jan 2027');

  // Lookup tables: a table keyed by a range of dates shows the same day.
  await page.getByTestId('calc-asof-dates-link').click();
  await expect(page).toHaveURL(new RegExp(`/studio/${pid}/dates$`));
  await expect(page.getByTestId('dates-issue-date')).toHaveValue('2027-01-02');
  await open(page, pid, 'lookup-tables?table=rates');
  await expect(page.getByTestId('lk-asof')).toHaveAttribute('data-value', '2027-01-02');
  await open(page, pid, 'lookup-tables?table=feeByTier');
  await expect(page.getByTestId('lk-asof')).toHaveCount(0);
});

test('W02 a rule condition on a calculation, Data Explorer’s calculated values and the Dates timeline link to the calculation or table', async ({ page, request }) => {
  const pid = await documentWith(request, 'Wave 2 links', depth);
  await open(page, pid, 'rules-data?rule=R90');
  await page.getByTestId('cond-0-calc-link').click();
  await expect(page).toHaveURL(new RegExp(`/studio/${pid}/calculations\\?calc=fee$`));
  await expect(page.getByTestId('calc-row-fee')).toHaveAttribute('aria-current', 'true');

  await open(page, pid, 'data');
  await setIssueDate(page, '2027-01-02');
  await page.getByTestId('dx-calc-link-perMissed').click();
  await expect(page).toHaveURL(new RegExp(`/studio/${pid}/calculations\\?calc=perMissed$`));
  await expect(page.getByTestId('calc-row-perMissed')).toHaveAttribute('aria-current', 'true');

  await open(page, pid, 'dates');
  const day = page.getByTestId('dates-boundary-2027-01-01');
  await expect(day).toContainText('Bonus rate');
  await day.getByTestId('dates-table-link-rates').click();
  await expect(page).toHaveURL(new RegExp(`/studio/${pid}/lookup-tables\\?table=rates$`));
  await expect(page.getByTestId('lk-title')).toHaveValue('Bonus rate');
});

test('W03 Blockers: a calculation that cannot be worked out links to it; one that finds no lookup row links to the calculation and its table', async ({ page, request }) => {
  const pid = await documentWith(request, 'Wave 2 blockers', depth);
  await open(page, pid, 'blockers');
  await setIssueDate(page, '2027-01-02');
  await page.locator('[data-blocker="lookup-no-match~calc.fee"]').first().click();
  const detail = page.getByTestId('bl-detail');
  await expect(detail).toHaveAttribute('data-blocker', 'lookup-no-match~calc.fee');
  await expect(detail.getByTestId('bl-open-calc')).toHaveText('Open the calculation “Fee”');
  await detail.getByTestId('bl-open-table').click();
  await expect(page).toHaveURL(new RegExp(`/studio/${pid}/lookup-tables\\?table=feeByTier$`));
  await expect(page.getByTestId('lk-title')).toHaveValue('Fee by tier');

  await open(page, pid, 'blockers?blocker=calculation-missing~calc.perMissed');
  await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', 'calculation-missing~calc.perMissed');
  await expect(page.getByTestId('bl-detail').getByTestId('bl-open-table')).toHaveCount(0);
  await page.getByTestId('bl-detail').getByTestId('bl-open-calc').click();
  await expect(page).toHaveURL(new RegExp(`/studio/${pid}/calculations\\?calc=perMissed$`));
});

test('W04 “Where it is used” links each place by what it is, even two parts with the same name', async ({ page, request }) => {
  const pid = await documentWith(request, 'Wave 2 used by', depth);
  await open(page, pid, 'calculations?calc=fee');
  const used = page.getByTestId('calc-used');
  await expect(used.getByRole('link', { name: /R90/ })).toBeVisible();
  const notes = used.getByRole('button', { name: 'Fee note', exact: true });
  await expect(notes).toHaveCount(2);
  await notes.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/studio/${pid}/design$`));
  await expect.poll(async () => (await ctx(page)).selectedNodeId).toBe('fee-note-b');
  await open(page, pid, 'calculations?calc=fee');
  await page.getByTestId('calc-used').getByRole('button', { name: 'Fee note', exact: true }).first().click();
  await expect.poll(async () => (await ctx(page)).selectedNodeId).toBe('fee-note-a');
});

test('W05 the AFP view of a document with a page design lists each page template’s area and columns', async ({ page, request }) => {
  const pid = await documentWith(request, 'Wave 2 AFP', () => [{ type: 'SET_PAGE_DESIGN', patch: { pageTemplates: { following: { columns: 2, columnGapPt: 18 } } } }]);
  await open(page, pid, 'outputs');
  await page.getByTestId('tab-afp').click();
  await page.getByTestId('view-afp-simulation').click();
  await expect(page.getByTestId('afp-region-first')).toContainText('First page');
  await expect(page.getByTestId('afp-region-first')).toContainText('1 column');
  await expect(page.getByTestId('afp-region-following')).toContainText('2 columns, 18 pt apart');
  await expect(page.getByTestId('afp-region-following')).toContainText(/area from [\d.]+, [\d.]+ pt · [\d.]+ × [\d.]+ pt/);
  await expect(page.getByTestId('afp-page-template-1')).toHaveText('First page');
  // a document without a page design keeps the original wording
  await open(page, 'aster-card-demo', 'outputs');
  await page.getByTestId('tab-afp').click();
  await page.getByTestId('view-afp-simulation').click();
  await expect(page.locator('.ox-afp')).toContainText('Continuation regions');
  await expect(page.locator('[data-testid^="afp-region-"]')).toHaveCount(0);
});

test('W06 a lookup table goes into the library, is approved, is used read-only in a second document, and is unlinked', async ({ page, request }) => {
  const title = `Fee by tier ${Date.now().toString(36)}`;
  const table = (): Command[] => [{ type: 'UPSERT_LOOKUP_TABLE', table: { id: 'feeByTier', title: 'Fee by tier', keys: [{ key: 'tier', label: 'Account tier', match: 'text' }], columns: [{ key: 'fee', label: 'Fee', type: 'money' }], rows: [{ keys: { tier: 'standard' }, values: { fee: 1500 } }, { keys: { tier: 'premium' }, values: { fee: 0 } }] } }];
  const docA = await documentWith(request, 'Library table source', table);
  const docB = await documentWith(request, 'Library table user', () => []);

  // The source document: Add to library, approve and link in place.
  await open(page, docA, 'lookup-tables?table=feeByTier');
  await page.getByTestId('lib-add-open').click();
  await page.getByTestId('lib-add-title').fill(title);
  await page.getByTestId('lib-add-save').click();
  await expect(page.getByTestId('lib-add-done')).toContainText('version 1 is a draft');
  await page.getByTestId('lib-add-approve-link').click();
  await expect(page.getByTestId('lib-linked-notice').getByTestId('lib-chip')).toContainText(`Library · ${title} · v1`);
  await expect(page.getByTestId('lk-grid')).toHaveAttribute('aria-readonly', 'true');
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');

  // The second document: From the library adds it linked; the grid is visibly read-only and typing does nothing.
  await open(page, docB, 'lookup-tables');
  await page.getByTestId('lk-from-library').click();
  await page.getByTestId('lib-pick-dialog').getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByTestId('lk-title')).toHaveValue('Fee by tier');
  await expect(page.getByTestId('lk-title')).toBeDisabled();
  await expect(page.getByTestId('lib-readonly-note')).toContainText('read-only in this document');
  await expect(page.getByTestId('lk-grid')).toHaveAttribute('aria-readonly', 'true');
  await expect(page.getByTestId('lk-save-state')).toHaveText('This table comes from the shared library and is read-only here.');
  await expect(page.getByTestId('lk-add-row')).toBeDisabled();
  await expect(page.getByTestId('lk-remove')).toBeDisabled();
  await page.getByTestId('lk-cell-0-1').click();
  await page.keyboard.type('99');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('lk-cell-0-1')).toHaveText('$15.00');
  await expect(page.getByTestId('lk-input')).toHaveCount(0);
  await expect(page.getByTestId('toast-error')).toHaveCount(0);

  // Unlink: the table becomes this document's own and can be edited.
  await page.getByTestId('lib-unlink').click();
  await page.getByTestId('lib-unlink-confirm').click();
  await expect(page.getByTestId('lib-linked-notice')).toHaveCount(0);
  await expect(page.getByTestId('lib-add-open')).toBeVisible();
  await expect(page.getByTestId('lk-grid')).not.toHaveAttribute('aria-readonly', 'true');
  await expect(page.getByTestId('lk-title')).toBeEnabled();
  const links = await page.evaluate(() => (window as any).__iss.store.getState().project.libraryLinks ?? []);
  expect(links).toEqual([]);
});
