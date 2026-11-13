// Captures evidence screenshots of saved templates and project file import (v0.7) from the running app.
// Usage: node scripts/screens-templates.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] ?? 'reports/evidence/screens';
mkdirSync(out, { recursive: true });
const API = `${process.env.E2E_API ?? 'http://127.0.0.1:3001'}/api/v1`;
const B = process.env.E2E_WEB ?? 'http://127.0.0.1:5173';
const post = (path, body) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const made = [];
const cleanUp = async () => {
  for (const id of made) await fetch(`${API}/projects/${id}`, { method: 'DELETE' });
  await post('/templates/reset', { confirm: true });
};

await post('/projects/aster-card-demo/reset', { confirm: true });
await post('/templates/reset', { confirm: true });
// A saved template with two versions, and one project started from the first.
await post('/templates', { projectId: 'aster-card-demo', title: 'Aster house statement', description: 'House statement layout used by every card product.', note: 'First version' });
await post('/templates', { projectId: 'aster-card-demo', templateId: 'saved-aster-house-statement', note: 'Updated payment wording' });
made.push((await post('/projects', { templateId: 'saved-aster-house-statement', templateVersion: 1, title: 'Spring card statement' })).project.projectId);
const file = await fetch(`${API}/projects/aster-card-demo/export`).then((r) => r.json());
const badFile = { ...file, nodes: file.nodes.map((n) => (n.image ? { ...n, image: { ...n.image, src: 'https://example.com/logo.png' } } : n)) };

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
const shot = async (name) => { await p.waitForTimeout(900); await p.screenshot({ path: `${out}/templates-${name}.png` }); console.log('captured', name); };
const gallery = async () => { await p.goto(`${B}/projects`, { waitUntil: 'networkidle' }); await p.waitForTimeout(500); };

try {
  // 1. Save a document as a template (new version of an existing one).
  await gallery();
  await p.getByRole('button', { name: /More actions for Aster Card/ }).click();
  await p.getByTestId('save-template-aster-card-demo').click();
  await p.getByTestId('save-template-dialog').waitFor();
  await shot('01-save-as-template');
  await p.keyboard.press('Escape');

  // 2. New project: a saved template selected, with its version picker.
  await p.getByTestId('new-project').click();
  await p.getByTestId('template-saved-aster-house-statement').click();
  await p.getByTestId('template-detail').waitFor();
  await p.getByTestId('template-detail').scrollIntoViewIfNeeded();
  await shot('02-new-project-saved-template');
  await p.keyboard.press('Escape');

  // 3. Import a project file: the report before anything is stored.
  await p.getByTestId('import-project').click();
  await p.getByTestId('import-project-file').setInputFiles({ name: 'aster-card.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await p.getByTestId('import-project-report').waitFor({ timeout: 20000 });
  await shot('03-import-report');

  // 4. A file that cannot be imported: every problem named, nothing stored.
  await p.getByTestId('import-project-file').setInputFiles({ name: 'edited-elsewhere.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(badFile)) });
  await p.getByTestId('import-project-problem').first().waitFor({ timeout: 20000 });
  await shot('04-import-refused');
  await p.keyboard.press('Escape');

  // 5. The gallery says where a project came from.
  await gallery();
  await p.getByTestId(`origin-${made[0]}`).scrollIntoViewIfNeeded();
  await shot('05-project-origin');
} finally {
  await b.close();
  await cleanUp();
}
console.log('page errors:', JSON.stringify(errors));
