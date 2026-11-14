import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyCommand, mergeVariantUpdate, projectContentDigest, richFromMarkup, type Command, type Project } from '@iss/model';
import { buildApp } from '../src/app';
import { buildReleasePackage, type PackageComposer } from '../src/releasePackage';
import { zipEntries, zipRead } from '../src/zip';
import { gymMember, gymProject } from '../../../packages/model/test/helpers/customProject';

/** Variants by brand or region (wave 5, section 1) against the real API: make, family, differences, lock on save, delete, releases, roles. */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-variants-'));
const stubComposer = (): PackageComposer => ({ async pdf() { return { pdf: Buffer.from('%PDF-1.4\n%%EOF\n'), pageCount: 1, facts: null }; }, async html() { return { facts: null }; } });
const unzip = (zip: Buffer): Record<string, Buffer> => Object.fromEntries(zipEntries(zip).map((e) => [e.name, zipRead(zip, e)]));

function helpers(getCtx: () => Ctx) {
  const inj = (method: any, url: string, payload?: any, headers?: any) => getCtx().app.inject({ method, url, payload, headers });
  const json = async (method: any, url: string, payload?: any, headers?: any) => (await inj(method, url, payload, headers)).json();
  const project = async (id: string, headers?: any): Promise<Project> => (await json('GET', `/api/v1/projects/${id}`, undefined, headers)).project;
  /** Applies commands to the working copy (as the studio does) and saves it; returns the response. */
  const put = async (id: string, p: Project, from: number, headers?: any) => inj('PUT', `/api/v1/projects/${id}`, { project: { ...p, modelVersion: from + 1 } }, { ...(headers ?? {}), 'if-match': `"${from}"` });
  const apply = async (id: string, cmds: Command[], headers?: any): Promise<Project> => {
    let p = await project(id, headers);
    const v = p.modelVersion;
    for (const c of cmds) { const r = applyCommand(p, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); p = r.project; }
    const r = await put(id, p, v, headers);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().project;
  };
  const workflow = (id: string, action: string, headers?: any) => inj('POST', `/api/v1/projects/${id}/workflow`, { action }, headers);
  return { inj, json, project, put, apply, workflow };
}

const EOB = 'harborcare-demo';
const variantBody = { title: 'HarborCare — Lakeshore', purpose: 'region', label: 'Lakeshore region' };

describe('variants (sign-in off)', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, extraSamples: false, auth: false, releasePackage: { composer: stubComposer() } }); });
  afterAll(async () => { await ctx.app.close(); });
  const { inj, json, project, put, apply, workflow } = helpers(() => ctx);
  let baseId = '', variantId = '';

  it('makes a variant of a document: an exact copy that follows its saved version', async () => {
    // The base: a copy of the benefits sample (a sample cannot be deleted, and this test deletes the base at the end).
    const dup = await inj('POST', `/api/v1/projects/${EOB}/duplicate`, { title: 'HarborCare base' });
    expect(dup.statusCode).toBe(201);
    baseId = dup.json().project.projectId;
    const r = await inj('POST', `/api/v1/projects/${baseId}/variants`, variantBody);
    expect(r.statusCode, r.body).toBe(201);
    const v = r.json().project as Project;
    variantId = v.projectId;
    const base = await project(baseId);
    expect(v.variantOf).toMatchObject({ projectId: baseId, modelVersion: base.modelVersion, contentDigest: projectContentDigest(base), purpose: 'region', label: 'Lakeshore region', baseTitle: 'HarborCare base' });
    expect(v.title).toBe('HarborCare — Lakeshore');
    expect(v.nodes).toEqual(base.nodes);
    const info = await json('GET', `/api/v1/projects/${variantId}/variant`);
    expect(info).toMatchObject({ variant: true, base: { found: true, projectId: baseId, follows: base.modelVersion, behind: false }, differences: [], counts: { total: 0 }, update: null });
    // the gallery list says it is a variant
    const listed = (await json('GET', '/api/v1/projects')).projects.find((p: any) => p.projectId === variantId);
    expect(listed.variantOf).toEqual({ projectId: baseId, modelVersion: base.modelVersion, purpose: 'region', label: 'Lakeshore region', baseTitle: 'HarborCare base' });
    // the activity entry: ids and counts only
    const ev = (await json('GET', `/api/v1/audit?projectId=${variantId}&action=project.variant.create`)).events[0];
    expect(ev.detail).toEqual({ baseId, baseVersion: base.modelVersion, purpose: 'region', customers: 0 });
  });

  it('refuses a variant of a variant, and a request without a name or a purpose', async () => {
    const r = await inj('POST', `/api/v1/projects/${variantId}/variants`, { ...variantBody, title: 'Again' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({ code: 'VARIANT_ONE_LEVEL', message: expect.stringMatching(/cannot be the base of another variant/) });
    expect((await inj('POST', `/api/v1/projects/${baseId}/variants`, { ...variantBody, purpose: 'colour' })).json().error.code).toBe('INVALID_PURPOSE');
    expect((await inj('POST', `/api/v1/projects/${baseId}/variants`, { ...variantBody, label: '' })).json().error.code).toBe('INVALID_LABEL');
    expect((await inj('POST', `/api/v1/projects/${baseId}/variants`, { ...variantBody, title: 'x' })).json().error.code).toBe('INVALID_TITLE');
  });

  it('saves the variant’s own changes and lists what differs', async () => {
    await apply(variantId, [
      { type: 'SET_BRAND', brand: { primary: '#0B4F7C', accent: '#2E7D5B' } },
      { type: 'UPDATE_NODE', nodeId: 'customer-address', patch: { content: richFromMarkup('**{{customer.givenName}} {{customer.familyName}}**, Lakeshore member services') } },
    ]);
    const info = await json('GET', `/api/v1/projects/${variantId}/variant`);
    expect(info.differences.map((d: any) => d.id)).toEqual(expect.arrayContaining(['brand', 'nodes[customer-address].content']));
    expect(info.counts).toMatchObject({ brand: 1, wording: 1 });
  });

  it('the lock on save: a saved variant whose locked parts differ from its base is refused', async () => {
    const p = await project(variantId);
    const moved = { ...p, presentationProfiles: p.presentationProfiles.map((x) => (x.id === 'paged-pdf' ? { ...x, duplex: !x.duplex } : x)) };
    const r = await put(variantId, moved, p.modelVersion);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: 'VARIANT_LOCKED', message: 'The page design comes from the base document “HarborCare base”. Change it there, or detach this variant.' });
    const reordered = { ...p, nodes: p.nodes.map((n) => (n.id === p.rootNodeId ? { ...n, children: [...n.children!].reverse() } : n)) };
    expect((await put(variantId, reordered, p.modelVersion)).json().error.code).toBe('VARIANT_LOCKED');
    const fields = { ...p, customFields: [{ key: 'region', label: 'Region', type: 'string' }] } as Project;
    expect((await put(variantId, fields, p.modelVersion)).json().error.message).toMatch(/^The data fields come from the base document/);
    // an ordinary document cannot become a variant by saving, and a variant cannot change its base
    const other = await project(EOB);
    expect((await put(EOB, { ...other, variantOf: p.variantOf }, other.modelVersion)).json().error.code).toBe('VARIANT_FROM_SAVE');
    expect((await put(variantId, { ...p, variantOf: { ...p.variantOf!, projectId: EOB } }, p.modelVersion)).json().error.code).toBe('VARIANT_BASE_FIXED');
    // a malformed variantOf is refused like any malformed part
    expect((await put(variantId, { ...p, variantOf: { ...p.variantOf!, purpose: 'x' as never } }, p.modelVersion)).statusCode).toBe(422);
  });

  it('a change in the base shows as an update available, with the three groups; applying it is a save of the working version', async () => {
    const baseNow = await apply(baseId, [
      { type: 'SET_BRAND', brand: { primary: '#222222', accent: '#AA0000' } },
      { type: 'UPDATE_NODE', nodeId: 'not-a-bill-banner', patch: { name: 'Not a bill (banner)' } },
    ]);
    const fam = await json('GET', `/api/v1/projects/${baseId}/family`);
    expect(fam.base).toMatchObject({ projectId: baseId, modelVersion: baseNow.modelVersion });
    expect(fam.variants).toEqual([expect.objectContaining({ projectId: variantId, variant: expect.objectContaining({ purpose: 'region', label: 'Lakeshore region', behind: true, baseMissing: false, rulesDiffer: false, differences: 2 }) })]);
    // the same family from the variant's side
    expect((await json('GET', `/api/v1/projects/${variantId}/family`)).baseId).toBe(baseId);
    const info = await json('GET', `/api/v1/projects/${variantId}/variant`);
    expect(info.base.behind).toBe(true);
    expect(info.update.comesIn.map((e: any) => e.id)).toContain('nodes[not-a-bill-banner].name');
    expect(info.update.kept.map((e: any) => e.id)).toContain('brand');
    expect(info.update.needsLook).toEqual([]);
    // the studio applies it in the working version (one command) and saves; the server checks the lock against the new version
    const v = await project(variantId);
    const ancestor = (await json('GET', `/api/v1/projects/${baseId}/versions/${v.variantOf!.modelVersion}`)).project;
    const merged = mergeVariantUpdate({ ancestor, base: baseNow, variant: v });
    const r = applyCommand(v, { type: 'UPDATE_FROM_BASE', project: merged.project });
    expect(r.ok).toBe(true);
    const saved = await put(variantId, (r as any).project, v.modelVersion);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().project.variantOf.modelVersion).toBe(baseNow.modelVersion);
    expect((await json('GET', `/api/v1/projects/${variantId}/variant`)).base.behind).toBe(false);
    const ev = (await json('GET', `/api/v1/audit?projectId=${variantId}&action=project.variant.update`)).events[0];
    expect(ev.detail).toEqual({ baseId, fromVersion: v.variantOf!.modelVersion, toVersion: baseNow.modelVersion });
  });

  it('a release of a variant records the base, the base version and the differences; its package carries them', async () => {
    expect((await workflow(variantId, 'submit')).statusCode).toBe(200);
    const ok = await workflow(variantId, 'approve');
    expect(ok.statusCode, ok.body).toBe(200);
    const rel = ok.json().release.release;
    const v = await project(variantId);
    expect(rel.variant).toMatchObject({ baseId, baseTitle: 'HarborCare base', baseVersion: v.variantOf!.modelVersion, baseDigest: v.variantOf!.contentDigest, purpose: 'region', label: 'Lakeshore region', baseFound: true });
    // both have a brand now (the base added one): the differences are colour by colour
    expect(rel.variant.differences.map((d: any) => d.id)).toEqual(expect.arrayContaining(['brand.accent', 'brand.primary', 'nodes[customer-address].content']));
    const z = await inj('GET', `/api/v1/releases/${rel.id}/package?wait=1`);
    expect(z.statusCode).toBe(200);
    const files = unzip(z.rawPayload);
    const manifest = JSON.parse(files['manifest.json'].toString('utf8'));
    expect(manifest.variant).toMatchObject({ baseId, baseVersion: v.variantOf!.modelVersion, purpose: 'region', label: 'Lakeshore region' });
    expect(manifest.variant.differences.length).toBe(rel.variant.differences.length);
    const readme = files['README.html'].toString('utf8');
    expect(readme).toContain('A variant of another document');
    expect(readme).toContain('HarborCare base');
    // the package's template is self-contained: no base to look up
    expect('variantOf' in JSON.parse(files['template.json'].toString('utf8'))).toBe(false);
  });

  it('a document that is not a variant produces exactly the package files it produced before variants existed', async () => {
    expect((await workflow(EOB, 'submit')).statusCode).toBe(200);
    const ok = await workflow(EOB, 'approve');
    expect(ok.statusCode, ok.body).toBe(200);
    const rel = ok.json().release.release;
    expect('variant' in rel).toBe(false);
    const z = await inj('GET', `/api/v1/releases/${rel.id}/package?wait=1`);
    const files = unzip(z.rawPayload);
    const manifest = JSON.parse(files['manifest.json'].toString('utf8'));
    expect('variant' in manifest).toBe(false);
    for (const [name, data] of Object.entries(files)) if (!name.endsWith('.pdf')) expect(data.toString('utf8'), name).not.toMatch(/variant of another document|"variant"|variantOf|baseNodeIds/i);
    // Built again from the stored release exactly as releases were stored before (no variant field), byte for byte the same.
    const stored = ctx.store.release(rel.id)!;
    const frozen = ctx.store.releaseProject(rel.id)!;
    const { variant: _none, ...asBefore } = stored as typeof stored & { variant?: unknown };
    const again = await buildReleasePackage(asBefore, frozen, { composer: stubComposer() });
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    expect(again.files.map((f) => f.path).sort()).toEqual(Object.keys(files).filter((n) => n !== 'manifest.json').sort());
    for (const f of again.files) expect(f.sha256, f.path).toBe(sha(files[f.path]));
  });

  it('a base with variants cannot be deleted; after the variant is detached it can', async () => {
    const r = await inj('DELETE', `/api/v1/projects/${baseId}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'HAS_VARIANTS', variants: [variantId], message: expect.stringMatching(/is the base of a variant \(“HarborCare — Lakeshore”\)\. Detach or delete it first\./) });
    // detaching: one command, saved; content unchanged
    const before = await project(variantId);
    const detached = await apply(variantId, [{ type: 'DETACH_VARIANT' }]);
    expect(detached.variantOf).toBeUndefined();
    expect(detached.nodes).toEqual(before.nodes);
    expect((await json('GET', `/api/v1/audit?projectId=${variantId}&action=project.variant.detach`)).events[0].detail).toEqual({ baseId, baseVersion: before.variantOf!.modelVersion });
    expect((await json('GET', `/api/v1/projects/${variantId}/variant`)).variant).toBe(false);
    expect((await inj('DELETE', `/api/v1/projects/${baseId}`)).statusCode).toBe(200);
  });

  it('a variant whose base is not in the studio says so and behaves as an ordinary document', async () => {
    const dup = (await json('POST', `/api/v1/projects/${EOB}/duplicate`, { title: 'Short-lived base' })).project as Project;
    const v = (await json('POST', `/api/v1/projects/${dup.projectId}/variants`, { ...variantBody, title: 'Orphan variant' })).project as Project;
    await apply(v.projectId, [{ type: 'DETACH_VARIANT' }]).catch(() => undefined);
    // Put the variant back as it was (a variant) by storing it directly, then remove its base: as after an import.
    ctx.store.putProject({ ...v, modelVersion: 9 });
    ctx.store.deleteProject(dup.projectId);
    const info = await json('GET', `/api/v1/projects/${v.projectId}/variant`);
    expect(info.base).toMatchObject({ found: false, reason: 'document', message: expect.stringMatching(/behaves as an ordinary document until it is detached or the base is imported/) });
    // a save with any change is accepted (no base to check against)
    const p = await project(v.projectId);
    const moved = { ...p, presentationProfiles: p.presentationProfiles.map((x) => (x.id === 'paged-pdf' ? { ...x, duplex: !x.duplex } : x)) };
    expect((await put(v.projectId, moved, p.modelVersion)).statusCode).toBe(200);
  });

  it('a variant of a document with its own data starts with copies of the base’s customers; its pinned tests use them', async () => {
    const gym: Project = { ...gymProject(), projectId: 'gym-base', title: 'Gym notice', testCases: [] };
    ctx.store.putProject(gym, projectContentDigest(gym));
    const [a, b] = ctx.store.addProjectRecords('gym-base', 'REC', 'supplied', [gymMember(), gymMember({ customer: { givenName: 'Bo' } })].map(({ recordId: _r, ...rest }) => rest));
    const withTest = await apply('gym-base', [{ type: 'UPSERT_TEST_CASE', testCase: { id: 'T1', name: 'First', recordId: a.recordId, expect: { noBlocking: true } } }]);
    const made = await inj('POST', '/api/v1/projects/gym-base/variants', { title: 'Gym notice — Brand B', purpose: 'brand', label: 'Brand B' });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().customers).toBe(2);
    const v = made.json().project as Project;
    const copies = ctx.store.projectRecords(v.projectId);
    expect(copies.map((r) => r.sourceId).sort()).toEqual([a.recordId, b.recordId].sort());
    expect(v.testCases![0].recordId).toBe(copies.find((r) => r.sourceId === a.recordId)!.recordId);
    const info = await json('GET', `/api/v1/projects/${v.projectId}/variant`);
    expect(info.differences).toEqual([]); // the test that uses the copy is the same test
    expect(info.customers[a.recordId]).toBe(v.testCases![0].recordId);
    expect(withTest.testCases).toHaveLength(1);
  });
});

describe('variants with sign-in on: who may do what', () => {
  let ctx: Ctx;
  const saved = { ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  const cookies: Record<string, { cookie: string }> = {};
  beforeAll(async () => {
    process.env.ADMIN_EMAIL = 'admin@example.test';
    process.env.ADMIN_PASSWORD = 'correct horse battery';
    ctx = await buildApp({ dataDir: tmp(), logger: false, extraSamples: false, auth: true, releasePackage: { composer: stubComposer() } });
    const login = async (email: string, password: string) => {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
      expect(r.statusCode).toBe(200);
      return { cookie: String([r.headers['set-cookie']].flat()[0]).split(';')[0] };
    };
    cookies.admin = await login('admin@example.test', 'correct horse battery');
    for (const [role, name] of [['author', 'Olive Author'], ['reviewer', 'Rhea Reviewer']] as const) {
      const made = await ctx.app.inject({ method: 'POST', url: '/api/v1/users', payload: { email: `${role}@example.test`, name, role, password: 'a long enough password' }, headers: cookies.admin });
      expect(made.statusCode).toBe(201);
      cookies[role] = await login(`${role}@example.test`, 'a long enough password');
    }
  });
  afterAll(async () => {
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const { inj, json, project, put } = helpers(() => ctx);

  it('reading the family and the differences needs a session; making a variant needs edit rights', async () => {
    expect((await inj('GET', `/api/v1/projects/${EOB}/family`)).statusCode).toBe(401);
    expect((await inj('POST', `/api/v1/projects/${EOB}/variants`, variantBody)).statusCode).toBe(401);
    const denied = await inj('POST', `/api/v1/projects/${EOB}/variants`, variantBody, cookies.reviewer);
    expect(denied.statusCode).toBe(403);
    const made = await inj('POST', `/api/v1/projects/${EOB}/variants`, variantBody, cookies.author);
    expect(made.statusCode).toBe(201);
    const id = made.json().project.projectId;
    expect((await json('GET', `/api/v1/projects/${EOB}/family`, undefined, cookies.reviewer)).variants.map((v: any) => v.projectId)).toEqual([id]);
    expect((await json('GET', `/api/v1/projects/${id}/variant`, undefined, cookies.reviewer)).variant).toBe(true);
    const ev = (await json('GET', `/api/v1/audit?projectId=${id}&action=project.variant.create`, undefined, cookies.admin)).events[0];
    expect(ev.userName).toBe('Olive Author');
    // a reviewer cannot detach (it is a save)
    const p = await project(id, cookies.reviewer);
    const { variantOf: _v, ...plain } = p;
    expect((await put(id, plain as Project, p.modelVersion, cookies.reviewer)).statusCode).toBe(403);
  });
});
