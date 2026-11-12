import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const API = 'http://127.0.0.1:3001/api/v1';
export const EXPECTED = JSON.parse(readFileSync(path.join(process.cwd(), 'fixtures/expected_scenarios.json'), 'utf8')).cases;

export async function resetAll(request: APIRequestContext) {
  for (const id of ['aster-card-demo', 'harborcare-demo']) {
    const r = await request.post(`${API}/projects/${id}/reset`, { data: { confirm: true } });
    expect(r.ok()).toBeTruthy();
  }
}

export async function open(page: Page, project: string, view: string) {
  await page.goto(`/studio/${project}/${view}`);
  await expect(page.getByRole('main')).toBeVisible();
  await page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready');
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

export async function dragAfter(page: Page, sourceTestId: string, targetTestId: string, where: 'after' | 'center' = 'after') {
  const target = page.getByTestId(targetTestId).first();
  const box = (await target.boundingBox())!;
  await page.getByTestId(sourceTestId).dragTo(target, { targetPosition: { x: Math.min(40, box.width / 2), y: where === 'after' ? box.height - 2 : box.height / 2 } });
}

/** Choose a synthetic customer through the searchable top-bar record picker. */
export async function pickRecord(page: Page, recordId: string) {
  await page.getByTestId('record-selector').click();
  await page.getByTestId('record-search').fill(recordId);
  await page.getByTestId(`record-option-${recordId}`).click();
  await expect(page.getByTestId('record-selector')).toHaveAttribute('data-value', recordId);
}
