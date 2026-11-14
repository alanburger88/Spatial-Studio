import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, demoTool, open, state } from './helpers';

/**
 * Blockers phase 6: warn before saving (docs/design/BLOCKERS.md decision 8). A save a person starts works out the fast
 * root causes of the version about to be saved and of the last saved version; a save that adds one shows a dialog with
 * the new causes (how many customers each stops, where each is fixed, and that layout and PDF problems are not part of
 * the check), focused on Go back. A save that adds nothing saves at once. Each spec works on its own copy of Aster Card.
 */

let pid = '';
const dup = async (request: APIRequestContext, title: string): Promise<string> => {
  const r = await request.post(`${API}/projects/aster-card-demo/duplicate`, { data: { title: `${title} ${Date.now().toString(36)}` } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).project.projectId;
};
test.afterEach(async ({ request }) => { if (pid) await request.delete(`${API}/projects/${pid}`); pid = ''; });

const savedVersion = async (request: APIRequestContext, id: string) => (await (await request.get(`${API}/projects/${id}`)).json()).project.modelVersion as number;
/** Tie R03 and R04 (the D01 demonstration defect): a rules blocker the saved version does not have. */
const addTie = async (page: Page) => { await demoTool(page, 'seed-d01'); await page.keyboard.press('Escape'); };

test('SW01 a save that adds a blocker warns first: Go back keeps the edits unsaved, Save anyway saves', async ({ page, request }) => {
  pid = await dup(request, 'Save warning');
  await open(page, pid, 'design');
  const v0 = await savedVersion(request, pid);
  await addTie(page);
  await expect(page.getByTestId('save-state')).toContainText('Unsaved');
  await page.getByTestId('save-project').click();
  const dialog = page.getByTestId('save-warning');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('save-warning-title')).toHaveText('This save adds a blocker');
  const cause = dialog.getByTestId('save-warning-cause');
  await expect(cause).toHaveCount(1);
  await expect(cause).toHaveAttribute('data-blocker', /^priority-tie~/);
  await expect(cause).toHaveAttribute('data-kind', 'rules');
  await expect(cause.getByTestId('save-warning-customers')).toHaveText(/^stops \d+ of 70 synthetic customers$/);
  await expect(dialog.getByTestId('save-warning-scope')).toContainText('Layout and PDF problems are not part of it');
  // The dialog's own content. Left out, as they belong to shared parts reported to the integrator: the studio-wide primary
  // button colour (white on the primary green, 3.45:1 at 13px) and the shared Dialog's header/footer landmarks.
  const axe = await new AxeBuilder({ page }).include('.dialog').exclude('.dialog .btn.primary').disableRules(['landmark-no-duplicate-banner', 'landmark-no-duplicate-contentinfo']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary}`).join(' | ')}`)).toEqual([]);
  // Go back is the default
  await expect(page.getByTestId('save-warning-back')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('save-state')).toContainText('Unsaved');
  expect(await savedVersion(request, pid)).toBe(v0);
  // Ctrl/Cmd+S warns in the same way; Save anyway saves
  await page.keyboard.press('ControlOrMeta+s');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('save-warning-save').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  expect(await savedVersion(request, pid)).toBeGreaterThan(v0);
  // The saved version now has the cause, so saving another edit does not warn about it again
  await page.evaluate(() => (window as any).__iss.store.getState().dispatch({ type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { name: 'Payment help' } }));
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  await expect(dialog).toHaveCount(0);
});

test('SW02 a save that adds nothing saves at once; the check is quick on the 70 customers and on a 250-row customer', async ({ page, request }) => {
  pid = await dup(request, 'Save no warning');
  // A customer of the document's own with 250 transactions (the stress case), so the check covers it too.
  const sample = (await (await request.get(`${API}/records/CARD-0001`)).json()).record;
  const tx = Array.from({ length: 250 }, (_, i) => ({ id: `STRESS-${String(i + 1).padStart(4, '0')}`, date: '2026-10-15', merchant: `Synthetic transaction ${i + 1}`, amountCents: Math.floor(sample.card.purchasesCents / 250) + (i < sample.card.purchasesCents % 250 ? 1 : 0) }));
  const { recordId: _r, documentType: _d, projectId: _p, origin: _o, ...data } = sample;
  expect((await request.post(`${API}/projects/${pid}/records`, { data: { record: { ...data, card: { ...sample.card, transactions: tx } } } })).status()).toBe(201);
  await open(page, pid, 'design');
  const before = await state(page);
  await page.evaluate(() => (window as any).__iss.store.getState().dispatch({ type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { name: 'Payment help' } }));
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  await expect(page.getByTestId('save-warning')).toHaveCount(0);
  expect((await state(page)).modelVersion).toBeGreaterThan(before.modelVersion);
  const ms = Number(await page.getByTestId('save-project').getAttribute('data-check-ms'));
  console.log(`save check, ${(await page.evaluate(() => (window as any).__iss.store.getState().records.length))} customers incl. a 250-row one: ${ms} ms`);
  expect(ms).toBeLessThan(1500);
});

test('SW03 each new cause opens where it is fixed, as the Blockers screen does', async ({ page, request }) => {
  pid = await dup(request, 'Save warning link');
  await open(page, pid, 'design');
  await addTie(page);
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-warning')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('save-warning-open').click();
  await expect(page).toHaveURL(new RegExp(`/studio/${pid}/rules-data`));
  await expect(page.getByTestId('save-warning')).toHaveCount(0);
  // nothing was saved
  await expect(page.getByTestId('save-state')).toContainText('Unsaved');
  // and "See it in Blockers" opens the cause there (the open, unsaved version has it)
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-warning')).toBeVisible({ timeout: 20_000 });
  const id = await page.getByTestId('save-warning-cause').getAttribute('data-blocker');
  await page.getByTestId('save-warning-blockers').click();
  await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', id!, { timeout: 30_000 });
});

test('SW04 a save through the API is not affected', async ({ request }) => {
  pid = await dup(request, 'Save API');
  const { project } = await (await request.get(`${API}/projects/${pid}`)).json();
  const r3 = project.rules.find((r: any) => r.id === 'R03');
  const tied = { ...project, rules: project.rules.map((r: any) => (r.id === 'R03' ? { ...r3, when: { op: 'gte', path: 'card.missedPayments', value: 2 }, priority: 400 } : r)) };
  const r = await request.put(`${API}/projects/${pid}`, { data: { project: tied }, headers: { 'If-Match': `"${project.modelVersion}"` } });
  expect(r.ok()).toBeTruthy();
});
