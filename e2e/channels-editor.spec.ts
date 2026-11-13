import { test, expect, type Page } from '@playwright/test';
import { open, pickRecord, resetAll, setView } from './helpers';

test.beforeEach(async ({ request }) => { await resetAll(request); });

const frameBody = (page: Page) => page.frameLocator('[data-testid="ch-email-preview"]').locator('body');
const channelsOf = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().project.channels ?? null);
const bodyText = async (page: Page) => (await frameBody(page).innerText()).replace(/\s+/g, ' ');

test('default wording is shown with the composed preview for the previewed customer', async ({ page }) => {
  await open(page, 'aster-card-demo', 'channels');
  await expect(page.getByTestId('channels-view')).toBeVisible();
  await expect(page.getByTestId('ch-email-subject')).toHaveValue(/\{\{issuer\.product\}\} statement is ready/);
  await expect(page.getByTestId('ch-email-title')).toHaveValue('Your statement is ready');
  await expect(page.getByTestId('ch-email-subject-count')).toContainText('/ 200');
  await expect(page.getByTestId('ch-preview-subject')).toContainText('Your Aster Card statement is ready');
  await expect(page.getByTestId('ch-preview-for')).toContainText('English');
  await expect(page.getByTestId('ch-parity-overall')).toContainText('Same facts as the PDF');
  await expect(page.getByTestId('ch-email-preview')).toHaveAttribute('sandbox', '');
  await expect(frameBody(page)).toContainText('Your statement is ready');
  expect(await channelsOf(page)).toBeNull();
});

test('changing the subject updates the preview and Undo restores it', async ({ page }) => {
  await open(page, 'aster-card-demo', 'channels');
  await expect(page.getByTestId('ch-preview-subject')).toContainText('Your Aster Card statement is ready');
  await page.getByTestId('ch-email-subject').fill('Hello from {{issuer.name}}');
  await page.getByTestId('ch-email-subject').blur();
  await expect(page.getByTestId('save-state')).toContainText('Unsaved');
  await expect(page.getByTestId('ch-preview-subject')).toHaveText('Hello from Aster Card');
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('ch-email-subject')).toHaveValue(/statement is ready/);
  await expect(page.getByTestId('ch-preview-subject')).toContainText('Your Aster Card statement is ready');
});

test('an unknown {{token}} is flagged and refused, and the model is unchanged', async ({ page }) => {
  await open(page, 'aster-card-demo', 'channels');
  await page.getByTestId('ch-email-title').fill('Hi {{card.nothingHere}}');
  await expect(page.getByTestId('ch-token-warning')).toContainText('card.nothingHere');
  await page.getByTestId('ch-email-title').blur();
  await expect(page.getByTestId('ch-email-title-error')).toContainText('not a data field');
  expect(await channelsOf(page)).toBeNull();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
});

test('insert field puts the token at the caret', async ({ page }) => {
  await open(page, 'aster-card-demo', 'channels');
  await page.getByTestId('ch-email-title').fill('Hello ');
  await page.getByTestId('ch-field-title').getByTestId('ch-insert-field').click();
  await page.getByTestId('ch-field-search').fill('issuer');
  await page.getByTestId('ch-field-option-issuer.name').click();
  await expect(page.getByTestId('ch-email-title')).toHaveValue('Hello {{issuer.name}}');
  await page.getByTestId('ch-email-title').blur();
  await expect(page.getByTestId('save-state')).toContainText('Unsaved');
  await expect(frameBody(page)).toContainText('Hello Aster Card');
});

test('sections: hide Short tables and move Action buttons first; the rendered email follows', async ({ page }) => {
  await open(page, 'harborcare-demo', 'channels');
  await pickRecord(page, 'EOB-0002');
  await expect(frameBody(page)).toContainText('Claim details');
  const before = await bodyText(page);
  expect(before.indexOf('Questions about this claim?')).toBeGreaterThan(before.indexOf('Claim under review'));

  await page.getByTestId('ch-section-toggle-tables').click();
  await expect(page.getByTestId('ch-section-toggle-tables')).toHaveAttribute('aria-checked', 'false');
  await expect(frameBody(page)).not.toContainText('Claim details');
  await expect(frameBody(page)).toContainText('Claim under review');

  for (let i = 0; i < 4; i++) await page.getByTestId('ch-section-up-actions').click();
  await expect(page.getByTestId('ch-announce')).toContainText('Action buttons moved to position 1 of 5');
  await expect(page.getByTestId('ch-section-up-actions')).toBeDisabled();
  await expect.poll(async () => { const t = await bodyText(page); return t.includes('Questions about this claim?') && t.indexOf('Questions about this claim?') < t.indexOf('Key facts'); }).toBe(true);
  const ch = await channelsOf(page);
  expect(ch.email.sections.map((s: any) => s.id)).toEqual(['actions', 'keyFacts', 'messages', 'tables', 'summaries']);
  expect(ch.email.sections.find((s: any) => s.id === 'tables').show).toBe(false);
  await expect(page.getByTestId('ch-always')).toContainText('Required notices and disclosures');
  await expect(page.getByTestId('ch-section-toggle-keyFacts')).toBeEnabled();
  await expect(frameBody(page)).toContainText('DEMO DATA');
});

test('SMS meter: GSM-7 by default, UCS-2 once a non-GSM character is typed', async ({ page }) => {
  await open(page, 'aster-card-demo', 'channels');
  await page.getByTestId('ch-tab-sms').click();
  const meter = page.getByTestId('ch-sms-meter');
  await expect(meter).toHaveAttribute('data-encoding', 'GSM-7');
  await expect(meter).toHaveAttribute('data-segments', /^[12]$/);
  await expect(page.getByTestId('ch-sms-preview')).toContainText('DEMO Aster Card');
  const ta = page.getByTestId('ch-sms-text');
  await ta.fill('DEMO {{issuer.name}}: Estado listo, pagá {{card.minimumDueCents}}. {{link}}');
  await ta.blur();
  await expect(meter).toHaveAttribute('data-encoding', 'UCS-2');
  await expect(page.getByTestId('ch-sms-nongsm')).toContainText('á');
  await expect(page.getByTestId('ch-sms-preview')).toContainText('pagá $45.00');
});

test('the preview follows a customer switch', async ({ page }) => {
  await open(page, 'aster-card-demo', 'channels');
  await expect(page.getByTestId('ch-preview-for')).toContainText('Jordan Mercer');
  const first = await page.getByTestId('ch-preview-subject').innerText();
  await pickRecord(page, 'CARD-0002');
  await expect(page.getByTestId('ch-preview-for')).not.toContainText('Jordan Mercer');
  await expect.poll(async () => page.getByTestId('ch-preview-subject').innerText()).not.toBe(first);
});

test('EOB keeps THIS IS NOT A BILL; removing it from the SMS turns parity to a mismatch', async ({ page }) => {
  await open(page, 'harborcare-demo', 'channels');
  await expect(page.getByTestId('ch-parity-overall')).toContainText('Same facts as the PDF');
  await expect(page.getByTestId('ch-email-preheader')).toHaveValue(/THIS IS NOT A BILL/);
  await expect(frameBody(page)).toContainText('THIS IS NOT A BILL');
  await page.getByTestId('ch-tab-sms').click();
  await expect(page.getByTestId('ch-sms-preview')).toContainText('THIS IS NOT A BILL');
  await expect(page.getByTestId('ch-parity-overall')).toContainText('Same facts as the PDF');
  await setView(page, 'technical');
  const ta = page.getByTestId('ch-sms-text');
  await ta.fill('DEMO {{issuer.name}}: Your Explanation of Benefits for claim {{claim.claimId}} is ready. Details: {{link}}');
  await ta.blur();
  await expect(page.getByTestId('ch-sms-preview')).not.toContainText('NOT A BILL');
  await expect(page.getByTestId('ch-parity-overall')).toContainText('Differs from the PDF');
});

test('reset to default wording asks first and restores the defaults', async ({ page }) => {
  await open(page, 'aster-card-demo', 'channels');
  await page.getByTestId('ch-email-title').fill('Something else');
  await page.getByTestId('ch-email-title').blur();
  await expect(page.getByTestId('save-state')).toContainText('Unsaved');
  await expect(frameBody(page)).toContainText('Something else');
  await page.getByTestId('ch-reset').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Keep my wording' }).click();
  await expect(page.getByTestId('ch-email-title')).toHaveValue('Something else');
  await page.getByTestId('ch-reset').click();
  await page.getByTestId('ch-reset-confirm').click();
  await expect(page.getByTestId('ch-email-title')).toHaveValue('Your statement is ready');
  await expect(frameBody(page)).not.toContainText('Something else');
});
