import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-st-'));

describe('saved templates (auth off: local admin)', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false }); });
  afterAll(async () => { await ctx.app.close(); });
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const project = async (id: string) => (await inj('GET', `/api/v1/projects/${id}`)).json().project;

  it('saves a document as a template: version 1, listed after the built-in starters, with nothing that belongs to the one document', async () => {
    const r = await inj('POST', '/api/v1/templates', { projectId: 'aster-card-demo', title: '  Aster   statement starter ', description: 'House statement layout', note: 'First version' });
    expect(r.statusCode).toBe(201);
    const { template, version, created } = r.json();
    expect({ version, created }).toEqual({ version: 1, created: true });
    expect(template).toMatchObject({ id: 'saved-aster-statement-starter', title: 'Aster statement starter', description: 'House statement layout', documentType: 'credit-statement', source: 'saved', version: 1, retired: false });
    expect(template.versions).toHaveLength(1);
    expect(template.versions[0]).toMatchObject({ version: 1, note: 'First version', savedBy: { name: 'Local admin' }, from: { projectId: 'aster-card-demo', title: 'Aster Card – credit-card statement' } });
    const src = await project('aster-card-demo');
    expect(template.versions[0].counts).toMatchObject({ components: src.nodes.length, rules: src.rules.length, messages: src.contentParts.length });

    const list = (await inj('GET', '/api/v1/templates')).json();
    expect(list.canSave).toBe(true);
    expect(list.templates.map((t: any) => t.source)).toEqual(['builtin', 'builtin', 'builtin', 'saved']);

    const preview = (await inj('GET', `/api/v1/templates/${template.id}/project`)).json();
    expect(preview.version).toBe(1);
    expect(preview.project).not.toHaveProperty('lastSavedAt');
    expect(preview.project).not.toHaveProperty('derivedFrom');
    expect(preview.project.rules).toEqual(src.rules);
  });

  it('a project started from a saved template names the template version, keeps rules, translations and tests, and resolves', async () => {
    const c = await inj('POST', '/api/v1/projects', { templateId: 'saved-aster-statement-starter', title: 'Spring statement' });
    expect(c.statusCode).toBe(201);
    const p = c.json().project;
    const src = await project('aster-card-demo');
    expect(p).toMatchObject({ projectId: 'spring-statement', title: 'Spring statement', modelVersion: 1, fromTemplate: { templateId: 'saved-aster-statement-starter', version: 1, title: 'Aster statement starter' } });
    expect(p.contentParts).toEqual(src.contentParts);
    expect(p.testCases ?? []).toEqual(src.testCases ?? []);
    expect((await inj('GET', `/api/v1/projects/${p.projectId}/workflow`)).json().workflow?.state ?? 'draft').toBe('draft');
    expect((await inj('POST', '/api/v1/resolve', { projectId: p.projectId, recordId: 'CARD-0002' })).statusCode).toBe(200);
  });

  it('saving again adds version 2; version 1 is frozen and can still be used', async () => {
    const p = await project('spring-statement');
    const edited = { ...p, issuer: { ...p.issuer, product: 'Aster Spring' } };
    const put = await inj('PUT', '/api/v1/projects/spring-statement', { project: edited }, { 'if-match': String(p.modelVersion) });
    expect(put.statusCode).toBe(200);
    const r = await inj('POST', '/api/v1/templates', { projectId: 'spring-statement', templateId: 'saved-aster-statement-starter', note: 'Spring product name' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ version: 2, created: false });
    expect(r.json().template.versions.map((v: any) => v.version)).toEqual([2, 1]);
    // a template never carries where its source document came from
    const latest = (await inj('GET', '/api/v1/templates/saved-aster-statement-starter/project')).json();
    expect(latest.version).toBe(2);
    expect(latest.project.issuer.product).toBe('Aster Spring');
    expect(latest.project.fromTemplate).toMatchObject({ version: 2 });
    const v1 = (await inj('GET', '/api/v1/templates/saved-aster-statement-starter/project?version=1')).json();
    expect(v1.project.issuer.product).not.toBe('Aster Spring');
    const fromV1 = (await inj('POST', '/api/v1/projects', { templateId: 'saved-aster-statement-starter', templateVersion: 1, title: 'From the first version' })).json();
    expect(fromV1.project.fromTemplate.version).toBe(1);
    expect(fromV1.project.issuer.product).not.toBe('Aster Spring');
    expect((await inj('GET', '/api/v1/templates/saved-aster-statement-starter/project?version=9')).statusCode).toBe(404);
    expect((await inj('POST', '/api/v1/projects', { templateId: 'saved-aster-statement-starter', templateVersion: 0, title: 'Nope nope' })).statusCode).toBe(400);
  });

  it('refuses a name that is taken, a version of a built-in starter, and a version for another kind of document', async () => {
    expect((await inj('POST', '/api/v1/templates', { projectId: 'aster-card-demo', title: 'aster STATEMENT starter' })).json().error.code).toBe('TEMPLATE_NAME_TAKEN');
    expect((await inj('POST', '/api/v1/templates', { projectId: 'aster-card-demo', title: 'Blank letter' })).statusCode).toBe(409);
    expect((await inj('POST', '/api/v1/templates', { projectId: 'aster-card-demo', templateId: 'blank-letter' })).statusCode).toBe(404);
    expect((await inj('POST', '/api/v1/templates', { projectId: 'harborcare-demo', templateId: 'saved-aster-statement-starter' })).json().error.code).toBe('DOCUMENT_TYPE_MISMATCH');
    expect((await inj('POST', '/api/v1/templates', { projectId: 'no-such-project', title: 'Whatever' })).statusCode).toBe(404);
    expect((await inj('POST', '/api/v1/templates', { projectId: 'aster-card-demo', title: 'x' })).statusCode).toBe(400);
  });

  it('retiring hides a template from the list without removing it; saving a new version brings it back', async () => {
    expect((await inj('PATCH', '/api/v1/templates/blank-letter', { retired: true })).statusCode).toBe(404);
    expect((await inj('PATCH', '/api/v1/templates/saved-aster-statement-starter', {})).statusCode).toBe(400);
    expect((await inj('PATCH', '/api/v1/templates/saved-aster-statement-starter', { retired: true })).json().template.retired).toBe(true);
    expect((await inj('GET', '/api/v1/templates')).json().templates).toHaveLength(3);
    expect((await inj('GET', '/api/v1/templates?includeRetired=true')).json().templates).toHaveLength(4);
    // projects already started from it are untouched, and it can still be opened by id
    expect((await project('spring-statement')).fromTemplate.templateId).toBe('saved-aster-statement-starter');
    expect((await inj('PATCH', '/api/v1/templates/saved-aster-statement-starter', { retired: false })).json().template.retired).toBe(false);
    const audit = (await inj('GET', '/api/v1/audit?limit=50')).json();
    const actions = (audit.events ?? audit.entries ?? []).map((e: any) => e.action);
    for (const a of ['template.save', 'template.retire', 'template.unretire', 'project.create']) expect(actions).toContain(a);
  });

  it('reset removes saved templates only, and needs confirmation', async () => {
    expect((await inj('POST', '/api/v1/templates/reset', {})).statusCode).toBe(400);
    expect((await inj('POST', '/api/v1/templates/reset', { confirm: true })).json().removed).toBe(1);
    expect((await inj('GET', '/api/v1/templates?includeRetired=true')).json().templates.map((t: any) => t.id)).toEqual(['credit-card-statement', 'explanation-of-benefits', 'blank-letter']);
  });
});

describe('project file import (auth off)', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false }); });
  afterAll(async () => { await ctx.app.close(); });
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const exported = async (id = 'aster-card-demo') => (await inj('GET', `/api/v1/projects/${id}/export`)).json();
  const count = async () => (await inj('GET', '/api/v1/projects')).json().projects.length;

  it('imports an exported project as a new draft document; the original is not replaced', async () => {
    const file = await exported();
    const before = await count();
    const dry = await inj('POST', '/api/v1/projects/import', { file, dryRun: true });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ dryRun: true, wouldCreate: { title: file.title }, report: { from: { projectId: 'aster-card-demo' }, notImported: ['Customers', 'Version history', 'Review state', 'Comments'] } });
    expect(await count()).toBe(before);

    const r = await inj('POST', '/api/v1/projects/import', { file, title: 'Aster statement (from file)' });
    expect(r.statusCode).toBe(201);
    const { project, report } = r.json();
    expect(project).toMatchObject({ projectId: 'aster-statement-from-file', title: 'Aster statement (from file)', modelVersion: 1, importedFrom: { projectId: 'aster-card-demo', modelVersion: file.modelVersion } });
    expect(project.rules).toEqual(file.rules);
    expect(report.counts).toMatchObject({ components: file.nodes.length, rules: file.rules.length });
    expect(report.warnings.join(' ')).toContain('nothing is replaced');
    expect(await count()).toBe(before + 1);
    expect((await inj('GET', '/api/v1/projects/aster-card-demo')).json().project.modelVersion).toBe(file.modelVersion);
    expect((await inj('POST', '/api/v1/resolve', { projectId: project.projectId, recordId: 'CARD-0001' })).statusCode).toBe(200);
    // the same file again gets its own id
    expect((await inj('POST', '/api/v1/projects/import', { file, title: 'Aster statement (from file)' })).json().project.projectId).toBe('aster-statement-from-file-2');
    // the envelope form is accepted too
    expect((await inj('POST', '/api/v1/projects/import', { file: { format: 'iss-project', project: await exported('harborcare-demo') } })).statusCode).toBe(201);
  });

  it('rejects files that are not a project, with every problem named and nothing stored', async () => {
    const file = await exported();
    const before = await count();
    const bad = async (f: unknown) => { const r = await inj('POST', '/api/v1/projects/import', { file: f }); return { status: r.statusCode, ...r.json().error }; };
    expect(await bad('hello')).toMatchObject({ status: 422, code: 'INVALID_PROJECT_FILE' });
    expect(await bad({ records: [] })).toMatchObject({ status: 422, code: 'INVALID_PROJECT_FILE' });
    expect(await bad({ ...file, schemaVersion: '0.0.1' })).toMatchObject({ status: 422, code: 'SCHEMA_VERSION' });
    expect(await bad({ ...file, documentType: 'invoice' })).toMatchObject({ status: 422 });
    expect(await bad({ ...file, rootNodeId: 'nowhere' })).toMatchObject({ status: 422 });
    expect(await bad({ ...file, nodes: [...file.nodes, file.nodes[0]] })).toMatchObject({ status: 422 });
    const img = file.nodes.find((n: any) => n.image);
    const outside = await bad({ ...file, nodes: file.nodes.map((n: any) => (n === img ? { ...n, image: { ...n.image, src: 'https://example.com/pixel.png' } } : n)) });
    expect(outside).toMatchObject({ status: 422 });
    expect(JSON.stringify(outside.problems)).toContain('points outside the file');
    const brokenRule = await bad({ ...file, rules: [{ ...file.rules[0], when: { all: [{ path: 'no.such.field', op: 'eq', value: 1 }] } }, ...file.rules.slice(1)] });
    expect(brokenRule.status).toBe(422);
    const dangling = await bad({ ...file, nodes: file.nodes.map((n: any) => (n.id === file.rootNodeId ? { ...n, children: [...n.children, 'ghost'] } : n)) });
    expect(JSON.stringify(dangling.problems)).toContain('ghost');
    expect(await count()).toBe(before);
  });
});

describe('templates and project import: roles (auth on)', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    for (const k of ['AUTH', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']) saved[k] = process.env[k];
    process.env.AUTH = 'on';
    process.env.ADMIN_EMAIL = 'admin@example.test';
    process.env.ADMIN_PASSWORD = 'correct horse battery';
    ctx = await buildApp({ dataDir: tmp(), logger: false });
  });
  afterAll(async () => {
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const login = async (email: string, password: string) => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    return String([r.headers['set-cookie']].flat()[0]).split(';')[0];
  };

  it('approvers and admins save templates; authors and reviewers cannot. Authors import; reviewers and approvers cannot', async () => {
    const admin = await login('admin@example.test', 'correct horse battery');
    for (const role of ['author', 'reviewer', 'approver']) expect((await inj('POST', '/api/v1/users', { email: `${role}@example.test`, name: `${role} person`, role, password: 'password-123' }, { cookie: admin })).statusCode).toBe(201);
    const author = await login('author@example.test', 'password-123');
    const reviewer = await login('reviewer@example.test', 'password-123');
    const approver = await login('approver@example.test', 'password-123');
    const save = (cookie: string, title: string) => inj('POST', '/api/v1/templates', { projectId: 'aster-card-demo', title }, { cookie });

    expect((await save(author, 'By an author')).statusCode).toBe(403);
    expect((await save(reviewer, 'By a reviewer')).statusCode).toBe(403);
    const ok = await save(approver, 'By an approver');
    expect(ok.statusCode).toBe(201);
    expect(ok.json().template.versions[0].savedBy.name).toBe('approver person');
    expect((await save(admin, 'By an admin')).statusCode).toBe(201);
    expect((await inj('GET', '/api/v1/templates', undefined, { cookie: author })).json().canSave).toBe(false);
    expect((await inj('GET', '/api/v1/templates', undefined, { cookie: approver })).json().canSave).toBe(true);
    // retiring follows saving; the demo reset is for admins
    expect((await inj('PATCH', '/api/v1/templates/saved-by-an-approver', { retired: true }, { cookie: author })).statusCode).toBe(403);
    expect((await inj('PATCH', '/api/v1/templates/saved-by-an-approver', { retired: true }, { cookie: approver })).statusCode).toBe(200);
    expect((await inj('POST', '/api/v1/templates/reset', { confirm: true }, { cookie: approver })).statusCode).toBe(403);
    // anyone who can edit can start from a saved template and import a project file
    expect((await inj('POST', '/api/v1/projects', { templateId: 'saved-by-an-admin', title: 'Author starts here' }, { cookie: author })).statusCode).toBe(201);
    const file = (await inj('GET', '/api/v1/projects/aster-card-demo/export', undefined, { cookie: author })).json();
    expect((await inj('POST', '/api/v1/projects/import', { file, title: 'Imported by author' }, { cookie: author })).statusCode).toBe(201);
    expect((await inj('POST', '/api/v1/projects/import', { file, title: 'Imported by reviewer' }, { cookie: reviewer })).statusCode).toBe(403);
    expect((await inj('POST', '/api/v1/projects/import', { file, title: 'Imported by approver' }, { cookie: approver })).statusCode).toBe(403);
    expect((await inj('POST', '/api/v1/projects/import', { file, dryRun: true }, { cookie: reviewer })).statusCode).toBe(403);
  });
});
