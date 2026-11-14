import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, open } from './helpers';
import { gotoScreen } from './nav-helper';

/**
 * Blockers phase 4 in the browser (sign-in off: the local admin is the only possible owner): owner and status on each
 * row, the "Mine" filter, the detail's owner picker, "Being fixed" switch and notes, the "Fixed" group (worked out by
 * the studio from the saved document, until the next approval), and owner and status in the guided pass. Each test
 * works on its own copy of the card sample, deleted afterwards (which removes its owners and notes).
 */

const SPANISH = 'required-translation-missing~billing-summary~es-US';
const OTHER = 'required-translation-missing~payment-due~es-US';
let pid = '';
test.beforeEach(async ({ request }) => {
  const r = await request.post(`${API}/projects/aster-card-demo/duplicate`, { data: { title: `Owners E2E ${Date.now().toString(36)}` } });
  expect(r.ok()).toBeTruthy();
  pid = (await r.json()).project.projectId;
});
test.afterEach(async ({ request }) => { if (pid) await request.delete(`${API}/projects/${pid}`); });

const work = (request: APIRequestContext, blockerId: string, body: Record<string, unknown>) => request.put(`${API}/projects/${pid}/blocker-work/${encodeURIComponent(blockerId)}`, { data: body });
/** Approves every missing Spanish text and saves, as a person would: every Spanish blocker is fixed. */
async function fixSpanish(request: APIRequestContext) {
  const p = (await (await request.get(`${API}/projects/${pid}`)).json()).project;
  for (const part of p.contentParts) if (!part.approvedLocales['es-US']) part.approvedLocales['es-US'] = `ES: ${part.approvedLocales['en-US']}`;
  const r = await request.put(`${API}/projects/${pid}`, { data: { project: { ...p, modelVersion: p.modelVersion + 1 } }, headers: { 'If-Match': `"${p.modelVersion}"` } });
  expect(r.ok()).toBeTruthy();
}
async function openBlocker(page: Page, blockerId: string) {
  await open(page, pid, `blockers?blocker=${encodeURIComponent(blockerId)}`);
  await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', blockerId, { timeout: 30_000 });
}

test('BO01 the detail gives a blocker an owner, marks it "Being fixed" and keeps notes; the row shows them; they survive a reload', async ({ page }) => {
  await openBlocker(page, SPANISH);
  const panel = page.getByTestId('bl-work');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('bl-owner-picker')).toHaveValue('');
  // sign-in off: one line says assignment becomes useful with sign-in on
  await expect(page.getByTestId('bl-work-local')).toHaveText(/only possible owner is the local admin; giving blockers to people becomes useful with sign-in on/);
  const row = page.getByTestId(`bl-row-${SPANISH}`);
  await expect(row).toHaveAttribute('data-work-status', 'open');
  await expect(row.getByTestId('bl-work-status')).toHaveText('Open');

  await page.getByTestId('bl-owner-picker').selectOption({ label: 'Local admin' });
  await expect(row).toHaveAttribute('data-owner', 'local-admin');
  await expect(row.getByTestId('bl-owner')).toHaveText('Yours');
  await page.getByTestId('bl-being-fixed').check();
  await expect(row).toHaveAttribute('data-work-status', 'being-fixed');
  await expect(row.getByTestId('bl-work-status')).toHaveText('Being fixed');
  await expect(page.getByTestId('bl-work-line')).toContainText('Being fixed · set by Local admin');

  await page.getByTestId('bl-note-input').fill('Asked the translators; Spanish text due Monday.');
  await page.getByTestId('bl-note-add').click();
  await expect(page.getByTestId('bl-note')).toHaveCount(1);
  await expect(page.getByTestId('bl-note').first()).toContainText('Local admin');
  await expect(page.getByTestId('bl-note').first()).toContainText('Asked the translators; Spanish text due Monday.');
  await expect(page.getByTestId('bl-note-input')).toHaveValue('');

  // not an edit of the document: nothing to undo, nothing unsaved
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  await page.reload();
  await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', SPANISH, { timeout: 30_000 });
  await expect(page.getByTestId('bl-owner-picker')).toHaveValue('local-admin');
  await expect(page.getByTestId('bl-being-fixed')).toBeChecked();
  await expect(page.getByTestId('bl-note')).toHaveCount(1);

  // the Activity log says it in words
  await gotoScreen(page, 'S14');
  await expect(page.getByText('Made Local admin the owner of a blocker').first()).toBeVisible();
  await expect(page.getByText('Marked a blocker “Being fixed”').first()).toBeVisible();
  await expect(page.getByText('Added a note to a blocker').first()).toBeVisible();
});

test('BO02 "Mine" shows only the blockers you own, and says so when there are none', async ({ page, request }) => {
  await open(page, pid, 'blockers');
  await expect(page.getByTestId('bl-list')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('bl-mine').click();
  await expect(page.getByTestId('bl-mine')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('bl-none-shown')).toContainText('You own none of these blockers');
  await expect(page.locator('[data-testid^="bl-row-"]')).toHaveCount(0);
  expect((await work(request, OTHER, { ownerId: 'local-admin' })).ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator('[data-testid^="bl-row-"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId(`bl-row-${OTHER}`)).toBeVisible();
  await page.getByTestId('bl-mine').click();
  await expect(page.getByTestId('bl-mine')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.locator('[data-testid^="bl-row-"]').count()).toBeGreaterThan(1);
});

test('BO03 a cause fixed by an unsaved change is "Fixed when saved"; once saved the studio marks it Fixed; it drops off at the next approval', async ({ page, request }) => {
  expect((await work(request, SPANISH, { ownerId: 'local-admin', status: 'being-fixed' })).ok()).toBeTruthy();
  expect((await request.post(`${API}/projects/${pid}/blocker-work/${encodeURIComponent(SPANISH)}/notes`, { data: { body: 'Text is with the translators.' } })).ok()).toBeTruthy();
  await openBlocker(page, SPANISH);
  // approve the Spanish text for this one part in the open model (unsaved)
  const done = await page.evaluate(() => {
    const st = (window as any).__iss.store.getState();
    const part = st.project.contentParts.find((c: any) => c.id === 'billing-summary');
    const a = st.dispatch({ type: 'SET_TRANSLATION_DRAFT', partId: 'billing-summary', locale: 'es-US', text: `ES: ${part.approvedLocales['en-US']}` });
    const b = (window as any).__iss.store.getState().dispatch({ type: 'APPROVE_TRANSLATION', partId: 'billing-summary', locale: 'es-US' });
    return a.ok && b.ok;
  });
  expect(done).toBe(true);
  const fixedRow = page.getByTestId(`bl-fixed-${SPANISH}`);
  await expect(fixedRow).toBeVisible({ timeout: 30_000 });
  await expect(fixedRow).toHaveAttribute('data-unsaved', 'yes');
  await expect(fixedRow).toContainText('Fixed when saved');
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  await expect(fixedRow).not.toHaveAttribute('data-unsaved', 'yes', { timeout: 30_000 });
  await expect(fixedRow.getByTestId('bl-work-status')).toHaveText('Fixed');
  await fixedRow.click();
  const detail = page.getByTestId('bl-fixed-detail');
  await expect(detail).toHaveAttribute('data-blocker', SPANISH);
  await expect(detail).toContainText('No customer is stopped by this any more');
  await expect(detail.getByTestId('bl-note')).toContainText('Text is with the translators.');
  // Fixed is the studio's: the owner and the switch no longer change
  await expect(detail.getByTestId('bl-being-fixed')).toBeDisabled();
  await expect(detail.getByTestId('bl-owner-picker')).toBeDisabled();

  // the rest of the Spanish text, then submit and approve: the fixed cause drops off with its notes
  await fixSpanish(request);
  expect((await request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'submit' } })).ok()).toBeTruthy();
  const ok = await request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'approve' } });
  expect(ok.ok(), await ok.text()).toBeTruthy();
  await open(page, pid, 'blockers');
  await expect(page.getByTestId('bl-empty')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('bl-fixed-group')).toHaveCount(0);
});

test('BO04 the guided pass shows each blocker’s owner and status', async ({ page, request }) => {
  expect((await work(request, SPANISH, { ownerId: 'local-admin', status: 'being-fixed' })).ok()).toBeTruthy();
  await open(page, pid, 'blockers');
  await page.getByTestId('bl-resolve-start').click({ timeout: 30_000 });
  for (let i = 0; i < 8; i++) {
    const step = page.getByTestId('bl-pass-step');
    await expect(step).toBeVisible();
    if ((await step.getAttribute('data-blocker')) === SPANISH) break;
    await page.getByTestId('bl-pass-skip').click();
  }
  const step = page.getByTestId('bl-pass-step');
  await expect(step).toHaveAttribute('data-blocker', SPANISH);
  await expect(step.getByTestId('bl-work-status')).toHaveText('Being fixed');
  await expect(step.getByTestId('bl-owner')).toHaveText('Yours');
  await page.getByTestId('bl-pass-skip').click();
  const next = page.getByTestId('bl-pass-step');
  await expect(next.getByTestId('bl-work-status')).toHaveText('Open');
  await expect(next.getByTestId('bl-owner')).toHaveText('No owner');
  await page.getByTestId('bl-pass-close').click();
});
