/**
 * Import fields (wave 3, section 4) in the data fields editor: a data dictionary CSV into a "your own data" document,
 * with types read (and said when unrecognised), a clash skipped with the reason, one undoable step, and one synthetic
 * customer made from the examples through the customer route. Refused on a card statement, with the reason.
 * Run on an isolated stack (scripts/dev-isolated.mjs).
 */
import { test, expect, type Page } from '@playwright/test';
import { API, open, resetAll } from './helpers';

const created: string[] = [];
test.beforeEach(async ({ request }) => { await resetAll(request); });
test.afterEach(async ({ request }) => { for (const id of created.splice(0)) await request.delete(`${API}/projects/${id}`); });

const fields = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().project.customFields ?? []);
const DICTIONARY = [
  'Field Name,Data Type,Description,Sample Value',
  'plan_name,varchar,The plan,Flex',
  'monthly_fee,amount,Fee per month,49.00',
  'renewal_date,date,When it renews,2026-12-01',
  'tier,choice: basic|plus|pro,Membership tier,plus',
  'photo,blob,Member photo,',
  'given name,string,Clashes with a customer field,',
].join('\n') + '\n';

test('IF01 a data dictionary into a document with its own data, with a customer from the examples', async ({ page, request }) => {
  const r = await request.post(`${API}/projects`, { data: { templateId: 'blank-project', title: `Fields E2E ${Date.now().toString(36)}`, issuerName: 'Northside Gym' } });
  expect(r.status()).toBe(201);
  const pid = (await r.json()).project.projectId;
  created.push(pid);
  await open(page, pid, 'rules-data');
  await page.getByTestId((await page.getByTestId('no-data-fields-open').count()) ? 'no-data-fields-open' : 'open-data-fields').click();
  await page.getByTestId('df-import').click();
  const dialog = page.getByTestId('if-dialog');
  await dialog.locator('summary').click();
  await page.getByTestId('if-text').fill(DICTIONARY);
  await expect(page.getByTestId('if-columns')).toContainText('Names from “Field Name”, types from “Data Type”, examples from “Sample Value”');
  const row = (key: string) => page.locator(`[data-testid="if-row"][data-key="${key}"]`);
  await expect(row('monthlyFee')).toHaveAttribute('data-type', 'cents');
  await expect(row('monthlyFee').getByTestId('if-example-note')).toContainText('was read as 4900 cents');
  await expect(row('tier')).toContainText('basic, plus, pro');
  await expect(row('photo').getByTestId('if-type-note')).toHaveText('“blob” is not a type the studio knows: read as text.');
  await expect(row('givenName').getByTestId('if-skip')).toContainText('already one of the customer fields');
  // nothing has changed yet (a dry run)
  expect(await fields(page)).toEqual([]);
  await expect(page.getByTestId('if-customer-note')).toContainText('“Example Customer”');
  await expect(page.getByTestId('if-customer')).toBeChecked();
  await page.getByTestId('if-apply').click();
  await expect(page.getByTestId('if-dialog')).toHaveCount(0);
  expect((await fields(page)).map((f: any) => f.key)).toEqual(['planName', 'monthlyFee', 'renewalDate', 'tier', 'photo']);
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  // the customer was added through the customer route, from the examples only
  const records = (await (await request.get(`${API}/records?documentType=custom&full=1&projectId=${pid}`)).json()).records as any[];
  const example = records.find((x) => x.customer.givenName === 'Example' && x.customer.familyName === 'Customer');
  expect(example?.custom).toEqual({ planName: 'Flex', monthlyFee: 4900, renewalDate: '2026-12-01', tier: 'plus' });
  // the editor shows the new fields; undo takes the import back as one step
  await expect(page.getByTestId('df-row')).toHaveCount(5);
});

test('IF02 the import is one undoable step', async ({ page, request }) => {
  const r = await request.post(`${API}/projects`, { data: { templateId: 'blank-project', title: `Fields undo ${Date.now().toString(36)}` } });
  const pid = (await r.json()).project.projectId;
  created.push(pid);
  await open(page, pid, 'rules-data');
  await page.getByTestId((await page.getByTestId('no-data-fields-open').count()) ? 'no-data-fields-open' : 'open-data-fields').click();
  await page.getByTestId('df-import').click();
  await page.getByTestId('if-dialog').locator('summary').click();
  await page.getByTestId('if-text').fill('name,type\nbranch,text\nvisits,integer\n');
  await page.getByTestId('if-apply').click();
  expect((await fields(page)).map((f: any) => f.key)).toEqual(['branch', 'visits']);
  await page.evaluate(() => (window as any).__iss.store.getState().undo());
  expect(await fields(page)).toEqual([]);
});

test('IF03 refused on a card statement, with the reason', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await page.getByTestId('open-data-fields').click();
  await page.getByTestId('df-tab-custom').click();
  await expect(page.getByTestId('df-import')).toHaveCount(0);
  await expect(page.getByTestId('df-import-refused')).toContainText('its data fields are the studio’s built-in ones');
  await expect(page.getByTestId('df-import-refused')).toContainText('“Your own data”');
});
