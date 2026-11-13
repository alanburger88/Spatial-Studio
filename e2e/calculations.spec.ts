/**
 * Browser tests for the Calculations screen (S22): the builder, formula and plain-words views of one expression, the
 * value for the current customer and for every synthetic customer (checked against the engine, computed here
 * independently), what uses a calculation, undo, the worked examples on all three kinds of document, and the deep link.
 * Run on an isolated stack (scripts/dev-isolated.mjs) so the shared database is not reset under other people.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  buildContext, calculationUsage, evaluateCalculations, evaluateSteps, formulaInWords, printFormula, projectFieldIndex, validateCalculatedFields, wordsScopeOf,
  type CalculatedField, type Project, type SyntheticRecord,
} from '../packages/model/src';
import { gymProject } from '../packages/model/test/helpers/customProject';
import { API, open, resetAll } from './helpers';

const created: string[] = [];
test.beforeEach(async ({ request }) => { created.length = 0; await resetAll(request); });
test.afterEach(async ({ request }) => {
  for (const id of created) await request.delete(`${API}/projects/${id}`);
  await resetAll(request);
});

const store = (page: Page) => page.evaluate(() => {
  const s = (window as any).__iss.store.getState();
  return { project: s.project as Project, records: s.records as SyntheticRecord[], recordId: s.ctx.recordId as string };
});
const dispatch = (page: Page, cmd: unknown) => page.evaluate((c) => (window as any).__iss.store.getState().dispatch(c), cmd);

/** The engine's answer for the current customer, worked out here from the project and the customer as the store holds them. */
async function engine(page: Page) {
  const { project, records, recordId } = await store(page);
  const record = records.find((r) => r.recordId === recordId)!;
  const ctx = buildContext(record) as Record<string, unknown>;
  const out = evaluateCalculations(project, ctx, null);
  return { project, records, record, ctx, out };
}

const DAYS: CalculatedField = { key: 'daysToDue', label: 'Days to due date', type: 'number', expr: { op: 'days', from: { op: 'field', path: 'card.statementEnd' }, to: { op: 'field', path: 'card.dueDate' } } };
const HALF_MIN: CalculatedField = { key: 'halfMinimum', label: 'Half of the minimum payment', type: 'money', expr: { op: 'round', places: 2, arg: { op: 'mul', a: { op: 'field', path: 'card.minimumDueCents' }, b: { op: 'number', value: 0.5 } } } };
const PER_MISS: CalculatedField = { key: 'minPerMiss', label: 'Minimum per missed payment', type: 'money', expr: { op: 'round', places: 2, arg: { op: 'div', a: { op: 'field', path: 'card.minimumDueCents' }, b: { op: 'field', path: 'card.missedPayments' } } } };

test('CA01 an example creates a real calculation; the builder, formula and plain words follow each other', async ({ page }) => {
  await open(page, 'aster-card-demo', 'calculations');
  await expect(page.getByTestId('calc-empty')).toBeVisible();
  await page.getByTestId('calc-add').click();
  await page.getByTestId('calc-add-name').fill('Days to due date');
  await page.getByTestId('calc-add-confirm').click();
  await expect(page.getByTestId('calc-editor')).toBeVisible();
  const key = (await page.getByTestId('calc-editor').getAttribute('data-key'))!;
  expect(key).toBe('daysToDueDate');

  // Builder: choose "Days between two dates"; the formula and the words follow at once.
  await page.getByTestId('step-kind-root').selectOption('days');
  await expect(page.getByTestId('calc-formula')).toHaveValue(/^=DAYS\(card\.\w+, DATE\("2026-01-01"\)\)$/);
  await expect(page.getByTestId('calc-words')).toContainText('The number of days from');
  await page.getByLabel('From date: data field', { exact: true }).selectOption('card.statementEnd');
  await page.getByTestId('step-kind-to').selectOption('field');
  await page.getByLabel('To date: data field', { exact: true }).selectOption('card.dueDate');
  await expect(page.getByTestId('calc-formula')).toHaveValue('=DAYS(card.statementEnd, card.dueDate)');
  await expect(page.getByTestId('calc-words')).toHaveText('The number of days from “Statement period end” to “Payment due date”.');

  // Formula: type another and the builder follows.
  await page.getByTestId('calc-formula').fill('=DAYS(card.dueDate, card.statementEnd)');
  await expect(page.getByLabel('From date: data field', { exact: true })).toHaveValue('card.dueDate');
  await expect(page.getByLabel('To date: data field', { exact: true })).toHaveValue('card.statementEnd');
  await expect(page.getByTestId('calc-words')).toHaveText('The number of days from “Payment due date” to “Statement period end”.');
  await expect(page.getByTestId('calc-formula-error')).toHaveCount(0);

  // Save: one command; the saved expression prints back to the same formula and reads the same in words.
  await page.getByTestId('calc-save').click();
  await expect(page.getByTestId('calc-save-state')).toHaveText('Saved.');
  const { project } = await store(page);
  const saved = project.calculatedFields!.find((c) => c.key === key)!;
  expect(printFormula(saved.expr, projectFieldIndex(project))).toBe('=DAYS(card.dueDate, card.statementEnd)');
  expect(formulaInWords(saved.expr, wordsScopeOf(project, projectFieldIndex(project)))).toBe(await page.getByTestId('calc-words').innerText());
  expect(saved.type).toBe('number');
});

test('CA02 a mistake in the formula is pointed at, in words, and never saved; the builder keeps the last good version', async ({ page }) => {
  await open(page, 'aster-card-demo', 'calculations');
  await dispatch(page, { type: 'UPSERT_CALCULATED_FIELD', field: DAYS });
  await expect(page.getByTestId('calc-editor')).toBeVisible();
  const before = await page.getByTestId('calc-formula').inputValue();
  expect(before).toBe('=DAYS(card.statementEnd, card.dueDate)');

  // A field the document does not have: the mistake is the field, and it says so.
  await page.getByTestId('calc-formula').fill('=DAYS(card.nothing, card.dueDate)');
  await expect(page.getByTestId('calc-formula-error')).toBeVisible();
  await expect(page.getByTestId('calc-formula-error')).toContainText('is not a data field of this document');
  await expect(page.locator('.cf-where mark')).toHaveText('card.nothing');
  await expect(page.getByTestId('calc-lastgood')).toBeVisible();
  await expect(page.getByTestId('calc-save')).toBeDisabled();
  // The builder and the words still show the last good expression.
  await expect(page.getByLabel('From date: data field', { exact: true })).toHaveValue('card.statementEnd');
  await expect(page.getByTestId('calc-words')).toContainText('“Statement period end”');

  // A formula that does not read at all.
  await page.getByTestId('calc-formula').fill('=DAYS(card.dueDate,');
  await expect(page.getByTestId('calc-formula-error')).toBeVisible();
  await expect(page.getByTestId('calc-save')).toBeDisabled();
  expect((await store(page)).project.calculatedFields![0].expr).toEqual(DAYS.expr);

  // A kind of value the step cannot take: an amount cannot be added to a plain number.
  await page.getByTestId('calc-formula').fill('=card.minimumDueCents + card.missedPayments');
  await expect(page.getByTestId('calc-formula-error')).toContainText('cannot be added');
  await expect(page.getByTestId('calc-save')).toBeDisabled();

  // Auto-complete: functions and field paths from the engine's lists.
  await page.getByTestId('calc-formula').fill('=ROU');
  await expect(page.getByTestId('calc-formula-suggestions')).toContainText('ROUND(value, places)');
  await page.getByTestId('calc-formula').fill('=DAYS(card.due');
  await expect(page.getByTestId('calc-formula-suggestions').getByRole('option').first()).toContainText('card.dueDate');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('calc-formula')).toHaveValue('=DAYS(card.dueDate');

  // Revert goes back to the saved calculation.
  await page.getByTestId('calc-revert').click();
  await expect(page.getByTestId('calc-formula')).toHaveValue(before);
});

test('CA03 the value for the current customer and each step match the engine; the list shows the same value', async ({ page }) => {
  await open(page, 'aster-card-demo', 'calculations');
  for (const field of [DAYS, HALF_MIN, PER_MISS]) await dispatch(page, { type: 'UPSERT_CALCULATED_FIELD', field });

  for (const [calc, expected] of [[HALF_MIN, 'halfMinimum'], [DAYS, 'daysToDue']] as const) {
    await page.getByTestId(`calc-row-${expected}`).click();
    await expect(page.getByTestId('calc-editor')).toHaveAttribute('data-key', calc.key);
    const { project, ctx, out } = await engine(page);
    const mine = out.values[calc.key];
    expect(mine).not.toBeNull();
    await expect(page.getByTestId('calc-current')).toHaveAttribute('data-raw', String(mine));
    await expect(page.getByTestId(`calc-row-value-${calc.key}`)).toHaveAttribute('data-raw', String(mine));
    // Every step's value is the engine's step-by-step value.
    const steps = evaluateSteps(project, calc.expr, JSON.parse(JSON.stringify(ctx)), null, out.missing).steps;
    expect(steps.length).toBeGreaterThan(1);
    for (const s of steps) await expect(page.getByTestId(`step-value-${s.at || 'root'}`)).toHaveAttribute('data-raw', String(s.value));
  }
  // The amount is shown as the document would show it.
  await page.getByTestId('calc-row-halfMinimum').click();
  await expect(page.getByTestId('calc-current')).toHaveText(/^\$[\d,]+\.\d{2}$/);
  await expect(page.getByTestId('step-value-arg.a')).toContainText('$');
});

test('CA04 across all customers: smallest, largest, spread, and who has no value and why, equal the engine; each customer is a link', async ({ page }) => {
  await open(page, 'aster-card-demo', 'calculations');
  for (const field of [HALF_MIN, PER_MISS]) await dispatch(page, { type: 'UPSERT_CALCULATED_FIELD', field });
  const { project, records } = await store(page);
  const per = (key: string) => records.map((r) => { const c = buildContext(r) as Record<string, unknown>; const o = evaluateCalculations(project, c, null); return { id: r.recordId, v: o.values[key], m: o.missing[key] }; });

  // A calculation everyone has a value for.
  await page.getByTestId('calc-row-halfMinimum').click();
  const half = per('halfMinimum');
  const nums = half.filter((x) => x.v !== null).map((x) => x.v as number);
  await expect(page.getByTestId('calc-across-min')).toHaveAttribute('data-raw', String(Math.min(...nums)));
  await expect(page.getByTestId('calc-across-max')).toHaveAttribute('data-raw', String(Math.max(...nums)));
  await expect(page.getByTestId('calc-across-count')).toContainText(`${nums.length} of ${records.length} synthetic customers`);
  const bandTotal = (await page.getByTestId('calc-band-count').allInnerTexts()).reduce((n, t) => n + Number(t), 0);
  expect(bandTotal).toBe(nums.length);

  // One that some customers have no value for (no missed payments: nothing can be divided by zero).
  await page.getByTestId('calc-row-minPerMiss').click();
  const per2 = per('minPerMiss');
  const without = per2.filter((x) => x.v === null);
  expect(without.length).toBeGreaterThan(0);
  expect(without.length).toBeLessThan(records.length);
  await expect(page.getByTestId('calc-across-count')).toContainText(`${records.length - without.length} of ${records.length} synthetic customers`);
  const missing = page.getByTestId('calc-across-missing');
  await expect(missing).toContainText(`No value for ${without.length} synthetic customer`);
  await expect(missing).toContainText(without[0].m!.message);
  // A customer in the list becomes the current customer.
  const firstLink = missing.locator('.calc-people .linklike').first();
  await firstLink.click();
  expect(without.map((x) => x.id)).toContain((await store(page)).recordId);
  // The current customer has no value: the screen says why and what to do.
  await expect(page.getByTestId('calc-missing')).toBeVisible();
  await expect(page.getByTestId('calc-missing-reason')).toHaveText(without[0].m!.message);
  await expect(page.getByTestId('calc-missing')).toContainText('Change “Minimum per missed payment” so it never divides by zero');
});

test('CA05 a calculation a rule uses cannot be removed; the engine says why and where it is used; undo takes a save back', async ({ page }) => {
  await open(page, 'aster-card-demo', 'calculations');
  await dispatch(page, { type: 'UPSERT_CALCULATED_FIELD', field: DAYS });
  const rule = await page.evaluate(() => {
    const r = (window as any).__iss.store.getState().project.rules[0];
    return { ...r, id: 'R90', title: 'Due soon', priority: 77, when: { op: 'lt', path: 'calc.daysToDue', value: 5 } };
  });
  const added = await dispatch(page, { type: 'UPSERT_RULE', rule });
  expect(added.ok, JSON.stringify(added)).toBeTruthy();
  const { project } = await store(page);
  const where = calculationUsage(project).find((u) => u.key === 'daysToDue')!.where;
  expect(where).toContain('rule R90');

  // "Where it is used" names the rule and links to it.
  const link = page.getByTestId('calc-used').getByRole('link', { name: /R90/ });
  await expect(link).toHaveAttribute('href', /rules-data\?rule=R90/);
  // Removing is refused, in the engine's words, and the places are listed.
  await page.getByTestId('calc-remove').click();
  await expect(page.getByTestId('calc-refusal')).toBeVisible();
  await expect(page.getByTestId('calc-refusal-message')).toContainText('is still used by rule R90');
  await expect(page.getByTestId('calc-refusal-used').getByRole('link', { name: /R90/ })).toBeVisible();
  expect((await store(page)).project.calculatedFields!.map((c) => c.key)).toContain('daysToDue');

  // Undo: a saved change is one step.
  await page.getByTestId('calc-formula').fill('=DAYS(card.statementStart, card.dueDate)');
  await page.getByTestId('calc-save').click();
  await expect(page.getByTestId('calc-save-state')).toHaveText('Saved.');
  expect((await store(page)).project.calculatedFields![0].expr).toMatchObject({ from: { path: 'card.statementStart' } });
  await page.getByTestId('undo').click();
  expect((await store(page)).project.calculatedFields![0].expr).toEqual(DAYS.expr);
  await expect(page.getByTestId('calc-formula')).toHaveValue('=DAYS(card.statementEnd, card.dueDate)');

  // A calculation nothing uses can be removed, and undone.
  await dispatch(page, { type: 'UPSERT_CALCULATED_FIELD', field: HALF_MIN });
  await page.getByTestId('calc-row-halfMinimum').click();
  await expect(page.getByTestId('calc-row-halfMinimum')).toContainText('Not used yet');
  await page.getByTestId('calc-remove').click();
  await expect(page.getByTestId('calc-row-halfMinimum')).toHaveCount(0);
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('calc-row-halfMinimum')).toBeVisible();
});

test('CA06 duplicate, rename and an IF step with the condition builder', async ({ page }) => {
  await open(page, 'aster-card-demo', 'calculations');
  await dispatch(page, { type: 'UPSERT_CALCULATED_FIELD', field: HALF_MIN });
  await page.getByTestId('calc-duplicate').click();
  await expect(page.getByTestId('calc-editor')).toHaveAttribute('data-key', 'halfOfTheMinimumPaymentCopy');
  expect((await store(page)).project.calculatedFields!.map((c) => c.label)).toEqual(['Half of the minimum payment', 'Half of the minimum payment copy']);
  await page.getByTestId('calc-rename').click();
  await expect(page.getByTestId('calc-name')).toBeFocused();
  await page.getByTestId('calc-name').fill('Late payment fee');
  // Builder: If … otherwise, an amount either way, with a condition on a data field.
  await page.getByTestId('step-kind-root').selectOption('if');
  await expect(page.getByTestId('calc-formula')).toHaveValue(/^=IF\(/);
  await page.getByLabel('Result: condition, test 1 field').selectOption('card.missedPayments');
  await page.getByLabel('Result: condition, test 1 comparison').selectOption('gte');
  await page.getByLabel('Result: condition, test 1 value').fill('2');
  await page.getByTestId('step-kind-then').selectOption('constMoney');
  await page.getByLabel('Then: amount in dollars').fill('25');
  await page.getByTestId('step-kind-else').selectOption('constMoney');
  await expect(page.getByTestId('calc-formula')).toHaveValue('=IF(card.missedPayments >= 2, $25.00, $0.00)');
  await expect(page.getByTestId('calc-words')).toHaveText('If “Missed payments” is at least 2, $25.00; otherwise $0.00.');
  await page.getByTestId('calc-save').click();
  await expect(page.getByTestId('calc-save-state')).toHaveText('Saved.');
  const { project, records } = await store(page);
  const fee = project.calculatedFields!.find((c) => c.label === 'Late payment fee')!;
  expect(fee.type).toBe('money');
  for (const r of records.slice(0, 8)) {
    const o = evaluateCalculations(project, buildContext(r) as Record<string, unknown>, null);
    expect(o.values[fee.key]).toBe(((r as any).card.missedPayments ?? 0) >= 2 ? 2500 : 0);
  }
});

/** The "your own data" document of the model tests, stored under a fresh id with customers generated for it. */
async function gymDocument(request: APIRequestContext, title: string) {
  const r = await request.post(`${API}/projects`, { data: { templateId: 'blank-project', title, issuerName: 'Northside Gym', accent: '#1f4e79' } });
  expect(r.status()).toBe(201);
  const blank = (await r.json()).project as { projectId: string; modelVersion: number };
  created.push(blank.projectId);
  const p = { ...gymProject(), projectId: blank.projectId, title, modelVersion: blank.modelVersion };
  const put = await request.put(`${API}/projects/${blank.projectId}`, { data: { project: p }, headers: { 'If-Match': `"${blank.modelVersion}"` } });
  expect(put.ok(), await put.text()).toBeTruthy();
  expect((await request.post(`${API}/projects/${blank.projectId}/test-data`, { data: { outcomes: true, edges: true } })).ok()).toBeTruthy();
  return blank.projectId;
}

for (const [name, projectId] of [['a card statement', 'aster-card-demo'], ['an explanation of benefits', 'harborcare-demo']] as const) {
  test(`CA07 examples on ${name} create valid calculations from the document's own fields`, async ({ page }) => {
    await open(page, projectId, 'calculations');
    const n = await page.locator('[data-testid^="calc-example-"]').count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(3);
    // Each example is a button that makes a real calculation through a command; the empty state then gives way to the editor.
    await page.locator('[data-testid^="calc-example-"]').first().click();
    await expect(page.getByTestId('calc-editor')).toBeVisible();
    const { project } = await store(page);
    expect(project.calculatedFields!.length).toBe(1);
    expect(validateCalculatedFields(project, project.calculatedFields!)).toEqual([]);
    // The plain words and the formula are the engine's.
    await expect(page.getByTestId('calc-words')).toHaveText(formulaInWords(project.calculatedFields![0].expr, wordsScopeOf(project, projectFieldIndex(project))));
    await expect(page.getByTestId('calc-formula')).toHaveValue(printFormula(project.calculatedFields![0].expr, projectFieldIndex(project)));
  });
}

test('CA07 examples on a document with its own data use only its own fields; all of them are valid', async ({ page, request }) => {
  const id = await gymDocument(request, 'Gym calculations');
  await open(page, id, 'calculations');
  await expect(page.getByTestId('calc-empty')).toBeVisible();
  const buttons = page.locator('[data-testid^="calc-example-"]');
  const n = await buttons.count();
  expect(n).toBeGreaterThan(0);
  // Wording that belongs to the card and claim samples must not appear.
  expect((await page.getByTestId('calc-empty').innerText())).not.toMatch(/\b(card|claim|statement|balance|member responsibility)\b/i);
  for (let i = 0; i < n; i++) {
    await page.locator('[data-testid^="calc-example-"]').nth(i).click();
    await expect(page.getByTestId('calc-editor')).toBeVisible();
    const { project } = await store(page);
    expect(validateCalculatedFields(project, project.calculatedFields!)).toEqual([]);
    // Remove it again so the next example starts from the same empty document.
    await page.getByTestId('calc-remove').click();
    await expect(page.getByTestId('calc-empty')).toBeVisible();
  }
});

const goTo = (page: Page, url: string) => page.evaluate((u) => { window.history.pushState({}, '', u); window.dispatchEvent(new PopStateEvent('popstate')); }, url);

test('CA08 deep link ?calc=<key> selects that calculation; the first is pre-selected otherwise', async ({ page }) => {
  await open(page, 'aster-card-demo', 'calculations');
  for (const field of [DAYS, HALF_MIN, PER_MISS]) await dispatch(page, { type: 'UPSERT_CALCULATED_FIELD', field });
  await expect(page.getByTestId('calc-editor')).toHaveAttribute('data-key', 'daysToDue');
  await goTo(page, '/studio/aster-card-demo/calculations?calc=minPerMiss');
  await expect(page.getByTestId('calc-editor')).toHaveAttribute('data-key', 'minPerMiss');
  await expect(page.getByTestId('calc-row-minPerMiss')).toHaveAttribute('aria-current', 'true');
  // The same from a fresh page load, once the calculations are saved to the server.
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  await page.goto('/studio/aster-card-demo/calculations?calc=halfMinimum');
  await page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready');
  await expect(page.getByTestId('calc-editor')).toHaveAttribute('data-key', 'halfMinimum');
  // An unknown key falls back to the first calculation.
  await goTo(page, '/studio/aster-card-demo/calculations?calc=nothingHere');
  await expect(page.getByTestId('calc-editor')).toHaveAttribute('data-key', 'daysToDue');
});

test('CA09 choosing another calculation with unsaved changes asks first', async ({ page }) => {
  await open(page, 'aster-card-demo', 'calculations');
  for (const field of [DAYS, HALF_MIN]) await dispatch(page, { type: 'UPSERT_CALCULATED_FIELD', field });
  await page.getByTestId('calc-formula').fill('=DAYS(card.statementStart, card.dueDate)');
  await page.getByTestId('calc-row-halfMinimum').click();
  await expect(page.getByTestId('calc-leave-stay')).toBeVisible();
  await page.getByTestId('calc-leave-stay').click();
  await expect(page.getByTestId('calc-editor')).toHaveAttribute('data-key', 'daysToDue');
  await expect(page.getByTestId('calc-formula')).toHaveValue('=DAYS(card.statementStart, card.dueDate)');
  await page.getByTestId('calc-row-halfMinimum').click();
  await page.getByTestId('calc-leave-discard').click();
  await expect(page.getByTestId('calc-editor')).toHaveAttribute('data-key', 'halfMinimum');
  await page.getByTestId('calc-row-daysToDue').click();
  await expect(page.getByTestId('calc-formula')).toHaveValue('=DAYS(card.statementEnd, card.dueDate)');
});
