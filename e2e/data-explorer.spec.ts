import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, open, resetAll } from './helpers';
import { gotoScreen } from './nav-helper';

const P = 'aster-card-demo';
const H = 'harborcare-demo';
const TX = 'card.transactions';

test.beforeEach(async ({ request }) => { await resetAll(request); await request.delete(`${API}/projects/${P}/test-data`); });
// Remove every customer a test made (the document's own ones) and any generated test data.
test.afterEach(async ({ request }) => {
  for (const [p, type] of [[P, 'credit-statement'], [H, 'eob']] as const) {
    const recs = (await (await request.get(`${API}/records?documentType=${type}&full=1&projectId=${p}`)).json()).records as any[];
    for (const r of recs.filter((x) => x.projectId)) await request.delete(`${API}/projects/${p}/records/${r.recordId}`);
  }
  await request.delete(`${API}/projects/${P}/test-data`);
});

const ownRecords = async (request: APIRequestContext) => ((await (await request.get(`${API}/records?documentType=credit-statement&full=1&projectId=${P}`)).json()).records as any[]);
const byId = async (request: APIRequestContext, id: string) => (await ownRecords(request)).find((r) => r.recordId === id);
const record = (page: Page) => page.getByTestId('dx-record');
const toast = (page: Page, text: RegExp | string) => expect(page.getByTestId('toast').filter({ hasText: text }).first()).toBeVisible();

/** Make an editable copy of a sample in the UI and return the copy's id. */
async function makeCopy(page: Page, sampleId = 'CARD-0001') {
  await page.getByTestId(`dx-row-${sampleId}`).click();
  await page.getByTestId('dx-copy').click();
  await expect(record(page)).toHaveAttribute('data-origin', 'yours');
  const id = (await record(page).getAttribute('data-record'))!;
  expect(id).not.toBe(sampleId);
  return id;
}
async function ownCopy(request: APIRequestContext, sampleId = 'CARD-0001') {
  const r = await request.post(`${API}/projects/${P}/records`, { data: { copyOf: sampleId } });
  expect(r.status()).toBe(201);
  return (await r.json()).record.recordId as string;
}

test('D01 opens from the menu; customers are grouped; a sample shows nested sections and its transactions, read-only', async ({ page }) => {
  await open(page, P, 'rules-data');
  await gotoScreen(page, 'S16');
  await expect(page.getByTestId('data-explorer')).toBeVisible();
  await expect(page).toHaveURL(/\/studio\/aster-card-demo\/data/);
  await expect(page.getByTestId('dx-list')).toBeVisible();
  await expect(page.getByTestId('dx-group-sample')).toContainText('Samples');
  await expect(page.getByTestId('dx-group-yours')).toHaveCount(0);

  // The customer previewed in the top bar is selected.
  await expect(record(page)).toHaveAttribute('data-record', 'CARD-0001');
  await expect(page.getByTestId('dx-row-CARD-0001')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('dx-section-customer')).toBeVisible();
  await expect(page.getByTestId('dx-section-card')).toBeVisible();
  await expect(page.getByTestId('dx-section-toggle-card')).toHaveAttribute('aria-expanded', 'true');
  const list = page.getByTestId(`dx-list-${TX}`);
  await expect(list).toContainText('Transactions · 12 rows');
  await expect(page.locator(`[data-testid^="dx-trow-${TX}-"]`)).toHaveCount(12);
  // a nested group inside Customer
  await page.getByTestId('dx-nest-toggle-customer.accessibility').click();
  await expect(page.getByTestId('dx-f-customer.accessibility.largeText')).toBeVisible();
  // typed controls
  await expect(page.getByTestId('dx-f-card.creditLimitCents')).toHaveValue('8000.00');
  await expect(page.getByTestId('dx-f-card.dueDate')).toHaveAttribute('type', 'date');
  await expect(page.getByTestId('dx-f-card.assistanceRequested')).toHaveAttribute('role', 'switch');
  await expect(page.getByTestId('dx-f-card.availableCreditCents')).toContainText('$');
  await expect(page.getByTestId('dx-f-card.availableCreditCents')).toContainText('calculated');

  // read-only
  await expect(page.getByTestId('dx-banner')).toContainText('Sample customers are shared by every document and cannot be changed');
  await expect(page.getByTestId('dx-copy')).toBeEnabled();
  await expect(page.getByTestId('dx-f-customer.givenName')).toBeDisabled();
  await expect(page.getByTestId('dx-f-card.paymentStatus')).toBeDisabled();
  await expect(page.getByTestId('dx-list-add')).toBeDisabled();
  await expect(page.getByTestId('dx-delete')).toHaveCount(0);
  await expect(page.getByTestId('dx-save')).toHaveCount(0);
});

test('D02 an editable copy: editing a nested value changes what the customer gets before saving; it persists; the sample is unchanged', async ({ page, request }) => {
  await open(page, P, 'data');
  const id = await makeCopy(page);
  await expect(page.getByTestId('dx-group-yours')).toBeVisible();
  await expect(page.getByTestId(`dx-row-${id}`)).toBeVisible();
  await expect(page.getByTestId('dx-save')).toBeDisabled();
  const before = await page.getByTestId('dx-outcome-messages').innerText();
  await expect(page.getByTestId('dx-outcome-changed')).toHaveCount(0);

  await page.getByTestId('dx-f-card.paymentStatus').selectOption('overdue');
  await page.getByTestId('dx-f-card.missedPayments').fill('3');
  await expect(page.getByTestId('dx-outcome-changed')).toBeVisible();
  await expect(page.getByTestId('dx-outcome-diffs')).toContainText('→');
  expect(await page.getByTestId('dx-outcome-messages').innerText()).not.toBe(before);
  await expect(page.getByTestId('dx-dirty')).toBeVisible();
  // nothing is stored until Save
  expect((await byId(request, id)).card.paymentStatus).toBe('current');

  await page.getByTestId('dx-save').click();
  await toast(page, 'Customer saved');
  await expect(page.getByTestId('dx-dirty')).toHaveCount(0);
  await expect(page.getByTestId('dx-outcome-changed')).toHaveCount(0);

  await page.reload();
  await expect(record(page)).toHaveAttribute('data-record', id);
  await expect(page.getByTestId('dx-f-card.paymentStatus')).toHaveValue('overdue');
  await expect(page.getByTestId('dx-f-card.missedPayments')).toHaveValue('3');
  const stored = await byId(request, id);
  expect(stored.card.paymentStatus).toBe('overdue');
  expect(stored.card.missedPayments).toBe(3);

  const sample = (await (await request.get(`${API}/records?documentType=credit-statement&full=1&projectId=${P}`)).json()).records.find((r: any) => r.recordId === 'CARD-0001');
  expect(sample.card.paymentStatus).toBe('current');
  expect(sample.card.missedPayments).toBe(0);

  // Discard returns to the saved values
  await page.getByTestId('dx-f-card.missedPayments').fill('1');
  await page.getByTestId('dx-discard').click();
  await expect(page.getByTestId('dx-f-card.missedPayments')).toHaveValue('3');
});

test('D03 list editing: add a row, amount in dollars stored as cents, duplicate, reorder, delete; saved values persist', async ({ page, request }) => {
  await open(page, P, 'data');
  const id = await makeCopy(page);
  const rows = page.locator(`[data-testid^="dx-trow-${TX}-"]`);
  await expect(rows).toHaveCount(12);

  await page.getByTestId('dx-list-add').click();
  await expect(rows).toHaveCount(13);
  await expect(page.getByTestId(`dx-list-${TX}`)).toContainText('13 rows');
  await page.getByTestId(`dx-c-${TX}-12-merchant`).fill('Test shop');
  await page.getByTestId(`dx-c-${TX}-12-amountCents`).fill('12.34');

  // duplicate, rename the copy, and move it above the original
  await page.getByTestId(`dx-trow-${TX}-12`).getByTestId('dx-row-dup').click();
  await expect(rows).toHaveCount(14);
  await expect(page.getByTestId(`dx-c-${TX}-13-merchant`)).toHaveValue('Test shop');
  await page.getByTestId(`dx-c-${TX}-13-merchant`).fill('Second shop');
  await page.getByTestId(`dx-trow-${TX}-13`).getByTestId('dx-row-up').click();
  await expect(page.getByTestId(`dx-c-${TX}-12-merchant`)).toHaveValue('Second shop');
  await expect(page.getByTestId(`dx-c-${TX}-13-merchant`)).toHaveValue('Test shop');
  await page.getByTestId(`dx-trow-${TX}-12`).getByTestId('dx-row-down').click();
  await expect(page.getByTestId(`dx-c-${TX}-13-merchant`)).toHaveValue('Second shop');
  await page.getByTestId(`dx-trow-${TX}-13`).getByTestId('dx-row-up').click();
  // delete the second one (now "Test shop")
  await page.getByTestId(`dx-trow-${TX}-13`).getByTestId('dx-row-del').click();
  await expect(rows).toHaveCount(13);
  await expect(page.getByTestId(`dx-c-${TX}-12-merchant`)).toHaveValue('Second shop');
  await expect(page.getByTestId(`dx-c-${TX}-12-amountCents`)).toHaveValue('12.34');
  // the calculated sum follows the rows
  await expect(page.getByTestId('dx-f-card.transactionsTotalCents')).toContainText('$');

  await page.getByTestId('dx-save').click();
  await toast(page, 'Customer saved');
  const stored = await byId(request, id);
  expect(stored.card.transactions).toHaveLength(13);
  expect(stored.card.transactions[12].amountCents).toBe(1234);
  expect(stored.card.transactions[12].merchant).toBe('Second shop');
  expect(stored.card.transactions[0].id).toBe('T-001-0001');

  await page.reload();
  await expect(page.getByTestId(`dx-list-${TX}`)).toContainText('13 rows');
  await expect(page.getByTestId(`dx-c-${TX}-12-amountCents`)).toHaveValue('12.34');
});

test('D03b a long list shows 25 rows and offers more', async ({ page, request }) => {
  const id = await ownCopy(request);
  const rec = await byId(request, id);
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `T-${i}`, date: '2026-10-01', merchant: `Shop ${i}`, amountCents: 100 + i }));
  expect((await request.put(`${API}/projects/${P}/records/${id}`, { data: { record: { ...rec, card: { ...rec.card, transactions: many } } } })).ok()).toBeTruthy();
  await open(page, P, `data?customer=${id}`);
  const rows = page.locator(`[data-testid^="dx-trow-${TX}-"]`);
  await expect(page.getByTestId(`dx-list-${TX}`)).toContainText('60 rows');
  await expect(rows).toHaveCount(25);
  await page.getByTestId('dx-list-more').click();
  await expect(rows).toHaveCount(50);
});

test('D04 a bad value shows beside the field and in the summary, Save is off until it is fixed', async ({ page, request }) => {
  await open(page, P, 'data');
  const id = await makeCopy(page);
  await page.getByTestId('dx-mode-json').click();
  const json = page.getByTestId('dx-json');
  const text = await json.inputValue();
  expect(text).toContain('"dueDate": "2026-11-25"');
  await json.fill(text.replace('"dueDate": "2026-11-25"', '"dueDate": "tomorrow"').replace('"paymentStatus": "current"', '"paymentStatus": "late"'));
  await expect(page.getByTestId('dx-problems')).toContainText('Payment due date');
  await expect(page.getByTestId('dx-problems')).toContainText('Payment status');
  await expect(page.getByTestId('dx-save')).toBeDisabled();
  await expect(page.getByTestId('dx-outcome-blocked')).toContainText('Fix the values');

  await page.getByTestId('dx-mode-form').click();
  await expect(page.getByTestId('dx-f-card.dueDate')).toHaveValue('tomorrow');
  await expect(page.getByTestId('dx-f-card.dueDate')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('dx-section-card').getByTestId('dx-field-problem').first()).toBeVisible();
  await expect(page.getByTestId('dx-f-card.paymentStatus').locator('option:checked')).toHaveText('late (not allowed)');
  await expect(page.getByTestId('dx-save')).toBeDisabled();

  // the summary jumps to the field
  await page.getByTestId('dx-problems').getByRole('button', { name: /Payment due date/ }).click();
  await expect(page.getByTestId('dx-f-card.dueDate')).toBeFocused();

  await page.getByTestId('dx-f-card.dueDate').fill('2026-11-30');
  await page.getByTestId('dx-f-card.paymentStatus').selectOption('overdue');
  await expect(page.getByTestId('dx-problems')).toHaveCount(0);
  await expect(page.getByTestId('dx-save')).toBeEnabled();
  await page.getByTestId('dx-save').click();
  await toast(page, 'Customer saved');
  const stored = await byId(request, id);
  expect(stored.card.dueDate).toBe('2026-11-30');
});

test('D04b a bad value inside a list row is reported with the row and column', async ({ page }) => {
  await open(page, P, 'data');
  await makeCopy(page);
  await page.getByTestId('dx-mode-json').click();
  const json = page.getByTestId('dx-json');
  const text = await json.inputValue();
  await json.fill(text.replace('"date": "2026-10-03"', '"date": "3rd October"'));
  await expect(page.getByTestId('dx-problems')).toContainText('Transactions, row 3, Date');
  await page.getByTestId('dx-problems').getByRole('button', { name: /row 3, Date/ }).click();
  await expect(page.getByTestId(`dx-c-${TX}-2-date`)).toBeFocused();
  await expect(page.getByTestId('dx-save')).toBeDisabled();
});

test('D05 JSON mode shows the nested record, reports a syntax error without losing it, and a valid edit reaches the form', async ({ page }) => {
  await open(page, P, 'data');
  await makeCopy(page);
  await page.getByTestId('dx-mode-json').click();
  const json = page.getByTestId('dx-json');
  const text = await json.inputValue();
  expect(text).toContain('"customer": {');
  expect(text).toContain('"transactions": [');
  expect(text).not.toContain('"recordId"');
  await expect(page.getByTestId('dx-json-fixed')).toBeVisible();
  await expect(page.getByTestId('dx-json-error')).toHaveCount(0);

  await json.fill(text.slice(0, -4));
  await expect(page.getByTestId('dx-json-error')).toContainText('not valid JSON');
  await expect(page.getByTestId('dx-save')).toBeDisabled();
  await expect(page.getByTestId('dx-record-name')).toHaveText('Jordan Mercer');

  await json.fill(text.replace('"givenName": "Jordan"', '"givenName": "Jordana"'));
  await expect(page.getByTestId('dx-json-error')).toHaveCount(0);
  await expect(page.getByTestId('dx-record-name')).toHaveText('Jordana Mercer');
  await page.getByTestId('dx-mode-form').click();
  await expect(page.getByTestId('dx-f-customer.givenName')).toHaveValue('Jordana');
  await expect(page.getByTestId('dx-save')).toBeEnabled();
  // and back: a form edit shows in the JSON
  await page.getByTestId('dx-f-customer.familyName').fill('Merceria');
  await page.getByTestId('dx-mode-json').click();
  await expect(page.getByTestId('dx-json')).toHaveValue(/"familyName": "Merceria"/);
});

test('D05b an unknown value is shown read-only and kept on save', async ({ page, request }) => {
  const id = await ownCopy(request);
  const rec = await byId(request, id);
  expect((await request.put(`${API}/projects/${P}/records/${id}`, { data: { record: { ...rec, card: { ...rec.card, loyaltyCode: 'GOLD-7' } } } })).ok()).toBeTruthy();
  await open(page, P, `data?customer=${id}`);
  await page.getByTestId('dx-other').getByRole('button', { name: /Other values/ }).click();
  await expect(page.getByTestId('dx-other')).toContainText('GOLD-7');
  await page.getByTestId('dx-f-customer.givenName').fill('Kept');
  await page.getByTestId('dx-save').click();
  await toast(page, 'Customer saved');
  expect((await byId(request, id)).card.loyaltyCode).toBe('GOLD-7');
});

test('D06 a new blank customer can be edited and deleted', async ({ page, request }) => {
  await open(page, P, 'data');
  await page.getByTestId('dx-new').click();
  await page.getByTestId('dx-new-blank').click();
  await expect(record(page)).toHaveAttribute('data-origin', 'yours');
  const id = (await record(page).getAttribute('data-record'))!;
  await expect(page.getByTestId('dx-record-name')).toHaveText('New Customer');
  await expect(page.getByTestId('dx-group-yours').getByTestId(`dx-row-${id}`)).toBeVisible();
  await expect(page.getByTestId(`dx-list-${TX}`)).toContainText('0 rows');
  await expect(page.getByTestId('dx-problems')).toHaveCount(0);
  expect(await byId(request, id)).toBeTruthy();

  await page.getByTestId('dx-delete').click();
  await expect(page.getByTestId('dx-delete-dialog')).toContainText('New Customer');
  await page.getByTestId('dx-delete-confirm').click();
  await expect(page.getByTestId(`dx-row-${id}`)).toHaveCount(0);
  await expect(page.getByTestId('dx-group-yours')).toHaveCount(0);
  expect(await byId(request, id)).toBeUndefined();
});

test('D06b a copy of the selected customer, and the origin filter and search', async ({ page, request }) => {
  await open(page, P, 'data');
  await page.getByTestId('dx-row-CARD-0003').click();
  await page.getByTestId('dx-new').click();
  await page.getByTestId('dx-new-copy').click();
  await expect(record(page)).toHaveAttribute('data-origin', 'yours');
  const id = (await record(page).getAttribute('data-record'))!;
  expect((await byId(request, id)).customer.givenName).toBe('Alex');
  await page.getByTestId('dx-filter').selectOption('yours');
  await expect(page.getByTestId('dx-group-sample')).toHaveCount(0);
  await expect(page.getByTestId(`dx-row-${id}`)).toBeVisible();
  await page.getByTestId('dx-filter').selectOption('all');
  await page.getByTestId('dx-search').fill('Taylor');
  await expect(page.locator('[data-testid^="dx-row-"]').first()).toContainText('Taylor');
  await expect(page.getByTestId(`dx-row-${id}`)).toHaveCount(0);
  await page.getByTestId('dx-search').fill('zzzz');
  await expect(page.getByTestId('dx-list')).toContainText('No customer matches');
});

test('D06c a generated customer is editable and, once saved, is listed under Yours', async ({ page, request }) => {
  expect((await request.post(`${API}/projects/${P}/test-data`, { data: { outcomes: true, edges: false } })).ok()).toBeTruthy();
  await open(page, P, 'data');
  await expect(page.getByTestId('dx-group-generated')).toContainText('Generated for this document');
  const first = page.getByTestId('dx-group-generated').locator('[data-testid^="dx-row-"]').first();
  const id = (await first.getAttribute('data-testid'))!.replace('dx-row-', '');
  await first.click();
  await expect(record(page)).toHaveAttribute('data-origin', 'generated');
  await expect(page.getByTestId('dx-banner')).toContainText('Generated for this document. If you change it, it is kept as your own and generating again will not replace it.');
  await expect(page.getByTestId('dx-f-customer.givenName')).toBeEnabled();
  await expect(page.getByTestId('dx-delete')).toBeVisible();
  await page.getByTestId('dx-f-customer.givenName').fill('Edited');
  await page.getByTestId('dx-save').click();
  await toast(page, 'Customer saved');
  await expect(page.getByTestId('dx-group-yours').getByTestId(`dx-row-${id}`)).toBeVisible();
  await expect(page.getByTestId('dx-group-generated').getByTestId(`dx-row-${id}`)).toHaveCount(0);
  await expect(record(page)).toHaveAttribute('data-origin', 'yours');
  // generating again does not replace it
  expect((await request.post(`${API}/projects/${P}/test-data`, { data: { outcomes: true, edges: false } })).ok()).toBeTruthy();
  expect((await byId(request, id)).customer.givenName).toBe('Edited');
});

test('D07 an Explanation of Benefits customer shows Claims as a list whose rows expand into the claim', async ({ page }) => {
  await open(page, H, 'data');
  await expect(page.getByTestId('dx-section-member')).toBeVisible();
  await expect(page.getByTestId('dx-section-claims')).toBeVisible();
  const list = page.getByTestId('dx-list-claims');
  await expect(list).toContainText(/Claims · \d+ rows?/);
  await expect(page.getByTestId('dx-c-claims-0-claimId')).toBeVisible();
  await expect(page.locator('[data-testid^="dx-detail-claims-"]')).toHaveCount(0);
  await page.getByTestId('dx-trow-claims-0').getByTestId('dx-row-expand').click();
  const detail = page.getByTestId('dx-detail-claims-0');
  await expect(detail).toContainText('Claim status');
  await expect(detail).toContainText('Network status');
  await expect(detail).toContainText('Contractual adjustment');
  await expect(page.getByTestId('dx-x-claims-0-status')).toBeVisible();
  await expect(detail.getByTestId('dx-x-claims-0-liabilityConfirmed')).toHaveAttribute('role', 'switch');
  await page.getByTestId('dx-trow-claims-0').getByTestId('dx-row-expand').click();
  await expect(detail).toHaveCount(0);
});

test('D07b editing a claim in an EOB copy changes what the member gets and saves', async ({ page, request }) => {
  await open(page, H, 'data');
  await page.getByTestId('dx-copy').click();
  await expect(record(page)).toHaveAttribute('data-origin', 'yours');
  const id = (await record(page).getAttribute('data-record'))!;
  await page.getByTestId('dx-trow-claims-0').getByTestId('dx-row-expand').click();
  await page.getByTestId('dx-x-claims-0-network').selectOption('out-of-network');
  await page.getByTestId('dx-c-claims-0-billedCents').fill('555.50');
  await page.getByTestId('dx-save').click();
  await toast(page, 'Customer saved');
  const recs = (await (await request.get(`${API}/records?documentType=eob&full=1&projectId=${H}`)).json()).records as any[];
  const stored = recs.find((r) => r.recordId === id);
  expect(stored.claims[0].network).toBe('out-of-network');
  expect(stored.claims[0].billedCents).toBe(55550);
});

test('D08 without the right to edit everything is read-only with the reason', async ({ page, request }) => {
  const id = await ownCopy(request);
  await page.route('**/api/v1/session', (route) => route.fulfill({ json: {
    authEnabled: true, user: { id: 'u-rev', name: 'Riley Reviewer', email: 'rev@example.test', role: 'reviewer' },
    permissions: ['view', 'comment'], roles: ['reviewer'], expiresAt: null,
  } }));
  await open(page, P, `data?customer=${id}`);
  await expect(page.getByTestId('dx-banner')).toContainText('Reviewers can comment but not edit');
  await expect(page.getByTestId('dx-new')).toBeDisabled();
  await expect(page.getByTestId('dx-f-customer.givenName')).toBeDisabled();
  await expect(page.getByTestId('dx-f-card.paymentStatus')).toBeDisabled();
  await expect(page.getByTestId('dx-list-add')).toBeDisabled();
  await expect(page.getByTestId('dx-save')).toBeDisabled();
  await expect(page.getByTestId('dx-delete')).toBeDisabled();
  await expect(page.getByTestId('dx-row-up').first()).toBeDisabled();
  await page.getByTestId('dx-mode-json').click();
  await expect(page.getByTestId('dx-json')).toHaveAttribute('readonly', '');
  // a sample cannot be copied either
  await page.getByTestId('dx-mode-form').click();
  await page.getByTestId('dx-row-CARD-0001').click();
  await expect(page.getByTestId('dx-copy')).toBeDisabled();
});

test('D09 unsaved edits: switching customer or leaving the screen asks first', async ({ page, request }) => {
  const id = await ownCopy(request);
  await open(page, P, `data?customer=${id}`);
  await page.getByTestId('dx-f-customer.givenName').fill('Changed');
  await page.getByTestId('dx-row-CARD-0002').click();
  await expect(page.getByTestId('dx-leave-dialog')).toContainText('not saved');
  await page.getByTestId('dx-leave-stay').click();
  await expect(record(page)).toHaveAttribute('data-record', id);
  await expect(page.getByTestId('dx-f-customer.givenName')).toHaveValue('Changed');

  // the menu asks too
  await page.getByTestId('nav-section-design').click();
  await expect(page.getByTestId('dx-leave-dialog')).toBeVisible();
  await page.getByTestId('dx-leave-stay').click();
  await expect(page).toHaveURL(/\/data/);

  await page.getByTestId('dx-row-CARD-0002').click();
  await page.getByTestId('dx-leave-discard').click();
  await expect(record(page)).toHaveAttribute('data-record', 'CARD-0002');
  await expect(page).toHaveURL(/customer=CARD-0002/);
  expect((await byId(request, id)).customer.givenName).toBe('Jordan');
  // back on the edited one nothing is pending
  await page.getByTestId(`dx-row-${id}`).click();
  await expect(page.getByTestId('dx-f-customer.givenName')).toHaveValue('Jordan');
  await expect(page.getByTestId('dx-leave-dialog')).toHaveCount(0);
});

test('D10 preview selects the customer in the studio; it waits for unsaved edits', async ({ page, request }) => {
  const id = await ownCopy(request);
  await open(page, P, `data?customer=${id}`);
  await expect(page.getByTestId('dx-preview')).toBeEnabled();
  await page.getByTestId('dx-f-customer.givenName').fill('Edited');
  await expect(page.getByTestId('dx-preview')).toBeDisabled();
  await expect(page.getByTestId('dx-preview-hint')).toContainText('Save or discard');
  await page.getByTestId('dx-discard').click();
  await page.getByTestId('dx-preview').click();
  await expect(page).toHaveURL(/\/studio\/aster-card-demo\/design/);
  await expect(page.getByTestId('record-selector')).toHaveAttribute('data-value', id);
});

test('D11 a link opens that customer, the list works from the keyboard, and Technical view shows paths and ids', async ({ page }) => {
  await open(page, P, 'data?customer=CARD-0004');
  await expect(record(page)).toHaveAttribute('data-record', 'CARD-0004');
  await page.getByTestId('dx-row-CARD-0004').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('dx-row-CARD-0005')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/customer=CARD-0005/);
  await expect(record(page)).toHaveAttribute('data-record', 'CARD-0005');
  // technical view shows field paths and record ids
  await page.evaluate(() => (window as any).__iss.store.getState().setViewMode('technical'));
  await expect(record(page).getByText('card.paymentStatus').first()).toBeVisible();
  await expect(page.getByTestId('dx-row-CARD-0005')).toContainText('CARD-0005');
});
