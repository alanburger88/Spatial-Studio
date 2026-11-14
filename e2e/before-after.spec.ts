import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, open, resetAll } from './helpers';

/**
 * Before & after (S20): what customers would see differently between two versions of a document, and who.
 * Every test works on its own duplicate of the HarborCare sample (a new document id, so release numbers start at 1)
 * and deletes it afterwards; a document's releases are kept after it is deleted, which affects nobody else.
 */

test.beforeEach(async ({ request }) => { await resetAll(request); });

let pid = '';
test.beforeEach(async ({ request }) => {
  const r = await request.post(`${API}/projects/harborcare-demo/duplicate`, { data: { title: `Compare E2E ${Date.now().toString(36)}` } });
  expect(r.ok()).toBeTruthy();
  pid = (await r.json()).project.projectId;
});
test.afterEach(async ({ request }) => { if (pid) await request.delete(`${API}/projects/${pid}`); });

async function approve(request: APIRequestContext) {
  const state = (await (await request.get(`${API}/projects/${pid}/workflow?checks=0`)).json()).state;
  if (state !== 'draft') expect((await request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'reopen' } })).ok()).toBeTruthy();
  expect((await request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'submit' } })).ok()).toBeTruthy();
  const r = await request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'approve' } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).release as { created: boolean; release: { number: number; id: string } };
}
/** Saves a changed copy of the document, the way an edit and Save would. */
async function edit(request: APIRequestContext, change: (p: any) => void) {
  const p = (await (await request.get(`${API}/projects/${pid}`)).json()).project;
  change(p);
  const r = await request.put(`${API}/projects/${pid}`, { data: { project: { ...p, modelVersion: p.modelVersion + 1 } }, headers: { 'If-Match': `"${p.modelVersion}"` } });
  expect(r.ok(), await r.text()).toBeTruthy();
}
/** Claims that were processed and covered now get the appeal message. */
const ruleChange = (p: any) => { p.rules.find((x: any) => x.id === 'R13').then.variantId = 'eob-appeal-status'; };
const wordingChange = (p: any) => { const c = p.contentParts.find((x: any) => x.id === 'eob-covered'); c.approvedLocales['en-US'] += ' Thank you.'; };

/** Customers whose selected alternatives differ between the frozen release and the working version, worked out independently through the API. */
async function differentMessage(request: APIRequestContext, releaseId: string) {
  const frozen = await (await request.get(`${API}/releases/${releaseId}/template`)).json();
  const working = (await (await request.get(`${API}/projects/${pid}`)).json()).project;
  const records = (await (await request.get(`${API}/records?documentType=eob&projectId=${pid}`)).json()).records as Array<{ recordId: string }>;
  const sel = async (project: any, recordId: string) => JSON.stringify((await (await request.post(`${API}/resolve`, { data: { projectId: pid, recordId, project } })).json()).result.selectedVariants);
  const ids: string[] = [];
  for (const { recordId } of records) if ((await sel(frozen, recordId)) !== (await sel(working, recordId))) ids.push(recordId);
  return { ids, total: records.length };
}

const groupCount = async (page: Page, g: string) => Number(await page.getByTestId(`cmp-group-${g}`).getAttribute('data-count'));
const customersIn = (page: Page, g: string) => page.getByTestId(`cmp-group-${g}`).getByTestId('cmp-customer');
async function openCompare(page: Page, query = '') {
  await open(page, pid, `compare${query}`);
  await expect(page.getByTestId('cmp-who')).toBeVisible();
}
const mark = (page: Page, side: 'before' | 'after', nodeId: string) => page.evaluate(({ side, nodeId }) => {
  const pane = document.querySelector(`[data-testid="cmp-pane-${side}"]`)!;
  const out: string[] = [];
  const look = (root: Document | ShadowRoot) => root.querySelectorAll(`[data-node-id="${nodeId}"]`).forEach((el) => out.push(getComputedStyle(el).outlineStyle));
  pane.querySelectorAll('.cmp-page-host').forEach((h) => h.shadowRoot && look(h.shadowRoot));
  const f = pane.querySelector('iframe') as HTMLIFrameElement | null;
  if (f?.contentDocument) look(f.contentDocument);
  return out;
}, { side, nodeId });

test('B01 a document with no release says so plainly and offers no comparison', async ({ page }) => {
  await open(page, pid, 'compare');
  await expect(page.getByTestId('before-after')).toBeVisible();
  await expect(page.getByTestId('cmp-no-release')).toContainText('no release of this document yet');
  await expect(page.getByTestId('cmp-pickers')).toHaveCount(0);
  await expect(page.getByTestId('cmp-who')).toHaveCount(0);
  await expect(page.getByTestId('cmp-limits')).toContainText('does not compare pixels');
});

test('B02 a release against the working version after a rule change: the right customers, in the right groups, with outlines on the pages', async ({ page, request }) => {
  const { release } = await approve(request);
  await edit(request, ruleChange);
  const want = await differentMessage(request, release.id);
  expect(want.ids.length).toBeGreaterThan(0);

  await openCompare(page);
  // Opens on the default pair: the latest release (nothing is in Production) against the working version, which differs.
  await expect(page.getByTestId('cmp-before')).toHaveAttribute('data-value', 'r1');
  await expect(page.getByTestId('cmp-after')).toHaveAttribute('data-value', 'working');
  await expect(page).toHaveURL(/before=r1&after=working/);

  await expect(page.getByTestId('cmp-who-total')).toHaveAttribute('data-total', String(want.total));
  expect(await groupCount(page, 'message')).toBe(want.ids.length);
  await expect(page.getByTestId('cmp-count-message')).toContainText(`${want.ids.length} of ${want.total} synthetic`);
  expect(await groupCount(page, 'same')).toBe(want.total - want.ids.length);
  // The same customers, nobody else.
  await page.getByTestId('cmp-group-message').locator('summary').click({ trial: true }).catch(() => undefined);
  const shown = await customersIn(page, 'message').evaluateAll((els) => els.map((e) => e.getAttribute('data-record')));
  expect([...shown].sort()).toEqual([...want.ids].sort());
  // "No visible change" starts collapsed.
  await expect(page.getByTestId('cmp-group-same')).not.toHaveAttribute('open', '');
  await expect(page.getByTestId('cmp-group-message')).toHaveAttribute('open', '');

  // The first customer of the first group is chosen; the differences are listed in words.
  const first = page.getByTestId('cmp-diff').first();
  await expect(first).toContainText('Claim message');
  await expect(first).toContainText('showed');
  await expect(first).toContainText('now shows');

  // Real pages, side by side, with the part that differs outlined on both.
  await expect(page.getByTestId('cmp-pane-before').locator('.cmp-page-host').first()).toBeVisible();
  await expect(page.getByTestId('cmp-pane-after').locator('.cmp-page-host').first()).toBeVisible();
  await expect.poll(() => mark(page, 'before', 'eob-claim-message')).toContain('dashed');
  await expect.poll(() => mark(page, 'after', 'eob-claim-message')).toContain('dashed');
  await expect(page.getByTestId('cmp-page-count')).toBeVisible();

  // Web page: the same, in a frame.
  await page.getByTestId('cmp-output-web').click();
  await expect(page.getByTestId('cmp-pane-before').locator('iframe')).toBeVisible();
  await expect.poll(() => mark(page, 'before', 'eob-claim-message')).toContain('dashed');
  await expect.poll(() => mark(page, 'after', 'eob-claim-message')).toContain('dashed');

  // Email is shown without outlines and says so.
  await page.getByTestId('cmp-output-email').click();
  await expect(page.getByTestId('cmp-email-note')).toContainText('without outlines');
  await expect(page.getByTestId('cmp-pane-after').locator('iframe')).toBeVisible();
});

test('B03 a wording change shows the words before and after, marked', async ({ page, request }) => {
  await approve(request);
  await edit(request, wordingChange);
  await openCompare(page);
  await expect(page.getByTestId('cmp-group-message')).toHaveAttribute('data-count', '0');
  expect(await groupCount(page, 'wording')).toBeGreaterThan(0);
  await expect(page.getByTestId('cmp-before')).toHaveAttribute('data-value', 'r1');
  const diff = page.getByTestId('cmp-diff').filter({ hasText: 'wording changes' }).first();
  await expect(diff).toBeVisible();
  await expect(diff.locator('ins')).toContainText('Thank you.');
  await expect(diff.locator('del')).toHaveCount(0);
  await expect(diff).toContainText('Before');
  await expect(diff).toContainText('After');
});

test('B04 choosing a difference scrolls both sides to that part', async ({ page, request }) => {
  await approve(request);
  await edit(request, ruleChange);
  await openCompare(page);
  await page.getByTestId('cmp-output-web').click();
  await expect(page.getByTestId('cmp-pane-before').locator('iframe')).toBeVisible();
  await expect.poll(() => mark(page, 'after', 'eob-claim-message')).toContain('dashed');
  const visible = (side: 'before' | 'after') => page.evaluate((side) => {
    const pane = document.querySelector(`[data-testid="cmp-pane-${side}"]`)!;
    const sc = pane.querySelector('.cmp-scroll') as HTMLElement;
    const f = pane.querySelector('iframe') as HTMLIFrameElement;
    const el = f.contentDocument!.querySelector('[data-node-id="eob-claim-message"]')!;
    const top = f.getBoundingClientRect().top + el.getBoundingClientRect().top, s = sc.getBoundingClientRect();
    return { inView: top >= s.top - 1 && top <= s.bottom - 10, scrollTop: sc.scrollTop };
  }, side);
  // Scroll both panes away first, then choose the difference.
  await page.getByTestId('cmp-pane-before').locator('.cmp-scroll').evaluate((e) => { e.scrollTop = e.scrollHeight; });
  await page.getByTestId('cmp-diff').filter({ hasText: 'Claim message' }).first().click();
  await expect.poll(async () => (await visible('before')).inView).toBe(true);
  await expect.poll(async () => (await visible('after')).inView).toBe(true);
  await expect(page.getByTestId('cmp-diff').filter({ hasText: 'Claim message' }).first()).toHaveAttribute('aria-pressed', 'true');
  // The chosen part is outlined more heavily than the others.
  await expect.poll(() => mark(page, 'after', 'eob-claim-message')).toContain('solid');
});

test('B05 swapping the sides is one click, and the address says which comparison this is', async ({ page, request }) => {
  const { release } = await approve(request);
  await edit(request, ruleChange);
  const want = await differentMessage(request, release.id);
  await openCompare(page);
  await expect(page).toHaveURL(/before=r1&after=working/);
  await page.getByTestId('cmp-swap').click();
  await expect(page.getByTestId('cmp-before')).toHaveAttribute('data-value', 'working');
  await expect(page.getByTestId('cmp-after')).toHaveAttribute('data-value', 'r1');
  await expect(page).toHaveURL(/before=working&after=r1/);
  await expect(page.getByTestId('cmp-diff').first()).toContainText('showed');
  expect(await groupCount(page, 'message')).toBe(want.ids.length);
  // Choosing a customer and an output goes into the address too, and the link reopens the same comparison.
  const second = customersIn(page, 'message').nth(1);
  const recordId = (await second.getAttribute('data-record'))!;
  await second.click();
  await page.getByTestId('cmp-output-sms').click();
  await expect(page).toHaveURL(new RegExp(`customer=${recordId}`));
  const url = page.url();
  await page.goto(url);
  await expect(page.getByTestId('cmp-who')).toBeVisible();
  await expect(page.getByTestId('cmp-before')).toHaveAttribute('data-value', 'working');
  await expect(page.getByTestId('cmp-after')).toHaveAttribute('data-value', 'r1');
  await expect(page.getByTestId('cmp-sbs')).toHaveAttribute('data-record', recordId);
  await expect(page.getByTestId('cmp-sbs')).toHaveAttribute('data-output', 'sms');
});

test('B06 a release side is the frozen release, whatever happens to the working version afterwards', async ({ page, request }) => {
  await approve(request);
  await edit(request, ruleChange);
  await openCompare(page, '?before=r1&after=working&output=web');
  const pane = (side: 'before' | 'after') => page.getByTestId(`cmp-pane-${side}`).locator('iframe');
  await expect(pane('before')).toBeVisible();
  const text = (side: 'before' | 'after') => page.evaluate((side) => (document.querySelector(`[data-testid="cmp-pane-${side}"] iframe`) as HTMLIFrameElement).contentDocument?.body?.innerText ?? '', side);
  await expect.poll(async () => (await text('before')).length).toBeGreaterThan(50);
  const beforeText = await text('before');
  expect(beforeText).not.toContain('Thank you.');

  // The working version moves on (saved, so the studio and the server both hold it).
  await edit(request, wordingChange);
  await page.reload();
  await expect(page.getByTestId('cmp-who')).toBeVisible();
  await expect(pane('after')).toBeVisible();
  await expect.poll(async () => (await text('before')).length).toBeGreaterThan(50);
  expect(await text('before')).toBe(beforeText);
  expect(await text('before')).not.toContain('Thank you.');
  // The labels say which side is which.
  await expect(page.getByTestId('cmp-pane-before')).toContainText('Release 1');
  await expect(page.getByTestId('cmp-pane-after')).toContainText('Working version (not released)');
});

test('B07 the text message marks the words that changed; the document changes are one click away', async ({ page, request }) => {
  await approve(request);
  await edit(request, ruleChange);
  await openCompare(page, '?output=sms');
  await expect(page.getByTestId('cmp-sms-before')).toBeVisible();
  await expect(page.getByTestId('cmp-sms-after')).toBeVisible();
  const doc = page.getByTestId('cmp-doc-changes');
  await expect(doc).not.toHaveAttribute('open', '');
  await doc.locator('summary').click();
  await expect(page.getByTestId('cmp-doc-summary')).toBeVisible();
  await expect(page.getByTestId('cmp-doc-headline')).not.toHaveText('No changes');
});

test('B08 the Releases screen opens a comparison with that release; the screen holds up at narrow widths', async ({ page, request }) => {
  await approve(request);
  await edit(request, ruleChange);
  await open(page, pid, 'releases');
  await page.getByTestId('rel-compare').click();
  await expect(page.getByTestId('before-after')).toBeVisible();
  await expect(page.getByTestId('cmp-before')).toHaveAttribute('data-value', 'r1');
  await expect(page.getByTestId('cmp-after')).toHaveAttribute('data-value', 'working');
  for (const [w, h] of [[1280, 720], [1000, 700]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await expect(page.getByTestId('cmp-pickers')).toBeVisible();
    await expect(page.getByTestId('cmp-pane-before')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }
});

test('B09 a customer list that is empty says so', async ({ page, request }) => {
  await approve(request);
  await edit(request, ruleChange);
  await page.route('**/api/v1/records?**', (route) => route.fulfill({ json: { seed: 'x', syntheticOnly: true, records: [] } }));
  await open(page, pid, 'compare');
  await expect(page.getByTestId('cmp-no-customers')).toContainText('no test customers');
});
