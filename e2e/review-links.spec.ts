import { expect, test, type APIRequestContext } from '@playwright/test';
import { API, open } from './helpers';

/**
 * Review links (docs/design/WAVE4_TEAMS.md section 1): make a link in the studio, open it in a fresh browser with no
 * studio session, switch customer, output and language, comment, see the comment in the studio, answer it, see the
 * answer through the link, revoke it, and the link is then dead with the same words as a made-up token.
 * Every test works on its own copy of the HarborCare sample and deletes it afterwards (releases are kept by design).
 */

const DEAD = 'This review link is not available. Ask the person who sent it for a new one.';
let pid = '';
test.beforeEach(async ({ request }) => {
  const r = await request.post(`${API}/projects/harborcare-demo/duplicate`, { data: { title: `Review links E2E ${Date.now().toString(36)}` } });
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

/** Gives the copy approved Spanish wording, so a link can offer a second language. */
async function addSpanish(request: APIRequestContext) {
  const p = (await (await request.get(`${API}/projects/${pid}`)).json()).project;
  for (const c of p.contentParts) c.approvedLocales['es-US'] = `ES: ${c.approvedLocales['en-US']}`;
  p.languages = ['es-US'];
  const r = await request.put(`${API}/projects/${pid}`, { data: { project: { ...p, modelVersion: p.modelVersion + 1 } }, headers: { 'If-Match': `"${p.modelVersion}"` } });
  expect(r.ok(), await r.text()).toBeTruthy();
}

test('RL01 make a link, review through it without a session, comment, answer, revoke', async ({ page, browser, request }) => {
  await addSpanish(request);
  await approve(request);
  await open(page, pid, 'releases');

  // Make the link from the release.
  await page.getByTestId('rel-share-review').click();
  const dialog = page.getByTestId('share-review-dialog');
  await expect(dialog.getByTestId('share-review-customers')).toBeVisible();
  await expect(dialog).toContainText('Only built-in sample customers and generated test customers can be shared');
  await dialog.getByTestId('share-review-label').fill('Plain English check');
  const boxes = dialog.locator('[data-testid^="share-review-customer-"]');
  expect(await boxes.count()).toBeGreaterThan(1);
  if (!(await boxes.nth(1).isChecked())) await boxes.nth(1).check();
  if (!(await boxes.nth(0).isChecked())) await boxes.nth(0).check();
  await expect(dialog.getByTestId('share-review-days')).toHaveValue('7');
  await page.getByTestId('share-review-make').click();
  const made = page.getByTestId('share-review-made');
  await expect(made.getByTestId('share-review-once')).toContainText('cannot be shown again');
  const url = await made.getByTestId('share-review-url').inputValue();
  expect(url).toMatch(/\/review\/[A-Za-z0-9_-]{43}$/);
  await page.getByTestId('share-review-done').click();
  const row = page.getByTestId('review-link-row').filter({ hasText: 'Plain English check' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('2 customers');
  await expect(page.getByTestId('review-links-panel')).not.toContainText(url.split('/review/')[1]);

  // A fresh browser with no studio session.
  const outside = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const rp = await outside.newPage();
  const studioCalls: string[] = [];
  rp.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/') && !u.pathname.startsWith('/api/v1/review/')) studioCalls.push(u.pathname); });
  const res = await rp.goto(url);
  expect(res?.headers()['referrer-policy']).toBe('no-referrer');
  expect(res?.headers()['cache-control']).toBe('no-store');
  await expect(rp.getByTestId('review-banner')).toHaveText('Review copy: synthetic data. Not for distribution.');
  await expect(rp.getByTestId('review-version')).toContainText('Release 1');
  await expect(rp.locator('#nav, [data-testid="nav-S01"], [data-testid="record-selector"]')).toHaveCount(0);

  // Switch customer, output and language.
  const output = rp.getByTestId('review-output');
  await expect(output.getByTestId('review-pdf')).toBeVisible();
  const customers = await rp.getByTestId('review-customer').locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
  expect(customers).toHaveLength(2);
  await rp.getByTestId('review-customer').selectOption(customers[1]);
  await expect(output).toHaveAttribute('data-customer', customers[1]);
  await rp.getByTestId('review-output-html').click();
  const frame = output.getByTestId('review-html');
  await expect(frame).toBeVisible();
  expect(await frame.getAttribute('sandbox')).toBe('allow-scripts allow-popups');
  await expect(rp.frameLocator('[data-testid="review-html"]').locator('body')).toContainText(/\S/);
  await rp.getByTestId('review-output-email').click();
  await expect(output.getByTestId('review-email-subject')).not.toBeEmpty();
  await rp.getByTestId('review-output-sms').click();
  await expect(output.getByTestId('review-sms')).toContainText('characters');
  await rp.getByTestId('review-output-html').click();
  await expect(rp.frameLocator('[data-testid="review-html"]').locator('body')).not.toContainText('ES: ');
  await rp.getByTestId('review-language').selectOption('es-US');
  await expect(output).toHaveAttribute('data-language', 'es-US');
  await expect(output.getByTestId('review-output-language')).toContainText('Spanish');
  await expect(rp.frameLocator('[data-testid="review-html"]').locator('body')).toContainText('ES: ');
  const pdf = await rp.request.get(new URL(`/api/v1/review/${url.split('/review/')[1]}/pdf?customer=${customers[0]}`, url).toString());
  expect(pdf.headers()['content-type']).toBe('application/pdf');

  // Leave a comment on one part.
  await rp.getByTestId('review-name').fill('Rosa Reviewer');
  await rp.getByTestId('review-part').selectOption({ index: 1 });
  await rp.getByTestId('review-body').fill('Please say who to call in plainer words.');
  await rp.getByTestId('review-send').click();
  await expect(rp.getByTestId('review-comment-done')).toBeVisible();
  await expect(rp.getByTestId('review-comment')).toHaveCount(1);
  await expect(rp.getByTestId('review-comment')).toContainText('Rosa Reviewer (review link: Plain English check)');
  expect(studioCalls).toEqual([]);
  expect(await outside.cookies()).toEqual([]);

  // In the studio: under "From review links", never as a user; answer and resolve it.
  await page.getByTestId('workflow-status').click();
  const fromLinks = page.getByTestId('review-panel').getByTestId('review-from-links');
  const thread = fromLinks.getByTestId('review-link-thread').filter({ hasText: 'plainer words' });
  await expect(thread).toBeVisible();
  await expect(thread.getByTestId('review-link-thread-author')).toHaveText('Rosa Reviewer (review link: Plain English check)');
  await thread.getByTestId('review-link-reply').click();
  await thread.getByTestId('review-link-reply-text').fill('Thank you. We changed it to “Call us on the number below”.');
  await thread.getByTestId('review-link-reply-send').click();
  await expect(thread.getByTestId('review-link-reply')).toHaveCount(0);
  await expect(fromLinks).toContainText('We changed it');
  await fromLinks.getByTestId('review-link-thread').filter({ hasText: 'plainer words' }).getByTestId('review-link-resolve').click();
  await expect(fromLinks).toContainText('Every comment from a review link is resolved');

  // The link holder sees the answer.
  await rp.reload();
  const seen = rp.getByTestId('review-comment').filter({ hasText: 'plainer words' });
  await expect(seen.getByTestId('review-reply')).toContainText('We changed it');
  await expect(seen.getByTestId('review-comment-resolved')).toBeVisible();

  // Overview counts it.
  await open(page, pid, 'overview');
  await expect(page.getByTestId('glance-review-links')).toContainText('1 review link active');

  // Revoke: the link is dead, with the same words as a made-up token.
  await open(page, pid, 'releases');
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('review-link-row').filter({ hasText: 'Plain English check' }).getByTestId('review-link-revoke').click();
  await expect(page.getByTestId('review-links-panel')).toContainText('0 active');
  await rp.reload();
  await expect(rp.getByTestId('review-dead')).toContainText(DEAD);
  const revokedText = await rp.getByTestId('review-dead').innerText();
  await rp.goto(new URL(`/review/${'Q'.repeat(43)}`, url).toString());
  await expect(rp.getByTestId('review-dead')).toContainText(DEAD);
  expect(await rp.getByTestId('review-dead').innerText()).toBe(revokedText);
  await outside.close();
});

test('RL02 the review page works at phone width and from the keyboard; Before & after shares the saved version', async ({ page, browser, request }) => {
  await approve(request);
  const made = await request.post(`${API}/projects/${pid}/review-links`, { data: { releaseId: `${pid}-r1`, customers: ['EOB-0001', 'EOB-0002'] } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const { path } = await made.json();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const rp = await phone.newPage();
  await rp.goto(path.startsWith('http') ? path : new URL(path, process.env.E2E_WEB ?? 'http://127.0.0.1:5173').toString());
  await expect(rp.getByTestId('review-banner')).toBeVisible();
  // No sideways scrolling at phone width.
  expect(await rp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  // Keyboard: from the customer list, Tab reaches the output buttons and Space switches the output.
  await rp.getByTestId('review-customer').focus();
  await rp.keyboard.press('Tab');
  await expect(rp.getByTestId('review-output-pdf')).toBeFocused();
  await rp.keyboard.press('Tab');
  await expect(rp.getByTestId('review-output-html')).toBeFocused();
  await rp.keyboard.press('Space');
  await expect(rp.getByTestId('review-output-html')).toHaveAttribute('aria-pressed', 'true');
  await expect(rp.getByTestId('review-html')).toBeVisible();
  await phone.close();

  // Before & after: the After side is the working version, so the link is to the saved version.
  await open(page, pid, 'compare');
  await page.getByTestId('cmp-after').selectOption('working');
  await page.getByTestId('cmp-share-review').click();
  await expect(page.getByTestId('share-review-dialog')).toContainText('saved version');
});
