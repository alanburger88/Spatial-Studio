import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { SOURCE_LANGUAGE, projectContentDigest, projectLanguages, type Project } from '@iss/model';
import { seedProjects } from '@iss/model/fixtures';
import { buildReleasePackage, type PackageComposer } from '../src/releasePackage';
import { releaseVersions } from '../src/releases';
import type { StoredRelease } from '../src/db';
import { zipEntries, zipRead } from '../src/zip';
import { gymProject } from '../../../packages/model/test/helpers/customProject';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const stub: PackageComposer = {
  async pdf(html: string) { return { pdf: Buffer.from(`%PDF-1.4\n% stub composition ${sha(html)}\n%%EOF\n`), pageCount: 1, facts: null }; },
  async html() { return { facts: null }; },
};
function releaseOf(p: Project): StoredRelease {
  return {
    id: `${p.projectId}-r1`, documentId: p.projectId, number: 1, title: p.title, documentType: p.documentType, modelVersion: p.modelVersion, contentDigest: projectContentDigest(p),
    languages: [SOURCE_LANGUAGE, ...projectLanguages(p)], versions: releaseVersions(p), pinned: [], origin: 'approval',
    approvedBy: { id: 'u-approver', name: 'Ada Approver' }, approvedAt: '2026-11-14T10:00:00.000Z', createdBy: { id: 'u-approver', name: 'Ada Approver' }, createdAt: '2026-11-14T10:00:00.001Z',
    stages: { test: { status: 'current', since: '2026-11-14T10:00:00.001Z', by: null }, production: null }, documentRemovedAt: null,
  } as StoredRelease;
}
const build = (p: Project) => buildReleasePackage(releaseOf(p), p, { composer: stub, scenarioCap: 4, referenceCap: 1 });
const unzip = (zip: Buffer) => new Map(zipEntries(zip).map((e) => [e.name, zipRead(zip, e)]));
const documents = (): Project[] => { const [card, eob] = seedProjects(); return [card, eob, gymProject({ withSpanish: true })]; };

describe('baseline', () => {
  it('prints', async () => {
    for (const p of documents()) { const pkg = await build(p); console.log(p.projectId, sha(unzip(pkg.zip).get('manifest.json')!), pkg.sha256); }
    expect(1).toBe(1);
  });
});
