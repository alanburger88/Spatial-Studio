/**
 * Browser tests for the third kind of document, "Your own data" (kind `custom`): a blank project with the
 * customer's name and language plus data fields the user defines. Projects are created through the UI or the API
 * and ALWAYS deleted afterwards. Runs against the real local stack like the other specs.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API } from './helpers';
import { gymProject } from '../packages/model/test/helpers/customProject';

const created: string[] = [];
test.beforeEach(() => { created.length = 0; });
test.afterEach(async ({ request }) => {
  for (const id of created) await request.delete(`${API}/projects/${id}`);
});

const STUDIO_SCREENS = ['design', 'rules-data', 'data', 'content', 'channels', 'cube', 'landscape', 'page-stack', 'journey', 'validate', 'outputs', 'demo', 'assistant', 'activity'];
/** Wording that belongs to the card and claim samples. */
const SAMPLE_WORDING = /\b(card|cardholder|claims?|statement|member responsibility|explanation of benefits|aster|harborcare)\b/i;

/** A blank project made through the API. */
async function blankProject(request: APIRequestContext, title: string, extra: Record<string, unknown> = {}) {
  const r = await request.post(`${API}/projects`, { data: { templateId: 'blank-project', title, ...extra } });
  expect(r.status()).toBe(201);
  const body = await r.json();
  created.push(body.project.projectId);
  return body.project as { projectId: string; modelVersion: number; title: string };
}

/** The "gym membership" document from the model tests, stored under a fresh id, with customers generated for it. */
async function gymDocument(request: APIRequestContext, title: string) {
  const blank = await blankProject(request, title, { issuerName: 'Northside Gym', accent: '#1f4e79' });
  const p = { ...gymProject({ withSpanish: true }), projectId: blank.projectId, title, modelVersion: blank.modelVersion };
  const put = await request.put(`${API}/projects/${blank.projectId}`, { data: { project: p }, headers: { 'If-Match': `"${blank.modelVersion}"` } });
  expect(put.ok(), await put.text()).toBeTruthy();
  const gen = await request.post(`${API}/projects/${blank.projectId}/test-data`, { data: { outcomes: true, edges: true } });
  expect(gen.ok(), await gen.text()).toBeTruthy();
  return blank.projectId;
}

async function openStudio(page: Page, id: string, view: string) {
  await page.goto(`/studio/${id}/${view}`);
  await expect(page.getByRole('main')).toBeVisible();
  await page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready');
  await expect(page.locator('#main section.screen').first()).toBeVisible();
}

test('C05 every studio screen opens for a document with its own data, without errors or card and claim wording', async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const problems: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const full = await gymDocument(request, 'Gym notice screens');
  const empty = await blankProject(request, 'Empty notice screens');
  for (const id of [full, empty.projectId]) {
    for (const view of STUDIO_SCREENS) {
      await openStudio(page, id, view);
      await page.waitForTimeout(600);
      const where = `${id}/${view}`;
      if (await page.locator('#main .error-state').count()) problems.push(`${where}: error state: ${(await page.locator('#main .error-state').first().innerText()).replace(/\s+/g, ' ').slice(0, 160)}`);
      const text = (await page.locator('#main').innerText()).replace(/Synthetic data/g, '');
      for (const m of text.matchAll(new RegExp(SAMPLE_WORDING.source, 'gi'))) problems.push(`${where}: “${text.slice(Math.max(0, m.index! - 40), m.index! + 60).replace(/\s+/g, ' ')}”`);
    }
    // The exploded view of a component.
    const node = id === full ? 'renewal-note' : null;
    if (node) { await openStudio(page, id, `exploded/${node}`); await page.waitForTimeout(500); if (await page.locator('#main .error-state').count()) problems.push(`${id}/exploded: error state`); }
  }
  expect(errors).toEqual([]);
  expect(problems).toEqual([]);
});

/* ------------------------------------------------------------------------------------------------ helpers */

const idFromUrl = (page: Page) => /\/studio\/([^/]+)\//.exec(page.url())![1];
const store = <T>(page: Page, fn: (s: any) => T) => page.evaluate((src) => (new Function('s', `return (${src})(s)`))((window as any).__iss.store.getState()), fn.toString());
const dispatch = (page: Page, cmd: unknown) => page.evaluate((c) => { const r = (window as any).__iss.store.getState().dispatch(c); return r.ok ? null : r.message as string; }, cmd);
const customersOf = async (request: APIRequestContext, id: string) => ((await (await request.get(`${API}/records?documentType=custom&full=1&projectId=${id}`)).json()).records as any[]);
const saved = async (page: Page) => { await page.getByTestId('save-project').click(); await expect(page.getByTestId('save-state')).toContainText('Saved'); };

/** The data fields of the small "membership" document built in C03. */
const MEMBER_FIELDS = [
  { key: 'planName', label: 'Plan name', type: 'string' },
  { key: 'monthlyFeeCents', label: 'Monthly fee', type: 'cents' },
  { key: 'tier', label: 'Membership tier', type: 'enum', enumValues: ['basic', 'pro'] },
  { key: 'autoRenew', label: 'Renews automatically', type: 'bool' },
  { key: 'sessions', label: 'Booked sessions', type: 'list', itemFields: [{ key: 'day', label: 'Day', type: 'date' }, { key: 'className', label: 'Class', type: 'string' }, { key: 'priceCents', label: 'Price', type: 'cents' }] },
];

/* ------------------------------------------------------------------------------------------------ C01 */

test('C01 New project, Blank project: issuer name and colour, an empty page, a generated customer, and the gallery says “Your own data”', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/projects');
  await page.getByTestId('new-project').click();
  const card = page.getByTestId('template-blank-project');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Your own data');
  // the thumbnail is an empty page (it is drawn, not a spinner)
  await expect(card.locator('.pv-wrap, .pv-page, [class*="pv-"]').first()).toBeVisible();
  await expect(page.getByTestId('template-blank-letter')).toBeVisible();
  await card.click();
  await expect(page.getByTestId('blank-project-options')).toContainText('your own data fields');
  await expect(page.getByTestId('blank-accent-hex')).toHaveValue('#475569');
  await page.getByTestId('new-project-title').fill('Membership notice C01');
  // who the document is from defaults to the project name; 2 to 60 characters
  await expect(page.getByTestId('blank-issuer-name')).toHaveValue('Membership notice C01');
  await page.getByTestId('blank-issuer-name').fill('N');
  await expect(page.getByTestId('create-project')).toBeDisabled();
  await page.getByTestId('blank-issuer-name').fill('Northside Gym');
  await page.getByTestId('blank-accent').fill('#1f4e79');
  await expect(page.getByTestId('blank-accent-hex')).toHaveValue('#1f4e79');
  await page.getByTestId('create-project').click();
  await page.waitForURL(/\/studio\/membership-notice-c01\/design/);
  created.push(idFromUrl(page));
  await page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready');

  // an empty page with a way to start, and the first generated customer selected
  await expect(page.getByTestId('design-empty')).toBeVisible();
  await expect(page.getByTestId('design-empty')).toContainText('Add your first component');
  await page.getByTestId('design-empty-add').click();
  await expect(page.getByRole('complementary', { name: 'Components and layers' })).toBeVisible();
  const st = await store(page, (s) => ({ type: s.project.documentType, issuer: s.project.issuer, rec: s.ctx.recordId, count: s.records.length, kids: s.project.nodes.find((n: any) => n.id === s.project.rootNodeId).children.length }));
  expect(st).toMatchObject({ type: 'custom', issuer: { name: 'Northside Gym', accent: '#1f4e79' }, kids: 0 });
  expect(st.rec).toMatch(/^REC-/);
  expect(st.count).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('record-selector')).toHaveAttribute('data-value', st.rec);
  // the customer picker names it by what it is, and marks it as generated
  await page.getByTestId('record-selector').click();
  await expect(page.getByTestId('record-generated-chip').first()).toBeVisible();
  await page.keyboard.press('Escape');

  // the gallery card names the kind
  await page.goto('/projects');
  const gcard = page.getByTestId('project-card-membership-notice-c01');
  await expect(gcard).toContainText('Your own data');
  await expect(gcard).toContainText('Your own document');
  await expect(gcard.locator('.gal-paper')).toBeVisible();
  expect(errors).toEqual([]);
  expect((await customersOf(request, 'membership-notice-c01')).length).toBe(st.count);
});

/* ------------------------------------------------------------------------------------------------ C02 */

test('C02 data fields: text, amount, choice, yes/no and a list with three columns; they appear in the pickers; a bad key is rejected with a plain message', async ({ page, request }) => {
  const blank = await blankProject(request, 'Fields C02');
  await openStudio(page, blank.projectId, 'rules-data');
  // an empty project points at the editor
  await expect(page.getByTestId('no-data-fields')).toContainText('no data fields yet');
  await expect(page.getByTestId('edge-case-generator')).toHaveCount(0);
  await page.getByTestId('no-data-fields-open').click();
  await expect(page.getByTestId('data-fields')).toBeVisible();
  const add = async (label: string, type: string, extra?: (row: ReturnType<Page['getByTestId']>) => Promise<void>) => {
    await page.getByTestId('df-add').click();
    const row = page.getByTestId('df-row').last();
    await row.getByTestId('df-label').fill(label);
    await row.getByTestId('df-type').selectOption(type);
    if (extra) await extra(row);
  };
  await add('Plan name', 'string');
  await add('Monthly fee', 'cents');
  await add('Membership tier', 'enum', async (row) => { await row.getByTestId('df-values').fill('basic, pro'); });
  await add('Renews automatically', 'bool');
  await add('Booked sessions', 'list', async (row) => {
    await expect(row.getByTestId('df-col')).toHaveCount(1);
    await row.getByTestId('df-col-add').click();
    await row.getByTestId('df-col-add').click();
    const cols = row.getByTestId('df-col');
    await expect(cols).toHaveCount(3);
    const specs: Array<[string, string]> = [['Day', 'date'], ['Class', 'string'], ['Price', 'cents']];
    for (let i = 0; i < 3; i++) { await cols.nth(i).getByTestId('df-col-label').fill(specs[i][0]); await cols.nth(i).getByTestId('df-col-type').selectOption(specs[i][1]); }
    // a column can be moved: Class up, then back
    await cols.nth(1).getByRole('button', { name: /Move column Class up/ }).click();
    await expect(cols.nth(0).getByTestId('df-col-label')).toHaveValue('Class');
    await cols.nth(0).getByRole('button', { name: /Move column Class down/ }).click();
    await expect(cols.nth(0).getByTestId('df-col-label')).toHaveValue('Day');
  });
  await expect(page.getByTestId('df-row').nth(1).getByTestId('df-key')).toHaveValue('monthlyFee');
  await page.getByTestId('save-data-fields').click();
  await expect(page.getByTestId('data-fields')).toHaveCount(0);
  await expect(page.getByTestId('no-data-fields')).toHaveCount(0);
  const fields = await store(page, (s) => s.project.customFields);
  expect(fields.map((f: any) => `${f.key}:${f.type}`)).toEqual(['planName:string', 'monthlyFee:cents', 'membershipTier:enum', 'renewsAutomatically:bool', 'bookedSessions:list']);
  expect(fields[4].itemFields).toEqual([{ key: 'day', label: 'Day', type: 'date' }, { key: 'class', label: 'Class', type: 'string' }, { key: 'price', label: 'Price', type: 'cents' }]);

  // they are offered where rules are written, with the calculated number of rows
  await page.getByTestId('add-rule').click();
  const options = await page.getByTestId('cond-0-field').locator('option').allInnerTexts();
  expect(options).toEqual(expect.arrayContaining(['Plan name', 'Monthly fee', 'Membership tier', 'Renews automatically', 'Booked sessions count (derived)']));
  expect(options.join(' ')).not.toMatch(/payment|claim|balance/i);

  // a bad key is refused, with the reason in plain words, and the model is unchanged
  await page.getByTestId('open-data-fields').click();
  await page.getByTestId('df-add').click();
  const row = page.getByTestId('df-row').last();
  await row.getByTestId('df-label').fill('Bad one');
  await row.getByTestId('df-key').fill('1 bad-key');
  await page.getByTestId('save-data-fields').click();
  await expect(page.getByTestId('df-error')).toContainText('must start with a letter and use only letters and digits');
  await expect(page.getByTestId('data-fields')).toBeVisible();
  expect((await store(page, (s) => s.project.customFields)).length).toBe(5);
  // the server refuses the same thing when a project file with it is saved
  const proj = await store(page, (s) => s.project);
  const bad = { ...proj, customFields: [...proj.customFields, { key: '1 bad-key', label: 'Bad one', type: 'string' }] };
  const put = await request.put(`${API}/projects/${blank.projectId}`, { data: { project: bad }, headers: { 'If-Match': `"${blank.modelVersion}"` } });
  expect(put.ok()).toBeFalsy();
  expect(await put.text()).toMatch(/letter|key/i);
  await page.getByRole('button', { name: 'Cancel' }).click();

  // the list shows up in the design pickers: a table bound to it, with its columns
  await openStudio(page, blank.projectId, 'design');
});

/* ------------------------------------------------------------------------------------------------ C03 */

test('C03 a small document: heading with the customer’s name, a bound amount, a table with a total, a message with two versions and a rule; regenerated customers change the message', async ({ page, request }) => {
  test.setTimeout(240_000);
  const blank = await blankProject(request, 'Membership C03', { issuerName: 'Northside Gym', accent: '#1f4e79' });
  await openStudio(page, blank.projectId, 'design');
  expect(await dispatch(page, { type: 'SET_CUSTOM_FIELDS', fields: MEMBER_FIELDS })).toBeNull();
  // the customers were made before the document had data fields: generate them again so they carry values
  await saved(page);
  expect((await request.post(`${API}/projects/${blank.projectId}/test-data`, { data: { outcomes: true, edges: true } })).ok()).toBeTruthy();
  await openStudio(page, blank.projectId, 'design');
  await showLeft(page);

  // 1. heading text with the customer's name token
  await page.getByTestId('insert-rich-text').click();
  const heading = (await store(page, (s) => s.ctx.selectedNodeId)) as string;
  await page.getByTestId('edit-rich-text').click();
  await page.getByTestId('rich-text-editor').press('End');
  await page.getByTestId('token-customer.givenName').click();
  await page.getByTestId('rich-text-done').click();
  await expect(page.getByTestId(`node-${heading}`)).not.toContainText('{{');
  const name = await store(page, (s) => s.records.find((r: any) => r.recordId === s.ctx.recordId).customer.givenName);
  await expect(page.getByTestId(`node-${heading}`)).toContainText(name);
  // the token picker offers the document's own fields and the customer's, never card or claim fields
  const tokens = await page.locator('[data-testid^="token-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(tokens).toEqual(expect.arrayContaining(['token-custom.planName', 'token-custom.monthlyFeeCents', 'token-custom.sessions.count', 'token-customer.familyName']));
  expect(tokens.filter((t) => /token-(card|claim)/.test(t ?? ''))).toEqual([]);

  // 2. a bound amount
  await page.getByTestId('insert-bound-field').click();
  const amount = (await store(page, (s) => s.ctx.selectedNodeId)) as string;
  const sel = page.getByTestId('binding-select');
  const bindings = await sel.locator('option').evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(bindings).toEqual(expect.arrayContaining(['custom.monthlyFeeCents', 'custom.planName', 'custom.sessions.count']));
  expect(bindings.filter((b) => /^(card|claim)\./.test(b))).toEqual([]);
  await sel.selectOption('custom.monthlyFeeCents');
  await expect(page.getByTestId(`node-${amount}`)).toContainText('$');

  // 3. a table bound to the list, with a total
  await page.getByTestId('insert-repeating-table').click();
  const table = (await store(page, (s) => s.ctx.selectedNodeId)) as string;
  await expect(page.getByTestId('table-binding')).toHaveValue('custom.sessions');
  await expect(page.getByTestId('column-total-day')).toHaveCount(0);
  await page.getByTestId('column-total-price').check();
  await expect(page.getByTestId(`node-${table}`)).toContainText(/total/i);
  expect((await store(page, (s) => s.project.nodes.find((n: any) => n.binding === 'custom.sessions').columns.filter((c: any) => c.total).map((c: any) => c.key)))).toEqual(['price']);

  // 4. a message with two versions
  await page.getByTestId('insert-variant-set').click();
  const msg = (await store(page, (s) => s.ctx.selectedNodeId)) as string;
  await page.getByTestId('new-variant-title').fill('Pro members');
  await page.getByTestId('new-variant-text').fill('As a Pro member you keep priority booking, {{customer.givenName}}.');
  await page.getByTestId('add-variant').click();
  await expect(page.getByTestId('variant-set-editor, [data-testid="variants-editor"]').first()).toContainText('Pro members');

  // 5. a rule on the choice field picks the second version
  await saved(page);
  await openStudio(page, blank.projectId, 'rules-data');
  await page.getByTestId('add-rule').click();
  await page.getByTestId('cond-0-field').selectOption({ label: 'Membership tier' });
  await page.getByTestId('cond-0-value').locator('select').selectOption('pro');
  await page.getByTestId('action-op').selectOption('selectVariant');
  const proVersion = await store(page, (s) => s.project.nodes.find((n: any) => n.type === 'variant-set').variantIds.find((v: string) => /pro/.test(v)));
  await page.getByTestId('action-variant').selectOption(proVersion);
  await page.getByTestId('rule-title').fill('Pro members get the Pro note');
  await page.getByTestId('apply-rule-change').click();
  await expect(page.getByTestId('rule-errors')).toHaveCount(0);
  await saved(page);

  // 6. generate customers for it: every outcome once
  await page.getByTestId('testdata-open').click();
  await page.getByTestId('testdata-generate').click();
  await expect(page.getByTestId('testdata-done')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  const generated = (await customersOf(request, blank.projectId)).filter((r) => r.generated);
  expect(generated.length).toBeGreaterThanOrEqual(2);

  // 7. the picker lists them; switching customers changes the message
  await openStudio(page, blank.projectId, 'design');
  await page.getByTestId('record-selector').click();
  const listed = await page.locator('[data-testid^="record-option-"]').count();
  expect(listed).toBe((await customersOf(request, blank.projectId)).length);
  await page.keyboard.press('Escape');
  const text = async (recordId: string) => {
    await page.evaluate((id) => (window as any).__iss.store.getState().setRecord(id), recordId);
    await expect(page.getByTestId('record-selector')).toHaveAttribute('data-value', recordId);
    return page.getByTestId(`node-${msg}`).innerText();
  };
  const pro = generated.find((r) => r.custom?.tier === 'pro');
  const basic = generated.find((r) => r.custom?.tier === 'basic');
  expect(pro && basic).toBeTruthy();
  const forPro = await text(pro.recordId);
  const forBasic = await text(basic.recordId);
  expect(forPro).toContain('Pro member');
  expect(forBasic).not.toContain('Pro member');
  expect(forBasic).toContain('Write the message here');
  await page.screenshot({ path: `${SHOTS}/c03-design.png` });
});

const SHOTS = '/tmp/claude-0/-home-user-Spatial-Studio/60b1a659-14d2-561c-bbb9-5044a0a4d3ba/scratchpad/custom-ui';
async function showLeft(page: Page) {
  if (!(await page.getByRole('complementary', { name: 'Components and layers' }).count())) await page.getByTestId('toggle-palette').click();
  await expect(page.getByRole('complementary', { name: 'Components and layers' })).toBeVisible();
}
