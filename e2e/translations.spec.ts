/** Content & Translations: language tabs, groups, AI/sample first pass, bulk approval, adding and removing languages. */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { open, pickRecord, resetAll } from './helpers';

test.beforeEach(async ({ request }) => { await resetAll(request); });

const rows = (page: Page) => page.getByTestId('tr-row');
const undoCount = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().past.length as number);

async function draftAll(page: Page) {
  await page.getByTestId('tr-ai-draft-all').click();
  await expect(page.getByTestId('tr-ai-result')).toBeVisible();
}

test('language bar, three groups with counts and honest AI status', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  await expect(page.getByTestId('tr-lang-es-US')).toHaveAttribute('aria-selected', 'true');
  const all = Number((await page.getByTestId('tr-group-all').innerText()).match(/\d+/)![0]);
  expect(all).toBeGreaterThan(20);
  let sum = 0;
  for (const g of ['messages', 'labels', 'channels']) {
    const n = Number((await page.getByTestId(`tr-group-${g}`).innerText()).match(/(\d+)$/)![1]);
    expect(n).toBeGreaterThan(0);
    sum += n;
    await page.getByTestId(`tr-group-${g}`).click();
    await expect(rows(page)).toHaveCount(n);
    for (const d of await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-group')))) expect(d).toBe(g);
  }
  expect(sum).toBe(all);
  await page.getByTestId('tr-group-all').click();
  await expect(rows(page)).toHaveCount(all);
  await expect(page.getByTestId('tr-summary')).toContainText(new RegExp(`0 of ${all} approved`));
  await expect(page.getByTestId('tr-ai-status')).toHaveAttribute('data-live', /^(on|off)$/);
});

test('sample drafts, edit clears the chip, token mismatch blocks, bulk approve unblocks Spanish customers, undo', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  await pickRecord(page, 'CARD-0001');
  await page.getByTestId('select-language').selectOption('es-US');
  await expect(page.getByTestId('dock-status')).toContainText(/blocking/);
  const before = await undoCount(page);

  await draftAll(page);
  await expect(page.getByTestId('tr-ai-result')).toHaveAttribute('data-mode', 'sample');
  await expect(page.getByTestId('tr-ai-result')).toContainText(/sample/i);
  expect(await undoCount(page)).toBe(before + 1); // one undo step for the whole batch
  const total = await rows(page).count();
  await expect(page.getByTestId('tr-origin')).toHaveCount(total);
  await expect(page.getByTestId('tr-origin').first()).toHaveAttribute('data-origin', 'sample');
  await expect(page.getByTestId('tr-origin').first()).toContainText('Sample draft');
  await expect(page.getByTestId('tr-origin').first()).toContainText('not reviewed');
  await expect(page.getByTestId('tr-ai-draft-row')).toHaveCount(0);

  // a person edits one row: its chip goes away, the others stay
  const edited = rows(page).first();
  const input = edited.getByTestId('tr-draft-input');
  await input.fill((await input.inputValue()) + ' (revisado)');
  await input.blur();
  await expect(edited.getByTestId('tr-origin')).toHaveCount(0);
  await expect(page.getByTestId('tr-origin')).toHaveCount(total - 1);

  // a draft that lost its data token cannot be approved
  const tokenRow = rows(page).filter({ has: page.locator('.tr-token') }).first();
  const tokenInput = tokenRow.getByTestId('tr-draft-input');
  await tokenInput.fill('Texto sin el dato.');
  await tokenInput.blur();
  await expect(tokenRow.getByTestId('tr-token-warning')).toBeVisible();
  await tokenRow.getByTestId('tr-approve').click();
  await expect(tokenRow.getByTestId('tr-status')).not.toContainText('Approved');

  // bulk approve leaves the broken one out
  await page.getByTestId('tr-approve-all').click();
  const confirm = page.getByTestId('tr-approve-all-confirm');
  await expect(confirm).toContainText(/data-field mismatch/);
  await expect(confirm).toContainText(/untouched/);
  await page.getByTestId('tr-approve-all-apply').click();
  await expect(page.getByTestId('tr-approve-all-confirm')).toHaveCount(0);
  await expect(page.getByTestId('tr-summary')).toContainText(new RegExp(`${total - 1} of ${total} approved`));
  await expect(tokenRow.getByTestId('tr-status')).not.toContainText('Approved');
  // fix the broken row, approve it, then nothing required is missing
  await tokenRow.getByTestId('tr-insert-tokens').click();
  await tokenRow.getByTestId('tr-approve').click();
  await expect(page.getByTestId('tr-summary')).toContainText(`${total} of ${total} approved`);
  await expect(page.getByTestId('tr-summary')).toContainText('All required text is approved');
  await expect(page.getByTestId('tr-summary')).not.toContainText('still missing');
  await expect(page.getByTestId('dock-status')).not.toContainText(/blocking/);

  // undo steps back through the approvals and then the whole sample batch
  const now = await undoCount(page);
  for (let i = 0; i < now - before; i++) await page.getByTestId('undo').click();
  await expect(page.getByTestId('tr-origin')).toHaveCount(0);
  await expect(page.getByTestId('tr-summary')).toContainText(new RegExp(`0 of ${total} approved`));
  await expect(page.getByTestId('tr-summary')).not.toContainText('drafts waiting');
});

test('draft a single row with the row action', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  const first = rows(page).first();
  const id = await first.getAttribute('data-part');
  await first.getByTestId('tr-ai-draft-row').click();
  await expect(page.getByTestId('tr-ai-result')).toHaveAttribute('data-mode', 'sample');
  await expect(rows(page).and(page.locator(`[data-part="${id}"]`)).getByTestId('tr-origin')).toBeVisible();
  await expect(page.getByTestId('tr-origin')).toHaveCount(1);
});

test('add French through the dialog, see the unavailable explanation, remove it again', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  await page.getByTestId('tr-add-language').click();
  await page.getByTestId('tr-language-search').fill('français');
  await expect(page.getByTestId('tr-language-option').first()).toBeVisible();
  await expect(page.locator('[data-testid=tr-language-option][data-code="es-US"]')).toHaveCount(0); // already added
  await page.locator('[data-testid=tr-language-option][data-code="fr-FR"]').click();
  await expect(page.getByTestId('tr-lang-fr-FR')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tr-lang-es-US')).toBeVisible();
  await page.getByTestId('tr-ai-draft-all').click();
  const res = page.getByTestId('tr-ai-result');
  await expect(res).toHaveAttribute('data-mode', 'unavailable');
  await expect(res).not.toHaveText('');
  await expect(page.getByTestId('tr-origin')).toHaveCount(0);
  await page.getByTestId('tr-remove-language').click();
  await page.getByTestId('tr-remove-language-confirm').click();
  await expect(page.getByTestId('tr-lang-fr-FR')).toHaveCount(0);
  await expect(page.getByTestId('tr-lang-es-US')).toHaveAttribute('aria-selected', 'true');
});

test('Spanish cannot be removed while a rule selects it', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  await page.getByTestId('tr-remove-language').click();
  await page.getByTestId('tr-remove-language-confirm').click();
  await expect(page.getByTestId('tr-language-error')).toContainText(/rule/i);
  await expect(page.getByTestId('tr-lang-es-US')).toBeVisible();
});

test('Preview in this language switches the previewed language and opens Preview & Export', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  await page.getByTestId('tr-preview-language').click();
  await expect(page).toHaveURL(/\/outputs$/);
  await expect(page.getByTestId('select-language')).toHaveValue('es-US');
});
