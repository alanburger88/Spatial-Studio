import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyCommand, linkStatus, projectContentDigest, type Command, type Project } from '@iss/model';
import { RECORDS } from '@iss/model/fixtures';
import { compareVersions } from '@iss/scenarios';
import { buildApp } from '../src/app';
import { libraryUpdateImpact } from '../src/library';
import { zipEntries, zipRead } from '../src/zip';
import type { PackageComposer } from '../src/releasePackage';

/** The shared library on the server: items, frozen versions, roles, where used, the impact of an update, releases and files. */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-library-'));
const stubComposer = (): PackageComposer => ({ async pdf() { return { pdf: Buffer.from('%PDF-1.4\n%%EOF\n'), pageCount: 1, facts: null }; }, async html() { return { facts: null }; } });
const BRAND = { primary: '#1F4E79', accent: '#4EAF60', fontFamily: 'Georgia' };

function helpers(getCtx: () => Ctx) {
  const inj = (method: any, url: string, payload?: any, headers?: any) => getCtx().app.inject({ method, url, payload, headers });
  const json = async (method: any, url: string, payload?: any, headers?: any) => (await inj(method, url, payload, headers)).json();
  const project = async (id: string): Promise<Project> => (await json('GET', `/api/v1/projects/${id}`)).project;
  /** What the studio does: apply commands to the working copy, then save it. */
  const apply = async (id: string, ...cmds: Command[]): Promise<Project> => {
    let p = await project(id);
    const v = p.modelVersion;
    for (const c of cmds) { const r = applyCommand(p, c); if (!r.ok) throw new Error(r.message); p = r.project; }
    const put = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...p, modelVersion: v + 1 } }, { 'if-match': `"${v}"` });
    expect(put.statusCode, put.body).toBe(200);
    return put.json().project;
  };
  const latest = async (itemId: string) => json('GET', `/api/v1/library/${itemId}/versions/latest`);
  return { inj, json, project, apply, latest };
}

describe('the shared library (sign-in off: the local admin)', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false, releasePackage: { composer: stubComposer() } }); });
  afterAll(async () => { await ctx.app.close(); });
  const { inj, json, project, apply, latest } = helpers(() => ctx);
  const CARD = 'aster-card-demo', EOB = 'harborcare-demo';

  it('starts empty; an item is created with its first version as a draft, from content or from a saved document', async () => {
    expect(await json('GET', '/api/v1/library')).toEqual({ items: [], can: { create: true, approve: true } });
    const r = await inj('POST', '/api/v1/library', { kind: 'brand', title: '  House   brand ', description: 'Colours for every statement', content: BRAND });
    expect(r.statusCode).toBe(201);
    expect(r.json().item).toMatchObject({ id: 'house-brand', kind: 'brand', title: 'House brand', latest: null, draft: 1, usage: { documents: 0, behind: 0 }, versions: [{ version: 1, state: 'draft', note: 'First version', createdBy: { name: 'Local admin' } }] });
    const block = await inj('POST', '/api/v1/library', { kind: 'block', title: 'Payment actions', projectId: CARD, ref: 'payment-actions' });
    expect(block.statusCode, block.body).toBe(201);
    expect(block.json().item.source).toEqual({ projectId: CARD, projectTitle: (await project(CARD)).title, ref: 'payment-actions' });
    const v = await json('GET', '/api/v1/library/payment-actions/versions/1');
    expect(v.content.nodes.map((n: any) => n.id)).toEqual(['payment-actions', 'payment-action', 'payment-qr']);
    expect((await inj('GET', '/api/v1/library/payment-actions/versions/latest')).statusCode).toBe(404);
    // Same kind and name twice is refused; filters work.
    expect((await inj('POST', '/api/v1/library', { kind: 'brand', title: 'house brand', content: BRAND })).json().error.code).toBe('LIBRARY_NAME_TAKEN');
    expect((await json('GET', '/api/v1/library?kind=block')).items.map((i: any) => i.id)).toEqual(['payment-actions']);
    expect((await json('GET', '/api/v1/library?q=colours')).items.map((i: any) => i.id)).toEqual(['house-brand']);
    expect((await json('GET', '/api/v1/library?state=approved')).items).toEqual([]);
    expect((await inj('GET', '/api/v1/library?kind=poster')).statusCode).toBe(400);
  });

  it('refuses malformed and oversized content in plain words', async () => {
    const bad = await inj('POST', '/api/v1/library', { kind: 'brand', title: 'Bad brand', content: { primary: 'red', accent: '#123456' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toMatch(/6-digit hex/);
    const big = await inj('POST', '/api/v1/library', { kind: 'wording', title: 'Huge', content: { part: { id: 'huge', title: 'Huge', type: 'text', approvedLocales: { 'en-US': 'x'.repeat(1_600_000) } } } });
    expect(big.statusCode).toBe(422);
    expect(big.json().error.message).toMatch(/too large/);
    expect((await inj('POST', '/api/v1/library', { kind: 'wording-rules', title: 'Rules', content: { rules: [{ id: 'r1', kind: 'banned', severity: 'must' }] } })).json().error.message).toMatch(/needs the phrase/);
    expect((await inj('POST', '/api/v1/library', { kind: 'block', title: 'Whole', projectId: CARD, ref: 'doc-root' })).json().error.message).toMatch(/whole document/);
    expect((await inj('POST', '/api/v1/library', { kind: 'poster', title: 'X', content: {} })).statusCode).toBe(400);
  });

  it('approving freezes a version: nothing edits or deletes it, and a change is a new version', async () => {
    const a = await json('POST', '/api/v1/library/house-brand/approve', { note: 'Approved for 2027' });
    expect(a).toMatchObject({ version: 1, item: { latest: 1, draft: null, versions: [{ version: 1, state: 'approved', note: 'Approved for 2027', approvedBy: { name: 'Local admin' } }] } });
    expect((await inj('POST', '/api/v1/library/house-brand/approve')).json().error.code).toBe('NO_DRAFT');
    expect((await inj('DELETE', '/api/v1/library/house-brand/draft')).json().error.code).toBe('NO_DRAFT');
    // The table itself refuses to change or delete an approved version.
    const db = (ctx as any).store.db;
    expect(() => db.prepare("UPDATE library_versions SET json='{}' WHERE item_id='house-brand' AND number=1").run()).toThrow(/frozen/);
    expect(() => db.prepare("DELETE FROM library_versions WHERE item_id='house-brand'").run()).toThrow(/never deleted/);
    // A new draft is version 2; saving again edits the same draft; v1 is untouched.
    const d1 = await json('PUT', '/api/v1/library/house-brand/draft', { content: { ...BRAND, primary: '#222222' }, note: 'Darker' });
    expect(d1).toMatchObject({ version: 2, created: true, item: { latest: 1, draft: 2 } });
    const d2 = await json('PUT', '/api/v1/library/house-brand/draft', { content: { ...BRAND, primary: '#333333' }, note: 'Darker still' });
    expect(d2).toMatchObject({ version: 2, created: false });
    expect((await latest('house-brand')).content.primary).toBe('#1F4E79');
    expect((await json('GET', '/api/v1/library/house-brand/versions/2')).content.primary).toBe('#333333');
    // Discarding a draft keeps the approved versions.
    expect(await json('DELETE', '/api/v1/library/house-brand/draft')).toMatchObject({ discarded: 2, item: { latest: 1, draft: null } });
    // Discarding the only version of an item that was never approved removes the item.
    await inj('POST', '/api/v1/library', { kind: 'glossary', title: 'Scratch glossary', content: { entries: { 'es-US': [{ source: 'fee', target: 'cargo' }] } } });
    expect(await json('DELETE', '/api/v1/library/scratch-glossary/draft')).toEqual({ item: null, discarded: 1 });
    expect((await inj('GET', '/api/v1/library/scratch-glossary')).statusCode).toBe(404);
  });

  it('where used: every document linking to an item, at which version, and which are behind', async () => {
    expect((await json('POST', '/api/v1/library/payment-actions/approve')).version).toBe(1);
    const v1 = await latest('payment-actions');
    // A second document uses the block; the card links in place of the component it was made from.
    const dup = await json('POST', `/api/v1/projects/${CARD}/duplicate`, { title: 'Second card' });
    const second = dup.project.projectId as string;
    const linkCmd = (placement: any): Command => ({ type: 'LINK_LIBRARY_ITEM', item: { id: 'payment-actions', kind: 'block', title: 'Payment actions' }, version: 1, content: v1.content, placement });
    await apply(CARD, linkCmd({ replaceNodeId: 'payment-actions' }));
    const p2 = await apply(second, { type: 'DELETE_NODE', nodeId: 'payment-actions' }, linkCmd({ parentId: 'doc-root', index: 4 }));
    expect(p2.libraryLinks![0].target).toMatchObject({ kind: 'block', idPrefix: `${p2.libraryLinks![0].linkId}-` });
    let usage = await json('GET', '/api/v1/library/payment-actions/usage');
    expect(usage.usage.map((u: any) => [u.projectId, u.version, u.behind]).sort()).toEqual([[CARD, 1, false], [second, 1, false]]);
    // Version 2 is approved: both documents are behind; nothing changed in either document.
    const changed = JSON.parse(JSON.stringify(v1.content));
    changed.nodes.find((n: any) => n.id === 'payment-action').action.label = 'Pay your bill online';
    await json('PUT', '/api/v1/library/payment-actions/draft', { content: changed, note: 'Clearer button' });
    const before = projectContentDigest(await project(second));
    const appr = await json('POST', '/api/v1/library/payment-actions/approve');
    expect(appr.usage.filter((u: any) => u.behind)).toHaveLength(2);
    expect(projectContentDigest(await project(second))).toBe(before);
    usage = await json('GET', '/api/v1/library/payment-actions');
    expect(usage.item.usage).toEqual({ documents: 2, links: 2, behind: 2 });
    const list = (await json('GET', '/api/v1/library')).items.find((i: any) => i.id === 'payment-actions');
    expect(list).toMatchObject({ latest: 2, usage: { documents: 2, behind: 2 } });
  });

  it('the impact of updating a document is the Before & after comparison of the updated document, and it stores nothing', async () => {
    const second = (await json('GET', '/api/v1/projects')).projects.find((p: any) => p.title === 'Second card').projectId;
    const doc = await project(second);
    const link = doc.libraryLinks![0];
    const r = await inj('POST', '/api/v1/library/payment-actions/impact', { projectId: second, version: 2 });
    expect(r.statusCode, r.body).toBe(200);
    const impact = r.json();
    expect(impact).toMatchObject({ linkId: link.linkId, title: 'Payment actions', kind: 'block', from: 1, to: 2 });
    const records = RECORDS.filter((x) => x.documentType === doc.documentType);
    const v2 = (await json('GET', '/api/v1/library/payment-actions/versions/2')).content;
    const pure = libraryUpdateImpact(doc, link.linkId, { version: 2, content: v2, title: 'Payment actions' }, records);
    const updated = applyCommand(doc, { type: 'UPDATE_LIBRARY_LINK', linkId: link.linkId, version: 2, content: v2, title: 'Payment actions' });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(pure.comparison).toEqual(compareVersions(doc, updated.project, records));
    expect(projectContentDigest(pure.project)).toBe(projectContentDigest(updated.project));
    expect(impact.comparison.groups).toEqual(pure.comparison.groups);
    expect(impact.comparison.evaluated).toBeGreaterThan(0);
    expect(impact.comparison.customers.some((c: any) => c.changes.some((x: any) => x.after.includes('Pay your bill online')))).toBe(true);
    expect(impact.changes.flatMap((s: any) => s.items).join(' ')).toMatch(/updated from version 1 to version 2/);
    expect(projectContentDigest(await project(second))).toBe(projectContentDigest(doc));
    // Errors in plain words
    expect((await inj('POST', '/api/v1/library/house-brand/impact', { projectId: second })).json().error.message).toMatch(/does not use “House brand”/);
    expect((await inj('POST', '/api/v1/library/payment-actions/impact', { projectId: second, version: 9 })).json().error.message).toMatch(/not approved/);
  });

  it('saving a document that changes linked content is the client’s business; the server checks link shapes', async () => {
    const p = await project(CARD);
    const bad = JSON.parse(JSON.stringify(p));
    bad.libraryLinks[0].target.rootNodeId = 'nowhere';
    const r = await inj('PUT', `/api/v1/projects/${CARD}`, { project: { ...bad, modelVersion: p.modelVersion + 1 } }, { 'if-match': `"${p.modelVersion}"` });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toMatch(/library link .* not in the document/);
  });

  it('a release freezes the links with the content; the package manifest and README list what came from the library', async () => {
    await json('POST', '/api/v1/library/house-brand/approve').catch(() => undefined);
    const brand = await latest('house-brand');
    await apply(EOB, { type: 'LINK_LIBRARY_ITEM', item: { id: 'house-brand', kind: 'brand', title: 'House brand' }, version: brand.version.version, content: brand.content });
    expect((await inj('POST', `/api/v1/projects/${EOB}/workflow`, { action: 'submit' })).statusCode).toBe(200);
    const ok = await inj('POST', `/api/v1/projects/${EOB}/workflow`, { action: 'approve' });
    expect(ok.statusCode, ok.body).toBe(200);
    const id = ok.json().release.release.id;
    const lib = await json('GET', `/api/v1/releases/${id}/library`);
    expect(lib.library).toEqual([{ itemId: 'house-brand', title: 'House brand', kind: 'brand', version: 1, inLibrary: true }]);
    expect((await json('GET', `/api/v1/releases/${id}/template`)).libraryLinks).toHaveLength(1);
    const z = await inj('GET', `/api/v1/releases/${id}/package?wait=1`);
    expect(z.statusCode).toBe(200);
    const files = new Map(zipEntries(z.rawPayload).map((e) => [e.name, zipRead(z.rawPayload, e)]));
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.library).toEqual([{ itemId: 'house-brand', title: 'House brand', kind: 'brand', version: 1 }]);
    const readme = files.get('README.html')!.toString('utf8');
    expect(readme).toMatch(/What came from the library/);
    expect(readme).toMatch(/<td>House brand<\/td><td>Brand<\/td><td>1<\/td>/);
    // Updating to the version the document already holds is refused in plain words.
    expect((await inj('POST', '/api/v1/library/house-brand/impact', { projectId: EOB })).json().error.message).toMatch(/already holds version 1/);
  });

  it('saved templates and project files carry the links; an import naming items this studio does not have keeps the content', async () => {
    const tpl = await inj('POST', '/api/v1/templates', { projectId: CARD, title: 'Card with library block' });
    expect(tpl.statusCode).toBe(201);
    const made = await json('POST', '/api/v1/projects', { templateId: tpl.json().template.id, title: 'From library template' });
    expect(made.project.libraryLinks).toEqual((await project(CARD)).libraryLinks);
    const file = await project(CARD);
    file.libraryLinks = file.libraryLinks!.map((l) => ({ ...l, itemId: 'somewhere-else-block' }));
    const imp = await inj('POST', '/api/v1/projects/import', { file, title: 'Imported with unknown library item' });
    expect(imp.statusCode, imp.body).toBe(201);
    const imported = imp.json().project as Project;
    expect(imported.libraryLinks![0].itemId).toBe('somewhere-else-block');
    expect(imported.nodes.find((n) => n.id === 'payment-actions')).toBeTruthy();
    const items = (await json('GET', '/api/v1/library')).items;
    expect(linkStatus(imported.libraryLinks![0], items)).toBe('not-in-library');
    expect(linkStatus((await project(CARD)).libraryLinks![0], items)).toBe('behind');
    // A malformed link in a file is refused before anything is stored.
    const broken = { ...file, libraryLinks: [{ ...file.libraryLinks![0], kind: 'poster' }] };
    const r = await inj('POST', '/api/v1/projects/import', { file: broken, title: 'Broken links' });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LIBRARY' })]));
  });

  it('every write is in the audit log with ids and titles only', async () => {
    const rows = (await json('GET', '/api/v1/audit?limit=200')).events.filter((e: any) => e.action.startsWith('library.'));
    expect(rows.map((e: any) => e.action)).toEqual(expect.arrayContaining(['library.create', 'library.draft', 'library.approve', 'library.discard']));
    for (const e of rows) {
      expect(Object.keys(e.detail).every((k) => ['itemId', 'title', 'kind', 'version', 'newVersion', 'documentsBehind', 'itemRemoved', 'removed'].includes(k)), JSON.stringify(e.detail)).toBe(true);
      expect(JSON.stringify(e.detail)).not.toMatch(/#1F4E79|approvedLocales|nodes/);
    }
  });

  it('the reset is refused unless the server allows it', async () => {
    expect((await inj('POST', '/api/v1/library/reset', { confirm: true })).json().error.code).toBe('RESET_DISABLED');
    process.env.LIBRARY_RESET = 'allow';
    try {
      expect((await inj('POST', '/api/v1/library/reset', {})).json().error.code).toBe('CONFIRM_REQUIRED');
      expect((await json('POST', '/api/v1/library/reset', { confirm: true })).removed).toBeGreaterThan(0);
      expect((await json('GET', '/api/v1/library')).items).toEqual([]);
    } finally { delete process.env.LIBRARY_RESET; }
  });

});

describe('the shared library with sign-in on: who may do what', () => {
  let ctx: Ctx;
  const saved = { ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  const cookies: Record<string, { cookie: string }> = {};
  beforeAll(async () => {
    process.env.ADMIN_EMAIL = 'admin@example.test';
    process.env.ADMIN_PASSWORD = 'correct horse battery';
    ctx = await buildApp({ dataDir: tmp(), logger: false, auth: true, releasePackage: { composer: stubComposer() } });
    const login = async (email: string, password: string) => {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
      return { cookie: String([r.headers['set-cookie']].flat()[0]).split(';')[0] };
    };
    cookies.admin = await login('admin@example.test', 'correct horse battery');
    for (const role of ['author', 'reviewer', 'approver']) {
      await ctx.app.inject({ method: 'POST', url: '/api/v1/users', payload: { email: `${role}@example.test`, name: `${role} person`, role, password: 'a long enough password' }, headers: cookies.admin });
      cookies[role] = await login(`${role}@example.test`, 'a long enough password');
    }
  });
  afterAll(async () => {
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const inj = (method: any, url: string, payload: any, role: string | null) => ctx.app.inject({ method, url, payload, headers: role ? cookies[role] : undefined });

  it('anyone signed in reads; authors create and draft; approvers and admins approve; refusals are in plain words', async () => {
    expect((await inj('GET', '/api/v1/library', undefined, null)).statusCode).toBe(401);
    for (const r of ['author', 'reviewer', 'approver', 'admin']) expect((await inj('GET', '/api/v1/library', undefined, r)).statusCode, r).toBe(200);
    expect((await inj('GET', '/api/v1/library', undefined, 'reviewer')).json().can).toEqual({ create: false, approve: false });
    expect((await inj('GET', '/api/v1/library', undefined, 'author')).json().can).toEqual({ create: true, approve: false });
    expect((await inj('GET', '/api/v1/library', undefined, 'approver')).json().can).toEqual({ create: false, approve: true });
    const rev = await inj('POST', '/api/v1/library', { kind: 'brand', title: 'House brand', content: BRAND }, 'reviewer');
    expect(rev.statusCode).toBe(403);
    expect(rev.json().error.message).toBe('Reviewers cannot add to the library or draft a new version; ask an author.');
    const made = await inj('POST', '/api/v1/library', { kind: 'brand', title: 'House brand', content: BRAND }, 'author');
    expect(made.statusCode).toBe(201);
    expect(made.json().item.createdBy.name).toBe('author person');
    const own = await inj('POST', '/api/v1/library/house-brand/approve', {}, 'author');
    expect(own.statusCode).toBe(403);
    expect(own.json().error.message).toBe('Only approvers and admins can approve a library version.');
    expect((await inj('DELETE', '/api/v1/library/house-brand/draft', undefined, 'reviewer')).json().error.message).toBe('Reviewers can see the library but not change it.');
    const ok = await inj('POST', '/api/v1/library/house-brand/approve', {}, 'approver');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().item.versions[0].approvedBy.name).toBe('approver person');
    expect((await inj('PUT', '/api/v1/library/house-brand/draft', { content: BRAND }, 'approver')).statusCode).toBe(403);
    expect((await inj('PUT', '/api/v1/library/house-brand/draft', { content: { ...BRAND, primary: '#000000' } }, 'author')).statusCode).toBe(200);
    expect((await inj('DELETE', '/api/v1/library/house-brand/draft', undefined, 'approver')).statusCode).toBe(200);
    expect((await inj('POST', '/api/v1/library/reset', { confirm: true }, 'approver')).statusCode).toBe(403);
    const audit = (await inj('GET', '/api/v1/audit?limit=50', undefined, 'admin')).json().events.filter((e: any) => e.action.startsWith('library.'));
    expect(audit.map((e: any) => [e.action, e.userName])).toEqual(expect.arrayContaining([['library.create', 'author person'], ['library.approve', 'approver person'], ['library.discard', 'approver person']]));
  });
});
