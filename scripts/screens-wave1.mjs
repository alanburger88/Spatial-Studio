// Captures evidence screenshots of roadmap wave 1 (v0.11) from the running app: the menu and Overview, the tour and help,
// the Blockers resolve pass, a release with its runnable package, Before & after, and Proof.
// Usage: node scripts/screens-wave1.mjs [outDir]
// It works on a duplicate of the HarborCare sample (so the samples keep no release) and removes it afterwards.
// A release cannot be deleted, so the duplicate's release stays in the local data folder.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] ?? 'reports/evidence/screens';
mkdirSync(out, { recursive: true });
const API = `${process.env.E2E_API ?? 'http://127.0.0.1:3001'}/api/v1`;
const B = process.env.E2E_WEB ?? 'http://127.0.0.1:5173';
const post = (path, body) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const A = 'aster-card-demo';
await post(`/projects/${A}/reset`, { confirm: true });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
const shot = async (name) => { await p.waitForTimeout(700); await p.screenshot({ path: `${out}/w1-${name}.png` }); console.log(`saved w1-${name}.png`); };
let doc = null;
try {
  // 1. Overview with the tour offer, then the tour and the help sheet.
  await p.goto(`${B}/studio/${A}/overview`, { waitUntil: 'networkidle' });
  await p.getByTestId('overview-steps').waitFor();
  await shot('01-overview');
  await p.getByTestId('tour-prompt-start').click();
  await p.getByTestId('tour').waitFor();
  await shot('02-tour-first-step');
  for (let i = 0; i < 3; i++) await p.getByTestId('tour-next').click();
  await shot('03-tour-menu-step');
  await p.getByTestId('tour-skip').click();
  await p.goto(`${B}/studio/${A}/blockers`, { waitUntil: 'networkidle' });
  await p.getByTestId('bl-resolve-start').waitFor();
  await p.keyboard.press('?');
  await p.getByTestId('help-article').waitFor();
  await shot('04-help-for-this-screen');
  await p.keyboard.press('Escape');

  // 2. Blockers: resolve one by one.
  await p.getByTestId('bl-resolve-start').click();
  await p.getByTestId('bl-pass-step').waitFor();
  await shot('05-blockers-resolve-one-by-one');

  // 3. A release of a duplicate of HarborCare, its runnable package, documents produced from it.
  doc = (await post('/projects/harborcare-demo/duplicate', { title: 'HarborCare benefits (wave 1 evidence)' })).project?.projectId;
  if (!doc) throw new Error('could not make a duplicate of the HarborCare sample');
  for (const action of ['submit', 'approve']) await post(`/projects/${doc}/workflow`, { action });
  const rel = `${doc}-r1`;
  await post(`/releases/${rel}/runtime`, { wait: true });
  await post(`/releases/${rel}/produce`, { all: true });
  await p.goto(`${B}/studio/${doc}/releases`, { waitUntil: 'networkidle' });
  await p.getByTestId('rel-compare').waitFor();
  const runtime = p.getByText('Runnable package', { exact: false }).first();
  await runtime.scrollIntoViewIfNeeded();
  await shot('06-release-runnable-package');

  // 4. Proof: the newest record, then re-create and verify with the test customer.
  await p.goto(`${B}/studio/${doc}/proof`, { waitUntil: 'networkidle' });
  await p.getByTestId('proof-lookup').waitFor();
  await shot('07-proof-record');

  // 5. Before & after: switch one rule off in the working version (not saved) and compare with release 1.
  await p.goto(`${B}/studio/${doc}/overview`, { waitUntil: 'networkidle' });
  await p.evaluate(() => { const s = window.__iss.store.getState(); const rule = s.project.rules.find((r) => r.enabled !== false); s.dispatch({ type: 'SET_RULE_ENABLED', ruleId: rule.id, enabled: false }); });
  await p.getByTestId('nav-section-releases').click();
  await p.getByTestId('nav-S20').click();
  await p.getByTestId('before-after').waitFor();
  await p.waitForTimeout(2500);
  await shot('08-before-and-after');
} finally {
  await b.close();
  if (doc) await fetch(`${API}/projects/${doc}`, { method: 'DELETE' });
  await post(`/projects/${A}/reset`, { confirm: true });
}
if (errors.length) console.log('page errors:', JSON.stringify(errors.slice(0, 3)));
