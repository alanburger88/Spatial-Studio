import { test, expect } from '@playwright/test';
import { API, open, pickRecord, resetAll } from './helpers';

test.beforeAll(async ({ request }) => { await resetAll(request); });

test('Email tab shows subject, parity and a sandboxed 600px iframe for CARD-0001', async ({ page }) => {
  await open(page, 'aster-card-demo', 'outputs');
  await page.getByTestId('tab-email').click();
  await expect(page.getByTestId('email-subject')).toContainText('Your Aster Card statement is ready');
  await expect(page.getByTestId('email-subject')).toContainText('$45.00');
  await expect(page.getByTestId('email-iframe')).toBeVisible();
  await expect(page.getByTestId('email-iframe')).toHaveAttribute('sandbox', '');
  const frame = page.frameLocator('[data-testid="email-iframe"]');
  await expect(frame.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(frame.locator('body')).toContainText('$1,248.00');
  await expect(frame.locator('body')).toContainText('DEMO DATA');
  await expect(page.getByTestId('email-parity-overall')).toContainText('matches manifest');
  await page.getByTestId('email-view-mobile').click();
  expect((await page.getByTestId('email-iframe').boundingBox())!.width).toBeCloseTo(360, 0);
  await page.getByTestId('email-text-toggle').click();
  await expect(page.getByTestId('email-text')).toContainText('KEY FACTS');
  await expect(page.getByTestId('email-iframe')).toHaveCount(0);
});

test('SMS tab shows a segment counter and the DEMO marker', async ({ page }) => {
  await open(page, 'aster-card-demo', 'outputs');
  await page.getByTestId('tab-sms').click();
  await expect(page.getByTestId('sms-text')).toContainText('DEMO');
  await expect(page.getByTestId('sms-counter')).toHaveText(/^\d+ \/ 160 · 1 segment · GSM-7$/);
  await expect(page.getByTestId('sms-parity')).toBeVisible();
});

test('EOB-0002 email says THIS IS NOT A BILL and never shows member liability as owed', async ({ page }) => {
  await open(page, 'harborcare-demo', 'outputs');
  await pickRecord(page, 'EOB-0002');
  await page.getByTestId('tab-email').click();
  await expect(page.getByTestId('email-subject')).toContainText('not a bill');
  const frame = page.frameLocator('[data-testid="email-iframe"]');
  await expect(frame.locator('body')).toContainText('THIS IS NOT A BILL');
  await expect(frame.locator('body')).toContainText('Not determined — under review');
  await page.getByTestId('email-text-toggle').click();
  const t = (await page.getByTestId('email-text').innerText());
  expect(t).toContain('THIS IS NOT A BILL');
  expect(t.split('\n').filter((l) => /responsib/i.test(l)).join(' ')).not.toContain('$');
  await page.getByTestId('tab-sms').click();
  await expect(page.getByTestId('sms-text')).toContainText('NOT A BILL');
});

test('compose/email API returns subject, parity and stores an email artifact', async ({ request }) => {
  const r = await request.post(`${API}/compose/email`, { data: { projectId: 'aster-card-demo', recordId: 'CARD-0001' } });
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.parity.ok).toBe(true);
  expect(j.html).not.toMatch(/<script/i);
  expect(j.artifactId).toMatch(/^art-email-/);
  const a = await request.get(`${API}/artifacts/${j.artifactId}`);
  expect(a.status()).toBe(200);
  expect(await a.text()).toBe(j.html);
});
