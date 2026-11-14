// Captures evidence screenshots of roadmap wave 4 (v0.15) from the running app: review links (the share dialog, the
// public review page, link comments in the studio), blocker owners and notes, the bell and My work, AI help for a
// wording blocker, questions about all customers, who else is editing, and the warning before a save that adds a blocker.
// Usage: node scripts/screens-wave4.mjs [outDir]      (best on a clean stack with a fresh data folder, sign-in off)
// It works on the Northwind example and on a copy of Aster Card that it deletes; Northwind is restored afterwards.
// The review link it makes is revoked at the end, and no screenshot shows the link itself.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] ?? 'reports/evidence/screens';
mkdirSync(out, { recursive: true });
const API = `${process.env.E2E_API ?? 'http://127.0.0.1:3001'}/api/v1`;
const B = process.env.E2E_WEB ?? 'http://127.0.0.1:5173';
const call = (method, path, body) => fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const NW = 'northwind-energy-demo';
await call('POST', `/projects/${NW}/reset`, { confirm: true });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(`${p.url()}: ${e.message}`));
const ready = (page) => page.waitForFunction(() => window.__iss?.store.getState().projectStatus === 'ready', null, { timeout: 60000 });
const shot = async (page, name) => { await page.waitForTimeout(900); await page.screenshot({ path: `${out}/w4-${name}.png` }); console.log(`saved w4-${name}.png`); };
const step = async (name, fn) => { try { await fn(); } catch (e) { console.log(`SKIPPED ${name}: ${String(e.message).split('\n')[0]}`); await p.keyboard.press('Escape').catch(() => {}); } };
let linkId = '', copyId = '';
try {
  // 1. Share for review: the dialog on Releases.
  await step('share dialog', async () => {
    await p.goto(`${B}/studio/${NW}/releases`, { waitUntil: 'domcontentloaded' }); await ready(p);
    await p.getByTestId('rel-share-review').first().click();
    await p.getByRole('dialog').first().waitFor();
    await shot(p, '01-share-for-review');
    await p.keyboard.press('Escape');
  });

  // 2. The public review page, opened in a browser that has no studio session; a reviewer's comment.
  const version = (await call('GET', `/projects/${NW}`)).json.project.modelVersion;
  const made = await call('POST', `/projects/${NW}/review-links`, { version, label: 'Customer care review', customers: ['NWE-60001', 'NWE-60003'] });
  const token = made.json.token; linkId = made.json.link?.id ?? '';
  if (!token) throw new Error(`no review link was made (${made.status})`);
  await call('POST', `/review/${token}/comments`, { name: 'Priya', body: 'The winter help paragraph is clear. Could the phone number come first?', customer: 'NWE-60001', output: 'html' });
  await step('review page', async () => {
    const outside = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const r = await outside.newPage();
    await r.goto(`${B}/review/${token}`, { waitUntil: 'domcontentloaded' });
    await r.getByTestId('review-banner').waitFor({ timeout: 60000 });
    await r.getByTestId('review-output-html').click().catch(() => {});
    await r.waitForTimeout(2500);
    await shot(r, '02-review-page');
    await outside.close();
  });

  // 3. The bell: the link comment tells the person who made the link; it opens the Review panel on that comment.
  await step('bell', async () => {
    await p.goto(`${B}/studio/${NW}/overview`, { waitUntil: 'domcontentloaded' }); await ready(p);
    await p.getByTestId('bell').click();
    await p.getByTestId('notify-panel').waitFor();
    await shot(p, '03-bell-notifications');
    await p.getByTestId('notify-item').first().click();
    await p.getByTestId('review-from-links').waitFor({ timeout: 15000 });
    await shot(p, '04-link-comments-in-review-panel');
    await p.keyboard.press('Escape');
  });

  // 4. Blockers: an owner, "Being fixed" and a note on one cause.
  await step('blocker owner', async () => {
    await p.goto(`${B}/studio/${NW}/blockers`, { waitUntil: 'domcontentloaded' }); await ready(p);
    await p.locator('[data-testid^="bl-row-"]').first().click();
    await p.getByTestId('bl-work').waitFor({ timeout: 30000 });
    const picker = p.getByTestId('bl-owner-picker');
    const options = await picker.locator('option').allTextContents();
    if (options.length > 1) await picker.selectOption({ index: 1 });
    await p.getByTestId('bl-being-fixed').click();
    await p.getByTestId('bl-note-input').fill('Spanish text is with the translators; due Monday.');
    await p.getByTestId('bl-note-add').click();
    await p.getByTestId('bl-note').first().waitFor();
    await p.getByTestId('bl-work').scrollIntoViewIfNeeded();
    await shot(p, '05-blocker-owner-status-notes');
    await p.getByTestId('bell').click();
    await p.getByTestId('notify-tab-work').click();
    await shot(p, '06-my-work');
    await p.keyboard.press('Escape');
  });

  // 5. Help for a wording blocker: draft the missing Spanish text (a labelled draft; the blocker stays open).
  await step('draft translation', async () => {
    await p.goto(`${B}/studio/${NW}/blockers`, { waitUntil: 'domcontentloaded' }); await ready(p);
    await p.locator('[data-testid^="bl-row-"][data-kind="wording"]').first().click();
    await p.getByTestId('bl-draft-translation').click();
    await p.getByTestId('bl-draft-result').waitFor({ timeout: 30000 }).catch(() => {});
    await p.getByTestId('bl-assist').scrollIntoViewIfNeeded().catch(() => {});
    await shot(p, '07-draft-for-a-wording-blocker');
  });
  await call('POST', `/projects/${NW}/reset`, { confirm: true });

  // 6. Ask about all customers.
  await step('ask all customers', async () => {
    await p.goto(`${B}/studio/${NW}/landscape`, { waitUntil: 'domcontentloaded' }); await ready(p);
    await p.getByTestId('assist-open').click();
    await p.getByTestId('assist-tab-all').click();
    await p.getByTestId('ask-input').fill('who gets the winter heating help in Spanish');
    await p.getByTestId('ask-submit').click();
    await p.getByTestId('ask-count').waitFor({ timeout: 30000 });
    await shot(p, '08-ask-about-all-customers');
    await p.keyboard.press('Escape');
  });

  // 7. Who else is editing: a second window on the same component.
  await step('presence', async () => {
    const other = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const q = await other.newPage();
    for (const page of [q, p]) { await page.goto(`${B}/studio/${NW}/design`, { waitUntil: 'domcontentloaded' }); await ready(page); }
    const nodeId = await p.evaluate(() => window.__iss.store.getState().selectedId ?? window.__iss.store.getState().project.nodes.find((n) => n.type === 'variant-set')?.id);
    for (const page of [q, p]) await page.evaluate((id) => window.__iss.store.getState().select(id), nodeId);
    await p.getByTestId('inspector-also-here').waitFor({ timeout: 30000 });
    await p.getByTestId('presence-open').click().catch(() => {});
    await shot(p, '09-who-else-is-editing');
    await p.keyboard.press('Escape');
    await other.close();
  });

  // 8. The warning before a save that adds a blocker (on a copy of Aster Card: two rules made to tie).
  await step('save warning', async () => {
    copyId = (await call('POST', '/projects/aster-card-demo/duplicate', { title: 'Aster Card — evidence copy' })).json.project.projectId;
    await p.goto(`${B}/studio/${copyId}/design`, { waitUntil: 'domcontentloaded' }); await ready(p);
    if (!(await p.getByTestId('demo-tools').isVisible())) await p.getByTestId('open-demo-tools').click();
    await p.getByTestId('seed-d01').click();
    await p.keyboard.press('Escape');
    await p.getByTestId('save-project').click();
    await p.getByTestId('save-warning').waitFor({ timeout: 30000 });
    await shot(p, '10-warning-before-saving');
    await p.getByTestId('save-warning-back').click();
  });
} finally {
  await b.close();
  if (linkId) await call('POST', `/projects/${NW}/review-links/${linkId}/revoke`, {});
  if (copyId) await call('DELETE', `/projects/${copyId}`);
  await call('POST', `/projects/${NW}/reset`, { confirm: true });
}
if (errors.length) console.log('page errors:', JSON.stringify(errors.slice(0, 5), null, 1));
