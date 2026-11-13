// Captures evidence screenshots of the assistant features (v0.6) from the running app. No AI key is needed:
// every shot shows a result the studio computes itself.
// Usage: node scripts/screens-assist.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] ?? 'reports/evidence/screens';
mkdirSync(out, { recursive: true });
const API = process.env.E2E_API ?? 'http://127.0.0.1:3001';
const B = process.env.E2E_WEB ?? 'http://127.0.0.1:5173';
const P = 'aster-card-demo';
const reset = () => fetch(`${API}/api/v1/projects/${P}/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"confirm":true}' });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
const open = async (view) => { await p.goto(`${B}/studio/${P}/${view}`, { waitUntil: 'networkidle' }); await p.waitForTimeout(600); };
const shot = async (name) => { await p.waitForTimeout(900); await p.screenshot({ path: `${out}/assist-${name}.png` }); console.log('captured', name); };

// 1. Side panel: "Explain why this customer gets this" on the Exploded Document.
await reset();
await open('exploded/payment-guidance');
await p.locator('.screen-head').getByTestId('assist-open').click();
await p.locator('[data-testid="assist-action"][data-action="explain"]').click();
await p.getByTestId('assist-panel').getByText('Rules involved').waitFor({ timeout: 20000 });
await shot('01-panel-explain');

// 2. Validate & Compare: a suggested fix with its effect on all synthetic customers (seeded priority tie).
await reset();
await open('rules-data');
await p.getByTestId('open-demo-tools').click();
await p.getByTestId('seed-d01').click();
await p.getByTestId('demo-tools').getByRole('button', { name: 'Close demo tools' }).click();
await p.evaluate(() => localStorage.setItem('iss.validateScope', 'this'));
await p.getByTestId('nav-section-check').click();
await p.getByTestId('nav-S09').click();
await p.getByTestId('validation-list').waitFor({ timeout: 90000 });
await p.locator('[data-testid^="issue-"][data-testid*="TIE"]').first().click();
await p.getByTestId('fix-panel').getByTestId('assist-impact').first().waitFor({ timeout: 30000 });
await shot('02-suggested-fix');

// 3. Rules & Data: a rule described in a sentence, restated before anything is created.
await reset();
await open('rules-data');
await p.getByTestId('rule-describe-button').click();
await p.getByTestId('rule-describe-input').fill('When the new balance is over $500, show the payment reminder');
await p.getByTestId('rule-describe-submit').click();
await p.getByTestId('rule-describe-result').waitFor({ timeout: 20000 });
await shot('03-describe-rule');

// 4. Rules & Data: coverage gaps with a scenario for each.
await p.keyboard.press('Escape');
await open('rules-data');
await p.getByTestId('coverage-open').click();
await p.getByTestId('coverage-summary').waitFor({ timeout: 60000 });
await shot('04-coverage-gaps');

// 5. Content & Translations: sample Spanish drafts, then the built-in translation check.
await open('content');
await p.getByTestId('tr-ai-draft-all').click();
await p.getByTestId('tr-ai-result').waitFor({ timeout: 30000 });
await p.getByTestId('tr-check').click();
await p.getByTestId('tr-check-result').waitFor({ timeout: 30000 });
await shot('05-translation-check');

await reset();
console.log('page errors:', JSON.stringify(errors));
await b.close();
