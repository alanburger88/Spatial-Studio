/**
 * Browser tests for saved templates and project files in the Project Gallery:
 * save as template (versions), start from a saved template, retire / bring back, import a project file,
 * and the role check. Runs against the real local stack, like acceptance.spec.ts.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, resetAll } from './helpers';

const created: string[] = [];
test.beforeEach(async ({ request }) => { created.length = 0; await resetAll(request); });
test.afterEach(async ({ request }) => {
  for (const id of created) await request.delete(`${API}/projects/${id}`);
});

const SRC = 'aster-card-demo';
const gallery = async (page: Page) => { await page.goto('/projects'); await expect(page.getByTestId(`project-card-${SRC}`)).toBeVisible(); };
const idFromUrl = (page: Page) => /\/studio\/([^/]+)\//.exec(page.url())![1];

async function saveViaMenu(page: Page, name: string, opts: { description?: string; note?: string; version?: boolean } = {}) {
  await page.getByTestId(`card-menu-${SRC}`).click();
  await page.getByTestId(`save-template-${SRC}`).click();
  const dlg = page.getByTestId('save-template-dialog');
  await expect(dlg).toBeVisible();
  if (opts.version) await page.getByTestId('save-template-mode-version').check();
  else await page.getByTestId('save-template-name').fill(name);
  if (opts.description !== undefined) await page.getByTestId('save-template-description').fill(opts.description);
  if (opts.note !== undefined) await page.getByTestId('save-template-note').fill(opts.note);
  await page.getByTestId('save-template-confirm').click();
}
const saveViaApi = async (request: APIRequestContext, title: string) => {
  const r = await request.post(`${API}/templates`, { data: { projectId: SRC, title, description: 'Made by a test' } });
  expect(r.status()).toBe(201);
  return (await r.json()).template.id as string;
};
const savedList = async (request: APIRequestContext) => ((await (await request.get(`${API}/templates?includeRetired=true`)).json()).templates as any[]).filter((t) => t.source === 'saved');

test('T01 save as template, start a project from it, and the card says where it came from', async ({ page, request }) => {
  await gallery(page);
  await saveViaMenu(page, 'Aster house style', { description: 'House statement layout', note: 'First version' });
  await expect(page.getByText('Saved as template “Aster house style” (version 1)')).toBeVisible();
  await expect(page.getByTestId('save-template-dialog')).toHaveCount(0);

  await page.getByTestId('new-project').click();
  const card = page.getByTestId('template-saved-aster-house-style');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Saved · v1');
  await expect(card).toContainText('House statement layout');
  await expect(page.getByRole('heading', { name: 'Saved templates' })).toBeVisible();
  await card.click();
  const detail = page.getByTestId('template-detail');
  await expect(detail).toContainText('First version');
  await expect(detail).toContainText('Aster Card');
  await expect(page.getByTestId('template-version')).toHaveCount(0);
  await page.getByTestId('new-project-title').fill('Spring statement e2e');
  await page.getByTestId('create-project').click();
  await expect(page).toHaveURL(/\/studio\/spring-statement-e2e\/design/);
  created.push(idFromUrl(page));

  await gallery(page);
  await expect(page.getByTestId('origin-spring-statement-e2e')).toHaveText('Started from the template “Aster house style”, version 1');
});

test('T02 a second save adds version 2; the older version stays usable', async ({ page, request }) => {
  await saveViaApi(request, 'Versioned style');
  const proj = (await (await request.get(`${API}/projects/${SRC}`)).json()).project;
  const original = proj.issuer.product;
  const put = await request.put(`${API}/projects/${SRC}`, { data: { project: { ...proj, issuer: { ...proj.issuer, product: 'Aster Spring' } } }, headers: { 'If-Match': `"${proj.modelVersion}"` } });
  expect(put.ok()).toBeTruthy();

  await gallery(page);
  await saveViaMenu(page, '', { version: true, note: 'Spring product name' });
  await expect(page.getByText('Saved as template “Versioned style” (version 2)')).toBeVisible();

  await page.getByTestId('new-project').click();
  await page.getByTestId('template-saved-versioned-style').click();
  const sel = page.getByTestId('template-version');
  await expect(sel.locator('option')).toHaveText(['v2 (latest)', 'v1']);
  await expect(page.getByTestId('template-detail')).toContainText('Spring product name');
  await sel.selectOption('1');
  await expect(page.getByTestId('template-detail')).toContainText('Version 1 saved by');
  await page.getByTestId('new-project-title').fill('From first version');
  await page.getByTestId('create-project').click();
  await expect(page).toHaveURL(/\/studio\/from-first-version\/design/);
  created.push(idFromUrl(page));
  const p = (await (await request.get(`${API}/projects/from-first-version`)).json()).project;
  expect(p.issuer.product).toBe(original);
  expect(p.fromTemplate).toMatchObject({ version: 1 });

  const latest = (await (await request.post(`${API}/projects`, { data: { templateId: 'saved-versioned-style', title: 'From latest one' } })).json()).project;
  created.push(latest.projectId);
  expect(latest.issuer.product).toBe('Aster Spring');
  expect(latest.fromTemplate.version).toBe(2);
});

test('T03 a name that is already taken is explained in the dialog and nothing is saved', async ({ page, request }) => {
  await saveViaApi(request, 'Taken name');
  await gallery(page);
  await saveViaMenu(page, 'taken NAME');
  const alert = page.getByTestId('save-template-dialog').getByRole('alert');
  await expect(alert).toContainText('There is already a template called');
  await expect(page.getByTestId('save-template-dialog')).toBeVisible();
  expect(await savedList(request)).toHaveLength(1);
  expect((await savedList(request))[0].versions).toHaveLength(1);
});

test('T04 retire hides a template, "Show retired templates" lists it, "Bring back" restores it', async ({ page, request }) => {
  await saveViaApi(request, 'Short lived');
  await gallery(page);
  await page.getByTestId('new-project').click();
  const card = page.getByTestId('template-saved-short-lived');
  await card.click();
  await page.getByTestId('template-retire').click();
  await page.getByTestId('template-retire-confirm').click();
  await expect(card).toHaveCount(0);
  expect((await savedList(request))[0].retired).toBe(true);

  await page.getByTestId('template-show-retired').check();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Retired');
  await expect(card).toBeDisabled();
  await page.getByTestId('template-unretire').click();
  await expect(card).not.toContainText('Retired');
  await expect(card).toBeEnabled();
  expect((await savedList(request))[0].retired).toBe(false);
  await page.getByTestId('template-show-retired').uncheck();
  await expect(card).toBeVisible();
});

test('T05 import a project file as a new draft; the original is unchanged', async ({ page, request }) => {
  const original = (await (await request.get(`${API}/projects/${SRC}`)).json()).project;
  const file = await (await request.get(`${API}/projects/${SRC}/export`)).json();
  await gallery(page);
  await page.getByTestId('import-project').click();
  await page.getByTestId('import-project-file').setInputFiles({ name: 'aster.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  const report = page.getByTestId('import-project-report');
  await expect(report).toBeVisible();
  await expect(report).toContainText(file.title);
  await expect(report).toContainText('Customers, Version history, Review state, Comments');
  await expect(page.getByTestId('import-project-warning').first()).toContainText('nothing is replaced');
  await expect(page.getByTestId('import-project-title')).toHaveValue(file.title);
  await page.getByTestId('import-project-title').fill('Imported aster e2e');
  await page.getByTestId('import-project-confirm').click();
  await expect(page).toHaveURL(/\/studio\/imported-aster-e2e\/design/);
  created.push(idFromUrl(page));

  await gallery(page);
  await expect(page.getByTestId('origin-imported-aster-e2e')).toContainText(`Imported from the file “${file.title}”`);
  const after = (await (await request.get(`${API}/projects/${SRC}`)).json()).project;
  expect(after.modelVersion).toBe(original.modelVersion);
  expect(after.importedFrom).toBeUndefined();
});

test('T06 a broken file lists every problem, says nothing was imported, and creates no project', async ({ page, request }) => {
  const count = async () => ((await (await request.get(`${API}/projects`)).json()).projects as any[]).length;
  const before = await count();
  const file = await (await request.get(`${API}/projects/${SRC}/export`)).json();
  const bad = { ...file, nodes: file.nodes.map((n: any) => (n.image ? { ...n, image: { ...n.image, src: 'https://example.com/x.png' } } : n)) };
  await gallery(page);
  await page.getByTestId('import-project').click();
  const input = page.getByTestId('import-project-file');
  await input.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) });
  await expect(page.getByTestId('import-project-problems')).toContainText('Nothing was imported');
  await expect(page.getByTestId('import-project-problem').first()).toContainText('points outside the file');
  await expect(page.getByTestId('import-project-confirm')).toBeDisabled();
  await expect(page.getByTestId('import-project-report')).toHaveCount(0);

  await input.setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('this is not json') });
  await expect(page.getByTestId('import-project-problem')).toHaveText(['This file is not a studio project file']);
  await expect(page.getByTestId('import-project-confirm')).toBeDisabled();
  expect(await count()).toBe(before);

  // choosing a good file afterwards works
  await input.setInputFiles({ name: 'ok.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.getByTestId('import-project-report')).toBeVisible();
  await expect(page.getByTestId('import-project-problems')).toHaveCount(0);
  await expect(page.getByTestId('import-project-confirm')).toBeEnabled();
});

test('T07 without the right to save, "Save as template…" is disabled and says why', async ({ page }) => {
  await page.route('**/api/v1/session', (route) => route.fulfill({ json: {
    authEnabled: true, user: { id: 'u-author', name: 'Alex Author', email: 'author@example.test', role: 'author' },
    permissions: ['view', 'edit', 'comment', 'submit'], roles: ['author'], expiresAt: null,
  } }));
  await gallery(page);
  await page.getByTestId(`card-menu-${SRC}`).click();
  const item = page.getByTestId(`save-template-${SRC}`);
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await expect(item).toContainText('Only approvers and admins can save templates');
  await item.click({ force: true });
  await expect(page.getByTestId('save-template-dialog')).toHaveCount(0);
  // an author can still import
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('import-project')).toBeEnabled();
});
