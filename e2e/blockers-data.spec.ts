import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, open, resetAll } from './helpers';

/** Blockers phase 2: a customer's data problem opens in Data Explorer on the fields, and an approver can set it aside for one customer. */

const P = 'aster-card-demo';
const DATA = 'inconsistent-payment-state~payment-guidance';
const SPANISH = 'required-translation-missing~billing-summary~es-US';
const IMPORTED = { givenName: 'Ottoline', familyName: 'Quillfeather' };

/** The card sample's own and imported customers removed, and both samples restored (which also clears their known data problems). */
async function clean(request: APIRequestContext) {
  const recs = (await (await request.get(`${API}/records?documentType=credit-statement&full=1&projectId=${P}`)).json()).records as any[];
  for (const r of recs.filter((x) => x.projectId)) await request.delete(`${API}/projects/${P}/records/${r.recordId}`);
  await request.delete(`${API}/records/imported?documentType=credit-statement`);
  await resetAll(request);
}
test.beforeEach(async ({ request }) => { await clean(request); });
test.afterEach(async ({ request }) => { await clean(request); });

/** An editable copy of a sample customer whose own data contradicts itself. */
async function badCopy(request: APIRequestContext, missed = 3) {
  const rec = (await (await request.post(`${API}/projects/${P}/records`, { data: { copyOf: 'CARD-0001' } })).json()).record;
  const put = await request.put(`${API}/projects/${P}/records/${rec.recordId}`, { data: { record: { ...rec, card: { ...rec.card, paymentStatus: 'current', missedPayments: missed } } } });
  expect(put.ok()).toBeTruthy();
  return rec.recordId as string;
}
/** A customer imported for every document (shared, so read-only in Data Explorer) whose data contradicts itself. */
async function badImported(request: APIRequestContext) {
  const { recordId: _id, ...row } = (await (await request.get(`${API}/records/CARD-0002`)).json()).record;
  const r = await request.post(`${API}/records/import`, { data: { documentType: 'credit-statement', format: 'json', data: [{ ...row, customer: { ...row.customer, ...IMPORTED }, card: { ...row.card, paymentStatus: 'current', missedPayments: 2 } }] } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).imported[0].recordId as string;
}
async function openBlocker(page: Page, id: string) {
  await open(page, P, `blockers?blocker=${encodeURIComponent(id)}`);
  await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', id, { timeout: 30_000 });
}
const n = async (page: Page, testId: string) => Number(await page.getByTestId(testId).textContent());
const params = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);

test('BD01 Open in Data Explorer opens the customer with the wrong values highlighted and scrolled to, a banner saying why and a link back', async ({ page, request }) => {
  const id = await badCopy(request);
  await openBlocker(page, DATA);
  await page.getByTestId('bl-open-data').click();
  await expect(page.getByTestId('dx-record')).toHaveAttribute('data-record', id);
  expect(params(page)).toEqual({ customer: id, blocker: DATA, highlight: 'card.paymentStatus,card.missedPayments' });
  const banner = page.getByTestId('dx-blocker-banner');
  await expect(banner).toContainText('The account is “up to date” but lists missed payments');
  await expect(banner).toContainText('The document is fine; this customer’s data is wrong.');
  await expect(page.getByTestId('dx-blocker-fields')).toContainText('Highlighted below:');
  const lit = page.locator('[data-highlight="yes"]');
  await expect(lit).toHaveCount(2);
  await expect(page.locator('[data-dx-field="card.missedPayments"]')).toHaveAttribute('data-highlight', 'yes');
  await expect(page.locator('[data-dx-field="card.paymentStatus"]')).toBeInViewport();
  // the customer is the document's own: correct the value and save; the banner says the problem has gone
  await expect(banner).toContainText('Correct the highlighted values and save.');
  await page.locator('[data-dx-path="card.missedPayments"]').fill('0');
  await expect(page.getByTestId('dx-blocker-fixed-draft')).toBeVisible();
  await page.getByTestId('dx-save').click();
  await expect(page.getByTestId('dx-blocker-gone')).toContainText('This problem no longer stops');
  await page.getByTestId('dx-blocker-back').click();
  await expect(page).toHaveURL(/\/blockers\?blocker=/);
  await expect(page.getByTestId(`bl-row-${DATA}`)).toHaveCount(0, { timeout: 30_000 });
});

test('BD02 a shared customer is read-only: make an editable copy (the highlight follows) or mark it as a known data problem', async ({ page, request }) => {
  const id = await badImported(request);
  await openBlocker(page, DATA);
  await page.getByTestId(`bl-customer-data-${id}`).click();
  await expect(page.getByTestId('dx-record')).toHaveAttribute('data-origin', 'imported');
  const banner = page.getByTestId('dx-blocker-banner');
  await expect(banner).toContainText('Shared customers cannot be changed here.');
  await expect(page.getByTestId('dx-blocker-copy')).toBeVisible();
  await expect(page.getByTestId('dx-blocker-known')).toBeVisible();
  await page.getByTestId('dx-blocker-copy').click();
  await expect(page.getByTestId('dx-record')).toHaveAttribute('data-origin', 'yours');
  expect(params(page)).toMatchObject({ blocker: DATA, highlight: 'card.paymentStatus,card.missedPayments' });
  expect(params(page).customer).not.toBe(id);
  await expect(page.locator('[data-highlight="yes"]')).toHaveCount(2);
  await expect(page.getByTestId('dx-blocker-banner')).toContainText('Correct the highlighted values and save.');

  // back on the imported customer: set it aside instead
  await page.goto(`/studio/${P}/data?customer=${id}&blocker=${encodeURIComponent(DATA)}`);
  await page.getByTestId('dx-blocker-known').click();
  const dialog = page.getByTestId('bl-known-dialog');
  await expect(dialog).toContainText('It applies to this customer and this problem only.');
  await expect(page.getByTestId('bl-known-save')).toBeDisabled();
  await page.getByTestId('bl-known-reason').fill('   ');
  await expect(page.getByTestId('bl-known-save')).toBeDisabled();
  await page.getByTestId('bl-known-reason').fill('The source system corrects this account next cycle');
  await page.getByTestId('bl-known-save').click();
  await expect(page.getByTestId('dx-blocker-known-status')).toContainText('Set aside as a known data problem by Local admin');
  await expect(page.getByTestId('dx-blocker-known-status')).toContainText('The source system corrects this account next cycle');
});

test('BD03 a known data problem sets one customer aside: counts, status, reason, who and when, the approval list, Activity, and Remove', async ({ page, request }) => {
  const id = await badImported(request);
  const own = await badCopy(request);
  await openBlocker(page, DATA);
  const stoppedBefore = await n(page, 'bl-stopped');
  const issuableBefore = await n(page, 'bl-issuable');
  await expect(page.getByTestId('bl-set-aside')).toHaveCount(0);
  await page.getByTestId(`bl-customer-known-${id}`).click();
  await page.getByTestId('bl-known-reason').fill('Agreed with operations: corrected at source in December');
  await page.getByTestId('bl-known-save').click();
  // one customer set aside, the other still stopped; the blocker stays open
  await expect(page.getByTestId('bl-set-aside')).toHaveText('1');
  await expect(page.getByTestId('bl-stopped')).toHaveText(String(stoppedBefore - 1));
  await expect(page.getByTestId('bl-issuable')).toHaveText(String(issuableBefore));
  const row = page.getByTestId(`bl-row-${DATA}`);
  await expect(row.getByTestId('bl-count')).toHaveText('1 customer stopped');
  await expect(row.getByTestId('bl-count-aside')).toHaveText('1 set aside');
  const entry = page.getByTestId(`bl-known-${id}`);
  await expect(entry).toContainText('Known data problem');
  await expect(entry).toContainText('Agreed with operations: corrected at source in December');
  await expect(entry).toContainText(`Set aside for ${IMPORTED.givenName} ${IMPORTED.familyName} by Local admin on`);
  // the other customer too: now every customer it stops is set aside, so its status is "Known data problem"
  await page.getByTestId(`bl-customer-known-${own}`).click();
  await page.getByTestId('bl-known-reason').fill('Test copy kept on purpose');
  await page.getByTestId('bl-known-save').click();
  await expect(row).toHaveAttribute('data-status', 'known-data-problem');
  await expect(row.getByTestId('bl-status')).toHaveText('Known data problem');
  await expect(page.getByTestId('bl-detail-status')).toHaveText('Status: Known data problem');
  await expect(page.getByTestId('bl-set-aside')).toHaveText('2');

  // the approval screen lists both with their reasons, and the data problem no longer blocks approval
  await page.getByTestId('workflow-status').click();
  const known = page.getByTestId('readiness-known');
  await expect(known).toContainText('Known data problems set aside (2)', { timeout: 30_000 });
  await expect(known).toContainText('Agreed with operations: corrected at source in December');
  await expect(known).toContainText('Test copy kept on purpose');
  await expect(page.getByTestId('readiness-blocking').filter({ hasText: 'paymentStatus=current' })).toHaveCount(0);
  await page.getByTestId('review-panel').getByRole('button', { name: /close/i }).first().click();

  // Activity names it in plain words
  await open(page, P, 'activity');
  await expect(page.getByText(`Set aside a known data problem for ${IMPORTED.givenName} ${IMPORTED.familyName}: The account is “up to date” but lists missed payments`)).toBeVisible({ timeout: 30_000 });

  // Remove: the customer counts as stopped again
  await openBlocker(page, DATA);
  await page.getByTestId(`bl-known-remove-${id}`).click();
  await expect(page.getByTestId(`bl-known-${id}`)).toHaveCount(0);
  await expect(page.getByTestId('bl-set-aside')).toHaveText('1');
  await expect(row).toHaveAttribute('data-status', 'open');
});

test('BD04 a blocker in the document itself can never be set aside: not offered, and refused by the server', async ({ page, request }) => {
  await openBlocker(page, SPANISH);
  await expect(page.getByTestId('bl-datanote')).toHaveCount(0);
  await expect(page.getByTestId('bl-mark-known')).toHaveCount(0);
  await expect(page.locator('[data-testid^="bl-customer-known-"]')).toHaveCount(0);
  const spanish = (await (await request.get(`${API}/records?documentType=credit-statement&full=1`)).json()).records.find((r: any) => r.customer.locale === 'es-US').recordId;
  const r = await request.post(`${API}/projects/${P}/known-data-problems`, { data: { blockerId: SPANISH, recordId: spanish, reason: 'We accept it' } });
  expect(r.status()).toBe(422);
  expect((await r.json()).error.code).toBe('NOT_A_DATA_PROBLEM');
});

test('BD05 a known data problem lapses by itself when the customer’s data is corrected, and the screen says so', async ({ page, request }) => {
  const id = await badCopy(request);
  expect((await request.post(`${API}/projects/${P}/known-data-problems`, { data: { blockerId: DATA, recordId: id, reason: 'Known upstream' } })).status()).toBe(201);
  await openBlocker(page, DATA);
  await expect(page.getByTestId('bl-set-aside')).toHaveText('1');
  // the data is corrected (here through the API, as Data Explorer would)
  const rec = (await (await request.get(`${API}/records?documentType=credit-statement&full=1&projectId=${P}`)).json()).records.find((r: any) => r.recordId === id);
  expect((await request.put(`${API}/projects/${P}/records/${id}`, { data: { record: { ...rec, card: { ...rec.card, missedPayments: 0 } } } })).ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId('bl-known-lapsed')).toContainText('1 known data problem no longer applies', { timeout: 30_000 });
  await expect(page.getByTestId(`bl-row-${DATA}`)).toHaveCount(0);
  await expect(page.getByTestId('bl-set-aside')).toHaveCount(0);
  expect((await (await request.get(`${API}/projects/${P}/known-data-problems`)).json()).knownDataProblems).toEqual([]);
});

test('BD06 approving with a known data problem records it in the release and its manifest, without the customer’s name', async ({ page, request }) => {
  // Releases are kept for good, so this works on its own copy of the card sample (deleted afterwards; its releases stay).
  const made = await request.post(`${API}/projects/${P}/duplicate`, { data: { title: `Known data E2E ${Date.now().toString(36)}` } });
  expect(made.ok()).toBeTruthy();
  const pid = (await made.json()).project.projectId as string;
  try {
    const id = await badImported(request);
    // fix the document's own blockers (Spanish wording) as a person would, then set the data problem aside
    const p = (await (await request.get(`${API}/projects/${pid}`)).json()).project;
    for (const part of p.contentParts) if (!part.approvedLocales['es-US']) part.approvedLocales['es-US'] = `ES: ${part.approvedLocales['en-US']}`;
    expect((await request.put(`${API}/projects/${pid}`, { data: { project: { ...p, modelVersion: p.modelVersion + 1 } }, headers: { 'if-match': `"${p.modelVersion}"` } })).ok()).toBeTruthy();
    expect((await request.post(`${API}/projects/${pid}/known-data-problems`, { data: { blockerId: DATA, recordId: id, reason: `${IMPORTED.givenName}'s account is corrected upstream` } })).status()).toBe(201);
    await open(page, pid, 'blockers');
    await expect(page.getByTestId('bl-set-aside')).toHaveText('1', { timeout: 30_000 });
    await page.getByTestId('workflow-status').click();
    await expect(page.getByTestId('readiness-known-item')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId('readiness-known')).toContainText(`${IMPORTED.givenName}'s account is corrected upstream`);
    await page.getByTestId('workflow-action-submit').click();
    await expect(page.getByTestId('workflow-action-approve')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('workflow-action-approve').click();
    await expect(page.getByTestId('review-state')).toHaveAttribute('data-state', 'approved', { timeout: 30_000 });
    const releases = (await (await request.get(`${API}/projects/${pid}/releases`)).json()).releases as any[];
    expect(releases).toHaveLength(1);
    // no id and no name of the imported customer: only that one such customer was set aside, the blocker and the reason
    expect(releases[0].knownDataProblems).toEqual([{ blockerId: DATA, blocker: 'The account is “up to date” but lists missed payments', customer: { kind: 'imported' }, reason: 'the customer\'s account is corrected upstream', markedBy: 'Local admin', markedAt: expect.any(String) }]);
  } finally {
    await request.delete(`${API}/projects/${pid}`);
  }
});
