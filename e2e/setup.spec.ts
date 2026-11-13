/**
 * Browser tests for "Describe your document" (New project). The test servers run WITHOUT a live AI model on purpose, so
 * the model path is only SIMULATED here: the draft route is fulfilled with a proposal marked `source: 'ai'` (built by
 * the real route from a hand-written setup) and the AI status is faked, so the screen believes a model is configured.
 * The CREATE call is never intercepted: documents are really created, checked and deleted again.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API } from './helpers';

const created: string[] = [];
test.beforeEach(() => { created.length = 0; });
test.afterEach(async ({ request }) => { for (const id of created) await request.delete(`${API}/projects/${id}`); });

const MEMBERS = [
  { firstName: 'Dana', lastName: 'Novak', planName: 'Flex', monthlyFee: 49, renewalDate: '2026-12-01', paymentStatus: 'paid', renewsAutomatically: true, visitsThisMonth: 14, fees: [{ description: 'Membership', chargedOn: '2026-11-01', amount: 49, quantity: 1 }, { description: 'Towels', chargedOn: '2026-11-03', amount: 5.5, quantity: 2 }] },
  { firstName: 'Eli', lastName: 'Marsh', planName: 'Max', monthlyFee: 120, renewalDate: '2026-12-15', paymentStatus: 'failed', renewsAutomatically: false, visitsThisMonth: 1, fees: [] },
];
const MEMBERS_JSON = JSON.stringify(MEMBERS);

/** A setup as a model would write it: a message with a condition and a fallback, a table, a notice and the email and text wording. */
const AI_SPEC = {
  title: 'Gym renewal', issuerName: 'Northside Gym', summary: 'A membership renewal notice.',
  fields: [
    { label: 'Plan name', type: 'text', example: 'Flex', required: true },
    { label: 'Monthly fee', type: 'amount', example: '49.00' },
    { label: 'Renewal date', type: 'date', example: '2026-12-01' },
    { label: 'Payment status', type: 'choice', choices: ['paid', 'failed'] },
    { label: 'Fees', type: 'list', columns: [{ label: 'Description', type: 'text' }, { label: 'Charged on', type: 'date' }, { label: 'Amount', type: 'amount' }] },
  ],
  sections: [
    { type: 'heading', text: 'Your membership renewal' },
    { type: 'paragraph', text: 'Hello {First name} {Last name}, your {Plan name} plan renews on {Renewal date}.' },
    { type: 'keyFigures', fields: ['Plan name', 'Monthly fee', 'Renewal date'] },
    { type: 'table', list: 'Fees', columns: ['Description', 'Charged on', 'Amount'], totalColumn: 'Amount' },
    { type: 'messages', name: 'Payment guidance', versions: [
      { title: 'Payment failed', text: 'Your last payment failed. Please update your payment details before {Renewal date}.', when: { field: 'Payment status', test: 'is', value: 'failed' } },
      { title: 'All good', text: 'Thank you for staying with us.', fallback: true },
    ] },
    { type: 'notice', text: 'Cancel any time from your account page.' },
  ],
  email: { subject: 'Your membership renews on {Renewal date}', intro: 'Hello {First name}, your renewal notice is ready.' },
  sms: 'Hello {First name}, your renewal notice is ready: {Link}',
};

const idFromUrl = (page: Page) => new URL(page.url()).pathname.split('/')[2];

async function openFlow(page: Page) {
  await page.goto('/projects');
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('setup-entry')).toContainText('Say what it is for and what it shows; the assistant proposes the fields, layout, messages and rules for you to approve');
  await page.getByTestId('setup-open').click();
  await expect(page.getByTestId('setup-step-describe')).toBeVisible();
}
async function pasteData(page: Page, text: string) {
  await page.getByText('Paste data instead').click();
  await page.getByTestId('setup-data-text').fill(text);
}
/** Draft from data alone and wait for the review. */
async function draftFromData(page: Page, title: string, data = MEMBERS_JSON) {
  await openFlow(page);
  await page.getByTestId('setup-title').fill(title);
  await pasteData(page, data);
  await page.getByTestId('setup-draft').click();
  await expect(page.getByTestId('setup-step-review')).toBeVisible();
}
async function createAndOpen(page: Page) {
  await page.getByTestId('setup-create').click();
  await page.waitForURL(/\/studio\/[^/]+\/overview/);
  created.push(idFromUrl(page));
  await page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready');
  return idFromUrl(page);
}
const store = <T,>(page: Page, fn: (s: any) => T) => page.evaluate((src) => (0, eval)(`(${src})`)((window as any).__iss.store.getState()), fn.toString());
const asUser = (page: Page, role: 'reviewer' | 'editor') => page.route('**/api/v1/session', (route) => route.fulfill({ json: {
  authEnabled: true, user: { id: 'u-x', name: 'Riley Reviewer', email: 'rev@example.test', role },
  permissions: role === 'reviewer' ? ['view', 'comment'] : ['view', 'comment', 'edit'], roles: [role], expiresAt: null,
} }));

/** What the real draft route answers for a setup, so the simulated proposal has the real shapes. */
async function realProposal(request: APIRequestContext, body: Record<string, unknown>) {
  const r = await request.post(`${API}/projects/setup/draft`, { data: body });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}

test('S01 no AI key: the flow opens, a description needs a key, data alone drafts a built-in proposal, and creating with my data opens the studio', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFlow(page);
  const needs = page.getByTestId('setup-step-describe').getByTestId('assist-needs-ai');
  await expect(needs).toBeVisible();
  await expect(needs).toContainText('A description needs an AI key');
  await expect(page.getByTestId('setup-privacy')).toContainText('never the rows');

  // a name and a description alone are not enough without a key
  await page.getByTestId('setup-title').fill('Gym renewal S01');
  await page.getByTestId('setup-example-renewal').click();
  await expect(page.getByTestId('setup-description')).toHaveValue(/membership renewal notice/i);
  await expect(page.getByTestId('setup-description-count')).toContainText(/\d+ \/ 2,000/);
  await expect(page.getByTestId('setup-draft')).toBeDisabled();

  // two customers of data enable it
  await pasteData(page, MEMBERS_JSON);
  await expect(page.getByTestId('setup-data-summary')).toContainText('2 rows');
  await expect(page.getByTestId('setup-draft')).toBeEnabled();
  await page.getByTestId('setup-draft').click();

  const review = page.getByTestId('setup-step-review');
  await expect(review).toBeVisible();
  await expect(review.getByTestId('assist-source')).toHaveAttribute('data-source', 'builtin');
  await expect(review.getByTestId('assist-source')).toHaveText('Built-in');
  await expect(review).toContainText('Nothing is created until you choose Create');
  const fields = page.getByTestId('setup-fields');
  await expect(fields.getByTestId('setup-field')).toHaveCount(7);
  await expect(fields.locator('[data-label="Monthly fee"]')).toContainText('Amount');
  await expect(fields.locator('[data-label="Fees"]')).toContainText('List');
  await expect(page.getByTestId('setup-sections').locator('[data-kind="Table"]')).toHaveCount(1);
  // the description was not used, and the notes say so
  await expect(page.getByTestId('setup-notes')).toContainText('No AI key is configured, so your description was not used');
  await expect(page.getByTestId('setup-matching')).toContainText('Plan name');
  await expect(page.getByTestId('setup-customers')).toContainText('Generate test customers for me');
  await expect(page.getByTestId('setup-customers-supplied')).toBeChecked();
  await expect(page.getByTestId('setup-customers')).toContainText('Use my data (2 of 2 rows fit)');
  await expect(page.getByTestId('setup-preview')).toContainText('Dana Novak');
  await expect(page.getByTestId('setup-thumb')).toBeVisible();

  const id = await createAndOpen(page);
  expect(id).toBe('gym-renewal-s01');
  // the customer picker lists the supplied customers
  await page.getByTestId('record-selector').click();
  await expect(page.getByTestId('record-supplied-chip')).toHaveCount(2);
  await page.getByTestId('record-search').fill('Eli');
  await expect(page.locator('[data-testid^="record-option-"]').first()).toContainText('Eli Marsh');
  await page.keyboard.press('Escape');
  // the gallery card says "Your own data"
  await page.goto('/projects');
  await expect(page.getByTestId(`project-card-${id}`)).toContainText('Your own data');
  expect(errors).toEqual([]);
});

test('S02 editing: remove a field and a section, rename the heading, check the changes, then create with generated customers', async ({ page }) => {
  await draftFromData(page, 'Gym edit S02');
  const create = page.getByTestId('setup-create');
  await expect(create).toBeEnabled();
  await expect(page.getByTestId('setup-recheck')).toHaveCount(0);
  const fieldsBefore = await page.getByTestId('setup-field').count();
  const sectionsBefore = await page.getByTestId('setup-section').count();

  await page.locator('[data-testid="setup-field"][data-label="Visits this month"]').getByTestId('setup-field-remove').click();
  await page.getByTestId('setup-section').filter({ hasText: 'Paragraph' }).getByTestId('setup-section-remove').click();
  await page.getByTestId('setup-section').first().getByTestId('setup-section-text').fill('Your renewal, edited');
  await expect(page.getByTestId('setup-changed')).toBeVisible();
  await expect(create).toBeDisabled();

  // rename a field with Enter: the places that use it follow
  const label = page.locator('[data-testid="setup-field"][data-label="Plan name"]').getByTestId('setup-field-label');
  await label.fill('Membership plan');
  await label.press('Enter');
  await expect(page.locator('[data-testid="setup-field"][data-label="Membership plan"]')).toHaveCount(1);

  await page.getByTestId('setup-recheck').click();
  await expect(page.getByTestId('setup-changed')).toHaveCount(0);
  await expect(page.getByTestId('setup-message')).toContainText('Your changes were checked');
  await expect(page.getByTestId('setup-field')).toHaveCount(fieldsBefore - 1);
  await expect(page.locator('[data-testid="setup-field"][data-label="Visits this month"]')).toHaveCount(0);
  await expect(page.getByTestId('setup-section')).toHaveCount(sectionsBefore - 1);
  await expect(page.getByTestId('setup-section').first().getByTestId('setup-section-text')).toHaveValue('Your renewal, edited');
  await expect(page.getByTestId('setup-sections')).toContainText('Membership plan');
  await expect(create).toBeEnabled();

  await page.getByTestId('setup-customers-generate').check();
  const id = await createAndOpen(page);
  expect(id).toBe('gym-edit-s02');
  const st = await store(page, (s) => ({ title: s.project.title, fields: (s.project.customFields ?? []).map((f: any) => f.label), supplied: s.records.filter((r: any) => r.supplied || r.imported).length, count: s.records.length }));
  expect(st.title).toBe('Gym edit S02');
  expect(st.fields).not.toContain('Visits this month');
  expect(st.fields).toContain('Membership plan');
  expect(st.count).toBeGreaterThanOrEqual(1);
  await page.getByTestId('record-selector').click();
  await expect(page.getByTestId('record-generated-chip').first()).toBeVisible();
  await expect(page.getByTestId('record-supplied-chip')).toHaveCount(0);
});

test('S03 a live-model proposal (simulated): AI suggestion, message versions with "shown when", notes; Back keeps the description; creating is real', async ({ page, request }) => {
  const proposal = await realProposal(request, { title: 'Gym AI S03', spec: AI_SPEC, source: 'ai', sampleData: { format: 'json', data: MEMBERS_JSON } });
  proposal.source = 'ai';
  proposal.message = 'Drafted by an AI model from your description. Read every part before you create the document.';
  proposal.providerStatus = 'Simulated AI model';
  proposal.notes = ['The description did not say what a failed payment should lead to, so the message asks the member to update their payment details.', 'No cancellation fee was mentioned, so none is shown.', 'A choice “Payment status” was added with the values paid and failed.'];
  let draftBody: any = null;
  await page.route('**/api/v1/assistant/status', (route) => route.fulfill({ json: { mode: 'external', label: 'Simulated AI model', model: 'simulated' } }));
  await page.route('**/api/v1/projects/setup/draft', async (route) => { draftBody = route.request().postDataJSON(); await route.fulfill({ json: proposal }); });

  await openFlow(page);
  // the model is on: no needs-AI note, and a description alone is enough
  await expect(page.getByTestId('setup-step-describe').getByTestId('assist-needs-ai')).toHaveCount(0);
  await page.getByTestId('setup-title').fill('Gym AI S03');
  await page.getByTestId('setup-issuer').fill('Northside Gym');
  const text = 'A renewal notice for gym members that shows the plan, the fee and the date, with a table of the fees charged. Members whose payment failed are asked to update their payment details.';
  await page.getByTestId('setup-description').fill(text);
  await expect(page.getByTestId('setup-draft')).toBeEnabled();
  await page.getByTestId('setup-draft').click();

  const review = page.getByTestId('setup-step-review');
  await expect(review).toBeVisible();
  expect(draftBody.description).toBe(text);
  expect(draftBody.title).toBe('Gym AI S03');
  expect(draftBody.issuerName).toBe('Northside Gym');
  await expect(review.getByTestId('assist-source')).toHaveAttribute('data-source', 'ai');
  await expect(review.getByTestId('assist-source')).toHaveText('AI suggestion');
  await expect(page.getByTestId('setup-message')).toContainText('Drafted by an AI model');
  await expect(page.getByTestId('setup-version')).toHaveCount(2);
  await expect(page.getByTestId('setup-version-when').first()).toContainText('Shown when payment status is “failed”');
  await expect(page.getByTestId('setup-version-when').nth(1)).toContainText('Shown when no other version applies');
  await expect(page.getByTestId('setup-notes')).toContainText('No cancellation fee was mentioned');
  await expect(page.getByTestId('setup-channels')).toContainText('edit it in the studio after');
  await expect(page.getByTestId('setup-preview')).toContainText('Payment guidance');

  // Back keeps what was typed; the proposal can be returned to
  await page.getByTestId('setup-back').click();
  await expect(page.getByTestId('setup-step-describe')).toBeVisible();
  await expect(page.getByTestId('setup-description')).toHaveValue(text);
  await expect(page.getByTestId('setup-title')).toHaveValue('Gym AI S03');
  await page.getByTestId('setup-to-review').click();
  await expect(page.getByTestId('setup-step-review')).toBeVisible();

  // generated customers; the create call is not intercepted
  await page.getByTestId('setup-customers-generate').check();
  const id = await createAndOpen(page);
  expect(id).toBe('gym-ai-s03');
  const st = await store(page, (s) => ({ title: s.project.title, issuer: s.project.issuer.name, nodes: s.project.nodes.length }));
  expect(st).toMatchObject({ title: 'Gym AI S03', issuer: 'Northside Gym' });
  const act = await (await request.get(`${API}/audit?projectId=${id}`)).text();
  expect(act).toContain('project.create');
});

test('S04 a description with no AI key: unavailable is a normal state, nothing is created', async ({ page, request }) => {
  const before = (await (await request.get(`${API}/projects`)).json()).projects.length;
  // The status call says a model is on (so the Draft button is enabled); the real server has none and answers `unavailable`.
  await page.route('**/api/v1/assistant/status', (route) => route.fulfill({ json: { mode: 'external', label: 'Simulated AI model' } }));
  await openFlow(page);
  await page.getByTestId('setup-title').fill('Unavailable S04');
  await page.getByTestId('setup-description').fill('A utility bill with the amount due and a table of meter readings.');
  await page.getByTestId('setup-draft').click();
  const box = page.getByTestId('setup-unavailable');
  await expect(box).toBeVisible();
  await expect(box).toContainText('AI key');
  await expect(box).toContainText('nothing was created');
  await expect(page.getByTestId('setup-step-review')).toHaveCount(0);
  await expect(page.getByTestId('setup-step-describe')).toBeVisible();
  await expect(page.getByTestId('setup-description')).toHaveValue(/utility bill/);
  const after = (await (await request.get(`${API}/projects`)).json()).projects.length;
  expect(after).toBe(before);
});

test('S05 without the right to edit the entry point is disabled with the reason', async ({ page }) => {
  await asUser(page, 'reviewer');
  await page.goto('/projects');
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('setup-open')).toBeDisabled();
  await expect(page.getByTestId('setup-open')).toHaveAttribute('title', /Reviewers can comment but not edit/);
  await expect(page.getByTestId('setup-open-why')).toContainText('Reviewers can comment but not edit');
});

test('S06 rejected rows: the review says 1 of 2 rows fit, with the reason, and creating with my data stores one customer', async ({ page, request }) => {
  // The built-in reader types a column by what every row holds, so a bad date makes the column text. A model's setup
  // (here: a date field) is checked against the same file by the real route, which is what rejects the row.
  const csv = 'First name,Last name,Plan name,Renewal date\nAna,Silva,Flex,2026-12-01\nBen,Okoro,Max,15/12/2026\n';
  const spec = { title: 'Gym rows S06', issuerName: 'Northside Gym', summary: 'A renewal notice.', fields: [{ label: 'Plan name', type: 'text' }, { label: 'Renewal date', type: 'date' }], sections: [{ type: 'heading', text: 'Your renewal' }, { type: 'keyFigures', fields: ['Plan name', 'Renewal date'] }] };
  const proposal = await realProposal(request, { title: 'Gym rows S06', spec, source: 'builtin', sampleData: { format: 'csv', data: csv } });
  expect(proposal.customers.supplied).toMatchObject({ total: 2, accepted: 1, rejectedCount: 1 });
  await page.route('**/api/v1/projects/setup/draft', (route) => route.fulfill({ json: proposal }));

  await openFlow(page);
  await page.getByTestId('setup-title').fill('Gym rows S06');
  await page.getByTestId('setup-data-file').setInputFiles({ name: 'members.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByTestId('setup-data-summary')).toContainText('members.csv');
  await expect(page.getByTestId('setup-data-summary')).toContainText('2 rows');
  await page.getByTestId('setup-draft').click();
  await expect(page.getByTestId('setup-step-review')).toBeVisible();
  await expect(page.getByTestId('setup-customers')).toContainText('Use my data (1 of 2 rows fit)');
  const rej = page.getByTestId('setup-rejected');
  await expect(rej).toContainText('1 row does not fit');
  await expect(rej).toContainText('Row 2');
  await expect(rej).toContainText(/Renewal date/);
  await expect(page.getByTestId('setup-matching')).toContainText('Renewal date');

  await page.getByTestId('setup-customers-supplied').check();
  const id = await createAndOpen(page);
  const mine = await (await request.get(`${API}/records?documentType=custom&projectId=${id}&full=1`)).json();
  expect((mine.records as any[]).filter((r) => r.supplied || r.imported || !r.generated)).toHaveLength(1);
  await page.getByTestId('record-selector').click();
  await expect(page.getByTestId('record-supplied-chip')).toHaveCount(1);
});

test('S07 closing with unsaved work asks first; an empty flow closes at once', async ({ page }) => {
  await openFlow(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('setup-dialog')).toHaveCount(0);
  await openFlow(page);
  await page.getByTestId('setup-title').fill('Something');
  await page.getByTestId('setup-cancel').click();
  await expect(page.getByTestId('setup-discard-confirm')).toBeVisible();
  await page.getByTestId('setup-keep').click();
  await expect(page.getByTestId('setup-title')).toHaveValue('Something');
  await page.getByTestId('setup-cancel').click();
  await page.getByTestId('setup-discard').click();
  await expect(page.getByTestId('setup-dialog')).toHaveCount(0);
});
