/**
 * Browser tests for the Lookup tables screen (S23): a table of each kind of key, the problems shown as you edit
 * (duplicate key, overlap, gap), paste from a spreadsheet with a problem row, "Try it", a calculation that reads a table,
 * a table in use that cannot be removed, keyboard editing of the grid, and 2,000 rows staying responsive.
 * Run on an isolated stack (scripts/dev-isolated.mjs) so the shared database is not reset under other people.
 */
import { test, expect, type Page } from '@playwright/test';
import { buildContext, evaluateCalculations, lookupRowFor, type CalculatedField, type LookupTable, type Project, type SyntheticRecord } from '../packages/model/src';
import { open, resetAll } from './helpers';

test.beforeEach(async ({ request }) => { await resetAll(request); });
test.afterEach(async ({ request }) => { await resetAll(request); });

const store = (page: Page) => page.evaluate(() => {
  const s = (window as any).__iss.store.getState();
  return { project: s.project as Project, records: s.records as SyntheticRecord[], recordId: s.ctx.recordId as string };
});
const dispatch = (page: Page, cmd: unknown) => page.evaluate((c) => (window as any).__iss.store.getState().dispatch(c), cmd);
const tables = async (page: Page) => (await store(page)).project.lookupTables ?? [];
const goTo = (page: Page, url: string) => page.evaluate((u) => { window.history.pushState({}, '', u); window.dispatchEvent(new PopStateEvent('popstate')); }, url);
const cell = (page: Page, r: number, c: number) => page.getByTestId(`lk-cell-${r}-${c}`);
const activeCell = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-cell') ?? null);

async function addTable(page: Page, title: string, match: 'text' | 'number-range' | 'date-range', type: 'money' | 'number' | 'text', from?: string) {
  await page.getByTestId(await page.getByTestId('lk-empty-add').count() ? 'lk-empty-add' : 'lk-add').click();
  await page.getByTestId('lk-add-name').fill(title);
  await page.getByTestId('lk-add-match').selectOption(match);
  if (from) await page.getByTestId('lk-add-from').selectOption(from);
  await page.getByTestId('lk-add-type').selectOption(type);
  await page.getByTestId('lk-add-confirm').click();
  await expect(page.getByTestId('lk-title')).toHaveValue(title);
}

test('LT01 a table of each kind of key can be built: exact text by typing, a range of numbers by typing, a range of dates by pasting', async ({ page }) => {
  await open(page, 'aster-card-demo', 'lookup-tables');
  await expect(page.getByTestId('lk-empty')).toBeVisible();

  // Exact text: the rows start from the values of a data field of the document.
  await addTable(page, 'Late fee by tier', 'text', 'money', 'card.tier');
  await expect(page.getByTestId('lk-rowcount')).toContainText('2 rows');
  await expect(cell(page, 0, 0)).toHaveText('standard');
  await cell(page, 0, 1).click();
  await page.keyboard.type('15');
  await page.keyboard.press('Enter');
  await page.keyboard.type('10.50');
  await page.keyboard.press('Enter');
  await expect(cell(page, 0, 1)).toHaveText('$15.00');
  await expect(cell(page, 1, 1)).toHaveText('$10.50');
  await page.getByTestId('lk-save').click();
  await expect(page.getByTestId('lk-save-state')).toHaveText('Saved.');
  let t = (await tables(page))[0];
  expect(t.keys[0].match).toBe('text');
  expect(t.rows.map((r) => r.values[t.columns[0].key])).toEqual([1500, 1050]);

  // A range of numbers (amounts): columns first, then rows typed in the grid.
  await addTable(page, 'Interest band', 'number-range', 'number');
  await expect(page.getByTestId('lk-columns-details')).toHaveAttribute('open', '');
  await page.getByTestId('lk-key-unit-0').selectOption('money');
  await page.getByTestId('lk-key-label-0').fill('Balance');
  await page.getByTestId('lk-col-label-0').fill('Rate');
  await page.getByTestId('lk-columns-details').locator('summary').click();
  for (const [from, until, rate] of [['0', '1000', '1.5'], ['1000', '5000', '2'], ['5000', '', '2.5']]) {
    await page.getByTestId('lk-add-row').click();
    await page.keyboard.type(from); await page.keyboard.press('Tab');
    // Tab saves the cell and moves right; on a cell that is not being edited the arrow keys move.
    if (until) { await page.keyboard.type(until); await page.keyboard.press('Tab'); } else await page.keyboard.press('ArrowRight');
    await page.keyboard.type(rate); await page.keyboard.press('Enter');
  }
  await expect(page.getByTestId('lk-no-problems')).toBeVisible();
  await page.getByTestId('lk-save').click();
  await expect(page.getByTestId('lk-save-state')).toHaveText('Saved.');
  t = (await tables(page)).find((x) => x.title === 'Interest band')!;
  expect(t.keys[0]).toMatchObject({ match: 'number-range', unit: 'money', label: 'Balance' });
  expect(t.rows.map((r) => r.keys[t.keys[0].key])).toEqual([{ from: 0, until: 100000 }, { from: 100000, until: 500000 }, { from: 500000 }]);
  expect(t.rows.map((r) => r.values[t.columns[0].key])).toEqual([1.5, 2, 2.5]);

  // A range of dates, pasted from a spreadsheet.
  await addTable(page, 'Bonus rate by date', 'date-range', 'number');
  await page.getByTestId('lk-paste').click();
  await page.getByTestId('lk-paste-text').fill('2026-01-01\t2027-01-01\t1.5\n2027-01-01\t\t2');
  await expect(page.getByTestId('lk-paste-summary')).toContainText('2 rows will be added');
  await page.getByTestId('lk-paste-apply').click();
  await expect(page.getByTestId('lk-rowcount')).toContainText('2 rows');
  await page.getByTestId('lk-save').click();
  await expect(page.getByTestId('lk-save-state')).toHaveText('Saved.');
  t = (await tables(page)).find((x) => x.title === 'Bonus rate by date')!;
  expect(t.keys[0].match).toBe('date-range');
  expect(t.rows.map((r) => r.keys[t.keys[0].key])).toEqual([{ from: '2026-01-01', until: '2027-01-01' }, { from: '2027-01-01' }]);
  expect((await tables(page)).length).toBe(3);
  await expect(page.getByTestId('lk-list')).toContainText('Late fee by tier');
});

test('LT02 duplicate keys, overlaps and gaps are shown as you edit, on the row and in the summary; what the engine refuses is said in its words', async ({ page }) => {
  await open(page, 'aster-card-demo', 'lookup-tables');
  const table: LookupTable = {
    id: 'bands', title: 'Bands',
    keys: [{ key: 'balance', label: 'Balance', match: 'number-range' }],
    columns: [{ key: 'rate', label: 'Rate', type: 'number' }],
    rows: [{ keys: { balance: { from: 0, until: 100 } }, values: { rate: 1 } }, { keys: { balance: { from: 100, until: 200 } }, values: { rate: 2 } }],
  };
  expect((await dispatch(page, { type: 'UPSERT_LOOKUP_TABLE', table })).ok).toBeTruthy();
  await expect(page.getByTestId('lk-no-problems')).toBeVisible();

  // An overlap: a third row that starts inside the second.
  await page.getByTestId('lk-add-row').click();
  await page.keyboard.type('150'); await page.keyboard.press('Tab'); await page.keyboard.type('250'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('lk-problem-summary')).toContainText('1 problem');
  await expect(page.getByTestId('lk-problems').locator('li[data-kind="overlap"]')).toContainText('overlap');
  await expect(page.getByTestId('lk-row-2')).toHaveClass(/error/);
  await expect(page.getByTestId('lk-row-2').locator('.lk-sr')).toContainText('Problem');
  // The engine will not store it, and says so in its own words.
  await page.getByTestId('lk-save').click();
  await expect(page.getByTestId('lk-save-error')).toContainText('overlap');
  expect((await tables(page))[0].rows.length).toBe(2);

  // Fix the overlap so that the third row starts where the second ends, then leave a gap before a fourth.
  await cell(page, 2, 0).click();
  await page.keyboard.type('200'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('lk-problems').locator('li[data-kind="overlap"]')).toHaveCount(0);
  await page.getByTestId('lk-add-row').click();
  await page.keyboard.type('300'); await page.keyboard.press('Tab'); await page.keyboard.type('400'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('lk-problems').locator('li[data-kind="gap"]')).toContainText('gap');
  await expect(page.getByTestId('lk-problem-summary')).toContainText('1 gap');
  await expect(page.getByTestId('lk-row-3')).toHaveClass(/warning/);
  // A gap is a warning, not an error: it can be saved.
  await page.getByTestId('lk-save').click();
  await expect(page.getByTestId('lk-save-state')).toHaveText('Saved.');
  await expect(page.getByTestId('lk-list')).toContainText('1 gap');

  // A duplicate key in a table of exact text.
  const text: LookupTable = { id: 'fees', title: 'Fees', keys: [{ key: 'tier', label: 'Tier', match: 'text' }], columns: [{ key: 'fee', label: 'Fee', type: 'money' }], rows: [{ keys: { tier: 'basic' }, values: { fee: 100 } }] };
  await dispatch(page, { type: 'UPSERT_LOOKUP_TABLE', table: text });
  await page.getByTestId('lk-row-item-fees').click();
  await page.getByTestId('lk-add-row').click();
  await page.keyboard.type('basic'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('lk-problems').locator('li[data-kind="duplicate"]')).toContainText('same key');
  await page.getByTestId('lk-save').click();
  await expect(page.getByTestId('lk-save-error')).toContainText('same key');
  // The problem list says which row to go to, and goes there.
  await page.getByTestId('lk-problems').getByRole('button', { name: /Go to row/ }).click();
  await expect.poll(() => activeCell(page)).toBe('1:0');
  // Choosing another table with unsaved changes asks first.
  await page.getByTestId('lk-row-item-bands').click();
  await expect(page.getByTestId('lk-leave-stay')).toBeVisible();
  await page.getByTestId('lk-leave-stay').click();
  await expect(page.getByTestId('lk-title')).toHaveValue('Fees');
  await page.getByTestId('lk-row-item-bands').click();
  await page.getByTestId('lk-leave-discard').click();
  await expect(page.getByTestId('lk-title')).toHaveValue('Bands');
  await page.getByTestId('lk-row-item-fees').click();
  await expect(page.getByTestId('lk-title')).toHaveValue('Fees');
  await expect(page.getByTestId('lk-rowcount')).toContainText('1 row');
});

test('LT03 paste from a spreadsheet shows what will be added and each problem by row and column before anything is applied', async ({ page }) => {
  await open(page, 'aster-card-demo', 'lookup-tables');
  await addTable(page, 'Notice by date', 'date-range', 'number');
  await page.getByTestId('lk-paste').click();
  const text = ['In effect from\tIn effect until\tValue', '2026-01-01\t2027-01-01\t30', '2027-01-01\t2028-01-01\t45', '2028-13-45\t\t60', '2029-01-01\t\tsoon'].join('\n');
  await page.getByTestId('lk-paste-text').fill(text);
  await expect(page.getByTestId('lk-paste-summary')).toContainText('2 rows will be added');
  await expect(page.getByTestId('lk-paste-summary')).toContainText('the heading row is skipped');
  await expect(page.getByTestId('lk-paste-summary')).toContainText('2 problems found');
  const problems = page.getByTestId('lk-paste-problems').locator('li');
  await expect(problems).toHaveCount(2);
  await expect(problems.nth(0)).toHaveAttribute('data-row', '4');
  await expect(problems.nth(0)).toHaveAttribute('data-column', '1');
  await expect(problems.nth(0)).toContainText('not a date');
  await expect(problems.nth(1)).toHaveAttribute('data-row', '5');
  await expect(problems.nth(1)).toHaveAttribute('data-column', '3');
  await expect(page.getByTestId('lk-paste-preview')).toContainText('2026-01-01');
  // Nothing is applied while there are problems, unless the rows with problems are skipped.
  await expect(page.getByTestId('lk-paste-apply')).toBeDisabled();
  expect((await tables(page)).length).toBe(1);
  await page.getByTestId('lk-paste-skip').check();
  await expect(page.getByTestId('lk-paste-apply')).toBeEnabled();
  await page.getByTestId('lk-paste-apply').click();
  await expect(page.getByTestId('lk-rowcount')).toContainText('2 rows');
  await expect(cell(page, 0, 0)).toHaveText('2026-01-01');
  await expect(cell(page, 1, 2)).toHaveText('45');
  // Pasting with the grid focused opens the same preview.
  await cell(page, 0, 0).click();
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="lk-grid"]') as HTMLElement;
    const dt = new DataTransfer(); dt.setData('text/plain', '2028-01-01\t\t50');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId('lk-paste-summary')).toContainText('1 row will be added');
  await page.getByTestId('lk-paste-apply').click();
  await expect(page.getByTestId('lk-rowcount')).toContainText('3 rows');
});

test('LT04 Try it: which row matches and what each value column gives, with a default row and with the current customer', async ({ page }) => {
  await open(page, 'aster-card-demo', 'lookup-tables');
  const fees: LookupTable = {
    id: 'feeByTier', title: 'Late fee by tier',
    keys: [{ key: 'tier', label: 'Account tier', match: 'text' }],
    columns: [{ key: 'lateFee', label: 'Late fee', type: 'money' }, { key: 'note', label: 'Note', type: 'text' }],
    rows: [{ keys: { tier: 'standard' }, values: { lateFee: 1500, note: 'Standard' } }, { keys: { tier: 'premium' }, values: { lateFee: 1000, note: 'Premium' } }],
  };
  await dispatch(page, { type: 'UPSERT_LOOKUP_TABLE', table: fees });
  const feeCalc: CalculatedField = { key: 'lateFee', label: 'Late fee', type: 'money', expr: { op: 'lookup', table: 'feeByTier', column: 'lateFee', keys: [{ op: 'field', path: 'card.tier' }] } };
  expect((await dispatch(page, { type: 'UPSERT_CALCULATED_FIELD', field: feeCalc })).ok).toBeTruthy();

  await page.getByTestId('lk-try-0').fill('premium');
  await expect(page.getByTestId('lk-try-which')).toContainText('row 2');
  await expect(page.getByTestId('lk-try-value-lateFee')).toHaveAttribute('data-raw', '1000');
  await expect(page.getByTestId('lk-try-value-lateFee')).toHaveText('$10.00');
  await expect(page.getByTestId('lk-try-value-note')).toHaveText('Premium');
  await page.getByTestId('lk-try-0').fill('gold');
  await expect(page.getByTestId('lk-try-none')).toContainText('No row matches');

  // A default row answers when nothing matches.
  await page.getByTestId('lk-columns-details').locator('summary').click();
  await page.getByTestId('lk-nomatch-default').check();
  await page.getByLabel('Default Late fee').fill('20');
  await expect(page.getByTestId('lk-try-which')).toContainText('default row');
  await expect(page.getByTestId('lk-try-value-lateFee')).toHaveAttribute('data-raw', '2000');

  // The current customer's own values, taken through the calculation that reads the table.
  const { project, records, recordId } = await store(page);
  const record = records.find((r) => r.recordId === recordId)!;
  const tier = (record as any).card.tier as string;
  await page.getByTestId('lk-try-use').click();
  await expect(page.getByTestId('lk-try-0')).toHaveValue(tier);
  const row = lookupRowFor(fees, [tier]);
  expect(row).not.toBeNull();
  await expect(page.getByTestId('lk-try-which')).toContainText(`row ${fees.rows.indexOf(row!) + 1}`);
  await expect(page.getByTestId('lk-try-value-lateFee')).toHaveAttribute('data-raw', String(row!.values.lateFee));
  expect(project.lookupTables![0].id).toBe('feeByTier');
});

test('LT05 a calculation that reads the table gets the right value; the table lists it; a table in use cannot be removed', async ({ page }) => {
  await open(page, 'aster-card-demo', 'lookup-tables');
  const fees: LookupTable = {
    id: 'feeByTier', title: 'Late fee by tier',
    keys: [{ key: 'tier', label: 'Account tier', match: 'text' }],
    columns: [{ key: 'lateFee', label: 'Late fee', type: 'money' }],
    rows: [{ keys: { tier: 'standard' }, values: { lateFee: 1500 } }, { keys: { tier: 'premium' }, values: { lateFee: 1000 } }],
  };
  await dispatch(page, { type: 'UPSERT_LOOKUP_TABLE', table: fees });
  await expect(page.getByTestId('lk-used')).toContainText('No calculation reads this table');
  const calc: CalculatedField = { key: 'lateFee', label: 'Late fee', type: 'money', expr: { op: 'lookup', table: 'feeByTier', column: 'lateFee', keys: [{ op: 'field', path: 'card.tier' }] } };
  await dispatch(page, { type: 'UPSERT_CALCULATED_FIELD', field: calc });
  const link = page.getByTestId('lk-used').getByRole('link', { name: 'Late fee' });
  await expect(link).toHaveAttribute('href', /calculations\?calc=lateFee/);
  await expect(page.getByTestId('lk-row-item-feeByTier')).toContainText('Read by 1');

  // Removing it is refused, in the engine's words.
  await page.getByTestId('lk-remove').click();
  await expect(page.getByTestId('lk-refusal')).toBeVisible();
  await expect(page.getByTestId('lk-refusal-message')).toContainText('is still read by “Late fee”');
  expect((await tables(page)).length).toBe(1);

  // The calculation has the value the engine gives for every customer, and the link goes to it.
  await link.click();
  await expect(page.getByTestId('calc-editor')).toHaveAttribute('data-key', 'lateFee');
  const { project, records } = await store(page);
  const per = records.map((r) => evaluateCalculations(project, buildContext(r) as Record<string, unknown>, null).values.lateFee);
  const have = per.filter((v) => v !== null) as number[];
  expect(have.length).toBeGreaterThan(0);
  await expect(page.getByTestId('calc-across-min')).toHaveAttribute('data-raw', String(Math.min(...have)));
  await expect(page.getByTestId('calc-across-max')).toHaveAttribute('data-raw', String(Math.max(...have)));
  const { record } = await (async () => { const s = await store(page); return { record: s.records.find((r) => r.recordId === s.recordId)! }; })();
  const mine = evaluateCalculations(project, buildContext(record) as Record<string, unknown>, null).values.lateFee;
  await expect(page.getByTestId('calc-current')).toHaveAttribute('data-raw', String(mine));
  // The builder shows a lookup step with its table and key.
  await expect(page.getByTestId('step-kind-root')).toHaveValue('lookup');
  await expect(page.getByLabel('Result: table', { exact: true })).toHaveValue('feeByTier');

  // Once nothing reads the table, it can be removed (and undone).
  await dispatch(page, { type: 'DELETE_CALCULATED_FIELD', key: 'lateFee' });
  await goTo(page, '/studio/aster-card-demo/lookup-tables');
  await page.getByTestId('lk-remove').click();
  await expect(page.getByTestId('lk-empty')).toBeVisible();
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('lk-editor')).toBeVisible();
});

test('LT06 the grid is fully keyboard-operable', async ({ page }) => {
  await open(page, 'aster-card-demo', 'lookup-tables');
  const table: LookupTable = {
    id: 'fees', title: 'Fees',
    keys: [{ key: 'tier', label: 'Tier', match: 'text' }],
    columns: [{ key: 'fee', label: 'Fee', type: 'money' }, { key: 'note', label: 'Note', type: 'text' }],
    rows: [{ keys: { tier: 'a' }, values: { fee: 100, note: 'one' } }, { keys: { tier: 'b' }, values: { fee: 200, note: 'two' } }, { keys: { tier: 'c' }, values: { fee: 300, note: 'three' } }],
  };
  await dispatch(page, { type: 'UPSERT_LOOKUP_TABLE', table });
  await page.getByTestId('lk-row-item-fees').click();
  // Tab reaches the grid (one stop), arrows move.
  await cell(page, 0, 0).focus();
  await expect.poll(() => activeCell(page)).toBe('0:0');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight');
  await expect.poll(() => activeCell(page)).toBe('1:1');
  await page.keyboard.press('End');
  await expect.poll(() => activeCell(page)).toBe('1:2');
  await page.keyboard.press('Control+Home');
  await expect.poll(() => activeCell(page)).toBe('0:0');
  // Enter edits; Escape cancels; Enter saves the cell and moves down.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('lk-input')).toBeFocused();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('zzz');
  await page.keyboard.press('Escape');
  await expect(cell(page, 0, 0)).toHaveText('a');
  await expect.poll(() => activeCell(page)).toBe('0:0');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  await expect(cell(page, 0, 0)).toHaveText('alpha');
  await expect.poll(() => activeCell(page)).toBe('1:0');
  // Tab saves and moves right; a wrong value is refused where it is typed.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('abc');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('lk-input')).toBeFocused();
  await expect(page.getByRole('alert').filter({ hasText: 'amount in dollars' })).toBeVisible();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('2.5');
  await page.keyboard.press('Tab');
  await expect(cell(page, 1, 1)).toHaveText('$2.50');
  await expect.poll(() => activeCell(page)).toBe('1:2');
  // Delete empties a cell; Ctrl+Enter adds a row below; Ctrl+Delete removes the row.
  await page.keyboard.press('Delete');
  await expect(cell(page, 1, 2)).toHaveText('');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('lk-rowcount')).toContainText('4 rows');
  await expect.poll(() => activeCell(page)).toBe('2:0');
  await page.keyboard.press('Control+Delete');
  await expect(page.getByTestId('lk-rowcount')).toContainText('3 rows');
  // The row is added and removed in the draft: saving is one undoable step.
  await page.getByTestId('lk-save').click();
  await expect(page.getByTestId('lk-save-state')).toHaveText('Saved.');
  const t = (await tables(page))[0];
  expect(t.rows.map((r) => r.keys.tier)).toEqual(['alpha', 'b', 'c']);
  expect(t.rows[1].values).toEqual({ fee: 250, note: null });
  await page.getByTestId('undo').click();
  expect((await tables(page))[0].rows.map((r) => r.keys.tier)).toEqual(['a', 'b', 'c']);
});

test('LT07 a table of 2,000 rows renders only the rows in view and stays responsive', async ({ page }, info) => {
  await open(page, 'aster-card-demo', 'lookup-tables');
  const rows = Array.from({ length: 2000 }, (_, i) => ({ keys: { code: `K${String(i + 1).padStart(4, '0')}` }, values: { fee: (i + 1) * 100, note: `Row ${i + 1}` } }));
  const big: LookupTable = { id: 'big', title: 'Big table', keys: [{ key: 'code', label: 'Code', match: 'text' }], columns: [{ key: 'fee', label: 'Fee', type: 'money' }, { key: 'note', label: 'Note', type: 'text' }], rows };
  const small: LookupTable = { id: 'small', title: 'Small table', keys: [{ key: 'code', label: 'Code', match: 'text' }], columns: [{ key: 'fee', label: 'Fee', type: 'money' }], rows: [{ keys: { code: 'a' }, values: { fee: 1 } }] };
  expect((await dispatch(page, { type: 'UPSERT_LOOKUP_TABLE', table: small })).ok).toBeTruthy();
  const r = await dispatch(page, { type: 'UPSERT_LOOKUP_TABLE', table: big });
  expect(r.ok, JSON.stringify(r)).toBeTruthy();

  // Time to open: from choosing the table to the grid showing its first row.
  const t0 = Date.now();
  await page.getByTestId('lk-row-item-big').click();
  await expect(cell(page, 0, 0)).toHaveText('K0001');
  await expect(page.getByTestId('lk-rowcount')).toContainText('2,000 rows');
  const openMs = Date.now() - t0;
  const rendered = await page.locator('[data-testid^="lk-row-"]').count();
  expect(rendered).toBeLessThan(60);
  expect(openMs).toBeLessThan(4000);

  // Time to edit a cell: from the first key press to the new value shown.
  await cell(page, 0, 2).click();
  const t1 = Date.now();
  await page.keyboard.type('Edited');
  await page.keyboard.press('Enter');
  await expect(cell(page, 0, 2)).toHaveText('Edited');
  const editMs = Date.now() - t1;
  expect(editMs).toBeLessThan(2000);
  // In the page itself (no test-runner round trips): the cost of the state change and render of one edit.
  const inPage = await page.evaluate(async () => {
    const cellEl = document.querySelector('[data-testid="lk-cell-1-2"]') as HTMLElement;
    cellEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); cellEl.focus();
    const grid = document.querySelector('[data-testid="lk-grid"]') as HTMLElement;
    const key = (k: string) => grid.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const t = performance.now();
    key('Enter');
    await new Promise((r2) => requestAnimationFrame(() => r2(null)));
    const input = document.querySelector('[data-testid="lk-input"]') as HTMLInputElement | null;
    if (!input) return -1;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, 'Edited in page'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise((r2) => requestAnimationFrame(() => r2(null)));
    await new Promise((r2) => requestAnimationFrame(() => r2(null)));
    return performance.now() - t;
  });
  expect(inPage).toBeGreaterThan(0);
  expect(inPage).toBeLessThan(500);
  info.annotations.push({ type: 'timing', description: `open ${openMs} ms, edit (incl. test runner) ${editMs} ms, edit in page ${Math.round(inPage)} ms, ${rendered} rows rendered of 2000` });
  console.log(`LT07 timing: open ${openMs} ms, edit (incl. test runner) ${editMs} ms, edit in page ${Math.round(inPage)} ms, ${rendered} rows rendered of 2000`);

  // The whole table is reachable: the last row, by keyboard, and rows far from the top render when scrolled to.
  await page.keyboard.press('Control+End');
  await expect(cell(page, 1999, 0)).toHaveText('K2000');
  expect(await page.locator('[data-testid^="lk-row-"]').count()).toBeLessThan(60);
  // Problems are found across the whole table: a duplicate at the far end is reported.
  await page.getByTestId('lk-add-row').click();
  await page.keyboard.type('K0001'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('lk-problems').locator('li[data-kind="duplicate"]')).toContainText('Rows 1 and 2001');
  // Saving 2,000 rows is one undoable step.
  await page.getByTestId('lk-remove-row').click();
  await page.getByTestId('lk-save').click();
  await expect(page.getByTestId('lk-save-state')).toHaveText('Saved.');
  const t = (await tables(page)).find((x) => x.id === 'big')!;
  expect(t.rows.length).toBe(2000);
  expect(t.rows[0].values.note).toBe('Edited');
});
