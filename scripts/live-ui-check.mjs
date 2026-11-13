#!/usr/bin/env node
// A SMALL, deliberate look at live AI results ON SCREEN (four model calls, billed to the key's owner).
// Never part of the automated tests. Start a stack with live AI first:
//   LIVE_AI=1 node scripts/dev-isolated.mjs 4
//   node scripts/live-ui-check.mjs http://127.0.0.1:5204 http://127.0.0.1:3104 <outDir>
// It drives the real screens, saves a screenshot of each live result, and removes what it created.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const WEB = process.argv[2] ?? 'http://127.0.0.1:5204';
const API = `${process.argv[3] ?? 'http://127.0.0.1:3104'}/api/v1`;
const out = process.argv[4] ?? 'reports/evidence/screens';
mkdirSync(out, { recursive: true });
const P = 'aster-card-demo';
const results = [];
const created = [];
const record = (name, ok, detail) => { results.push({ name, ok }); console.log(`[${ok ? 'OK ' : 'FAIL'}] ${name} — ${detail}`); };

const health = await (await fetch(`${API}/health`)).json();
console.log(`AI status: ${health.ai.mode}${health.ai.model ? ` · ${health.ai.model}` : ''}`);
if (health.ai.mode !== 'external') { console.log('Live AI is not on for this stack; nothing was called.'); process.exit(2); }
await fetch(`${API}/projects/${P}/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"confirm":true}' });

const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
const shot = async (name) => { await p.waitForTimeout(800); await p.screenshot({ path: `${out}/live-${name}.png` }); };
const step = async (name, fn) => { try { await fn(); } catch (e) { record(name, false, String(e?.message ?? e).split('\n')[0].slice(0, 200)); await p.screenshot({ path: `${out}/live-${name.replace(/\W+/g, '-').toLowerCase()}-failed.png` }).catch(() => {}); } };

try {
  // 1. Describe your document → a live proposal on screen → create it.
  await step('Describe your document', async () => {
    await p.goto(`${WEB}/projects`, { waitUntil: 'networkidle' });
    await p.getByTestId('new-project').click();
    await p.getByTestId('setup-open').click();
    await p.getByTestId('setup-example-renewal').click();
    await p.getByTestId('setup-draft').click();
    await p.getByTestId('setup-step-review').waitFor({ timeout: 180000 });
    const source = await p.getByTestId('setup-step-review').locator('[data-testid="assist-source"]').first().getAttribute('data-source');
    const fields = await p.getByTestId('setup-fields').locator('input').count();
    const text = await p.getByTestId('setup-step-review').innerText();
    await shot('01-setup-proposal');
    await p.getByTestId('setup-create').click();
    await p.waitForURL(/\/studio\/[^/]+\/design/, { timeout: 60000 });
    const id = new URL(p.url()).pathname.split('/')[2];
    created.push(id);
    await p.getByTestId('design-canvas').waitFor({ timeout: 30000 });
    await shot('02-setup-created-document');
    record('Describe your document', source === 'ai' && fields >= 3 && /Shown when/i.test(text), `source=${source}, ${fields} data fields, a conditional message: ${/Shown when/i.test(text)}; created “${id}” and opened it`);
  });

  // 2. Assistant side panel: a live answer about the current customer.
  await step('Assistant panel answer', async () => {
    await p.goto(`${WEB}/studio/${P}/exploded/payment-guidance`, { waitUntil: 'networkidle' });
    await p.locator('.screen-head').getByTestId('assist-open').click();
    await p.getByTestId('assist-tab-chat').click();
    await p.getByTestId('assistant-input').fill('Explain why this customer gets this about Payment guidance');
    await p.getByTestId('assistant-send').click();
    const reply = p.getByTestId('assistant-reply').last();
    await reply.waitFor({ timeout: 60000 });
    const text = await reply.innerText();
    await p.getByTestId('assistant-explanation').last().waitFor({ timeout: 20000 });
    await reply.scrollIntoViewIfNeeded();
    await shot('03-assistant-panel');
    const disclaims = /can(?:'|’)?t confirm|cannot confirm|unable to confirm/i.test(text);
    record('Assistant panel answer', /Live AI/i.test(text) && !disclaims, `answered by Live AI: ${/Live AI/i.test(text)}, no "cannot confirm" disclaimer: ${!disclaims}, engine explanation shown`);
  });

  // 3. Writing help: a live rewrite suggestion beside the original.
  await step('Writing help rewrite', async () => {
    await p.goto(`${WEB}/studio/${P}/design`, { waitUntil: 'networkidle' });
    await p.evaluate(() => window.__iss.store.getState().select('payment-guidance'));
    await p.getByTestId('component-inspector').waitFor();
    await p.getByTestId('insp-tab-content').click();
    await p.getByTestId('variants-editor').locator('li').nth(1).getByRole('button', { name: 'Edit text' }).click();
    await p.getByTestId('writing-help').click();
    await p.getByTestId('rewrite-plainer').click();
    await p.getByTestId('assist-suggestion').first().waitFor({ timeout: 60000 });
    const src = await p.getByTestId('assist-suggestion').first().locator('[data-testid="assist-source"]').getAttribute('data-source');
    const text = await p.getByTestId('assist-suggestion-text').first().innerText();
    await p.getByTestId('assist-suggestion').first().scrollIntoViewIfNeeded();
    await shot('04-writing-help-rewrite');
    record('Writing help rewrite', src === 'ai' && text.length > 10, `source=${src}; suggestion: “${text.slice(0, 120)}”`);
  });

  // 4. Translations: a live draft for ONE text (not the whole document).
  await step('AI translation draft for one text', async () => {
    await p.goto(`${WEB}/studio/${P}/content`, { waitUntil: 'networkidle' });
    const row = p.getByTestId('tr-row').first();
    await row.getByTestId('tr-ai-draft-row').click();
    await p.waitForFunction(() => { const r = document.querySelector('[data-testid="tr-row"]'); const t = r?.querySelector('[data-testid="tr-draft-input"]'); return !!t && t.value.trim().length > 0; }, null, { timeout: 60000 });
    const draft = await row.getByTestId('tr-draft-input').inputValue();
    const rowText = await row.innerText();
    await row.scrollIntoViewIfNeeded();
    await shot('05-translation-draft');
    record('AI translation draft for one text', draft.length > 3 && /AI/i.test(rowText), `draft: “${draft.slice(0, 100)}”; marked as an AI draft: ${/AI/i.test(rowText)}`);
  });
} finally {
  await b.close();
  for (const id of created) await fetch(`${API}/projects/${id}`, { method: 'DELETE' });
  await fetch(`${API}/projects/${P}/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"confirm":true}' });
}
if (errors.length) console.log('page errors:', JSON.stringify(errors.slice(0, 3)));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} on-screen live checks passed${failed.length ? `; failed: ${failed.map((f) => f.name).join('; ')}` : ''}.`);
process.exit(failed.length ? 1 : 0);
