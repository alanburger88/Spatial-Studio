/**
 * Wording rules (wave 2, section 4), end to end: house rules are made in the Library (with "Try a sentence") and approved;
 * a document follows them from Content & Translations; a banned word typed into a message shows its finding under the
 * field with a replacement that works; a "must" rule is a blocker and blocks approval until it is fixed; a "should" rule
 * only warns; the document adds its own rule but cannot weaken a house rule; a required phrase is reported and satisfied;
 * "Suggest compliant wording" with a stand-in reply (and the honest "needs an AI key" state without one); undo; a linked
 * alternative is read-only until it is unlinked. Library items are studio-wide and approved versions are never deleted,
 * so every run uses names of its own and its own copies of the sample document.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, open, plainCopy, saveAnyway } from './helpers';

const stamp = Date.now().toString(36);
const HOUSE = `House rules ${stamp}`;
let doc = '';

const project = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().project);
const select = (page: Page, id: string) => page.evaluate((nid) => (window as any).__iss.store.getState().select(nid), id);
const save = async (page: Page) => { await page.getByTestId('save-project').click(); await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 30_000 }); };
const duplicate = async (request: APIRequestContext, title: string) => {
  // The stored card sample has wording rules of its own since D106: start from the card as the fixtures build it.
  return (await plainCopy(request, 'aster-card-demo', title)).projectId;
};
/** Opens the alternatives editor of the payment guidance on one alternative's text. */
const editAlternative = async (page: Page, vid: string) => {
  await open(page, doc, 'design');
  await select(page, 'payment-guidance');
  const insp = page.getByTestId('component-inspector');
  await insp.getByTestId('insp-tab-content').click();
  await insp.getByTestId(`variant-edit-${vid}`).click();
  return insp;
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => { doc = await duplicate(request, `Wording rules ${stamp}`); });

test('WR01 house rules are made in the Library with a rule editor, tried on a sentence and approved', async ({ page }) => {
  await page.goto('/library');
  await page.getByTestId('lib-new-item').click();
  await page.getByTestId('lib-draft-kind').selectOption('wording-rules');
  await page.getByTestId('lib-draft-name').fill(HOUSE);
  const editor = page.getByTestId('lib-edit-rules');
  // rule 1: a banned word with its replacement, a "must" (the local admin sets the severity)
  await editor.getByTestId('lib-edit-rules-add').click();
  const r1 = editor.getByTestId('wr-rule-row').nth(0);
  await r1.getByTestId('wr-field-severity').selectOption('must');
  await r1.getByTestId('wr-field-phrase').fill('delinquent');
  await r1.getByTestId('wr-field-replacement').fill('past due');
  // rule 2: a preferred spelling, a "should"
  await editor.getByTestId('lib-edit-rules-add').click();
  const r2 = editor.getByTestId('wr-rule-row').nth(1);
  await r2.getByTestId('wr-field-kind').selectOption('preferred');
  await r2.getByTestId('wr-field-phrase').fill('e-mail');
  await r2.getByTestId('wr-field-replacement').fill('email');
  // reorder and back, keyboard-reachable buttons
  await r2.getByTestId('wr-rule-up').click();
  await expect(editor.getByTestId('wr-rule-row').nth(0).getByTestId('wr-field-phrase')).toHaveValue('e-mail');
  await editor.getByTestId('wr-rule-row').nth(0).getByTestId('wr-rule-down').click();
  await expect(editor.getByTestId('wr-rule-row').nth(0).getByTestId('wr-field-phrase')).toHaveValue('delinquent');
  // try a sentence: which rules it breaks
  await editor.getByTestId('wr-try-input').fill('Your Delinquent account: we sent an e-mail.');
  await expect(editor.getByTestId('wr-try-finding')).toHaveCount(2);
  await expect(editor.getByTestId('wr-try-finding').first()).toContainText('Must');
  await page.getByTestId('lib-draft-save').click();
  await expect(page.getByTestId('lib-detail')).toBeVisible();
  await page.getByTestId('lib-approve').click();
  await page.getByTestId('lib-approve-confirm').click();
  await expect(page.getByTestId('lib-message')).toContainText('Version 1 is approved and frozen');
});

test('WR02 a document follows the house rules from Content & Translations (read-only, with the item and version)', async ({ page }) => {
  await open(page, doc, 'content');
  const panel = page.getByTestId('wr-panel');
  await panel.getByTestId('wr-panel-toggle').click();
  await panel.getByTestId('wr-house-from-library').click();
  await page.getByTestId('lib-pick-dialog').getByRole('button', { name: new RegExp(HOUSE) }).click();
  await expect(panel.getByTestId('wr-house-rule')).toHaveCount(2);
  await expect(panel.getByTestId('wr-house').getByTestId('lib-chip').first()).toContainText(`Library · ${HOUSE} · v1`);
  await expect(panel.getByTestId('wr-rule-count')).toHaveText('2 rules');
  await expect(panel.getByTestId('wr-clean')).toBeVisible(); // the sample wording breaks neither rule
  await save(page);
  expect((await project(page)).houseWordingRules.map((r: any) => r.phrase)).toEqual(['delinquent', 'e-mail']);
});

test('WR03 a banned word typed into a message shows the finding under the field, and its replacement goes into the field', async ({ page }) => {
  const insp = await editAlternative(page, 'payment-reminder');
  const field = insp.getByTestId('variant-edit-text');
  await field.fill('Your account is delinquent. Please pay {{card.minimumDueCents}}.');
  const findings = insp.getByTestId('variant-wording-findings');
  const finding = findings.getByTestId('wording-finding');
  await expect(finding).toHaveCount(1);
  await expect(finding).toHaveAttribute('data-severity', 'must');
  await expect(finding.getByTestId('wording-severity')).toHaveText(/Must/);
  await expect(finding).toContainText('Banned: “delinquent”');
  const before = (await project(page)).modelVersion;
  await finding.getByTestId('wording-replace').focus();
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('Your account is past due. Please pay {{card.minimumDueCents}}.');
  await expect(findings).toHaveCount(0);
  expect((await project(page)).modelVersion).toBe(before); // into the field, not the model
  // Now leave the banned word in and save the text: it is a blocker, so the studio warns before saving (blockers phase 6)
  await field.fill('Your account is delinquent.');
  await insp.getByRole('button', { name: 'Save text (new version)' }).click();
  await saveAnyway(page, /^wording-banned~payment-reminder~/);
});

test('WR04 a “must” rule is a blocker on Blockers and blocks approval; fixing it clears both', async ({ page }) => {
  await open(page, doc, 'blockers');
  const id = 'wording-banned~payment-reminder~house:banned-1@payment-reminder';
  const row = page.getByTestId(`bl-row-${id}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute('data-kind', 'wording');
  await expect(row).toContainText('breaks a wording rule');
  await row.click();
  const detail = page.getByTestId('bl-detail');
  await expect(detail).toContainText('This is a house rule that must be met');
  const fix = detail.getByTestId('assist-proposal').filter({ hasText: 'Replace “delinquent” with “past due”' }).first();
  await expect(fix).toBeVisible();
  await expect(fix.getByTestId('assist-impact')).toContainText(/Replaces 1 occurrence in 1 text; changes what \d+ of \d+ synthetic customers read/, { timeout: 30_000 });

  // the Review panel: approval is blocked by it
  await page.getByTestId('workflow-status').click();
  const item = page.getByTestId('review-panel').getByTestId('readiness-blocking').filter({ hasText: 'delinquent' });
  await expect(item).toBeVisible({ timeout: 60_000 });
  await item.getByTestId('resolve-in-blockers').click();
  await expect(page.getByTestId('bl-detail')).toHaveAttribute('data-blocker', id);

  // apply the fix (one undoable step), save: the blocker and the readiness entry are gone
  await page.getByTestId('bl-detail').getByTestId('assist-proposal').filter({ hasText: 'Replace “delinquent” with “past due”' }).first().getByTestId('assist-apply').click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: /Apply/ });
  if (await confirm.count()) await confirm.first().click();
  await expect(page.getByTestId(`bl-row-${id}`)).toHaveCount(0, { timeout: 30_000 });
  expect((await project(page)).contentParts.find((c: any) => c.id === 'payment-reminder').approvedLocales['en-US']).toBe('Your account is past due.');
  await save(page);
  await page.getByTestId('workflow-status').click();
  await expect(page.getByTestId('review-panel').getByTestId('review-readiness')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('review-panel').getByTestId('readiness-blocking').filter({ hasText: 'delinquent' })).toHaveCount(0);
});

test('WR05 a “should” rule only warns: the finding shows under the email field, with no blocker', async ({ page }) => {
  await open(page, doc, 'channels');
  const subject = page.getByTestId('ch-email-subject');
  await subject.fill('Your statement is ready: we will e-mail you a copy');
  const f = page.getByTestId('ch-email-subject-wording').getByTestId('wording-finding');
  await expect(f).toHaveAttribute('data-severity', 'should');
  await expect(f.getByTestId('wording-severity')).toHaveText(/Should/);
  await f.getByTestId('wording-replace').click();
  await expect(subject).toHaveValue('Your statement is ready: we will email you a copy');
  await subject.fill('Your statement is ready: we will e-mail you a copy');
  await subject.blur();
  await expect.poll(async () => (await project(page)).channels?.email?.subject).toBe('Your statement is ready: we will e-mail you a copy');
  await save(page);
  await open(page, doc, 'blockers');
  await expect(page.getByTestId('bl-list')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid^="bl-row-wording-"]')).toHaveCount(0);
  // the Wording rules panel counts it as a "should"
  await open(page, doc, 'content');
  await page.getByTestId('wr-panel-toggle').click();
  await expect(page.getByTestId('wr-should-count')).toContainText('1 should');
});

test('WR06 the document adds its own rule, cannot weaken a house rule, and a required phrase is reported and then satisfied', async ({ page }) => {
  await open(page, doc, 'content');
  const panel = page.getByTestId('wr-panel');
  await panel.getByTestId('wr-panel-toggle').click();
  // weakening the house "must" is refused in plain words
  await panel.getByTestId('wr-own-add').click();
  const form = panel.getByTestId('wr-own-new');
  await form.getByTestId('wr-field-phrase').fill('Delinquent');
  await form.getByTestId('wr-field-severity').selectOption('should');
  await form.getByTestId('wr-own-add-save').click();
  await expect(panel.getByTestId('wr-own-error')).toContainText('cannot weaken them');
  // a required phrase of its own
  await form.getByTestId('wr-field-kind').selectOption('required');
  await form.getByTestId('wr-field-severity').selectOption('must');
  await form.getByTestId('wr-field-phrase').fill('dispute rights');
  await form.getByTestId('wr-own-add-save').click();
  await expect(panel.getByTestId('wr-own-rule')).toHaveCount(1);
  const req = panel.getByTestId('wr-summary-rule').filter({ hasText: 'Required: “dispute rights”' });
  await expect(req).toHaveAttribute('data-count', '1');
  await req.getByTestId('wr-summary-open').click();
  await expect(req.getByTestId('wr-summary-finding')).toContainText('The whole document');
  await expect(req.getByTestId('wr-summary-finding')).toContainText('must include “dispute rights” anywhere in the document');
  // undo removes the rule (one step), redo puts it back
  await page.getByTestId('undo').click();
  await expect(panel.getByTestId('wr-own-rule')).toHaveCount(0);
  await page.getByTestId('redo').click();
  await expect(panel.getByTestId('wr-own-rule')).toHaveCount(1);
  // satisfied by a message that says it (case and spacing ignored)
  await page.evaluate(() => {
    const s = (window as any).__iss.store.getState();
    const part = s.project.contentParts.find((c: any) => c.id === 'payment-standard');
    return s.dispatch({ type: 'UPSERT_CONTENT_PART', part: { ...part, approvedLocales: { ...part.approvedLocales, 'en-US': `${part.approvedLocales['en-US']} Your Dispute  Rights are explained on page 2.` } } });
  });
  await expect(panel.getByTestId('wr-summary-rule').filter({ hasText: 'Required: “dispute rights”' })).toHaveAttribute('data-count', '0');
  await save(page);
});

test('WR07 “Suggest compliant wording”: the needs-an-AI-key state without a key, and a checked AI suggestion with a stand-in', async ({ page }) => {
  const insp = await editAlternative(page, 'payment-reminder');
  const field = insp.getByTestId('variant-edit-text');
  await field.fill('Delinquent accounts pay fees.');
  const finding = insp.getByTestId('variant-wording-findings').getByTestId('wording-finding');
  await expect(finding).toHaveCount(1);
  // no key on test stacks: the normal state, not an error
  await finding.getByTestId('wording-suggest').click();
  await expect(finding.getByTestId('assist-needs-ai')).toBeVisible();
  // a reply shaped like the server's (the server has checked it with the same rules): shown beside the original as an AI suggestion
  let sent: any = null;
  await page.route('**/assist/rewrite', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ json: { mode: 'ai', providerStatus: 'stand-in', message: '', options: [{ text: 'Accounts that are past due pay fees.', tokenCheck: { ok: true, missing: [], extra: [] }, warnings: [] }] } });
  });
  await finding.getByTestId('wording-suggest').click();
  const s = finding.getByTestId('assist-suggestion');
  await expect(s.getByTestId('assist-source')).toHaveAttribute('data-source', 'ai');
  await expect(s.getByTestId('assist-suggestion-text')).toHaveText('Accounts that are past due pay fees.');
  expect(sent).toMatchObject({ style: 'compliant', scope: 'messages', text: 'Delinquent accounts pay fees.' });
  const before = (await project(page)).modelVersion;
  await s.getByTestId('assist-accept').click();
  await expect(field).toHaveValue('Accounts that are past due pay fees.');
  expect((await project(page)).modelVersion).toBe(before);
  // a refusal from the server says why
  await field.fill('Delinquent accounts pay fees today.');
  await page.unroute('**/assist/rewrite');
  await page.route('**/assist/rewrite', (route) => route.fulfill({ json: { mode: 'unavailable', providerStatus: 'stand-in', message: 'The AI suggestions still broke a “must” rule (Banned: “delinquent”), so none is offered. Reword it by hand.', options: [], refused: ['Banned: “delinquent”'] } }));
  await insp.getByTestId('variant-wording-findings').getByTestId('wording-suggest').click();
  await expect(insp.getByTestId('wording-ai-refused')).toContainText('still broke a “must” rule');
});

test('WR08 a linked alternative cannot be typed into; unlinking makes it editable again', async ({ page, request }) => {
  const title = `Support offer ${stamp}`;
  const made = await request.post(`${API}/library`, { data: { kind: 'wording', title, content: { part: { id: 'support', title: 'Payment support', type: 'text', approvedLocales: { 'en-US': 'If paying is hard, review the help we offer.' } } } } });
  expect(made.status()).toBe(201);
  const itemId = (await made.json()).item.id;
  expect((await request.post(`${API}/library/${itemId}/approve`, { data: {} })).ok()).toBeTruthy();
  const v = await (await request.get(`${API}/library/${itemId}/versions/latest`)).json();
  await open(page, doc, 'design');
  await page.evaluate(({ id, t, content }) => (window as any).__iss.store.getState().dispatch({ type: 'LINK_LIBRARY_ITEM', item: { id, kind: 'wording', title: t }, version: 1, content, placement: { partId: 'payment-support-offer' } }), { id: itemId, t: title, content: v.content });
  await select(page, 'payment-guidance');
  const insp = page.getByTestId('component-inspector');
  await insp.getByTestId('insp-tab-content').click();
  const linked = insp.getByTestId('variant-linked-payment-support-offer');
  await expect(linked.getByTestId('lib-chip')).toContainText(`Library · ${title} · v1`);
  await expect(linked.getByTestId('variant-linked-note')).toContainText('Read-only');
  await expect(insp.getByTestId('variant-edit-payment-support-offer')).toHaveCount(0);
  // unlink from the wording's library notice
  await insp.getByTestId('lib-part-payment-support-offer').getByTestId('lib-unlink').click();
  await page.getByTestId('lib-unlink-confirm').click();
  await expect(insp.getByTestId('variant-linked-payment-support-offer')).toHaveCount(0);
  await insp.getByTestId('variant-edit-payment-support-offer').click();
  await expect(insp.getByTestId('variant-edit-text')).toBeEditable();
});
