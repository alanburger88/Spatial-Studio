/**
 * Overview (S19): the document's home. Status strip, ordered next steps, at a glance and recent activity, all worked out
 * from the open document, its customers, the engines and the API. Runs against the real local stack (E2E_API / E2E_WEB).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, demoTool, open, resetAll } from './helpers';

const STEPS = ['customers', 'coverage', 'blockers', 'translations', 'full-check', 'review', 'release'];
const created: string[] = [];
test.beforeEach(async ({ request }) => { created.length = 0; await resetAll(request); });
test.afterEach(async ({ request }) => { for (const id of created) await request.delete(`${API}/projects/${id}`); });

const stepState = (page: Page, key: string) => page.getByTestId(`overview-step-${key}`).getAttribute('data-state');
const settled = async (page: Page) => { for (const k of STEPS) await expect(page.getByTestId(`overview-step-${k}`)).not.toHaveAttribute('data-state', 'working', { timeout: 60_000 }); };
const store = <T,>(page: Page, fn: (s: any) => T) => page.evaluate((src) => (0, eval)(`(${src})`)((window as any).__iss.store.getState()), fn.toString());

test('OV01 the status strip and the seven next steps come from the open document', async ({ page }) => {
  await open(page, 'aster-card-demo', 'overview');
  await expect(page.locator('#main h1').first()).toHaveText('Overview');
  await settled(page);
  const s = await store(page, (st) => ({ title: st.project.title, version: st.project.modelVersion, customers: st.records.length, kind: st.project.documentType }));
  await expect(page.getByTestId('overview-title')).toHaveText(s.title);
  await expect(page.getByTestId('overview-kind')).toHaveText('Credit-card statement');
  await expect(page.getByTestId('overview-version')).toHaveText(`Version ${s.version}`);
  await expect(page.getByTestId('overview-saved')).toHaveText(/All changes saved/);
  await expect(page.getByTestId('overview-workflow')).toContainText('Draft');
  await expect(page.getByTestId('overview-test')).toHaveText('None yet');
  await expect(page.getByTestId('overview-production')).toHaveText('None yet');

  const items = page.getByTestId('overview-steps').locator('> li');
  await expect(items).toHaveCount(7);
  for (let i = 0; i < STEPS.length; i++) await expect(items.nth(i)).toHaveAttribute('data-testid', `overview-step-${STEPS[i]}`);
  await expect(page.getByTestId('overview-step-why-customers')).toContainText(`${s.customers} synthetic customers`);
  await expect(page.getByTestId('overview-step-customers')).toHaveAttribute('data-state', 'done');
  // exactly one step is "Next", and it is the first one that is not done
  await expect(page.getByTestId('overview-next')).toHaveCount(1);
  const states = await Promise.all(STEPS.map((k) => stepState(page, k)));
  const first = STEPS[states.findIndex((x) => x !== 'done' && x !== 'not-needed')];
  await expect(page.getByTestId(`overview-step-${first}`).getByTestId('overview-next')).toBeVisible();
  // a state is always said in words
  for (const k of STEPS) await expect(page.getByTestId(`overview-step-state-${k}`)).toHaveText(/Done|To do|Needs attention|Not needed/);
  // no full check has run in this session: it says it cannot know
  await expect(page.getByTestId('overview-step-why-full-check')).toContainText('No full check has been run in this browser session');
  // counts of customers are always "synthetic"
  await expect(page.getByTestId('glance-customers')).toContainText('synthetic customers');
  await expect(page.getByTestId('glance-languages')).toContainText('English');
  await expect(page.getByTestId('glance-outputs')).toContainText('PDF');
});

test('OV02 the blockers step follows the real state of the document', async ({ page }) => {
  await open(page, 'harborcare-demo', 'overview');
  await settled(page);
  await expect(page.getByTestId('overview-step-blockers')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('overview-step-why-blockers')).toContainText('No blocker stops any of 30 synthetic customers');
  await expect(page.getByTestId('glance-customers')).toContainText('30 can be issued');

  // Aster Card starts with some blockers; a deliberate defect (two rules that tie, not saved) adds one more.
  await open(page, 'aster-card-demo', 'overview');
  await settled(page);
  const count = async () => Number((await page.getByTestId('overview-step-why-blockers').innerText()).match(/^(\d+) blockers?/)![1]);
  await expect(page.getByTestId('overview-step-blockers')).toHaveAttribute('data-state', 'attention');
  const n = await count();
  await demoTool(page, 'seed-d01');
  await page.getByTestId('demo-tools').getByRole('button', { name: 'Close demo tools' }).click();
  await expect.poll(count, { timeout: 30_000 }).toBe(n + 1);
  await expect(page.getByTestId('overview-saved')).toHaveText(/Unsaved changes/);
  await expect(page.getByTestId('glance-customers')).toContainText('stopped by a blocker');
  await expect(page.getByTestId('overview-step-why-review')).toContainText('unsaved changes');

  await page.getByTestId('undo').click();
  await expect.poll(count, { timeout: 30_000 }).toBe(n);
  await expect(page.getByTestId('overview-saved')).toHaveText(/All changes saved/);
});

test('OV03 each step has one button that opens the right screen or panel', async ({ page }) => {
  const go: Array<[string, RegExp]> = [['customers', /\/data$/], ['coverage', /\/rules-data$/], ['blockers', /\/blockers$/], ['translations', /\/content$/], ['full-check', /\/blockers$/], ['release', /\/releases$/]];
  for (const [key, url] of go) {
    await open(page, 'aster-card-demo', 'overview');
    await expect(page.getByTestId(`overview-step-${key}`).getByRole('button')).toHaveCount(1);
    await page.getByTestId(`overview-step-action-${key}`).click();
    await expect(page, key).toHaveURL(new RegExp(`/studio/aster-card-demo${url.source}`));
  }
  await open(page, 'aster-card-demo', 'overview');
  await page.getByTestId('overview-step-action-review').click();
  await expect(page.getByTestId('review-readiness')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('overview-activity-link').click();
  await expect(page).toHaveURL(/\/studio\/aster-card-demo\/activity$/);
});

test('OV04 what is released comes from the releases API', async ({ page }) => {
  const at = '2026-11-01T10:00:00.000Z';
  // A plain fixture for the page to read: the screen must show exactly what the API says.
  await page.route('**/api/v1/projects/harborcare-demo/releases', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const rel = (n: number, mv: number, test: string, prod: string | null) => ({ id: `harborcare-demo-r${n}`, documentId: 'harborcare-demo', number: n, title: 'HarborCare', documentType: 'eob', kind: 'Explanation of benefits', modelVersion: mv, contentDigest: 'x', languages: ['en-US'], approvedBy: null, approvedAt: at, origin: 'approval', createdBy: null, createdAt: at, versions: {}, stages: { test: { status: test, since: at, by: null }, production: prod ? { status: prod, since: at, by: null } : null }, standing: prod === 'current' ? 'production' : 'test' });
    return route.fulfill({ json: { documentId: 'harborcare-demo', documentExists: true, title: 'HarborCare', releases: [rel(2, 5, 'current', null), rel(1, 3, 'superseded', 'current')], production: 'harborcare-demo-r1', test: 'harborcare-demo-r2', create: { allowed: false, reason: 'Not approved.' } } });
  });
  await open(page, 'harborcare-demo', 'overview');
  await expect(page.getByTestId('overview-test')).toHaveText('Release 2 (version 5)');
  await expect(page.getByTestId('overview-production')).toHaveText('Release 1 (version 3)');
  await expect(page.getByTestId('overview-step-release')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('overview-step-why-release')).toContainText('Release 1 (version 3) is live in Production');
});

test('OV05 a failed releases request is said plainly, not hidden', async ({ page }) => {
  await page.route('**/api/v1/projects/harborcare-demo/releases', (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 500, json: { error: { message: 'Releases are unavailable.' } } }) : route.continue()));
  await open(page, 'harborcare-demo', 'overview');
  await expect(page.getByTestId('overview-released')).toHaveText('Could not be loaded');
  await expect(page.getByTestId('overview-step-release')).toHaveAttribute('data-state', 'attention');
});

test('OV06 recent activity lists the last five entries for this document, with a link to Activity', async ({ page, request }) => {
  const before = (await (await request.get(`${API}/audit?projectId=aster-card-demo&limit=5`)).json()).events as Array<{ id: number }>;
  await open(page, 'aster-card-demo', 'overview');
  const rows = page.getByTestId('overview-activity').locator('.ov-activity > li');
  if (before.length === 0) await expect(page.getByTestId('overview-activity')).toContainText('Nothing recorded yet');
  else { await expect(rows).toHaveCount(Math.min(5, before.length)); }
  await expect(page.getByTestId('overview-activity-link')).toHaveAttribute('href', '/studio/aster-card-demo/activity');
});

test('OV07 a new document opens on Overview; a blank document with no customers still shows it and says what to do', async ({ page, request }) => {
  await page.goto('/projects');
  await page.getByTestId('open-aster-card-demo').click();
  await expect(page).toHaveURL(/\/studio\/aster-card-demo\/overview$/);

  const made = await request.post(`${API}/projects`, { data: { templateId: 'blank-project', title: 'Overview blank e2e', issuerName: 'Northside Gym', accent: '#1f4e79' } });
  expect(made.status()).toBe(201);
  const id = (await made.json()).project.projectId as string;
  created.push(id);
  await open(page, id, 'overview');
  await expect(page.getByTestId('overview-kind')).toHaveText('Your own data');
  await expect(page.getByTestId('overview-step-customers')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('overview-step-translations')).toHaveAttribute('data-state', /not-needed|done|todo|attention/);
  await settled(page);
  await expect(page.getByTestId('overview-next')).toHaveCount(1);

  // remove every customer of the document: Overview still opens and the first step says to add some
  const recs = (await (await request.get(`${API}/records?documentType=custom&full=1&projectId=${id}`)).json()).records as Array<{ recordId: string; projectId?: string }>;
  for (const r of recs.filter((x) => x.projectId === id)) await request.delete(`${API}/projects/${id}/records/${r.recordId}`);
  await open(page, id, 'overview');
  await expect(page.getByTestId('overview-step-customers')).toHaveAttribute('data-state', 'todo');
  await expect(page.getByTestId('overview-step-customers').getByTestId('overview-next')).toBeVisible();
  await expect(page.getByTestId('glance-customers')).toHaveText('No customers yet');
});
