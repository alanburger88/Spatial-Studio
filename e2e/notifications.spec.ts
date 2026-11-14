import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { API, open } from './helpers';

/**
 * Notifications and "My work" in the browser. With sign-in off (the usual stack) the local admin is the only person, so
 * their own actions notify nobody: the bell shows, the panel says why it is quiet, "My work" lists their blockers and
 * the documents in review, and a fix the studio notices on its own (customers removed outside the document) is told.
 * With sign-in on (a stack started with AUTH=on, ADMIN_EMAIL and ADMIN_PASSWORD; set E2E_ADMIN_EMAIL and
 * E2E_ADMIN_PASSWORD to match if they differ from the defaults below) two people work in two browser windows.
 */

const SPANISH = 'required-translation-missing~billing-summary~es-US';
const DATA = 'inconsistent-payment-state~payment-guidance';
const ADMIN = { email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test', password: process.env.E2E_ADMIN_PASSWORD ?? 'correct horse battery' };

let authOn = false;
test.beforeAll(async ({ request }) => { authOn = !!(await (await request.get(`${API}/session`)).json()).authEnabled; });

const bellPanel = async (page: Page) => {
  await page.getByTestId('bell').click();
  await expect(page.getByTestId('notify-panel')).toBeVisible();
  return page.getByTestId('notify-panel');
};

test.describe('sign-in off: the local admin', () => {
  let pid = '';
  test.beforeEach(async ({ request }) => {
    test.skip(authOn, 'this stack has sign-in on');
    const r = await request.post(`${API}/projects/aster-card-demo/duplicate`, { data: { title: `Notify E2E ${Date.now().toString(36)}` } });
    expect(r.ok()).toBeTruthy();
    pid = (await r.json()).project.projectId;
  });
  test.afterEach(async ({ request }) => {
    if (authOn) return;
    if (pid) await request.delete(`${API}/projects/${pid}`);
    await request.delete(`${API}/records/imported?documentType=credit-statement`);
    await request.post(`${API}/notifications/read-all`, { data: {} });
  });

  test('NT01 the bell, a quiet panel that says why, and My work with the local admin’s blocker and a document in review', async ({ page, request }) => {
    await request.post(`${API}/notifications/read-all`, { data: {} });
    expect((await request.put(`${API}/projects/${pid}/blocker-work/${encodeURIComponent(SPANISH)}`, { data: { ownerId: 'local-admin', status: 'being-fixed' } })).ok()).toBeTruthy();
    expect((await request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'submit' } })).ok()).toBeTruthy();
    await open(page, pid, 'overview');
    await expect(page.getByTestId('bell')).toBeVisible();
    await expect(page.getByTestId('bell-count')).toHaveCount(0);
    const panel = await bellPanel(page);
    // the local admin's own actions notify nobody: the panel says so
    await expect(panel.getByTestId('notify-empty')).toBeVisible();
    await expect(panel.getByTestId('notify-local')).toContainText('Sign-in is off');
    await panel.getByTestId('notify-tab-work').click();
    const mine = panel.locator(`[data-testid="my-work-blocker"][data-project="${pid}"][data-blocker="${SPANISH}"]`);
    await expect(mine.first()).toBeVisible();
    await expect(mine.first()).toContainText('Being fixed');
    await expect(panel.locator(`[data-testid="my-work-review"][data-project="${pid}"]`)).toBeVisible();
    await expect(panel.getByTestId('my-work-local')).toContainText('you are the local admin');
    // a blocker opens the Blockers screen on that cause
    await mine.first().click();
    await expect(page).toHaveURL(new RegExp(`/studio/${pid}/blockers\\?blocker=`));
    await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', SPANISH, { timeout: 30_000 });
    await expect(page.getByTestId('notify-panel')).toHaveCount(0);
    // a review opens the Review panel
    const again = await bellPanel(page);
    await expect(again.getByTestId('notify-tab-work')).toHaveAttribute('aria-selected', 'true');
    await again.locator(`[data-testid="my-work-review"][data-project="${pid}"]`).click();
    await expect(page.getByTestId('review-readiness').or(page.getByTestId('workflow-comment')).first()).toBeVisible({ timeout: 30_000 });
    // Escape closes the panel and focus returns to the bell
    await page.keyboard.press('Escape');
    const p3 = await bellPanel(page);
    await page.keyboard.press('Escape');
    await expect(p3).toHaveCount(0);
    await expect(page.getByTestId('bell')).toBeFocused();
  });

  test('NT02 a fix the studio notices by itself is told to the owner; the item opens the Fixed blocker; Mark all as read', async ({ page, request }) => {
    await request.post(`${API}/notifications/read-all`, { data: {} });
    // an imported customer whose own data contradicts itself stops the copy with a data problem
    const { recordId: _id, ...row } = (await (await request.get(`${API}/records/CARD-0002`)).json()).record;
    const imp = await request.post(`${API}/records/import`, { data: { documentType: 'credit-statement', format: 'json', data: [{ ...row, card: { ...row.card, paymentStatus: 'current', missedPayments: 2 } }] } });
    expect(imp.ok()).toBeTruthy();
    expect((await request.put(`${API}/projects/${pid}/blocker-work/${encodeURIComponent(DATA)}`, { data: { ownerId: 'local-admin' } })).ok()).toBeTruthy();
    // the imported customers are removed outside the document: the next look at the work finds the cause gone
    expect((await request.delete(`${API}/records/imported?documentType=credit-statement`)).ok()).toBeTruthy();
    expect((await (await request.get(`${API}/projects/${pid}/blocker-work`)).json()).items[0]).toMatchObject({ blockerId: DATA, status: 'fixed' });

    await open(page, pid, 'overview');
    await expect(page.getByTestId('bell-count')).toHaveText('1');
    await expect(page.getByTestId('bell')).toHaveAttribute('aria-label', 'Notifications: 1 unread');
    const panel = await bellPanel(page);
    const item = panel.getByTestId('notify-item').first();
    await expect(item).toHaveAttribute('data-kind', 'blocker.fixed');
    await expect(item).toHaveAttribute('data-read', 'no');
    await expect(item).toContainText('A blocker you own in “');
    await expect(item).toContainText('is fixed: no customer is stopped by it any more');
    await item.click();
    await expect(page).toHaveURL(new RegExp(`/studio/${pid}/blockers\\?fixed=`));
    await expect(page.getByTestId('bl-fixed-detail')).toHaveAttribute('data-blocker', DATA, { timeout: 30_000 });
    await expect(page.getByTestId('bell-count')).toHaveCount(0);

    // a second one, then Mark all as read
    expect((await request.post(`${API}/notifications/read-all`, { data: {} })).ok()).toBeTruthy();
    const imp2 = await request.post(`${API}/records/import`, { data: { documentType: 'credit-statement', format: 'json', data: [{ ...row, card: { ...row.card, paymentStatus: 'current', missedPayments: 2 } }] } });
    expect(imp2.ok()).toBeTruthy();
    await request.get(`${API}/projects/${pid}/blocker-work`); // back: open again
    await request.delete(`${API}/records/imported?documentType=credit-statement`);
    await request.get(`${API}/projects/${pid}/blocker-work`); // fixed again: told again
    await page.reload();
    await expect(page.getByTestId('bell-count')).toHaveText('1', { timeout: 30_000 });
    const p2 = await bellPanel(page);
    await p2.getByTestId('notify-read-all').click();
    await expect(page.getByTestId('bell-count')).toHaveCount(0);
    await expect(p2.getByTestId('notify-item').first()).toHaveAttribute('data-read', 'yes');
  });
});

test.describe('sign-in on: two people', () => {
  test.skip(() => !authOn, 'needs a stack started with AUTH=on');

  async function signedIn(browser: Browser, email: string, password: string) {
    const context = await browser.newContext();
    const r = await context.request.post(`${API}/auth/login`, { data: { email, password } });
    expect(r.ok(), await r.text()).toBeTruthy();
    return { context, page: await context.newPage(), request: context.request };
  }

  test('NT03 an owner is told in their own window; a reviewer is told of a submission and finds it in My work', async ({ browser }) => {
    test.skip(!authOn, 'needs a stack started with AUTH=on');
    const admin = await signedIn(browser, ADMIN.email, ADMIN.password);
    const tag = Date.now().toString(36);
    const people: Record<string, { email: string; id: string }> = {};
    for (const [role, name] of [['author', `Ann Author ${tag}`], ['reviewer', `Rita Reviewer ${tag}`]] as const) {
      const email = `${role}-${tag}@example.test`;
      const r = await admin.request.post(`${API}/users`, { data: { email, name, role, password: 'a long enough password' } });
      expect(r.ok(), await r.text()).toBeTruthy();
      people[role] = { email, id: (await r.json()).user.id };
    }
    const dup = await admin.request.post(`${API}/projects/aster-card-demo/duplicate`, { data: { title: `Two people ${tag}` } });
    const pid = (await dup.json()).project.projectId as string;
    const ann = await signedIn(browser, people.author.email, 'a long enough password');
    const rita = await signedIn(browser, people.reviewer.email, 'a long enough password');
    try {
      // Rita gives the Spanish blocker to Ann (from her own session)
      expect((await rita.request.put(`${API}/projects/${pid}/blocker-work/${encodeURIComponent(SPANISH)}`, { data: { ownerId: people.author.id } })).ok()).toBeTruthy();
      await open(ann.page, pid, 'overview');
      await expect(ann.page.getByTestId('bell-count')).toHaveText('1', { timeout: 30_000 });
      const panel = await bellPanel(ann.page);
      const item = panel.getByTestId('notify-item').first();
      await expect(item).toHaveAttribute('data-kind', 'blocker.assigned');
      await expect(item).toContainText(`Rita Reviewer ${tag} made you the owner of a blocker in “Two people ${tag}”`);
      await item.click();
      await expect(ann.page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', SPANISH, { timeout: 30_000 });
      await expect(ann.page.getByTestId(`bl-row-${SPANISH}`).getByTestId('bl-owner')).toHaveText('Yours');
      // with sign-in on there is no "local admin" line, and the picker lists the studio's people
      await expect(ann.page.getByTestId('bl-work-local')).toHaveCount(0);
      await expect(ann.page.getByTestId('bl-owner-picker').locator('option', { hasText: `Rita Reviewer ${tag}` })).toHaveCount(1);
      // Ann adds a note from the screen; Rita is not the owner, so she is not told; Ann is not told of her own note
      await ann.page.getByTestId('bl-note-input').fill('Booked the translators.');
      await ann.page.getByTestId('bl-note-add').click();
      await expect(ann.page.getByTestId('bl-note')).toHaveCount(1);

      // Ann submits the document; Rita's bell counts it and My work lists it
      expect((await ann.request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'submit' } })).ok()).toBeTruthy();
      await open(rita.page, pid, 'overview');
      const ritaPanel = await (async () => { await expect(rita.page.getByTestId('bell-count')).toHaveText('1', { timeout: 30_000 }); return bellPanel(rita.page); })();
      const sub = ritaPanel.getByTestId('notify-item').first();
      await expect(sub).toHaveAttribute('data-kind', 'review.submitted');
      await expect(sub).toContainText(`Ann Author ${tag} submitted “Two people ${tag}”`);
      await ritaPanel.getByTestId('notify-tab-work').click();
      await expect(ritaPanel.locator(`[data-testid="my-work-review"][data-project="${pid}"]`)).toContainText(`submitted by Ann Author ${tag}`);
      await ritaPanel.getByTestId('notify-tab-news').click();
      await sub.click();
      await expect(rita.page.getByTestId('review-readiness').or(rita.page.getByTestId('workflow-comment')).first()).toBeVisible({ timeout: 30_000 });

      // Rita asks for changes; Ann is told (on her next look)
      expect((await rita.request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'request_changes', comment: 'Please check the totals.' } })).ok()).toBeTruthy();
      await ann.page.reload();
      await expect(ann.page.getByTestId('bell-count')).toHaveText('1', { timeout: 30_000 });
      const annPanel = await bellPanel(ann.page);
      await expect(annPanel.getByTestId('notify-item').first()).toContainText(`Rita Reviewer ${tag} asked for changes to “Two people ${tag}”`);
    } finally {
      await admin.request.delete(`${API}/projects/${pid}`);
      for (const p of Object.values(people)) await admin.request.patch(`${API}/users/${p.id}`, { data: { disabled: true } });
      for (const c of [admin, ann, rita]) await c.context.close();
    }
  });
});
