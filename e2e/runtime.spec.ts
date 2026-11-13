import { expect, test, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { API, open, resetAll, setView } from './helpers';

/**
 * The runnable package section of the Releases screen (phase 7). Works on its own duplicate of the HarborCare sample,
 * like releases.spec.ts, because releases persist across resetAll. Building it composes real PDFs on the test stack
 * (the release package first, then the proof pack), so the build is given time.
 */

test.beforeEach(async ({ request }) => { await resetAll(request); });

let pid = '';
test.beforeEach(async ({ request }) => {
  const r = await request.post(`${API}/projects/harborcare-demo/duplicate`, { data: { title: `Runtime E2E ${Date.now().toString(36)}` } });
  expect(r.ok()).toBeTruthy();
  pid = (await r.json()).project.projectId;
});
test.afterEach(async ({ request }) => { if (pid) await request.delete(`${API}/projects/${pid}`); });

async function approve(request: APIRequestContext) {
  for (const action of ['submit', 'approve']) {
    const r = await request.post(`${API}/projects/${pid}/workflow`, { data: { action } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
}

test('RT01 prepare the runnable package: busy, then ready with size, fingerprint and the three commands; it downloads and checks again', async ({ page, request }) => {
  test.setTimeout(300_000);
  await approve(request);
  await open(page, pid, 'releases');
  const section = page.getByTestId('rel-runtime');
  await expect(section).toBeVisible();
  await expect(section).toContainText('Runnable package');
  await expect(section).toContainText('another system can produce the PDF, web page, email and SMS itself');
  await expect(section.getByTestId('rel-runtime-status')).toHaveText('Not built');
  await expect(section.getByTestId('rel-runtime-download')).toHaveCount(0);
  // it sits under the release package section
  const boxes = await Promise.all(['rel-package', 'rel-runtime'].map(async (id) => (await page.getByTestId(id).boundingBox())!.y));
  expect(boxes[1]).toBeGreaterThan(boxes[0]);

  await section.getByTestId('rel-runtime-prepare').click();
  await expect(section.getByTestId('rel-runtime-busy')).toBeVisible();
  await expect(section.getByTestId('rel-runtime-status')).toHaveText('Ready', { timeout: 240_000 });
  await expect(section.getByTestId('rel-runtime-busy')).toHaveCount(0);
  await expect(section.getByTestId('rel-runtime-size')).toContainText(/\d+(\.\d)? MB · \d+ files · \d+ synthetic proof cases/);
  const status = (await (await request.get(`${API}/releases/${pid}-r1/runtime/status`)).json()).runtime;
  await expect(section.getByTestId('rel-runtime-fingerprint')).toContainText(status.sha256.slice(0, 12));
  await expect(section.getByTestId('rel-runtime-commands')).toContainText('node verify');
  await expect(section.getByTestId('rel-runtime-commands')).toContainText('node run --data customers.jsonl --outputs pdf,html,email,sms --out out');
  await expect(section.getByTestId('rel-runtime-commands')).toContainText('node serve --port 8787');
  // the release package was prepared for it
  await expect(page.getByTestId('rel-package').getByTestId('rel-package-status')).toHaveText('Ready', { timeout: 30_000 });

  const [download] = await Promise.all([page.waitForEvent('download'), section.getByTestId('rel-runtime-download').click()]);
  expect(download.suggestedFilename()).toBe(`${pid}-r1-runtime.zip`);
  const body = readFileSync((await download.path())!);
  expect(createHash('sha256').update(body).digest('hex')).toBe(status.sha256);
  expect(body.length).toBe(status.bytes);

  await setView(page, 'technical');
  await expect(section.getByTestId('rel-runtime-tech')).toContainText(status.sha256);
  await expect(section.getByTestId('rel-runtime-tech')).toContainText(status.engine.version);

  await section.getByTestId('rel-runtime-verify').click();
  await expect(section.getByTestId('rel-runtime-verified')).toContainText('building it again gives exactly the same package', { timeout: 240_000 });

  // Activity names it in words
  const events = (await (await request.get(`${API}/audit?action=release.runtime&limit=50`)).json()).events as any[];
  expect(events.filter((e) => e.detail.releaseId === `${pid}-r1`).map((e) => e.detail.event).reverse()).toEqual(['started', 'ready', 'check-started', 'checked']);
});
