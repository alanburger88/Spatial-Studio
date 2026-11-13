/**
 * The shared library (S25), end to end: a block and a wording go into the library from one document, are approved, and
 * are used read-only in a second document; a new version is published, the second document sees "Update available" with
 * its impact, applies it, undoes it and unlinks; where used; roles with a stand-in session; the Library tab beside Projects.
 * Library items are studio-wide and approved versions are never deleted, so every run uses names of its own.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, open, showLeftPanel } from './helpers';

const stamp = Date.now().toString(36);
const BLOCK = `Payment actions ${stamp}`;
const WORDING = `Payment reminder ${stamp}`;
let docA = '', docB = '';

const duplicate = async (request: APIRequestContext, title: string) => {
  const r = await request.post(`${API}/projects/aster-card-demo/duplicate`, { data: { title } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).project.projectId as string;
};
const select = (page: Page, id: string) => page.evaluate((nid) => (window as any).__iss.store.getState().select(nid), id);
const project = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().project);
const itemByTitle = async (request: APIRequestContext, title: string) => ((await (await request.get(`${API}/library`)).json()).items as any[]).find((i) => i.title === title);
const save = async (page: Page) => { await page.getByTestId('save-project').click(); await expect(page.getByTestId('save-state')).toContainText('Saved'); };
const asRole = (page: Page, role: 'author' | 'approver' | 'reviewer') => page.route('**/api/v1/session', (route) => route.fulfill({ json: {
  authEnabled: true, user: { id: 'u-x', name: `${role} stand-in`, email: `${role}@example.test`, role },
  permissions: role === 'author' ? ['edit', 'comment', 'submit', 'reopen'] : role === 'approver' ? ['comment', 'request_changes', 'approve', 'publish', 'reopen'] : ['comment', 'request_changes'], roles: [role], expiresAt: null,
} }));

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  docA = await duplicate(request, `Library source ${stamp}`);
  docB = await duplicate(request, `Library user ${stamp}`);
});

test('LB01 the Library tab sits beside Projects, with an honest list', async ({ page }) => {
  await page.goto('/projects');
  const tabs = page.getByRole('navigation', { name: 'Projects screens' });
  await expect(tabs.getByRole('link')).toHaveText(['Projects', 'Library']);
  await page.getByTestId('nav-S25').click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.locator('#main h1').first()).toHaveText('Library');
  await expect(page.getByTestId('nav-S25')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('library-screen')).toBeVisible();
  // eight menu entries still
  await expect(page.getByRole('navigation', { name: 'Studio views' }).getByRole('link')).toHaveCount(8);
});

test('LB02 a block and a wording go into the library from a document, are approved and linked in place', async ({ page, request }) => {
  await open(page, docA, 'design');
  await select(page, 'payment-actions');
  const insp = page.getByTestId('component-inspector');
  await insp.getByTestId('insp-tab-content').click();
  await insp.getByTestId('lib-node-section').getByTestId('lib-add-open').first().click();
  await page.getByTestId('lib-add-title').fill(BLOCK);
  await page.getByTestId('lib-add-description').fill('Pay online button and QR code');
  await page.getByTestId('lib-add-save').click();
  await expect(page.getByTestId('lib-add-done')).toContainText('version 1 is a draft');
  await page.getByTestId('lib-add-approve-link').click();
  await expect(insp.getByTestId('lib-chip').first()).toContainText(`Library · ${BLOCK} · v1`);
  await expect(insp.getByTestId('lib-readonly')).toBeVisible();

  // The wording of one alternative of the payment guidance
  await select(page, 'payment-guidance');
  const part = insp.getByTestId('lib-part-payment-reminder');
  await part.getByTestId('lib-add-open').click();
  await page.getByTestId('lib-add-title').fill(WORDING);
  await page.getByTestId('lib-add-save').click();
  await page.getByTestId('lib-add-approve-link').click();
  await expect(part.getByTestId('lib-chip')).toContainText(`Library · ${WORDING} · v1`);
  await save(page);

  const p = await project(page);
  expect(p.libraryLinks.map((l: any) => [l.kind, l.version])).toEqual([['block', 1], ['wording', 1]]);
  expect(p.nodes.some((n: any) => n.id === 'payment-actions')).toBe(true); // linked in place: the same ids
  expect((await itemByTitle(request, BLOCK)).latest).toBe(1);
});

test('LB03 a second document uses them read-only; a change is refused with a message that names the item', async ({ page }) => {
  await open(page, docB, 'design');
  await select(page, 'greeting');
  await showLeftPanel(page);
  await page.getByTestId('lib-insert-block').click();
  const item = page.getByTestId('lib-pick-dialog').getByRole('button', { name: new RegExp(BLOCK) });
  await item.click();
  const insp = page.getByTestId('component-inspector');
  await expect(insp.getByTestId('lib-chip').first()).toContainText(`Library · ${BLOCK} · v1`);
  await expect(insp.getByTestId('lib-readonly-note')).toContainText('read-only in this document');
  const p = await project(page);
  const link = p.libraryLinks[0];
  expect(link.target.rootNodeId).toBe(`${link.linkId}-payment-actions`);
  // The canvas and the command bus refuse a change, naming the library item.
  await page.evaluate((id) => (window as any).__iss.store.getState().dispatch({ type: 'DELETE_NODE', nodeId: id }), `${link.linkId}-payment-action`);
  await expect(page.getByTestId('toast-error').last()).toContainText(`comes from the library: “${BLOCK}”`);
  await expect(page.getByTestId('toast-error').last()).toContainText('Unlink it');

  // A library wording as a new alternative of the payment guidance
  await select(page, 'payment-guidance');
  await insp.getByTestId('insp-tab-content').click();
  await insp.getByTestId('lib-wording-from-library').click();
  await page.getByTestId('lib-pick-dialog').getByRole('button', { name: new RegExp(WORDING) }).click();
  await expect(insp.getByTestId('lib-node-section')).toContainText(`Library · ${WORDING} · v1`);
  await save(page);
  expect((await project(page)).libraryLinks).toHaveLength(2);
});

test('LB04 a new version is published; the document sees Update available with its impact, applies it, undoes it and unlinks', async ({ page, request }) => {
  // The source document makes the change: it unlinks, edits the button and saves.
  await open(page, docA, 'design');
  await select(page, 'payment-actions');
  const insp = page.getByTestId('component-inspector');
  await insp.getByTestId('lib-node-section').getByTestId('lib-unlink').click();
  await page.getByTestId('lib-unlink-confirm').click();
  await expect(insp.getByTestId('lib-readonly')).toHaveCount(0);
  await page.evaluate(() => {
    const s = (window as any).__iss.store.getState();
    const n = s.project.nodes.find((x: any) => x.id === 'payment-action');
    return s.dispatch({ type: 'UPDATE_NODE', nodeId: 'payment-action', patch: { action: { ...n.action, label: 'Pay your bill online today' } } });
  });
  await save(page);

  // In the library, version 2 is taken from that document and approved.
  const it = await itemByTitle(request, BLOCK);
  await page.goto(`/library?item=${it.id}`);
  await page.getByTestId('lib-new-version').click();
  await expect(page.getByTestId('lib-draft-document')).toHaveValue(docA);
  await expect(page.getByTestId('lib-draft-ref')).toHaveValue('payment-actions');
  await page.getByTestId('lib-draft-note').fill('Clearer button');
  await page.getByTestId('lib-draft-save').click();
  await expect(page.getByTestId('lib-detail').getByText('Draft v2').first()).toBeVisible();
  await page.getByTestId('lib-approve').click();
  await page.getByTestId('lib-approve-confirm').click();
  await expect(page.getByTestId('lib-message')).toContainText('Version 2 is approved and frozen');
  // Where used: the second document is behind.
  await expect(page.getByTestId('lib-used-doc').filter({ hasText: `Library user ${stamp}` })).toHaveAttribute('data-behind', 'true');

  // Overview of the second document says so, and links to the list.
  await open(page, docB, 'overview');
  await expect(page.getByTestId('overview-library-updates')).toContainText('1 library update available');
  await expect(page.getByTestId('overview-steps')).toBeVisible();

  // Update available opens the change and its impact.
  await open(page, docB, 'design');
  const p = await project(page);
  const link = p.libraryLinks.find((l: any) => l.kind === 'block');
  await select(page, link.target.rootNodeId);
  const binsp = page.getByTestId('component-inspector');
  await binsp.getByTestId('insp-tab-content').click();
  await binsp.getByTestId('lib-update-available').click();
  const count = page.getByTestId('lib-impact-count');
  await expect(count).toContainText('synthetic customers');
  expect(Number(await count.getAttribute('data-changed'))).toBeGreaterThan(0);
  await expect(page.getByTestId('lib-impact-list')).toContainText('Pay your bill online today');
  await expect(page.getByTestId('lib-impact-changes')).toContainText('updated from version 1 to version 2');
  await page.getByTestId('lib-update-apply').click();
  await expect(binsp.getByTestId('lib-chip').first()).toContainText('· v2');
  expect((await project(page)).libraryLinks.find((l: any) => l.kind === 'block').version).toBe(2);
  // Undo puts version 1 back; redo takes version 2 again.
  await page.getByTestId('undo').click();
  await expect(binsp.getByTestId('lib-chip').first()).toContainText('· v1');
  await page.getByTestId('redo').click();
  await expect(binsp.getByTestId('lib-chip').first()).toContainText('· v2');
  // Unlink: the content stays and becomes the document's own.
  await binsp.getByTestId('lib-unlink').first().click();
  await page.getByTestId('lib-unlink-confirm').click();
  const after = await project(page);
  expect(after.libraryLinks.some((l: any) => l.kind === 'block')).toBe(false);
  expect(after.nodes.some((n: any) => n.id === link.target.rootNodeId)).toBe(true);
  await expect(binsp.getByTestId('lib-readonly')).toHaveCount(0);
  await save(page);
});

test('LB05 roles: a reviewer only looks, an author proposes, an approver approves', async ({ page, request }) => {
  const it = await itemByTitle(request, WORDING);
  await asRole(page, 'reviewer');
  await page.goto(`/library?item=${it.id}`);
  await expect(page.getByTestId('lib-detail')).toBeVisible();
  await expect(page.getByTestId('lib-readonly-role')).toContainText('Authors add items and versions; approvers approve them');
  await expect(page.getByTestId('lib-new-item')).toHaveCount(0);
  await expect(page.getByTestId('lib-new-version')).toHaveCount(0);
  await page.unroute('**/api/v1/session');

  await asRole(page, 'author');
  await page.goto(`/library?item=${it.id}`);
  await expect(page.getByTestId('lib-new-version')).toBeVisible();
  await expect(page.getByTestId('lib-approve')).toHaveCount(0);
  await page.unroute('**/api/v1/session');

  // A draft waits for an approver.
  const v = await (await request.get(`${API}/library/${it.id}/versions/latest`)).json();
  expect((await request.put(`${API}/library/${it.id}/draft`, { data: { content: { ...v.content, part: { ...v.content.part, approvedLocales: { ...v.content.part.approvedLocales, 'en-US': `${v.content.part.approvedLocales['en-US']} Thank you.` } } }, note: 'Friendlier' } })).ok()).toBeTruthy();
  await asRole(page, 'approver');
  await page.goto(`/library?item=${it.id}`);
  await expect(page.getByTestId('lib-approve')).toBeVisible();
  await expect(page.getByTestId('lib-new-version')).toHaveCount(0);
  await expect(page.getByTestId('lib-discard')).toBeVisible();
  await page.getByTestId('lib-discard').click();
  await expect(page.getByTestId('lib-message')).toContainText('was discarded');
  await page.unroute('**/api/v1/session');
});

test('LB06 the library list shows kinds, versions, drafts and use, and works at narrow widths', async ({ page, request }) => {
  const it = await itemByTitle(request, BLOCK);
  for (const [w, h] of [[1280, 720], [1000, 700]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/library?item=${it.id}`);
    await expect(page.getByTestId('lib-detail')).toBeVisible();
    await expect(page.getByTestId('lib-latest')).toHaveText('Approved v2');
    await expect(page.getByTestId('lib-versions').locator('li')).toHaveCount(2);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/library');
  await expect(page.getByTestId(`lib-item-${it.id}`)).toContainText('v2');
  await expect(page.getByTestId(`lib-item-${it.id}`).getByTestId('lib-usage')).toContainText('document');
});
