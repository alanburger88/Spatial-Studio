/**
 * Duplicate wording across documents (wave 3, section 2), end to end, in the Library's Duplicates view: two documents
 * share a message exactly and a third has a near copy → the group, with the differing word marked → keep the wording in
 * the library and approve it → link it in the exact document (nobody reads anything different) and in the near one (the
 * customers who would read something different are shown) → the group shows them linked; the third is linked in bulk
 * (an exact copy in a draft document). The threshold changes what is grouped; the empty state is honest.
 * Library items are studio-wide and approved versions are never deleted, so every run uses words of its own.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API } from './helpers';

const stamp = Date.now().toString(36);
const PART = 'payment-standard';
/** Words of this run only, so earlier runs' documents (a few words apart) are never nearly the same as this run's. */
const tag = (s: string) => 'abcdefgh'.split('').map((c) => `${s}${c}`).join(' ');
const NOTICE = `Notice ${tag(stamp)}: interest is charged on any balance you carry past the due date; see the terms for the current rate.`;
const NEAR = `Notice ${tag(stamp)}: interest is charged on any balance you carry past the due date; see the terms for the annual rate.`;
const NAME = `Interest notice ${stamp}`;
let docA = '', docB = '', docC = '';

/** A copy of the card statement whose payment instructions read `text`, saved. */
async function copyWith(request: APIRequestContext, title: string, text: string): Promise<string> {
  const r = await request.post(`${API}/projects/aster-card-demo/duplicate`, { data: { title } });
  expect(r.ok()).toBeTruthy();
  const id = (await r.json()).project.projectId as string;
  const p = (await (await request.get(`${API}/projects/${id}`)).json()).project;
  p.contentParts = p.contentParts.map((c: any) => (c.id === PART ? { ...c, version: c.version + 1, approvedLocales: { ...c.approvedLocales, 'en-US': text } } : c));
  const put = await request.put(`${API}/projects/${id}`, { data: { project: { ...p, modelVersion: p.modelVersion + 1 } }, headers: { 'if-match': `"${p.modelVersion}"` } });
  expect(put.ok(), await put.text()).toBeTruthy();
  return id;
}
const openDuplicates = async (page: Page, find: string) => {
  await page.goto('/library?view=duplicates');
  await expect(page.getByTestId('dup-view')).toBeVisible();
  await expect(page.getByTestId('dup-coverage')).toBeVisible();
  await page.getByTestId('dup-search').fill(find);
};
const member = (page: Page, projectId: string) => page.getByTestId('dup-member').and(page.locator(`[data-project="${projectId}"]`));
const save = async (page: Page) => { await page.getByTestId('save-project').click(); await expect(page.getByTestId('save-state')).toContainText('Saved'); };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  docA = await copyWith(request, `Duplicates A ${stamp}`, NOTICE);
  docB = await copyWith(request, `Duplicates B ${stamp}`, NOTICE);
  docC = await copyWith(request, `Duplicates C ${stamp}`, NEAR);
});

test('DU01 the group appears with the differing words marked; the scan says what it covered', async ({ page }) => {
  await openDuplicates(page, `Notice ${stamp}a`);
  await expect(page.getByTestId('lib-view-duplicates')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('dup-coverage')).toContainText(/Compared [\d,]+ texts in [\d,]+ saved documents/);
  await expect(page.getByTestId('dup-limit-note')).toContainText('It compares words, not meaning');
  const groups = page.getByTestId('dup-group');
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toHaveAttribute('data-documents', '3');
  await expect(groups.first()).toHaveAttribute('data-match', 'near');
  const detail = page.getByTestId('dup-detail');
  await expect(detail.getByTestId('dup-form')).toHaveCount(2);
  await expect(detail.getByTestId('dup-changed')).toHaveText(['(differs: annual)']);
  await expect(detail.getByTestId('dup-diffwords')).toContainText('Not in this text: “current”');
  await expect(member(page, docA)).toContainText('Suggested to keep');
  await expect(detail.getByTestId('dup-lib-none')).toBeVisible();
  // the scan is a second call away from the cache
  await page.getByTestId('dup-rescan').click();
  await expect(page.getByTestId('dup-coverage')).toContainText('from the last scan');
});

test('DU02 keep the wording in the library, approve it, and link it in the exact document (no one reads anything different)', async ({ page }) => {
  await openDuplicates(page, `Notice ${stamp}a`);
  await page.getByTestId('dup-keep').click();
  await expect(page.getByTestId('dup-keep-dialog')).toBeVisible();
  await expect(page.getByTestId('dup-keep-text')).toHaveValue(NOTICE);
  await page.getByTestId('dup-keep-title').fill(NAME);
  await page.getByTestId('dup-keep-save').click();
  await expect(page.getByTestId('dup-keep-done')).toContainText('version 1 is a draft');
  await page.getByTestId('dup-keep-approve').click();
  await expect(page.getByTestId('dup-keep-done')).toContainText('Version 1 of');
  await page.getByTestId('dup-keep-close').click();
  const lib = page.getByTestId('dup-lib');
  await expect(lib).toContainText(NAME);
  await expect(lib.locator('li')).toHaveAttribute('data-state', 'approved');

  await member(page, docA).getByTestId('dup-link-here').click();
  const impact = page.getByTestId('dup-link-impact');
  await expect(impact).toHaveAttribute('data-changed', '0');
  await expect(impact).toContainText('No synthetic customer would read anything different');
  await page.getByTestId('dup-link-apply').click();
  await expect(page).toHaveURL(new RegExp(`/studio/${docA}/content`));
  // One undoable, unsaved change in the document
  const st = await page.evaluate(() => { const s = (window as any).__iss.store.getState(); return { links: s.project.libraryLinks, past: s.past.length, dirty: (window as any).__iss.digest() }; });
  // the copy keeps the card sample's own links (D106: house wording rules, late-fee table) before the new one
  expect(st.links.map((l: any) => l.itemId).slice(0, 2)).toEqual(['card-late-fees', 'house-wording-rules']);
  expect(st.links.slice(2).map((l: any) => [l.kind, l.target.partId, l.version])).toEqual([['wording', PART, 1]]);
  expect(st.past).toBe(1);
  await save(page);
});

test('DU03 the near document shows the difference in words and who would read something different before it is linked', async ({ page }) => {
  await openDuplicates(page, `Notice ${stamp}a`);
  await member(page, docC).getByTestId('dup-link-here').click();
  await expect(page.getByTestId('dup-link-dialog')).toBeVisible();
  const impact = page.getByTestId('dup-link-impact');
  await expect(impact).toHaveAttribute('data-identical', 'false');
  await expect(impact).toContainText(/\d+ of \d+ synthetic customers/);
  expect(Number(await impact.getAttribute('data-changed'))).toBeGreaterThan(0);
  const diff = page.getByTestId('dup-link-diff');
  await expect(diff.locator('del')).toHaveText(['annual']);
  await expect(diff.locator('ins')).toHaveText(['current']);
  await expect(page.getByTestId('dup-link-who').locator('li').first()).toBeVisible();
  await page.getByTestId('dup-link-apply').click();
  await expect(page).toHaveURL(new RegExp(`/studio/${docC}/content`));
  await save(page);
});

test('DU04 the group now shows those documents as linked; the exact draft is linked in bulk', async ({ page, request }) => {
  await openDuplicates(page, `Notice ${stamp}a`);
  await expect(member(page, docA)).toHaveAttribute('data-linked', 'true');
  await expect(member(page, docC)).toHaveAttribute('data-linked', 'true');
  await expect(member(page, docB)).toHaveAttribute('data-linked', 'false');
  // Now that C reads as the library does, the group is exactly the same wording
  await expect(page.getByTestId('dup-group').first()).toHaveAttribute('data-match', 'exact');
  await page.getByTestId('dup-link-drafts').click();
  const report = page.getByTestId('dup-link-drafts-result');
  await expect(report).toContainText('in 1 document and saved a new version');
  await expect(report).toContainText('Nothing was approved');
  await expect(member(page, docB)).toHaveAttribute('data-linked', 'true');
  await expect(page.getByTestId('dup-group').first()).toContainText('All linked');
  const wf = await (await request.get(`${API}/projects/${docB}/workflow?checks=0`)).json();
  expect(wf.state).toBe('draft');
});

test('DU05 the threshold changes what is grouped', async ({ page, request }) => {
  const s2 = `${stamp}x`;
  const one = `Reminder ${tag(s2)}: your statement lists every purchase, payment and fee made in this period on the card.`;
  const two = `Reminder ${tag(s2)}: your statement lists every purchase, payment and charge made in this month on the card.`;
  await copyWith(request, `Threshold A ${stamp}`, one);
  await copyWith(request, `Threshold B ${stamp}`, two);
  await openDuplicates(page, `Reminder ${s2}a`);
  await expect(page.getByTestId('dup-group')).toHaveCount(1);
  await expect(page.getByTestId('dup-changed')).toHaveText(['(differs: fee)', '(differs: period)']);
  await page.getByTestId('dup-threshold').fill('95');
  await expect(page.getByTestId('dup-limit-note')).toContainText('at least 95%');
  await expect(page.getByTestId('dup-empty')).toContainText('No duplicate wording matches these filters');
  await page.getByTestId('dup-threshold').fill('80');
  await expect(page.getByTestId('dup-group')).toHaveCount(1);
  // Exact only hides it; near only shows it
  await page.getByTestId('dup-match-exact').click();
  await expect(page.getByTestId('dup-group')).toHaveCount(0);
  await page.getByTestId('dup-match-near').click();
  await expect(page.getByTestId('dup-group')).toHaveCount(1);
});

test('DU06 an honest empty state, and the Library keeps its items view', async ({ page }) => {
  await page.route('**/api/v1/library/duplicates*', async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, groups: [] } });
  });
  await page.goto('/library?view=duplicates');
  const empty = page.getByTestId('dup-empty');
  await expect(empty).toBeVisible();
  const docs = await page.getByTestId('dup-coverage').getAttribute('data-documents');
  await expect(empty).toContainText(`No duplicate wording found in ${Number(docs).toLocaleString('en-US')} documents`);
  await page.getByTestId('lib-view-items').click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByTestId('dup-view')).toHaveCount(0);
});
