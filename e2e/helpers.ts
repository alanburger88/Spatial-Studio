import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The API under test. E2E_API points the suite at an isolated stack (see scripts/dev-isolated.mjs). */
export const API_ORIGIN = process.env.E2E_API ?? 'http://127.0.0.1:3001';
export const API = `${API_ORIGIN}/api/v1`;
export const EXPECTED = JSON.parse(readFileSync(path.join(process.cwd(), 'fixtures/expected_scenarios.json'), 'utf8')).cases;

export async function resetAll(request: APIRequestContext) {
  // Every sample: the two fixture samples and the two example documents with their own data (their customers are restored too).
  for (const id of ['aster-card-demo', 'harborcare-demo', 'northwind-energy-demo', 'meridian-wealth-demo']) {
    const r = await request.post(`${API}/projects/${id}/reset`, { data: { confirm: true } });
    expect(r.ok()).toBeTruthy();
  }
  // Saved templates are studio-wide, so one spec's templates must not show up in another's "New project" list.
  expect((await request.post(`${API}/templates/reset`, { data: { confirm: true } })).ok()).toBeTruthy();
}

export async function open(page: Page, project: string, view: string) {
  await page.goto(`/studio/${project}/${view}`);
  await expect(page.getByRole('main')).toBeVisible();
  await page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready');
  // Screens are separate downloads: wait until the requested one has actually rendered.
  await expect(page.locator('#main section.screen').first()).toBeVisible();
}

export const state = (page: Page) => page.evaluate(() => {
  const s = (window as any).__iss.store.getState();
  return { modelVersion: s.project?.modelVersion, ctx: s.ctx, digest: (window as any).__iss.digest(), nodeIds: s.project?.nodes.map((n: any) => n.id) as string[], past: s.past.length, future: s.future.length };
});

export const node = (page: Page, id: string) => page.evaluate((nid) => (window as any).__iss.store.getState().project.nodes.find((n: any) => n.id === nid), id);

export async function pdfText(bytes: Buffer): Promise<{ pages: string[] }> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const tc = await p.getTextContent();
    pages.push(tc.items.map((it: any) => it.str).join(' '));
  }
  return { pages };
}

/** The Design Studio's components/layers panel starts closed on windows under 1500px: open it if it is closed. */
export async function showLeftPanel(page: Page) {
  if (!(await page.getByRole('complementary', { name: 'Components and layers' }).count())) await page.getByTestId('toggle-palette').click();
  await expect(page.getByRole('complementary', { name: 'Components and layers' })).toBeVisible();
}

export async function dragAfter(page: Page, sourceTestId: string, targetTestId: string, where: 'after' | 'center' = 'after') {
  if (sourceTestId.startsWith('palette-')) await showLeftPanel(page);
  const target = page.getByTestId(targetTestId).first();
  const box = (await target.boundingBox())!;
  await page.getByTestId(sourceTestId).dragTo(target, { targetPosition: { x: Math.min(40, box.width / 2), y: where === 'after' ? box.height - 2 : box.height / 2 } });
}

/** Click a control inside the status-bar "Demo tools" panel (deliberate defects), opening the panel first if needed. */
export async function demoTool(page: Page, testId: string) {
  if (!(await page.getByTestId('demo-tools').isVisible())) await page.getByTestId('open-demo-tools').click();
  await page.getByTestId(testId).click();
}

/** Switch Business/Technical detail level from the top-bar settings menu. */
export async function setView(page: Page, mode: 'business' | 'technical') {
  if (!(await page.getByTestId('settings-menu').isVisible())) await page.getByTestId('open-settings').click();
  await page.getByTestId(`view-${mode}`).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-menu')).toHaveCount(0);
}

/** Open a project card's "…" menu in the gallery and click one of its items. */
export async function cardAction(page: Page, action: string, projectId: string) {
  await page.getByTestId(`card-menu-${projectId}`).click();
  await page.getByTestId(`${action}-${projectId}`).click();
}

/** Choose a synthetic customer through the searchable top-bar record picker. */
export async function pickRecord(page: Page, recordId: string) {
  await page.getByTestId('record-selector').click();
  await page.getByTestId('record-search').fill(recordId);
  await page.getByTestId(`record-option-${recordId}`).click();
  await expect(page.getByTestId('record-selector')).toHaveAttribute('data-value', recordId);
}

/**
 * A new document made from the built-in starter of a sample's kind: the sample exactly as the fixtures build it, without
 * the showcase additions the stored samples have since D106 (calculations, lookup tables, the document's date, page
 * design, own wording rules, a mapping, email wording, pinned tests). For tests whose subject is a document that does not
 * have those yet. The caller deletes it (`DELETE /projects/:id`).
 */
export async function plainCopy(request: APIRequestContext, sample: 'aster-card-demo' | 'harborcare-demo', title = `Plain ${sample} ${Date.now().toString(36)}`): Promise<{ projectId: string; project: any }> {
  const templateId = sample === 'aster-card-demo' ? 'credit-card-statement' : 'explanation-of-benefits';
  const r = await request.post(`${API}/projects`, { data: { templateId, title } });
  expect(r.status(), await r.text()).toBe(201);
  const project = (await r.json()).project;
  expect(project.calculatedFields ?? []).toEqual([]);
  return { projectId: project.projectId as string, project };
}
