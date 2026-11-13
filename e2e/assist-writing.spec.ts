/**
 * Writing help: rewrite actions, new version, image description (Design inspector); fit the SMS and subject lines
 * (Email & SMS); Check drafts and the glossary (Content & Translations).
 * No AI key is configured in the test environment: the "needs an AI key" state is seen for real. The model-backed paths are
 * exercised only by fulfilling the assist routes with replies shaped like the client types (this tests the UI, not a model).
 */
import { test, expect, type Page } from '@playwright/test';
import { open, resetAll } from './helpers';

test.beforeEach(async ({ request }) => { await resetAll(request); });

const project = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().project);
const part = (page: Page, id: string) => page.evaluate((pid) => (window as any).__iss.store.getState().project.contentParts.find((c: any) => c.id === pid), id);
const select = (page: Page, id: string) => page.evaluate((nid) => (window as any).__iss.store.getState().select(nid), id);

async function openInspector(page: Page, nodeId: string, tab = 'insp-tab-content') {
  await open(page, 'aster-card-demo', 'design');
  await select(page, nodeId);
  await expect(page.getByTestId('component-inspector')).toBeVisible();
  await page.getByTestId(tab).click();
}

test('inspector: writing help shows the reading level, needs a key without one, and a rewrite goes into the editor, then commits and undoes', async ({ page }) => {
  await openInspector(page, 'payment-guidance');
  const list = page.getByTestId('variants-editor');
  const first = list.locator('li').first();
  const vid = (await first.getAttribute('data-testid'))!.replace('variant-', '');
  const original = (await part(page, vid)).approvedLocales['en-US'] as string;
  await first.getByRole('button', { name: 'Edit text' }).click();
  await page.getByTestId('writing-help').click();
  await expect(page.getByTestId('writing-help-panel')).toBeVisible();
  await expect(page.getByTestId('writing-reading-level')).toContainText(/Reading level: .*grade \d+\) · \d+ words/);

  // no AI key: the plain needs-a-key state, nothing suggested
  await page.getByTestId('rewrite-shorter').click();
  await expect(page.getByTestId('assist-needs-ai')).toBeVisible();
  await expect(page.getByTestId('assist-suggestion')).toHaveCount(0);

  // a reply shaped like the client type (not a model): the option appears beside the original
  const suggestion = 'Please pay what you owe by the due date.';
  let sent: any = null;
  await page.route('**/assist/rewrite', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ json: { mode: 'ai', message: '', options: [{ text: suggestion, tokenCheck: { ok: true, missing: [], extra: [] } }] } });
  });
  await page.getByTestId('rewrite-plainer').click();
  await expect(page.getByTestId('assist-suggestion')).toBeVisible();
  await expect(page.getByTestId('assist-suggestion-text')).toHaveText(suggestion);
  await expect(page.getByTestId('assist-suggestion')).toContainText(original.slice(0, 20));
  await expect(page.getByTestId('assist-source')).toHaveAttribute('data-source', 'ai');
  expect(sent.style).toBe('plainer');
  expect(sent.kind).toBe('message');
  expect(sent.project.projectId).toBe('aster-card-demo');

  const before = (await project(page)).modelVersion;
  await page.getByTestId('assist-accept').click();
  await expect(page.getByTestId('writing-help-panel')).toHaveCount(0);
  await expect(page.getByTestId('writing-help')).toBeFocused();
  await expect(page.getByTestId('variant-edit-text')).toHaveValue(suggestion);
  expect((await project(page)).modelVersion).toBe(before); // nothing is written behind the person's back
  await first.getByRole('button', { name: 'Save text (new version)' }).click();
  expect((await part(page, vid)).approvedLocales['en-US']).toBe(suggestion);
  await page.getByTestId('undo').click();
  expect((await part(page, vid)).approvedLocales['en-US']).toBe(original);
});

test('inspector: Escape closes writing help and focus returns to its button', async ({ page }) => {
  await openInspector(page, 'payment-guidance');
  await page.getByTestId('variants-editor').locator('li').first().getByRole('button', { name: 'Edit text' }).click();
  await page.getByTestId('writing-help').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('writing-help-panel')).toBeVisible();
  await page.getByTestId('rewrite-formal').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('writing-help-panel')).toHaveCount(0);
  await expect(page.getByTestId('writing-help')).toBeFocused();
});

test('inspector: draft a new version needs a key without one; with a reply it adds a version through the normal path', async ({ page }) => {
  await openInspector(page, 'payment-guidance');
  const n0 = (await page.evaluate(() => (window as any).__iss.store.getState().project.nodes.find((n: any) => n.id === 'payment-guidance').variantIds.length)) as number;
  await page.getByTestId('new-version-ai').click();
  await expect(page.getByTestId('new-version-draft')).toBeDisabled(); // a brief is required
  await page.getByTestId('new-version-brief').fill('For customers who just made a late payment');
  await page.getByTestId('new-version-draft').click();
  await expect(page.getByTestId('assist-needs-ai')).toBeVisible();
  await expect(page.getByTestId('new-version-suggestion')).toHaveCount(0);

  await page.route('**/assist/new-version', (route) => route.fulfill({ json: { mode: 'ai', message: '', title: 'Late payment thanks', text: 'Thank you for your recent payment, {{customer.givenName}}.' } }));
  await page.getByTestId('new-version-draft').click();
  await expect(page.getByTestId('new-version-suggestion')).toBeVisible();
  await expect(page.getByTestId('new-version-title')).toHaveText('Late payment thanks');
  await page.getByTestId('new-version-accept').click();
  const p = await project(page);
  const node = p.nodes.find((x: any) => x.id === 'payment-guidance');
  expect(node.variantIds.length).toBe(n0 + 1);
  const vid = node.variantIds[node.variantIds.length - 1];
  const added = await part(page, vid);
  expect(added.title).toBe('Late payment thanks');
  expect(added.approvedLocales['en-US']).toBe('Thank you for your recent payment, {{customer.givenName}}.');
  await expect(page.getByTestId('new-version-reminder')).toContainText('rule');
  await expect(page.getByTestId('variant-edit-text')).toHaveValue('Thank you for your recent payment, {{customer.givenName}}.');
});

test('inspector: image description is suggested built-in and fills the alt text field', async ({ page }) => {
  await openInspector(page, 'issuer-logo', 'inspector-tab-comments');
  await page.getByTestId('alt-suggest').click();
  await expect(page.getByTestId('assist-suggestion')).toBeVisible();
  await expect(page.getByTestId('assist-source')).toHaveAttribute('data-source', 'builtin');
  await expect(page.getByTestId('alt-suggest-basis')).toContainText('Based on');
  const text = (await page.getByTestId('assist-suggestion-text').innerText()).trim();
  expect(text.length).toBeGreaterThan(3);
  // the picture-based path needs a key here
  await page.getByTestId('alt-suggest-ai').click();
  await expect(page.getByTestId('assist-needs-ai')).toBeVisible();
  await page.getByTestId('assist-accept').first().click();
  await expect(page.getByTestId('alt-text-input')).toHaveValue(text);
  await expect(page.getByTestId('alt-text-input')).toBeFocused();
  await page.getByTestId('alt-text-input').blur();
  expect((await page.evaluate(() => (window as any).__iss.store.getState().project.nodes.find((n: any) => n.id === 'issuer-logo').image.alt))).toBe(text);
});

test('email and SMS: fit in one message (built-in), subject lines need a key, and with a reply fill the subject', async ({ page }) => {
  await open(page, 'aster-card-demo', 'channels');
  // subject
  await page.getByTestId('subject-suggest').click();
  await expect(page.getByTestId('assist-needs-ai')).toBeVisible();
  await page.route('**/assist/subject-lines', (route) => route.fulfill({ json: { mode: 'ai', message: '', options: [{ text: 'Your statement is ready' }, { text: 'Your Aster Card statement is ready to read and pay online today, with a clear summary of the balance and the due date' }, { text: 'Statement ready' }] } }));
  await page.getByTestId('subject-suggest').click();
  await expect(page.getByTestId('subject-option')).toHaveCount(3);
  await expect(page.getByTestId('subject-option-length').first()).toContainText('23 characters');
  await expect(page.getByTestId('subject-option-length').nth(1)).toContainText(/long/);
  await page.getByTestId('subject-option-use').first().click();
  await expect(page.getByTestId('ch-email-subject')).toHaveValue('Your statement is ready');

  // opening text has writing help
  await page.getByTestId('writing-help-intro').click();
  await expect(page.getByTestId('writing-help-intro-panel')).toBeVisible();
  await page.keyboard.press('Escape');

  // SMS
  await page.getByTestId('ch-tab-sms').click();
  const long = 'DEMO {{issuer.name}}: Here’s your “statement” — it’s ready. New balance {{card.newBalanceCents}}; minimum due {{card.minimumDueCents}} by {{card.dueDate}}.   You do not need to call us and you cannot be charged for reading this  message.  We are here to help you.  {{link}}';
  await page.getByTestId('ch-sms-text').fill(long);
  await page.getByTestId('ch-sms-text').blur();
  await expect(page.getByTestId('ch-sms-meter')).toHaveAttribute('data-encoding', 'UCS-2');
  await page.getByTestId('sms-fit').click();
  await expect(page.getByTestId('assist-source')).toHaveAttribute('data-source', 'builtin');
  const nums = (s: string) => Number(s.match(/(\d+) characters/)![1]);
  const b = nums(await page.getByTestId('sms-fit-before').innerText());
  const a = nums(await page.getByTestId('sms-fit-after').innerText());
  expect(a).toBeLessThan(b);
  expect(await page.getByTestId('sms-fit-changes').locator('li').count()).toBeGreaterThan(0);
  await expect(page.getByTestId('sms-fit-after')).toContainText('GSM-7');
  const suggested = (await page.getByTestId('assist-suggestion-text').innerText());
  expect(suggested).not.toMatch(/[’“”—]/);
  expect(suggested).toContain('{{link}}');
  await page.getByTestId('assist-accept').click();
  await expect(page.getByTestId('ch-sms-text')).toHaveValue(suggested);
  await expect(page.getByTestId('ch-sms-meter')).toHaveAttribute('data-encoding', 'GSM-7');
  await expect.poll(async () => (await project(page)).channels?.sms?.text).toBe(suggested);

  // AI rewrite to fit: needs a key
  await page.getByTestId('sms-fit-ai').click();
  await expect(page.getByTestId('assist-needs-ai')).toBeVisible();
});

async function draftSamples(page: Page) {
  await open(page, 'aster-card-demo', 'content');
  await page.getByTestId('tr-ai-draft-all').click();
  await expect(page.getByTestId('tr-ai-result')).toHaveAttribute('data-mode', 'sample');
}

test('translations: Check drafts is quiet on the samples, flags untranslated and length, and Flagged narrows the list', async ({ page }) => {
  await draftSamples(page);
  await page.getByTestId('tr-check').click();
  await expect(page.getByTestId('tr-check-result')).toContainText(/0 texts flagged of \d+ checked/);
  await expect(page.getByTestId('tr-check-meaning-note')).toContainText('Meaning check needs an AI key; the built-in checks below still ran');
  await expect(page.getByTestId('tr-flag')).toHaveCount(0);

  // a message left identical to the English
  await page.getByTestId('tr-group-messages').click();
  const plainRow = page.getByTestId('tr-row').filter({ hasNot: page.locator('mark.tr-token') }).first();
  const plainId = (await plainRow.getAttribute('data-part'))!;
  const english = (await plainRow.locator('.tr-en').innerText()).trim();
  await plainRow.getByTestId('tr-draft-input').fill(english);
  await plainRow.getByTestId('tr-draft-input').blur();
  // a label three times as long
  await page.getByTestId('tr-group-labels').click();
  const labelRow = page.locator('[data-testid="tr-row"][data-part*="/label"]').first();
  const labelId = (await labelRow.getAttribute('data-part'))!;
  const labelInput = labelRow.getByTestId('tr-draft-input');
  const cur = await labelInput.inputValue();
  await labelInput.fill(`${cur} ${cur} ${cur}`);
  await labelInput.blur();

  await page.getByTestId('tr-check').click();
  await page.getByTestId('tr-group-all').click();
  await expect(page.locator(`[data-part="${plainId}"] [data-testid="tr-flag"][data-kind="untranslated"][data-source="builtin"]`)).toBeVisible();
  await expect(page.locator(`[data-part="${labelId}"] [data-testid="tr-flag"][data-kind="length"]`)).toBeVisible();
  await expect(page.getByTestId('tr-check-result')).toContainText(/[12] texts? flagged/);
  const total = await page.getByTestId('tr-row').count();
  await page.getByTestId('tr-filter-flagged').click();
  const flaggedRows = await page.getByTestId('tr-row').count();
  expect(flaggedRows).toBeGreaterThanOrEqual(2);
  expect(flaggedRows).toBeLessThan(total);
  await expect(page.getByTestId('tr-row').locator('[data-testid="tr-flag"]')).not.toHaveCount(0);

  // flags never change or approve text: still drafts; editing a text removes its flags until the next check
  await expect(page.locator(`[data-part="${plainId}"]`)).toHaveAttribute('data-status', 'draft');
  const inp = page.locator(`[data-part="${plainId}"]`).getByTestId('tr-draft-input');
  await inp.fill(english + ' (revisado)');
  await expect(page.locator(`[data-part="${plainId}"] [data-testid="tr-flag"]`)).toHaveCount(0);
});

test('translations: glossary saves one undoable step and a differing draft gets a glossary flag', async ({ page }) => {
  await draftSamples(page);
  // a text whose English has the word "statement" and whose draft does not use the preferred wording
  await page.getByTestId('tr-glossary-open').click();
  await expect(page.getByTestId('tr-glossary')).toBeVisible();
  await page.getByTestId('tr-glossary-add').click();
  await page.getByTestId('tr-glossary-source').fill('statement');
  await page.getByTestId('tr-glossary-target').fill('estado de cuenta');
  await page.getByTestId('tr-glossary-save').click();
  await expect(page.getByTestId('tr-glossary')).toHaveCount(0);
  await expect(page.getByTestId('tr-glossary-count')).toHaveText('1');
  expect((await project(page)).glossary['es-US']).toEqual([{ source: 'statement', target: 'estado de cuenta' }]);

  // reopening shows it; a rejected save explains why inline
  await page.getByTestId('tr-glossary-open').click();
  await expect(page.getByTestId('tr-glossary-source')).toHaveValue('statement');
  await expect(page.getByTestId('tr-glossary-target')).toHaveValue('estado de cuenta');
  await page.getByTestId('tr-glossary-add').click();
  await page.getByTestId('tr-glossary-source').nth(1).fill('Statement');
  await page.getByTestId('tr-glossary-target').nth(1).fill('extracto');
  await page.getByTestId('tr-glossary-save').click();
  await expect(page.getByTestId('tr-glossary-error')).toContainText('twice');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tr-glossary')).toHaveCount(0);

  // make one draft that renders "statement" differently
  const row = page.getByTestId('tr-row').filter({ has: page.locator('.tr-en', { hasText: /\bstatement\b/i }) }).first();
  const partId = (await row.getAttribute('data-part'))!;
  const en = await row.locator('.tr-en').innerText();
  expect(en).toMatch(/statement/i);
  const input = row.getByTestId('tr-draft-input');
  await input.fill((await input.inputValue()).replace(/estado de cuenta/gi, 'resumen') + (/resumen/i.test(await input.inputValue()) ? '' : ' resumen'));
  await input.blur();
  await page.getByTestId('tr-check').click();
  await expect(page.locator(`[data-part="${partId}"] [data-testid="tr-flag"][data-kind="glossary"]`)).toBeVisible();

  // Undo removes the glossary change
  await page.getByTestId('undo').click(); // the draft edit
  await page.getByTestId('undo').click(); // the glossary
  await expect.poll(async () => (await project(page)).glossary?.['es-US'] ?? null).toBeNull();
  await expect(page.getByTestId('tr-glossary-count')).toHaveText('0');
});
