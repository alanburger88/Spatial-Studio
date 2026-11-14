import { expect, test, type Page } from '@playwright/test';
import { open, resetAll } from './helpers';

/**
 * Blockers phase 5 (wave 4, item 6): help from the assistant for wording blockers. The test stack has no AI key, so the
 * screens show the built-in help: the labelled sample draft for a missing translation, and a wording rule's own
 * replacement as a before and after. Nothing is approved by the assistant; a change is one undoable step.
 */

const P = 'aster-card-demo';
const MISSING = 'required-translation-missing~payment-standard~es-US';
test.beforeEach(async ({ request }) => { await resetAll(request); });
test.afterAll(async ({ request }) => { await resetAll(request); });

const store = <T = any>(page: Page, expr: string) => page.evaluate((e) => new Function(`return (${e})`)(), expr) as Promise<T>;
const past = (page: Page) => store<number>(page, 'window.__iss.store.getState().past.length');
const dispatch = (page: Page, cmd: unknown) => page.evaluate((c) => (window as any).__iss.store.getState().dispatch(c), cmd);
const partText = (page: Page, id: string, locale = 'en-US') => page.evaluate(([i, l]) => (window as any).__iss.store.getState().project.contentParts.find((c: any) => c.id === i)?.approvedLocales[l] ?? null, [id, locale]);

test('BD01 a missing required translation: “Draft the translation” stores a labelled sample draft, never approved; the blocker stays open; one undo removes it', async ({ page }) => {
  await open(page, P, `blockers?blocker=${encodeURIComponent(MISSING)}`);
  const help = page.getByTestId('bl-assist');
  await expect(help).toHaveAttribute('data-kind', 'translation');
  // No AI key: said in one line, and the built-in sample draft is still offered.
  await expect(help.getByTestId('bl-assist-nokey')).toContainText('No AI key is set');
  const before = await past(page);
  await help.getByTestId('bl-draft-translation').click();
  const result = help.getByTestId('bl-draft-result');
  await expect(result).toHaveAttribute('data-mode', 'sample');
  await expect(result).toContainText('Saved as a draft, not approved.');
  await expect(result.getByTestId('assist-source')).toHaveAttribute('data-source', 'sample');
  await expect(result.getByTestId('bl-draft-stays-open')).toContainText('This blocker stays open until a person reviews and approves the Spanish text');
  expect(await past(page)).toBe(before + 1);
  // Not approved: no Spanish text is approved, and the blocker is still listed for the same customers.
  expect(await partText(page, 'payment-standard', 'es-US')).toBeNull();
  const draft = await page.evaluate(() => { const s = (window as any).__iss.store.getState(); return s.project.contentParts.find((c: any) => c.id === 'payment-standard'); });
  expect(JSON.stringify(draft)).toContain('Su pago vence');
  await expect(page.getByTestId(`bl-row-${MISSING}`)).toBeVisible();
  await expect(page.getByTestId(`bl-row-${MISSING}`)).toHaveAttribute('data-count', '6');
  await expect(help.getByTestId('bl-draft-current')).toContainText('Draft, not approved');

  // The link opens Content & Translations at that text, in Spanish, as a draft.
  await help.getByTestId('bl-draft-open-content').click();
  await expect(page.getByTestId('translations-view')).toBeVisible();
  await expect(page.getByTestId('tr-search')).toHaveValue('payment-standard');
  const row = page.locator('[data-testid="tr-row"][data-part="payment-standard"]');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-status', 'draft');

  // One undo step takes the draft away again.
  await page.getByTestId('undo').click();
  await expect(row).toHaveAttribute('data-status', 'missing');
});

test('BD02 wording a “must” rule forbids: the rule’s own replacement as a before and after; using it is one undoable step that clears the blocker', async ({ page }) => {
  await open(page, P, 'blockers');
  // Make the document's own "should" rule a "must" (an ordinary, unsaved edit), so the wording becomes a blocker.
  const r = await dispatch(page, { type: 'UPDATE_WORDING_RULE', ruleId: 'aster-relationship-team', rule: { id: 'aster-relationship-team', kind: 'banned', severity: 'must', phrase: 'relationship specialist', replacement: 'relationship team', appliesTo: 'messages' } });
  expect(r.ok).toBe(true);
  const row = page.locator('[data-testid^="bl-row-wording-banned~relationship-manager"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  const help = page.getByTestId('bl-assist');
  await expect(help).toHaveAttribute('data-kind', 'rewrite');
  await expect(help.getByTestId('bl-assist-nokey')).toContainText('No AI key is set, so AI wording suggestions are not available. The rule’s own replacement is offered instead.');
  const ba = help.getByTestId('bl-wording-builtin');
  await expect(ba.getByTestId('bl-ba-before')).toHaveText('Contact your assigned relationship specialist.');
  await expect(ba.getByTestId('bl-ba-after')).toHaveText('Contact your assigned relationship team.');
  // The words that change are marked (struck out and inserted), not shown by colour alone.
  await expect(ba.locator('del')).toHaveText('specialist.');
  await expect(ba.locator('ins')).toHaveText('team.');
  const before = await past(page);
  await ba.getByTestId('bl-wording-use').click();
  expect(await past(page)).toBe(before + 1);
  expect(await partText(page, 'relationship-manager')).toBe('Contact your assigned relationship team.');
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('bl-resolved')).toContainText('is no longer a blocker');
  // One undo restores the wording, and the blocker comes back.
  await page.getByTestId('undo').click();
  expect(await partText(page, 'relationship-manager')).toBe('Contact your assigned relationship specialist.');
  await expect(row).toBeVisible();
});

test('BD03 a required disclosure is never rewritten by the assistant: it says so and links to it', async ({ page }) => {
  await open(page, P, 'blockers');
  const text: string = await page.evaluate(() => (window as any).__iss.store.getState().project.contentParts.find((c: any) => c.id === 'sample-disclosure-set').approvedLocales['en-US']);
  const word = (text.match(/[A-Za-z]{7,}/g) ?? [])[0];
  expect(word).toBeTruthy();
  const r = await dispatch(page, { type: 'ADD_WORDING_RULE', rule: { id: 'e2e-disclosure-word', kind: 'banned', severity: 'must', phrase: word, appliesTo: 'disclosures' } });
  expect(r.ok).toBe(true);
  const row = page.locator('[data-testid^="bl-row-wording-banned~sample-disclosure-set"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  const note = page.getByTestId('bl-wording-disclosure');
  await expect(note).toContainText('The assistant never rewrites a required disclosure');
  await expect(page.getByTestId('bl-wording-use')).toHaveCount(0);
  await expect(note.getByTestId('bl-wording-open-disclosure')).toBeVisible();
});

test('BD04 the guided pass offers the same help on a wording step', async ({ page }) => {
  await open(page, P, 'blockers');
  await page.getByTestId('bl-resolve-start').click();
  const step = page.getByTestId('bl-pass-step');
  await expect(step).toHaveAttribute('data-kind', 'wording');
  const help = step.getByTestId('bl-assist');
  await expect(help).toHaveAttribute('data-kind', 'translation');
  await help.getByTestId('bl-draft-translation').click();
  await expect(help.getByTestId('bl-draft-result')).toHaveAttribute('data-mode', 'sample');
  // Still a step of the pass: a draft does not fix it.
  await expect(step).toBeVisible();
  await expect(page.getByTestId('bl-pass-stopped')).toHaveText('6');
});
