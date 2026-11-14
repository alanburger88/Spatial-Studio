/** Rules & Data: decision-table view (gap/overlap analysis) and pinned regression tests. */
import { test, expect } from '@playwright/test';
import { API, demoTool, open, pickRecord, plainCopy, resetAll } from './helpers';

test.beforeEach(async ({ request }) => { await resetAll(request); });
const plain: string[] = [];
test.afterEach(async ({ request }) => { while (plain.length) await request.delete(`${API}/projects/${plain.pop()}`); });

test('decision table lists Payment guidance rules in priority order and flags an injected tie', async ({ page }) => {
  await open(page, 'aster-card-demo', 'rules-data');
  await page.getByTestId('rules-view-table').click();
  await expect(page.getByTestId('view-table')).toBeVisible();
  const rows = page.getByTestId('dt-row');
  await expect(rows).toHaveCount(5);
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-rule-id')))).toEqual(['R05', 'R04', 'R03', 'R02', 'R01']);
  await expect(page.getByTestId('dt-fallback')).toBeVisible();
  await expect(page.getByTestId('dt-overlap')).toHaveCount(0);
  // wins come from the resolver and add up to the 70 synthetic records
  const wins = await page.getByTestId('dt-wins').allInnerTexts();
  expect(wins.reduce((s, t) => s + Number(t.trim().split(/\s+/)[0]), 0)).toBe(70);

  // inject D01 from the defect strip, come back to the table
  await page.getByTestId('rules-view-editor').click();
  await demoTool(page, 'seed-d01');
  await page.getByTestId('rules-view-table').click();
  await expect(page.getByTestId('dt-overlap')).toBeVisible();
  await expect(page.getByTestId('dt-overlap')).toContainText('R03');
  await expect(page.getByTestId('dt-overlap')).toContainText('R04');
  await expect(page.getByTestId('dt-overlap')).toContainText('Seen in synthetic records');
  await expect(page.getByTestId('dt-overlap')).toContainText('Possible combination');

  // a link jumps to the rule in the editor
  await page.getByTestId('dt-link-R03').first().click();
  await expect(page.getByTestId('rule-editor')).toBeVisible();
  await expect(page.getByTestId('rule-row-R03')).toHaveAttribute('aria-pressed', 'true');
});

test('pin CARD-0002 as a test; disabling R04 fails it in plain language and undo passes it again', async ({ page, request }) => {
  // The stored card sample has pinned tests of its own since D106: start from the card as the fixtures build it (none yet).
  const { projectId } = await plainCopy(request, 'aster-card-demo', 'Pinned tests E2E');
  plain.push(projectId);
  await open(page, projectId, 'rules-data');
  await expect(page.getByTestId('tests-summary')).toContainText('No tests');
  await pickRecord(page, 'CARD-0002');
  await page.getByTestId('rules-view-tests').click();
  await expect(page.getByTestId('tests-panel')).toContainText('No tests yet');
  await page.getByTestId('pin-test').click();
  await page.getByTestId('pin-name').fill('Assistance requested customer');
  await page.getByTestId('pin-confirm').click();
  await expect(page.getByTestId('test-row')).toHaveCount(1);
  await expect(page.getByTestId('test-status')).toContainText('Pass');
  await expect(page.getByTestId('tests-summary')).toContainText('1 of 1 tests pass');

  // draft impact next to Apply: narrow R04 so it no longer matches CARD-0002 -> would break the test
  await page.getByTestId('rules-view-editor').click();
  await page.getByTestId('rule-row-R04').click();
  await page.getByTestId('tab-ast').click();
  await page.getByTestId('ast-textarea').fill('{"op":"eq","path":"card.assistanceRequested","value":false}');
  await expect(page.getByTestId('draft-tests')).toContainText('Would break 1 of 1 test');
  await page.getByRole('button', { name: 'Revert draft' }).click();

  // disable R04 in the model
  await page.getByTestId('rule-enabled-toggle').click();
  await page.getByTestId('rules-view-tests').click();
  await expect(page.getByTestId('test-status')).toContainText('Fail');
  await expect(page.getByTestId('test-diffs')).toContainText('Payment guidance: expected');
  await expect(page.getByTestId('test-diffs')).not.toContainText('payment-assistance-requested');
  await expect(page.getByTestId('tests-summary')).toContainText('fail');

  await page.getByTestId('undo').click();
  await expect(page.getByTestId('test-status')).toContainText('Pass');
  await expect(page.getByTestId('tests-summary')).toContainText('1 of 1 tests pass');

  // delete (confirmed)
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('test-delete').click();
  await expect(page.getByTestId('test-row')).toHaveCount(0);
});
