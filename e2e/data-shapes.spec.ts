/**
 * Richer data shapes (wave 5, section 2) in the browser: a group and a list inside a list defined in the data fields
 * editor; a repeating section with an inner table and a subtotal laid out in Design Studio and seen for a customer;
 * a nested value edited in Data Explorer; test customers generated; a rule over the items. The household statement
 * example (test only) is stored under a fresh id through the API and always deleted afterwards.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, open, pickRecord, showLeftPanel } from './helpers';
import { gotoScreen } from './nav-helper';
import { buildHousehold, householdCustomers } from '../packages/model/src/samples/household';

const created: string[] = [];
test.afterEach(async ({ request }) => { for (const id of created.splice(0)) await request.delete(`${API}/projects/${id}`); });

async function blank(request: APIRequestContext, title: string) {
  const r = await request.post(`${API}/projects`, { data: { templateId: 'blank-project', title } });
  expect(r.status()).toBe(201);
  const p = (await r.json()).project as { projectId: string; modelVersion: number };
  created.push(p.projectId);
  return p;
}

/** The household statement under a fresh id, with its 20 customers. */
async function household(request: APIRequestContext, title: string) {
  const b = await blank(request, title);
  const project = { ...buildHousehold(), projectId: b.projectId, title, modelVersion: b.modelVersion };
  const put = await request.put(`${API}/projects/${b.projectId}`, { data: { project }, headers: { 'If-Match': `"${b.modelVersion}"` } });
  expect(put.ok(), await put.text()).toBeTruthy();
  const imp = await request.post(`${API}/records/import`, { data: { projectId: b.projectId, scope: 'project', format: 'json', data: householdCustomers().map((c) => ({ customer: c.customer, custom: c.custom })) } });
  expect(imp.ok(), await imp.text()).toBeTruthy();
  const ids = ((await imp.json()).imported as Array<{ recordId: string }>).map((r) => r.recordId);
  return { projectId: b.projectId, ids };
}

const project = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().project);

test('DS01 the data fields editor defines a group and a list inside the items of a list, and shows the shape', async ({ page, request }) => {
  const { projectId } = await blank(request, 'Shapes in the editor');
  await open(page, projectId, 'rules-data');
  await page.getByTestId('no-data-fields-open').or(page.getByTestId('open-data-fields')).first().click();
  await expect(page.getByTestId('data-fields')).toBeVisible();

  // A group: Mailing address with City and Postcode.
  await page.getByTestId('df-add').click();
  await page.getByTestId('df-label').last().fill('Mailing address');
  await page.getByTestId('df-type').last().selectOption('group');
  await page.getByTestId('df-member-label').last().fill('City');
  await page.getByTestId('df-member-add').last().click();
  await page.getByTestId('df-member-label').last().fill('Postcode');

  // A list of accounts whose items hold a holder group and a list of transactions.
  await page.getByTestId('df-add').click();
  await page.getByTestId('df-label').last().fill('Accounts');
  await page.getByTestId('df-type').last().selectOption('list');
  await page.getByTestId('df-col-label').last().fill('Account number');
  await page.getByTestId('df-col-add').last().click();
  await page.getByTestId('df-col-label').last().fill('Closing balance');
  await page.getByTestId('df-col-type').last().selectOption('cents');
  await page.getByTestId('df-col-add').last().click();
  await page.getByTestId('df-col-label').last().fill('Transactions');
  await page.getByTestId('df-col-type').last().selectOption('list');
  const inner = page.getByTestId('df-inner-list').last();
  await inner.getByTestId('df-col-label').first().fill('Amount');
  await inner.getByTestId('df-col-type').first().selectOption('cents');
  // An inner list offers only simple columns: lists go two levels deep at most.
  await expect(inner.getByTestId('df-col-type').first().locator('option')).toHaveText(['Text', 'Whole number', 'Amount', 'Date']);

  await expect(page.getByTestId('df-tree')).toContainText('Mailing address');
  await expect(page.getByTestId('df-tree')).toContainText('Transactions');
  await page.getByTestId('save-data-fields').click();
  await expect(page.getByTestId('data-fields')).toHaveCount(0);
  const fields = (await project(page)).customFields;
  expect(fields.map((f: any) => [f.key, f.type])).toEqual([['mailingAddress', 'group'], ['accounts', 'list']]);
  expect(fields[0].fields.map((m: any) => m.key)).toEqual(['city', 'postcode']);
  expect(fields[1].itemFields.map((c: any) => [c.key, c.type])).toEqual([['accountNumber', 'string'], ['closingBalance', 'cents'], ['transactions', 'list']]);
  expect(fields[1].itemFields[2].itemFields).toEqual([{ key: 'amount', label: 'Amount', type: 'cents' }]);
});

test('DS02 a repeating section with an inner table and a subtotal, seen for a customer, in Design Studio', async ({ page, request }) => {
  const { projectId, ids } = await household(request, 'Shapes in Design Studio');
  const four = ids[4];
  await open(page, projectId, 'design');
  await pickRecord(page, four);
  // The example's section repeats for each of the four accounts; later items are marked as repeats on the canvas.
  await expect(page.getByTestId('repeat-accounts-section')).toBeVisible();
  await expect(page.locator('[data-repeat-item]')).toHaveCount(4);
  // The first account is laid out in full; later ones show their heading and how much more they repeat.
  await expect(page.getByTestId('node-account-transactions')).toBeVisible();
  await expect(page.getByTestId('node-account-heading~4')).toBeVisible();
  await expect(page.locator('[data-repeat-item="4"]')).toContainText('repeated (+3 more components)');
  // Clicking a repeat selects the component of the document (its Inspector, not a copy).
  await page.getByTestId('node-account-heading~3').click();
  await expect(page.getByTestId('node-account-heading')).toHaveClass(/is-selected/);

  // A second repeating section built here: a section set to repeat, then a table of each account's transactions and its subtotal.
  await page.getByTestId('node-closing').click();
  await showLeftPanel(page);
  await page.getByTestId('insert-container').click();
  const section = (await project(page)).nodes.find((n: any) => n.type === 'container' && n.id !== 'doc-root' && n.id !== 'totals' && n.id !== 'accounts-section');
  await expect(page.getByTestId('repeat-editor')).toBeVisible();
  await page.getByTestId('repeat-list').selectOption('custom.accounts');
  await page.getByTestId('repeat-keep-heading').check();
  await expect(page.getByTestId('repeat-note')).toContainText('4 times for this customer');
  await page.getByTestId('insert-repeating-table').click();
  await page.getByTestId('table-binding').selectOption('custom.accounts[].transactions');
  await page.getByTestId(`node-${section.id}`).click({ position: { x: 4, y: 4 } });
  await page.getByTestId('insert-summary-metric').click();
  const p = await project(page);
  const inside = p.nodes.find((n: any) => n.id === section.id).children.map((id: string) => p.nodes.find((n: any) => n.id === id));
  const metric = inside.find((n: any) => n.type === 'summary-metric');
  await page.getByTestId('binding-select').selectOption('calc.accountSubtotal');
  const after = await project(page);
  expect(after.nodes.find((n: any) => n.id === section.id).repeat).toEqual({ list: 'custom.accounts', keepHeading: true });
  expect(after.nodes.find((n: any) => n.id === metric.id).binding).toBe('calc.accountSubtotal');
  // For this customer: the first account's table and subtotal on the canvas; four of each in the document.
  const tableId = inside.find((n: any) => n.type === 'repeating-table').id;
  await expect(page.getByTestId(`node-${tableId}`)).toBeVisible();
  const accounts = householdCustomers()[4].custom.accounts as Array<{ transactions: Array<{ amountCents: number }> }>;
  const first = accounts[0].transactions.reduce((s, t) => s + t.amountCents, 0);
  await expect(page.getByTestId(`node-${metric.id}`)).toContainText(`$${(Math.abs(first) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  const res = await request.post(`${API}/resolve`, { data: { projectId, recordId: four, project: after, includeTree: true } });
  const tree = JSON.stringify((await res.json()).tree);
  for (const k of [2, 3, 4]) { expect(tree).toContain(`"${tableId}~${k}"`); expect(tree).toContain(`"${metric.id}~${k}"`); }
});

test('DS03 Data Explorer edits a value inside a list of a list, adds and removes an inner row', async ({ page, request }) => {
  const { projectId, ids } = await household(request, 'Shapes in Data Explorer');
  const id = ids[3];
  await open(page, projectId, 'rules-data');
  await gotoScreen(page, 'S16');
  await page.getByTestId(`dx-row-${id}`).click();
  // Customers supplied for a document are kept as they came: edit a copy.
  await page.getByTestId('dx-copy').click();
  await expect(page.getByTestId('dx-record')).toHaveAttribute('data-origin', 'yours');
  const copy = (await page.getByTestId('dx-record').getAttribute('data-record'))!;
  const accounts = page.getByTestId('dx-list-custom.accounts');
  await expect(accounts).toBeVisible();
  await accounts.getByTestId('dx-row-expand').first().click();
  // The holder (a group in each account) is shown by name, and the account's transactions as a table of their own.
  await expect(page.getByTestId('dx-x-custom.accounts-0-holder.name')).toHaveValue(/Daniela/);
  const tx = page.getByTestId('dx-list-custom.accounts[0].transactions');
  await expect(tx).toBeVisible();
  const before = await tx.locator('tbody tr[data-testid^="dx-trow-"]').count();
  await page.getByTestId('dx-c-custom.accounts[0].transactions-0-amountCents').fill('-1234.56');
  await tx.getByTestId('dx-list-add').click();
  await expect(tx.locator('tbody tr[data-testid^="dx-trow-"]')).toHaveCount(before + 1);
  await tx.getByTestId('dx-row-del').last().click();
  await expect(tx.locator('tbody tr[data-testid^="dx-trow-"]')).toHaveCount(before);
  await page.getByTestId('dx-save').click();
  await expect.poll(async () => {
    const r = await request.get(`${API}/records?projectId=${projectId}&full=1`);
    return ((await r.json()).records as any[]).find((x) => x.recordId === copy)?.custom?.accounts?.[0]?.transactions?.[0]?.amountCents;
  }).toBe(-123456);
});

test('DS04 test customers are generated with nested lists, and a rule over the items is edited in plain words', async ({ page, request }) => {
  const { projectId } = await household(request, 'Shapes in rules');
  const gen = await request.post(`${API}/projects/${projectId}/test-data`, { data: { outcomes: true, edges: true } });
  expect(gen.ok(), await gen.text()).toBeTruthy();
  const plan = await gen.json();
  expect(JSON.stringify(plan)).toContain('Any account is overdrawn');
  await open(page, projectId, 'rules-data');
  await page.getByTestId('rule-row-R01').click();
  await expect(page.getByTestId('cond-0-items')).toBeVisible();
  await expect(page.getByTestId('cond-0-match')).toHaveValue('any');
  await expect(page.getByTestId('cond-0-list')).toHaveValue('custom.accounts');
  await expect(page.getByTestId('cond-0-item-field')).toHaveValue('custom.accounts[].balanceCents');
  await page.getByTestId('cond-0-match').selectOption('atLeast');
  await page.getByTestId('cond-0-count').fill('2');
  await expect(page.locator('body')).toContainText('at least 2 items of “Accounts”');
});
