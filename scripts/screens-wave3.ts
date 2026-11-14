// Captures evidence screenshots of roadmap wave 3 (v0.13) from the running app: rebuild from a file (what was found,
// and what would be sent), the Mapping tab, and duplicate wording in the Library.
// Usage: npx tsx scripts/screens-wave3.ts [outDir]     (best on a clean stack: node scripts/dev-isolated.mjs <slot>)
// The file it reads is generated here from invented values (the same generator the tests use). Nothing is sent to a model.
// It works on duplicates of the sample document and deletes them afterwards.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { statementPdf } from '../apps/api/test/fixtures/import/makeFiles';

const out = process.argv[2] ?? 'reports/evidence/screens';
mkdirSync(out, { recursive: true });
const API = `${process.env.E2E_API ?? 'http://127.0.0.1:3001'}/api/v1`;
const B = process.env.E2E_WEB ?? 'http://127.0.0.1:5173';
const post = (path: string, body: unknown) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
const A = 'aster-card-demo';
await post(`/projects/${A}/reset`, { confirm: true });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errors: string[] = [];
p.on('pageerror', (e) => errors.push(e.message));
const shot = async (name: string) => { await p.waitForTimeout(800); await p.screenshot({ path: `${out}/w3-${name}.png` }); console.log(`saved w3-${name}.png`); };
const made: string[] = [];
try {
  // 1. Rebuild from a file: what the studio read, with likely personal details marked.
  await p.goto(`${B}/projects`, { waitUntil: 'networkidle' });
  await p.getByTestId('new-project').click();
  await p.getByTestId('rebuild-open').click();
  await p.getByTestId('rebuild-file-input').setInputFiles([{ name: 'statement.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await statementPdf()) }]);
  await p.getByTestId('rebuild-read').click();
  await p.getByTestId('rebuild-step-found').waitFor({ timeout: 60000 });
  await shot('01-rebuild-what-was-found');
  await p.getByTestId('rebuild-next').click();
  await shot('02-rebuild-what-would-be-sent');
  await p.keyboard.press('Escape');

  // 2. Mapping: the data dictionary and one mapping with a few fields mapped (unsaved working-version state).
  await p.goto(`${B}/studio/${A}/mapping`, { waitUntil: 'networkidle' });
  await p.getByTestId('map-dictionary').waitFor({ timeout: 30000 }).catch(() => {});
  // Passed as text: the script runner rewrites functions in a way the page cannot run.
  const commands = [
    { type: 'ADD_MAPPING', mapping: { id: 'print-house', name: 'Mapping for the print house', system: 'Print house composition system' } },
    { type: 'IMPORT_TARGET_FIELDS', mappingId: 'print-house', fields: [
      { name: 'CUST_FIRST_NAME', type: 'text', description: 'Given name' }, { name: 'CUST_LAST_NAME', type: 'text', description: 'Family name' },
      { name: 'NEW_BALANCE', type: 'decimal', description: 'New balance in dollars' }, { name: 'MIN_PAYMENT', type: 'decimal', description: 'Minimum payment due' },
      { name: 'DUE_DATE', type: 'date', description: 'Payment due date' }, { name: 'ACCOUNT_TIER', type: 'text', description: 'Tier of the account' },
    ] },
  ];
  await p.evaluate(`(() => { const s = window.__iss.store.getState(); for (const c of ${JSON.stringify(commands)}) { const r = s.dispatch(c); if (r && r.ok === false) throw new Error(r.message); } })()`);
  await p.getByTestId('nav-section-design').click();
  await p.getByTestId('nav-section-releases').click();
  await p.getByTestId('nav-S26').click();
  await p.waitForTimeout(600);
  await shot('03-mapping');

  // 3. Duplicate wording: two copies of the sample share every message with it.
  for (const title of ['Aster Card — gold statement', 'Aster Card — student statement']) {
    const r = await post(`/projects/${A}/duplicate`, { title });
    if (r.project?.projectId) made.push(r.project.projectId);
  }
  await p.goto(`${B}/library?view=duplicates`, { waitUntil: 'networkidle' });
  await p.getByTestId('dup-group').first().waitFor({ timeout: 60000 });
  await p.getByTestId('dup-group').first().click();
  await shot('04-duplicate-wording');
} finally {
  await b.close();
  for (const id of made) await fetch(`${API}/projects/${id}`, { method: 'DELETE' });
  await post(`/projects/${A}/reset`, { confirm: true });
}
if (errors.length) console.log('page errors:', JSON.stringify(errors.slice(0, 3)));
