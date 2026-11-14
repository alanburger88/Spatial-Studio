/**
 * Assistant column matching in the customer import (built-in, no AI model): everyday column names are matched to
 * data fields with a confidence and a reason, values that do not fit are flagged, and nothing is imported by the matching itself.
 */
import { test, expect } from '@playwright/test';
import { resetAll } from './helpers';

test.beforeEach(async ({ request }) => { await resetAll(request); });

test('I01 import: everyday column names are matched with reasons, a dollars-not-cents value is flagged, an unknown column is left out', async ({ page }) => {
  await page.goto('/projects');
  await page.getByTestId('import-records').click();
  await page.getByText('…or paste data').click();
  await page.getByTestId('import-text').fill('Customer ID,First name,Surname,Language,Min payment,New balance,Due date,Mood\nC-1,Robin,Quill,en-US,45.00,124800,2026-11-25,happy\n');
  const map = page.getByTestId('import-mapping');
  await expect(map).toContainText('7 of 8 columns used');
  await expect(map).toContainText('Built-in matching');
  // first name -> given name, pre-selected, with the reason
  await expect(page.getByTestId('map-1')).toHaveValue('customer.givenName');
  await expect(page.getByTestId('match-1')).toHaveAttribute('data-confidence', 'likely');
  await expect(page.getByTestId('match-1')).toContainText('Given name');
  // a decimal amount where whole cents are expected is called out
  await expect(page.getByTestId('map-4')).toHaveValue('card.minimumDueCents');
  await expect(page.getByTestId('match-problem-4')).toContainText(/dollars/i);
  // an unknown column is not guessed
  await expect(page.getByTestId('map-7')).toHaveValue('');
  await expect(page.getByTestId('match-7')).toHaveAttribute('data-confidence', 'none');
  // the corrected file can be downloaded with data-field names as headers
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('import-rename-download').click()]);
  const csv = (await (await download.createReadStream()).toArray()).map((c) => c.toString()).join('');
  expect(csv.split(/\r?\n/)[0]).toBe('recordId,customer.givenName,customer.familyName,customer.locale,card.minimumDueCents,card.newBalanceCents,card.dueDate');
  expect(csv).not.toContain('happy');
});
