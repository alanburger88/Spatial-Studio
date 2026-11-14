import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyCommand, type Project } from '@iss/model';
import { buildApp } from '../src/app';
import type { PackageComposer } from '../src/releasePackage';
import { zipEntries, zipRead } from '../src/zip';

/** A release of a document with a page background image carries that image in `assets/`, next to the brand logo. */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
// A 1×1 PNG (synthetic, made for this test).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_URI = `data:image/png;base64,${PNG.toString('base64')}`;

function stubComposer(): PackageComposer {
  return { async pdf(html: string) { return { pdf: Buffer.from(`%PDF-1.4\n% ${sha(html)}\n%%EOF\n`), pageCount: 1, facts: null }; }, async html() { return { facts: null }; } };
}

describe('release package: page background images', () => {
  let ctx: Ctx;
  let id = '';
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });

  beforeAll(async () => {
    ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-bg-')), logger: false, auth: false, releasePackage: { composer: stubComposer(), scenarioCap: 6, referenceCap: 2 } });
    const made = (await inj('POST', '/api/v1/projects', { templateId: 'blank-project', title: 'Stationery notice', issuerName: 'Northside Gym', accent: '#1f4e79' })).json().project as Project;
    id = made.projectId;
    const r = applyCommand(made, { type: 'SET_PAGE_DESIGN', patch: { pageTemplates: { first: { background: { kind: 'image', image: PNG_URI, fit: 'cover', opacityPct: 40 } }, following: { background: { kind: 'tint', color: '#eeeeee', opacityPct: 20 } } } } });
    if (!r.ok) throw new Error(r.message);
    const put = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...r.project, modelVersion: made.modelVersion + 1 } }, { 'if-match': `"${made.modelVersion}"` });
    expect(put.statusCode, put.body.slice(0, 300)).toBe(200);
    for (const action of ['submit', 'approve']) { const w = await inj('POST', `/api/v1/projects/${id}/workflow`, { action }); expect(w.statusCode, w.body.slice(0, 300)).toBe(200); }
  }, 120_000);
  afterAll(async () => { await ctx.app.close(); });

  it('lists the background image among the images, as a file named by its hash, with the page template it is behind', async () => {
    const got = await inj('GET', `/api/v1/releases/${id}-r1/package?wait=1`);
    expect(got.statusCode, got.body.slice(0, 300)).toBe(200);
    const zip = got.rawPayload;
    const files = new Map(zipEntries(zip).map((e) => [e.name, zipRead(zip, e)]));
    const index = JSON.parse(files.get('assets/index.json')!.toString('utf8'));
    const bg = index.assets.find((a: any) => a.usedBy.some((u: any) => u.what === 'page background'));
    expect(bg).toMatchObject({ path: `assets/${sha(PNG)}.png`, sha256: sha(PNG), bytes: PNG.length, mime: 'image/png', usedBy: [{ what: 'page background', name: 'First page' }] });
    expect(files.get(bg.path)!.equals(PNG)).toBe(true);
    // a tint is not an image
    expect(index.assets.filter((a: any) => a.usedBy.some((u: any) => u.what === 'page background'))).toHaveLength(1);
    // and template.json still carries it inline
    const template = JSON.parse(files.get('template.json')!.toString('utf8')) as Project;
    expect(template.presentationProfiles.find((p) => p.id === 'paged-pdf')!.pageTemplates!.first!.background!.image).toBe(PNG_URI);
  });
});
