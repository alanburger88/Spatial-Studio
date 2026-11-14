import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, open, setView } from './helpers';

/**
 * Proof (S21) and "Produce from this release". Proof records are kept for good (only a test reset removes them), so
 * every test works on its own duplicate of the HarborCare sample, approves it (release 1) and searches within that
 * document only. The duplicate is deleted afterwards; its releases and proof records are kept, as the API promises.
 * The browser stack runs with sign-in off, so roles are shown with a stand-in session (as e2e/releases.spec.ts does);
 * the server's own role checks are covered by apps/api/test/proofs.test.ts.
 */

let pid = '';
test.beforeEach(async ({ request }) => {
  const r = await request.post(`${API}/projects/harborcare-demo/duplicate`, { data: { title: `Proof E2E ${Date.now().toString(36)}` } });
  expect(r.ok()).toBeTruthy();
  pid = (await r.json()).project.projectId;
});
test.afterEach(async ({ request }) => { if (pid) await request.delete(`${API}/projects/${pid}`); });

async function approve(request: APIRequestContext) {
  expect((await request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'submit' } })).ok()).toBeTruthy();
  const r = await request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'approve' } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).release.release as { id: string; number: number };
}
async function produceAll(request: APIRequestContext, releaseId: string) {
  const r = await request.post(`${API}/releases/${releaseId}/produce`, { data: { all: true } });
  expect(r.status(), await r.text()).toBe(201);
  return r.json();
}
const record = async (request: APIRequestContext, id: string) => (await (await request.get(`${API}/records/${id}`)).json()).record;
const asRole = (page: Page, role: 'author' | 'approver') => page.route('**/api/v1/session', (route) => route.fulfill({ json: {
  authEnabled: true, user: { id: 'u-x', name: role === 'author' ? 'Avery Author' : 'Alex Approver', email: `${role}@example.test`, role },
  permissions: role === 'author' ? ['edit', 'comment', 'submit', 'reopen'] : ['comment', 'request_changes', 'approve', 'publish', 'reopen'], roles: [role], expiresAt: null,
} }));

test('P01 produce from a release, then find the records on the Proof screen filtered to that release, newest pre-selected', async ({ page, request }) => {
  const rel = await approve(request);
  await open(page, pid, 'releases');
  const produce = page.getByTestId('rel-produce');
  await produce.scrollIntoViewIfNeeded();
  await expect(produce).toContainText('Produce from this release');
  await expect(page.getByTestId('rel-produce-email')).toBeChecked();
  await expect(page.getByTestId('rel-produce-sms')).toBeChecked();
  await expect(page.getByTestId('rel-produce-html')).toBeChecked();
  await expect(page.getByTestId('rel-produce-pdf')).not.toBeChecked();
  await page.getByTestId('rel-produce-who').selectOption('EOB-0004');
  await page.getByTestId('rel-produce-go').click();
  await expect(page.getByTestId('rel-produce-done')).toContainText('1 of 1 produced from release 1');
  await expect(page.getByTestId('rel-produce-done')).toContainText('not kept');
  await page.getByTestId('rel-produce-proofs').click();

  await expect(page).toHaveURL(new RegExp(`/studio/${pid}/proof\\?release=${rel.id}`));
  await expect(page.getByTestId('proof-lookup')).toBeVisible();
  await expect(page.getByTestId('proof-filter-release')).toHaveValue(rel.id);
  await expect(page.getByTestId('proof-count')).toHaveText('1');
  const detail = page.getByTestId('proof-detail');
  await expect(detail.getByTestId('proof-detail-ref')).toHaveText('EOB-0004');
  await expect(detail.getByTestId('proof-summary')).toContainText('by the studio from release 1');
  await expect(detail.getByTestId('proof-summary')).toContainText('web page, email and text message');
  await expect(detail.getByTestId('proof-detail-producer')).toHaveText('Studio');
  await expect(page.getByTestId('proof-limits')).toContainText('not that it was delivered');

  // Producing for every test customer adds a record each; the newest is selected, and the release link goes back.
  const all = await produceAll(request, rel.id);
  await page.reload();
  await expect(page.getByTestId('proof-count')).toHaveText(String(all.counts.customers + 1));
  await expect(page.getByTestId('proof-row').first()).toHaveAttribute('aria-current', 'true');
  await page.getByTestId('proof-release-link').click();
  await expect(page).toHaveURL(new RegExp(`/studio/${pid}/releases\\?release=1`));
});

test('P02 look up by customer reference; the record explains each part by name and holds no customer values', async ({ page, request }) => {
  const rel = await approve(request);
  await produceAll(request, rel.id);
  const customer = await record(request, 'EOB-0007');
  await open(page, pid, 'proof');
  await page.getByTestId('proof-filter-customer').fill('EOB-0007');
  await page.getByTestId('proof-search-go').click();
  await expect(page.getByTestId('proof-count')).toHaveText('1');
  const detail = page.getByTestId('proof-detail');
  await expect(detail.getByTestId('proof-detail-ref')).toHaveText('EOB-0007');
  await expect(detail.getByTestId('proof-no-values')).toContainText('none are held');
  const rows = detail.getByTestId('proof-why-row');
  expect(await rows.count()).toBeGreaterThan(0);
  const why = await detail.getByTestId('proof-why').innerText();
  expect(why).toContain('Claim message');
  expect(why).not.toMatch(/eob-claim-message/); // names first; codes only in Technical view
  // None of the customer's values are in what the record shows (the studio's own test customers are listed only under "Re-create and verify").
  const text = (await detail.locator(':scope > :not([data-testid="proof-verify"])').allInnerTexts()).join('\n');
  expect(text).toContain('Claim message');
  for (const v of [`${customer.customer.givenName} ${customer.customer.familyName}`, customer.claims[0].claimId, customer.claims[0].serviceDate, customer.claims[0].service]) expect(text).not.toContain(v);
  await setView(page, 'technical');
  await expect(detail.getByTestId('proof-why')).toContainText('eob-claim-message');
  await expect(detail.getByTestId('proof-id')).toHaveText(/^proof-/);
  // The run number finds it too.
  const runId = (await detail.getByTestId('proof-run').innerText()).trim();
  await page.getByTestId('proof-filter-customer').fill('');
  await page.getByTestId('proof-search').fill(runId);
  await page.getByTestId('proof-search-go').click();
  await expect(page.getByTestId('proof-count')).toHaveText('1');
});

test('P03 re-create and verify: same with the test customer and with the same data as JSON; changed data is named', async ({ page, request }) => {
  const rel = await approve(request);
  await produceAll(request, rel.id);
  const customer = await record(request, 'EOB-0002');
  await open(page, pid, 'proof?customer=EOB-0002');
  const verify = page.getByTestId('proof-verify');
  await expect(verify).toContainText('not stored and not logged');
  await expect(page.getByTestId('proof-verify-customer')).toHaveValue('EOB-0002');
  await page.getByTestId('proof-verify-go').click();
  await expect(page.getByTestId('proof-verdict')).toHaveAttribute('data-same', 'true');
  await expect(page.getByTestId('proof-verdict-text')).toHaveText('Same data, same release, same result.');
  await expect(page.getByTestId('proof-explained')).toContainText(customer.customer.givenName); // with values, for this check only
  await expect(page.getByTestId('proof-recreated-html')).toBeVisible();

  await page.getByTestId('proof-source-json').check();
  await page.getByTestId('proof-verify-json').fill(JSON.stringify(customer));
  await page.getByTestId('proof-verify-go').click();
  await expect(page.getByTestId('proof-verdict')).toHaveAttribute('data-same', 'true');
  await expect(page.getByTestId('proof-verdict')).toContainText('the data supplied');

  const changed = { ...customer, claims: customer.claims.map((c: any, i: number) => (i === 0 ? { ...c, planPaidCents: c.planPaidCents + 100 } : c)) };
  await page.getByTestId('proof-verify-file').setInputFiles({ name: 'customer.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(changed)) });
  await expect(page.getByTestId('proof-verify-json')).toHaveValue(/planPaidCents/);
  await page.getByTestId('proof-verify-go').click();
  await expect(page.getByTestId('proof-verdict')).toHaveAttribute('data-same', 'false');
  await expect(page.getByTestId('proof-verdict-text')).toHaveText('Not the same.');
  await expect(page.getByTestId('proof-differences')).toContainText('not the data the document was produced from');
  await expect(page.getByTestId('proof-recreated')).toHaveCount(0);

  // A different test customer: the data and what the document says differ.
  await page.getByTestId('proof-source-customer').check();
  await page.getByTestId('proof-verify-customer').selectOption('EOB-0009');
  await page.getByTestId('proof-verify-go').click();
  await expect(page.getByTestId('proof-differences').locator('li[data-kind="data"]')).toHaveCount(1);
});

test('P04 add proof records from a file: a dry run says what would happen, then they are added and searchable', async ({ page, request }) => {
  const rel = await approve(request);
  const made = await (await request.post(`${API}/releases/${rel.id}/produce`, { data: { recordId: 'EOB-0001' } })).json();
  const stored = (await (await request.get(`${API}/proofs/${made.results[0].proofId}`)).json()).proof;
  const stamp = Date.now().toString(36);
  const ref1 = `BILLING-${stamp}-1`, ref2 = `BILLING-${stamp}-2`;
  const runtime = { ...stored, producer: 'runtime', proofId: `proof-e2e-${stamp}`, customerRef: ref1, producedAt: '2026-11-01T09:00:00.000Z' };
  const foreign = { ...runtime, proofId: `${runtime.proofId}-x`, releaseId: `${pid}-r9`, customerRef: ref2, releaseNumber: 9 };
  const text = [JSON.stringify(runtime), JSON.stringify(foreign), JSON.stringify(stored), 'not json', JSON.stringify({ ...runtime, proofId: `proof-e2e-${stamp}-extra`, note: 'x' })].join('\n');

  await open(page, pid, 'proof');
  await page.getByTestId('proof-add-open').click();
  await page.getByTestId('proof-add-file').setInputFiles({ name: 'proof.jsonl', mimeType: 'text/plain', buffer: Buffer.from(text) });
  const summary = page.getByTestId('proof-add-summary');
  await expect(summary).toContainText('5 records read');
  await expect(page.getByTestId('proof-add-new')).toContainText('2 new (1 for a release not known here');
  await expect(page.getByTestId('proof-add-known')).toContainText('1 already known');
  await expect(page.getByTestId('proof-add-refused')).toContainText('2 refused');
  await expect(page.getByTestId('proof-add-why')).toContainText('Line 4: The line is not JSON.');
  await expect(page.getByTestId('proof-add-why')).toContainText('Unexpected fields: note');
  // The dry run stored nothing.
  expect((await (await request.get(`${API}/proofs?customerRef=${ref1}`)).json()).total).toBe(0);
  await page.getByTestId('proof-add-confirm').click();
  await expect(page.getByTestId('proof-add-dialog')).toHaveCount(0);

  await page.getByTestId('proof-filter-customer').fill(ref1);
  await page.getByTestId('proof-search-go').click();
  await expect(page.getByTestId('proof-count')).toHaveText('1');
  await expect(page.getByTestId('proof-detail-producer')).toHaveText('Runnable package');
  await expect(page.getByTestId('proof-summary')).toContainText('by the runnable package');
  await page.getByTestId('proof-filter-customer').fill(ref2);
  await page.getByTestId('proof-search-go').click();
  await expect(page.getByTestId('proof-row-unknown')).toHaveText('Release not known here');
  await expect(page.getByTestId('proof-release-unknown')).toContainText('Release not known here');
});

test('P05 a file with nothing usable is refused line by line and nothing can be added', async ({ page }) => {
  await open(page, pid, 'proof');
  await expect(page.getByTestId('proof-lookup')).toContainText('No proof records yet');
  await page.getByTestId('proof-add-open').click();
  await page.getByTestId('proof-add-file').setInputFiles({ name: 'proof.jsonl', mimeType: 'text/plain', buffer: Buffer.from('{"schema":"proof-record/9"}\n[1,2,3]\n') });
  await expect(page.getByTestId('proof-add-refused')).toContainText('2 refused');
  await expect(page.getByTestId('proof-add-why')).toContainText('Unknown kind of record');
  await expect(page.getByTestId('proof-add-why')).toContainText('Not a proof record');
  await expect(page.getByTestId('proof-add-confirm')).toBeDisabled();
});

test('P06 roles: an author may look and check but not produce or add records', async ({ page, request }) => {
  const rel = await approve(request);
  await produceAll(request, rel.id);
  await asRole(page, 'author');
  await open(page, pid, 'proof');
  await expect(page.getByTestId('proof-add-open')).toBeDisabled();
  await expect(page.getByTestId('proof-add-open')).toHaveAttribute('title', 'Only approvers and admins can add proof records.');
  await expect(page.getByTestId('proof-detail')).toBeVisible();
  await page.getByTestId('proof-verify-go').click();
  await expect(page.getByTestId('proof-verdict')).toHaveAttribute('data-same', 'true');
  await open(page, pid, 'releases');
  await page.getByTestId('rel-produce').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('rel-produce-go')).toBeDisabled();
  await expect(page.getByTestId('rel-produce-why')).toHaveText('Only approvers and admins can produce documents from a release.');
  await page.unroute('**/api/v1/session');
  await asRole(page, 'approver');
  await page.reload();
  await page.getByTestId('rel-produce').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('rel-produce-go')).toBeEnabled();
});

test('P07 a release that has been replaced cannot be produced from, and Activity says what was produced and checked', async ({ page, request }) => {
  const rel = await approve(request);
  await produceAll(request, rel.id);
  const proofs = (await (await request.get(`${API}/proofs?releaseId=${rel.id}&limit=1`)).json()).records;
  expect((await request.post(`${API}/proofs/${proofs[0].proof.proofId}/verify`, { data: { recordId: proofs[0].proof.customerRef } })).ok()).toBeTruthy();
  // A second release replaces the first in Test.
  const p = (await (await request.get(`${API}/projects/${pid}`)).json()).project;
  p.nodes.find((n: any) => n.type === 'variant-set').name = 'Renamed for release 2';
  expect((await request.put(`${API}/projects/${pid}`, { data: { project: { ...p, modelVersion: p.modelVersion + 1 } }, headers: { 'If-Match': `"${p.modelVersion}"` } })).ok()).toBeTruthy();
  await request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'reopen' } });
  await approve(request);
  const refused = await request.post(`${API}/releases/${rel.id}/produce`, { data: { all: true } });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.message).toContain('replaced by a later release');
  await open(page, pid, 'releases?release=1');
  await page.getByTestId('rel-produce').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('rel-produce-why')).toContainText('A later release has replaced this one');

  await open(page, pid, 'activity');
  await expect(page.locator('#main')).toContainText('from release 1 of');
  await expect(page.locator('#main')).toContainText('same data, same release, same result');
});
