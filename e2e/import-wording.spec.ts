/**
 * Import wording (wave 3, section 4) on Content & Translations: the studio's own export read back with no change, a
 * plain spreadsheet that brings a new language's drafts, the dry run (nothing changes before Import), undo of the whole
 * import, and an approved translation that is never overwritten. Run on an isolated stack (scripts/dev-isolated.mjs).
 */
import { test, expect, type Page } from '@playwright/test';
import { open, resetAll } from './helpers';

test.beforeEach(async ({ request }) => { await resetAll(request); });
test.afterEach(async ({ request }) => { await resetAll(request); });

const project = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().project);
const dispatch = (page: Page, cmd: unknown) => page.evaluate((c) => (window as any).__iss.store.getState().dispatch(c), cmd);
const cell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n', 'utf8');

async function openImport(page: Page, file: { name: string; buffer: Buffer } | string) {
  await page.getByTestId('tr-import-wording').first().click();
  await expect(page.getByTestId('wi-dialog')).toBeVisible();
  await page.getByTestId('wi-file').setInputFiles(typeof file === 'string' ? file : { name: file.name, mimeType: 'text/csv', buffer: file.buffer });
  await expect(page.getByTestId('wi-summary')).toBeVisible();
}

test('WI01 the studio’s own export, read back, changes nothing', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('tr-export').click()]);
  const path = (await dl.path())!;
  const before = (await project(page)).modelVersion;
  await openImport(page, path);
  await expect(page.getByTestId('wi-kind')).toHaveAttribute('data-kind', 'studio-csv');
  const summary = page.getByTestId('wi-summary');
  await expect(summary).toHaveAttribute('data-drafts', '0');
  await expect(summary).toHaveAttribute('data-english', '0');
  await expect(summary).toHaveAttribute('data-unmatched', '0');
  await expect(page.getByTestId('wi-apply')).toBeDisabled();
  await expect(page.getByTestId('wi-foot')).toHaveText('There is nothing to change.');
  expect((await project(page)).modelVersion).toBe(before);
});

test('WI02 a plain spreadsheet brings a new language’s drafts in one step that Undo takes back', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  const p = await project(page);
  const en = p.contentParts.find((c: any) => c.id === 'payment-reminder').approvedLocales['en-US'];
  await openImport(page, { name: 'wording.csv', buffer: csv([['Key', 'English', 'French', 'Notes'], ['payment-reminder', en, 'Rappel de paiement', 'from the agency'], ['', 'A sentence that is in no document at all', 'Une phrase', '']]) });
  await expect(page.getByTestId('wi-kind')).toHaveAttribute('data-kind', 'plain-csv');
  await expect(page.locator('[data-testid="wi-col"]').nth(0)).toHaveAttribute('data-role', 'id');
  await expect(page.locator('[data-testid="wi-col"]').nth(1)).toHaveAttribute('data-role', 'english');
  await expect(page.locator('[data-testid="wi-col"]').nth(2)).toHaveAttribute('data-locale', 'fr-FR');
  await expect(page.locator('[data-testid="wi-col"]').nth(3)).toHaveAttribute('data-role', 'ignore');
  await expect(page.locator('[data-testid="wi-lang"][data-locale="fr-FR"]')).toHaveAttribute('data-added', 'yes');
  const summary = page.getByTestId('wi-summary');
  await expect(summary).toHaveAttribute('data-drafts', '1');
  await expect(summary).toHaveAttribute('data-unmatched', '1');
  // the unmatched row can be made a new message instead of being skipped
  await page.getByTestId('wi-view-unmatched').click();
  await page.getByTestId('wi-decision').selectOption('new-message');
  await expect(summary).toHaveAttribute('data-new', '1');
  await expect(summary).toHaveAttribute('data-drafts', '2');
  await page.getByTestId('wi-decision').selectOption('skip');
  // still a dry run
  expect((await project(page)).modelVersion).toBe(p.modelVersion);
  await page.getByTestId('wi-apply').click();
  await expect(page.getByTestId('wi-dialog')).toHaveCount(0);
  const after = await project(page);
  expect(after.modelVersion).toBe(p.modelVersion + 1);
  expect(after.languages).toContain('fr-FR');
  expect(after.contentParts.find((c: any) => c.id === 'payment-reminder').draftLocales['fr-FR']).toBe('Rappel de paiement');
  expect(after.contentParts.find((c: any) => c.id === 'payment-reminder').approvedLocales['fr-FR']).toBeUndefined();
  expect(after.translationOrigins['fr-FR|payment-reminder']).toBe('imported');
  await page.evaluate(() => (window as any).__iss.store.getState().undo());
  const undone = await project(page);
  expect(undone.languages ?? []).not.toContain('fr-FR');
  expect(undone.contentParts.find((c: any) => c.id === 'payment-reminder').draftLocales?.['fr-FR']).toBeUndefined();
});

test('WI03 an approved translation is never overwritten: it is listed as skipped, with the reason', async ({ page }) => {
  await open(page, 'aster-card-demo', 'content');
  expect((await dispatch(page, { type: 'SET_TRANSLATION_DRAFT', partId: 'payment-reminder', locale: 'es-US', text: 'Recordatorio aprobado' })).ok).toBe(true);
  expect((await dispatch(page, { type: 'APPROVE_TRANSLATION', partId: 'payment-reminder', locale: 'es-US' })).ok).toBe(true);
  await openImport(page, { name: 'es.csv', buffer: csv([['id', 'es-US'], ['payment-reminder', 'Otro texto'], ['@billing-summary/label', 'Saldo nuevo importado']]) });
  const summary = page.getByTestId('wi-summary');
  await expect(summary).toHaveAttribute('data-drafts', '1');
  await page.getByTestId('wi-view-skipped').click();
  await expect(page.getByTestId('wi-skipped').first()).toContainText('which an import never replaces');
  // asked for, it becomes a draft beside the approved text (still never approved)
  await page.getByTestId('wi-draft-over-approved').check();
  await expect(summary).toHaveAttribute('data-drafts', '2');
  await page.getByTestId('wi-draft-over-approved').uncheck();
  await page.getByTestId('wi-apply').click();
  const after = await project(page);
  const part = after.contentParts.find((c: any) => c.id === 'payment-reminder');
  expect(part.approvedLocales['es-US']).toBe('Recordatorio aprobado');
  expect(part.draftLocales?.['es-US']).toBeUndefined();
  expect(after.strings['@billing-summary/label'].draft['es-US']).toBe('Saldo nuevo importado');
  // the Translations table marks the draft as imported and not reviewed
  await page.getByTestId('tr-search').fill('Saldo nuevo importado');
  await expect(page.locator('[data-testid="tr-origin"][data-origin="imported"]').first()).toContainText('Imported draft');
});
