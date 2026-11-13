import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, open, resetAll, setView } from './helpers';

/**
 * Releases screen (S18): a release is a frozen, numbered copy of an approved document, made when it is approved.
 * Releases persist across resetAll by design, so every test works on its own duplicate of the HarborCare sample (a new
 * document id, so its release numbers start at 1) and deletes the copy afterwards. A document's releases are kept after
 * it is deleted, which is what the API promises and does not affect other tests.
 */

test.beforeEach(async ({ request }) => { await resetAll(request); });

let pid = '';
test.beforeEach(async ({ request }) => {
  const r = await request.post(`${API}/projects/harborcare-demo/duplicate`, { data: { title: `Releases E2E ${Date.now().toString(36)}` } });
  expect(r.ok()).toBeTruthy();
  pid = (await r.json()).project.projectId;
});
test.afterEach(async ({ request }) => { if (pid) await request.delete(`${API}/projects/${pid}`); });

/** Submit and approve through the same workflow calls the review panel makes. Returns what the approval answered. */
async function approve(request: APIRequestContext, id = pid) {
  const state = (await (await request.get(`${API}/projects/${id}/workflow?checks=0`)).json()).state;
  if (state !== 'draft') expect((await request.post(`${API}/projects/${id}/workflow`, { data: { action: 'reopen' } })).ok()).toBeTruthy();
  expect((await request.post(`${API}/projects/${id}/workflow`, { data: { action: 'submit' } })).ok()).toBeTruthy();
  const r = await request.post(`${API}/projects/${id}/workflow`, { data: { action: 'approve' } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).release as { created: boolean; release: { number: number; id: string; modelVersion: number } };
}
/** Saves a changed copy of the document (a rename of its first component), the way an edit and Save would. Returns the new saved version. */
async function editAndSave(request: APIRequestContext, name: string, id = pid) {
  const p = (await (await request.get(`${API}/projects/${id}`)).json()).project;
  p.nodes.find((n: any) => n.type === 'variant-set').name = name;
  const r = await request.put(`${API}/projects/${id}`, { data: { project: { ...p, modelVersion: p.modelVersion + 1 } }, headers: { 'If-Match': `"${p.modelVersion}"` } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).project.modelVersion as number;
}
const releasesOf = async (request: APIRequestContext, id = pid) => (await (await request.get(`${API}/projects/${id}/releases`)).json()).releases as any[];
const highest = async (request: APIRequestContext) => Math.max(0, ...(await releasesOf(request)).map((r) => r.number));
const rel = (n: number) => `${API}/releases/${pid}-r${n}`;

const asRole = (page: Page, role: 'author' | 'approver') => page.route('**/api/v1/session', (route) => route.fulfill({ json: {
  authEnabled: true, user: { id: 'u-x', name: role === 'author' ? 'Avery Author' : 'Alex Approver', email: `${role}@example.test`, role },
  permissions: role === 'author' ? ['edit', 'comment', 'submit', 'reopen'] : ['comment', 'request_changes', 'approve', 'publish', 'reopen'], roles: [role], expiresAt: null,
} }));

test('R01 a document that was never approved shows the empty state and how a release is made', async ({ page, request }) => {
  expect(await releasesOf(request)).toHaveLength(0);
  await open(page, pid, 'releases');
  await expect(page.getByTestId('releases-screen')).toBeVisible();
  const empty = page.getByTestId('rel-empty');
  await expect(empty).toContainText('no release yet');
  await expect(empty).toContainText('approves the document');
  await expect(empty).toContainText('release 1 at Test');
  await expect(page.getByTestId('rel-live')).toContainText('Nothing in Production yet');
  await expect(page.getByTestId('rel-create')).toHaveCount(0); // nothing is approved, so there is nothing to create a release from
  await expect(page.getByTestId('rel-list')).toHaveCount(0);
});

test('R02 approving makes the next release at Test; a later edit says the document has changed while the release stays as it was', async ({ page, request }) => {
  const before = await highest(request);
  const made = await approve(request);
  expect(made.created).toBe(true);
  const n = before + 1;
  expect(made.release.number).toBe(n);
  const approvedVersion = made.release.modelVersion;

  await open(page, pid, 'releases');
  const row = page.getByTestId(`rel-row-${n}`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('rel-standing')).toHaveText('Test');
  await expect(row).toContainText('Local admin');
  await expect(row).toContainText('Package not built');
  await expect(row).toContainText('Not handed over');
  const live = page.getByTestId('rel-live');
  await expect(live.getByTestId('rel-live-test')).toContainText(`Release ${n}`);
  await expect(live.getByTestId('rel-live-test')).toContainText('Approved by Local admin');
  await expect(live.getByTestId('rel-live-production')).toContainText('Nothing in Production yet');
  await expect(page.getByTestId('rel-changed')).toHaveCount(0);
  const detail = page.getByTestId('rel-detail');
  await expect(detail).toHaveAttribute('data-release', String(n)); // the newest release is selected by default
  await expect(detail.getByTestId('rel-fact-version')).toHaveText(`v${approvedVersion}`);
  await expect(page.getByTestId('rel-stages')).toContainText('Created and moved to Test');
  const title = await detail.getByTestId('rel-fact-title').textContent();

  // Edit and save the document: it is a draft again at a newer version. The release does not change.
  const saved = await editAndSave(request, 'Renamed after the release');
  expect(saved).toBeGreaterThan(approvedVersion);
  await open(page, pid, 'releases');
  await expect(page.getByTestId('rel-changed')).toContainText(`The document has changed since release ${n}: v${saved} is not released`);
  await expect(page.getByTestId('rel-changed')).toContainText('submit it for review and approve');
  await expect(page.getByTestId('rel-detail').getByTestId('rel-fact-version')).toHaveText(`v${approvedVersion}`);
  await expect(page.getByTestId('rel-detail').getByTestId('rel-fact-title')).toHaveText(title!);
  await expect(page.getByTestId('rel-list').getByTestId(/rel-row-/)).toHaveCount(1);

  // Approving the changed document makes the next release; deep link selects an older one.
  const next = await approve(request);
  expect(next.release.number).toBe(n + 1);
  await page.goto(`/studio/${pid}/releases?release=${n}`);
  await expect(page.getByTestId('rel-detail')).toHaveAttribute('data-release', String(n));
  await expect(page.getByTestId(`rel-row-${n}`).getByTestId('rel-standing')).toHaveText('Superseded');
  await expect(page.getByTestId(`rel-row-${n + 1}`).getByTestId('rel-standing')).toHaveText('Test');
  await expect(page.getByTestId('rel-changed')).toHaveCount(0);
  await expect(page.getByTestId('rel-stages')).toContainText(`Release ${n + 1} took its place in Test`);
});

test('R03 prepare the package: busy state, ready with its size, what is inside, previews, and the ZIP download', async ({ page, request }) => {
  test.setTimeout(150_000);
  const made = await approve(request);
  const n = made.release.number;
  await open(page, pid, 'releases');
  const pkg = page.getByTestId('rel-package');
  await expect(pkg.getByTestId('rel-package-status')).toHaveText('Not built');
  await expect(pkg.getByTestId('rel-download')).toHaveCount(0);

  const t0 = Date.now();
  await pkg.getByTestId('rel-prepare').click();
  await expect(pkg.getByTestId('rel-package-busy')).toBeVisible();
  await expect(pkg.getByTestId('rel-prepare')).toBeDisabled();
  await expect(pkg.getByTestId('rel-package-status')).toHaveText('Ready', { timeout: 120_000 });
  const seconds = (Date.now() - t0) / 1000;
  console.log(`package build took ${seconds.toFixed(1)} s`);
  await expect(pkg.getByTestId('rel-package-busy')).toHaveCount(0);
  await expect(pkg.getByTestId('rel-package-size')).toContainText(/\d+(\.\d)? (KB|MB)/);
  await expect(page.getByTestId(`rel-row-${n}`)).toContainText('Package ready');

  // What is inside, in plain words.
  const contents = page.getByTestId('rel-contents');
  await expect(contents).toBeVisible();
  for (const g of ['template', 'wording', 'dictionary', 'scenarios', 'references']) await expect(contents.getByTestId(`rel-group-${g}`)).toBeVisible();
  await expect(contents.getByTestId('rel-group-wording')).toContainText('Spanish (US)');
  await expect(contents.getByTestId('rel-lang-missing').first()).toContainText('not translated yet');
  await expect(contents.getByTestId('rel-scenario-count')).toContainText(/\d+ synthetic scenarios?/);
  const refs = contents.getByTestId('rel-ref');
  expect(await refs.count()).toBeGreaterThan(0);

  // The README, a reference web page and a text message open in the preview without downloading the ZIP.
  await contents.getByTestId('rel-open-readme').click();
  const preview = page.getByTestId('rel-preview');
  await expect(preview).toHaveAttribute('data-path', 'README.html');
  await expect(page.frameLocator('[data-testid="rel-preview-frame"]').locator('h1')).toContainText(`release ${n}`);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await refs.first().getByTestId('rel-ref-open-document.html').click();
  await expect(page.getByTestId('rel-preview')).toHaveAttribute('data-path', /^reference\/.+\/document\.html$/);
  const htmlSrc = await page.getByTestId('rel-preview-frame').getAttribute('src');
  const htmlRes = await request.get(new URL(htmlSrc!, page.url()).toString().replace(/^http:\/\/127\.0\.0\.1:\d+/, API.replace('/api/v1', '')));
  expect(htmlRes.headers()['content-type']).toContain('text/html');
  expect(htmlRes.headers()['content-security-policy']).toContain('sandbox');
  await page.keyboard.press('Escape');
  await refs.first().getByTestId('rel-ref-open-sms.txt').click();
  await expect(page.getByTestId('rel-preview-text')).not.toBeEmpty();
  await page.keyboard.press('Escape');
  await refs.first().getByTestId('rel-ref-open-document.pdf').click();
  const pdfPath = (await page.getByTestId('rel-preview').getAttribute('data-path'))!;
  const pdf = await request.get(`${API}/releases/${pid}-r${n}/package/files/${pdfPath}`);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  await page.keyboard.press('Escape');

  // Download: a real ZIP whose hash and size are the ones shown.
  const [download] = await Promise.all([page.waitForEvent('download'), pkg.getByTestId('rel-download').click()]);
  expect(download.suggestedFilename()).toBe(`${pid}-r${n}.zip`);
  const zip = await request.get(`${API}/releases/${pid}-r${n}/package`);
  expect(zip.status()).toBe(200);
  expect(zip.headers()['content-type']).toBe('application/zip');
  expect(zip.headers()['content-disposition']).toContain(`${pid}-r${n}.zip`);
  const body = await zip.body();
  expect(body.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
  const sha = zip.headers()['x-sha256'];
  await setView(page, 'technical');
  await expect(page.getByTestId('rel-package-tech')).toContainText(sha);
  await expect(page.getByTestId('rel-package-tech')).toContainText(String(body.length));
  await setView(page, 'business');
});

test('R04 move to Production names what it replaces, a later release supersedes it, and a withdrawal shows its reason', async ({ page, request }) => {
  const r1 = (await approve(request)).release.number;
  await editAndSave(request, 'Second release wording');
  const r2 = (await approve(request)).release.number;
  expect(r2).toBe(r1 + 1);

  await page.goto(`/studio/${pid}/releases?release=${r1}`);
  await expect(page.getByTestId('rel-detail')).toHaveAttribute('data-release', String(r1));
  await page.getByTestId('rel-promote').click();
  await expect(page.getByTestId('rel-promote-replaces')).toContainText('Nothing is in Production yet');
  await page.getByTestId('rel-promote-confirm').click();
  await expect(page.getByTestId(`rel-row-${r1}`).getByTestId('rel-standing')).toHaveText('Production');
  await expect(page.getByTestId('rel-live-production')).toContainText(`Release ${r1}`);
  await expect(page.getByTestId('rel-stages')).toContainText('Moved to Production');
  await expect(page.getByTestId('rel-promote')).toBeDisabled();
  await expect(page.getByTestId('rel-promote-why')).toContainText(`Release ${r1} is already the Production release`);

  // A second release moved to Production replaces the first, and the dialog says so before it happens.
  await page.getByTestId(`rel-row-${r2}`).click();
  await expect(page.getByTestId('rel-detail')).toHaveAttribute('data-release', String(r2));
  await page.getByTestId('rel-promote').click();
  await expect(page.getByTestId('rel-promote-replaces')).toContainText(`replaces release ${r1}`);
  await page.getByTestId('rel-promote-note').fill('Go ahead');
  await page.getByTestId('rel-promote-confirm').click();
  await expect(page.getByTestId(`rel-row-${r2}`).getByTestId('rel-standing')).toHaveText('Production');
  await expect(page.getByTestId(`rel-row-${r1}`).getByTestId('rel-standing')).toHaveText('Superseded');
  await expect(page.getByTestId('rel-live-production')).toContainText(`Release ${r2}`);
  await expect(page.getByTestId('rel-live-test')).toContainText(`Release ${r2}`); // a release in Production is still the current Test release
  await expect(page.getByTestId('rel-detail').getByTestId('rel-stages')).toContainText('Go ahead');
  await page.getByTestId(`rel-row-${r1}`).click();
  await expect(page.getByTestId('rel-stages')).toContainText(`Release ${r2} took its place in Production`);

  // Withdraw needs a reason, and names the stage; the reason shows in the stage history.
  await page.getByTestId(`rel-row-${r2}`).click();
  await expect(page.getByTestId('rel-detail')).toHaveAttribute('data-release', String(r2));
  await page.getByTestId('rel-withdraw').click();
  const dialog = page.getByTestId('rel-withdraw-dialog');
  await expect(dialog).toContainText('Withdraw from Production');
  await expect(page.getByTestId('rel-withdraw-confirm')).toBeDisabled();
  await page.getByTestId('rel-withdraw-reason').fill('Wrong late-fee wording');
  await page.getByTestId('rel-withdraw-confirm').click();
  // It was withdrawn from Production but is still the current Test release, so the list says both.
  await expect(page.getByTestId(`rel-row-${r2}`).getByTestId('rel-prod-withdrawn')).toBeVisible();
  await expect(page.getByTestId('rel-stage-production')).toHaveText('Withdrawn');
  await expect(page.getByTestId('rel-stage-test')).toHaveText('Current');
  await expect(page.getByTestId('rel-stages')).toContainText('Withdrawn from Production');
  await expect(page.getByTestId('rel-stages')).toContainText('Reason: Wrong late-fee wording');
  await expect(page.getByTestId('rel-live-production')).toContainText('Nothing in Production yet'); // nothing takes its place by itself
  await expect(page.getByTestId('rel-promote')).toBeDisabled();
  await expect(page.getByTestId('rel-promote-why')).toContainText('was withdrawn');

  // The latest release was withdrawn and the document is still approved: a release can be made again from the approved version.
  await page.getByTestId('rel-create').click();
  await expect(page.getByTestId(`rel-row-${r2 + 1}`)).toBeVisible();
  await expect(page.getByTestId('rel-detail')).toHaveAttribute('data-release', String(r2 + 1));
  await expect(page.getByTestId('rel-detail')).toContainText('Made later from the approved version');
  await expect(page.getByTestId('rel-create')).toHaveCount(0);
});

test('R05 handover: mark as received with a note, then live; both show in the log and as marks in the list', async ({ page, request }) => {
  const n = (await approve(request)).release.number;
  await open(page, pid, 'releases');
  const row = page.getByTestId(`rel-row-${n}`);
  await expect(row).toContainText('Not handed over');
  const box = page.getByTestId('rel-handover');
  await expect(box.getByTestId('rel-handover-empty')).toBeVisible();
  await box.getByTestId('rel-handover-note-input').fill('Loaded into the CCM test environment');
  await box.getByTestId('rel-handover-received').click();
  const entries = box.getByTestId('rel-handover-entry');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toHaveAttribute('data-kind', 'received');
  await expect(entries.first()).toContainText('Loaded into the CCM test environment');
  await expect(entries.first()).toContainText('Local admin');
  await expect(row.getByTestId('rel-mark-received')).toBeVisible();
  await expect(row.getByTestId('rel-mark-live')).toHaveCount(0);
  await expect(page.getByTestId('rel-handover-note-input')).toHaveValue('');

  await box.getByTestId('rel-handover-live').click();
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(1)).toHaveAttribute('data-kind', 'live');
  await expect(row.getByTestId('rel-mark-live')).toBeVisible();
  await expect(row).not.toContainText('Not handed over');
  // The log is a record only: the release did not move.
  await expect(row.getByTestId('rel-standing')).toHaveText('Test');
});

test('R06 roles: an author may look but not act; an approver may log a handover but not promote', async ({ page, request }) => {
  const n = (await approve(request)).release.number;
  await asRole(page, 'author');
  await open(page, pid, 'releases');
  await expect(page.getByTestId(`rel-row-${n}`)).toBeVisible();
  await expect(page.getByTestId('rel-detail')).toBeVisible();
  await expect(page.getByTestId('rel-promote')).toBeDisabled();
  await expect(page.getByTestId('rel-promote-why')).toHaveText('Only admins can move a release to Production.');
  await expect(page.getByTestId('rel-withdraw')).toBeDisabled();
  await expect(page.getByTestId('rel-withdraw-why')).toHaveText('Only admins can withdraw a release.');
  await expect(page.getByTestId('rel-handover-received')).toBeDisabled();
  await expect(page.getByTestId('rel-handover-live')).toBeDisabled();
  await expect(page.getByTestId('rel-handover-why')).toHaveText('Only approvers and admins can add to the handover log.');
  await expect(page.getByTestId('rel-prepare')).toBeEnabled(); // everyone may prepare a package; it is not built here (slow)
  await expect(page.getByTestId('rel-create')).toHaveCount(0);

  await page.unroute('**/api/v1/session');
  await asRole(page, 'approver');
  await open(page, pid, 'releases');
  await expect(page.getByTestId('rel-promote')).toBeDisabled();
  await expect(page.getByTestId('rel-promote-why')).toContainText('Only admins');
  await expect(page.getByTestId('rel-withdraw')).toBeDisabled();
  await expect(page.getByTestId('rel-handover-received')).toBeEnabled();
  await expect(page.getByTestId('rel-handover-why')).toHaveCount(0);
  await page.getByTestId('rel-handover-received').click();
  await expect(page.getByTestId('rel-handover-entry')).toHaveCount(1);
  await expect(page.getByTestId(`rel-row-${n}`).getByTestId('rel-mark-received')).toBeVisible();
});

test('R07 Activity says in plain words that a release was created and moved to Production', async ({ page, request }) => {
  const made = await approve(request);
  const n = made.release.number;
  const moved = await request.post(`${rel(n)}/promote`, { data: { note: 'Ready' } });
  expect(moved.ok(), await moved.text()).toBeTruthy();
  await open(page, pid, 'activity');
  await page.getByTestId('activity-filter-action').selectOption('release.');
  const created = page.locator('[data-testid="activity-row"][data-action="release.create"]').first();
  await expect(created).toContainText(`Created release ${n} of “`);
  await expect(created).toContainText('at Test by approving it');
  const promoted = page.locator('[data-testid="activity-row"][data-action="release.promote"]').first();
  await expect(promoted).toContainText(`Moved release ${n} of “`);
  await expect(promoted).toContainText('to Production');
  await expect(promoted).toContainText('with a note');
  await expect(page.locator('[data-testid="activity-row"][data-action="workflow.approve"]')).toHaveCount(0); // the filter keeps only releases
});
