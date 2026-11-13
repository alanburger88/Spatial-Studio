import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Project } from '@iss/model';
import { buildApp } from '../src/app';
import { createRelease } from '../src/releases';
import { releaseKnownDataProblems } from '../src/routes/knownData';
import type { PackageComposer } from '../src/releasePackage';
import { zipEntries, zipRead } from '../src/zip';

/** Known data problems against the real API: refusals, who may, lapsing, the approval check, releases and their packages. */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-known-'));
const CARD = 'aster-card-demo';
const DATA = 'inconsistent-payment-state~payment-guidance';
const SPANISH = 'required-translation-missing~billing-summary~es-US';
const BASE = `/api/v1/projects/${CARD}/known-data-problems`;
const SUPPLIED = { givenName: 'Wilhelmina', familyName: 'Featherstonehaugh' };
const IMPORTED = { givenName: 'Zebulon', familyName: 'Quackenbush' };

function stubComposer(): PackageComposer {
  return {
    async pdf(html: string) { return { pdf: Buffer.from(`%PDF-1.4\n% stub ${createHash('sha256').update(html).digest('hex')}\n%%EOF\n`), pageCount: 1, facts: null }; },
    async html() { return { facts: null }; },
  };
}

function helpers(getCtx: () => Ctx) {
  const inj = (method: any, url: string, payload?: any, headers?: any) => getCtx().app.inject({ method, url, payload, headers });
  const json = async (method: any, url: string, payload?: any, headers?: any) => (await inj(method, url, payload, headers)).json();
  const project = async (id: string): Promise<Project> => (await json('GET', `/api/v1/projects/${id}`)).project;
  const save = async (id: string, edit: (p: any) => void) => {
    const p: any = await project(id);
    edit(p);
    const r = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...p, modelVersion: p.modelVersion + 1 } }, { 'if-match': `"${p.modelVersion}"` });
    expect(r.statusCode).toBe(200);
    return r.json().project as Project;
  };
  /** A customer of this document whose own data contradicts itself (up to date, yet missed payments). */
  const badCopy = async (name?: typeof SUPPLIED) => {
    const made = await json('POST', `/api/v1/projects/${CARD}/records`, { copyOf: 'CARD-0001' });
    const rec = made.record;
    const put = await inj('PUT', `/api/v1/projects/${CARD}/records/${rec.recordId}`, { record: { ...rec, customer: { ...rec.customer, ...(name ?? {}) }, card: { ...rec.card, paymentStatus: 'current', missedPayments: 3 } } });
    expect(put.statusCode).toBe(200);
    return rec.recordId as string;
  };
  const badImported = async (name: typeof IMPORTED) => {
    const { recordId: _id, ...row } = (await json('GET', '/api/v1/records/CARD-0002')).record;
    const r = await json('POST', '/api/v1/records/import', { documentType: 'credit-statement', format: 'json', data: [{ ...row, customer: { ...row.customer, ...name }, card: { ...row.card, paymentStatus: 'current', missedPayments: 2 } }] });
    expect(r.imported).toHaveLength(1);
    return r.imported[0].recordId as string;
  };
  const mark = (recordId: string, reason: unknown = 'Corrected in the source system next month', blockerId = DATA, headers?: any) => inj('POST', BASE, { blockerId, recordId, reason }, headers);
  const workflow = (action: string) => inj('POST', `/api/v1/projects/${CARD}/workflow`, { action });
  return { inj, json, project, save, badCopy, badImported, mark, workflow };
}

describe('known data problems (sign-in off: the local admin)', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false, releasePackage: { composer: stubComposer() } }); });
  afterAll(async () => { await ctx.app.close(); });
  const { inj, json, project, save, badCopy, badImported, mark, workflow } = helpers(() => ctx);
  let bad = '';
  let imported = '';

  it('none to begin with', async () => {
    expect(await json('GET', BASE)).toMatchObject({ projectId: CARD, knownDataProblems: [], lapsed: [], note: null });
  });

  it('refuses a missing or too long reason, a blocker in the document itself, an unknown customer and a problem that does not stop that customer', async () => {
    bad = await badCopy();
    const spanishCustomer = (await json('GET', '/api/v1/records?documentType=credit-statement&full=1')).records.find((r: any) => r.customer.locale === 'es-US').recordId;
    const cases: Array<[Promise<any>, number, string]> = [
      [mark(bad, ''), 400, 'REASON_REQUIRED'],
      [mark(bad, '    '), 400, 'REASON_REQUIRED'],
      [mark(bad, 42), 400, 'REASON_REQUIRED'],
      [mark(bad, 'x'.repeat(501)), 400, 'REASON_TOO_LONG'],
      [mark(spanishCustomer, 'We accept it', SPANISH), 422, 'NOT_A_DATA_PROBLEM'],
      [mark(bad, 'A tie we accept', 'priority-tie~R03+R04'), 422, 'NOT_A_DATA_PROBLEM'],
      [mark(bad, 'Pages', 'flow-overflow-no-continuation~transaction-table'), 422, 'NOT_A_DATA_PROBLEM'],
      [mark('CARD-9999'), 404, 'UNKNOWN_CUSTOMER'],
      [mark('EOB-0001'), 404, 'UNKNOWN_CUSTOMER'],
      [mark('CARD-0001'), 409, 'NOT_STOPPING_THIS_CUSTOMER'],
      [inj('POST', BASE, { recordId: bad, reason: 'no blocker' }), 400, 'INVALID_REQUEST'],
    ];
    for (const [p, status, code] of cases) {
      const r = await p;
      expect(r.statusCode, `${code}: ${r.body}`).toBe(status);
      expect(r.json().error.code).toBe(code);
    }
    expect((await json('GET', BASE)).knownDataProblems).toEqual([]);
    const refused = (await json('GET', `/api/v1/audit?projectId=${CARD}&limit=50`)).events.map((e: any) => e.action);
    expect(refused).not.toContain('known-data.add');
  });

  it('sets one aside for one customer, with the reason (trimmed), who and when; audited; a second time is refused', async () => {
    const r = await mark(bad, '  Corrected in the source system next month  ');
    expect(r.statusCode).toBe(201);
    const k = r.json().knownDataProblem;
    expect(k).toMatchObject({ blockerId: DATA, recordId: bad, reason: 'Corrected in the source system next month', markedBy: { name: 'Local admin' }, blocker: { kind: 'customer-data', title: 'The account is “up to date” but lists missed payments', fields: ['card.paymentStatus', 'card.missedPayments'] }, customer: { origin: 'supplied' } });
    expect(Date.parse(k.markedAt)).not.toBeNaN();
    expect((await mark(bad)).json().error.code).toBe('ALREADY_KNOWN');
    expect((await json('GET', BASE)).knownDataProblems.map((x: any) => x.id)).toEqual([k.id]);
    const audit = (await json('GET', `/api/v1/audit?projectId=${CARD}&limit=50`)).events.find((e: any) => e.action === 'known-data.add');
    expect(audit).toMatchObject({ detail: { blockerId: DATA, recordId: bad, id: k.id } });
    // the reason is not copied into the audit log
    expect(JSON.stringify(audit)).not.toContain('source system');
  });

  it('no longer blocks approval for that customer; the approval check lists it with its reason', async () => {
    imported = await badImported(IMPORTED);
    // the Spanish wording is a document blocker: fix it as a person would
    await save(CARD, (p) => { for (const part of p.contentParts) if (!part.approvedLocales['es-US']) part.approvedLocales['es-US'] = `ES: ${part.approvedLocales['en-US']}`; });
    let r = (await json('GET', `/api/v1/projects/${CARD}/workflow`)).readiness;
    expect(r.ready).toBe(false);
    const data = r.blocking.filter((g: any) => g.code === 'INCONSISTENT_PAYMENT_STATE');
    expect(data.flatMap((g: any) => g.recordIds)).toEqual([imported]);
    expect(r.knownDataProblems).toHaveLength(1);
    expect(r.knownDataProblems[0]).toMatchObject({ recordId: bad, reason: 'Corrected in the source system next month', blocker: { title: 'The account is “up to date” but lists missed payments' } });
    expect((await mark(imported, `Data for ${IMPORTED.givenName} ${IMPORTED.familyName} (${imported}) is fixed upstream`)).statusCode).toBe(201);
    r = (await json('GET', `/api/v1/projects/${CARD}/workflow`)).readiness;
    expect(r).toMatchObject({ ready: true, blocking: [] });
    expect(r.knownDataProblems.map((k: any) => k.recordId).sort()).toEqual([bad, imported].sort());
  });

  it('every release records them, without customer data, and its package manifest lists them', async () => {
    expect((await workflow('submit')).statusCode).toBe(200);
    const approved = await workflow('approve');
    expect(approved.statusCode, approved.body).toBe(200);
    const rel = approved.json().release.release;
    expect(rel.knownDataProblems).toEqual([
      { blockerId: DATA, blocker: 'The account is “up to date” but lists missed payments', customer: { kind: 'supplied' }, reason: 'Corrected in the source system next month', markedBy: 'Local admin', markedAt: expect.any(String) },
      { blockerId: DATA, blocker: 'The account is “up to date” but lists missed payments', customer: { kind: 'imported' }, reason: 'Data for the customer (the customer) is fixed upstream', markedBy: 'Local admin', markedAt: expect.any(String) },
    ]);
    const pkg = await inj('GET', `/api/v1/releases/${rel.id}/package?wait=1`);
    expect(pkg.statusCode).toBe(200);
    const zip = pkg.rawPayload;
    const files = new Map(zipEntries(zip).map((e) => [e.name, zipRead(zip, e)]));
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.knownDataProblems).toEqual(rel.knownDataProblems);
    expect(files.get('README.html')!.toString('utf8')).toContain('Known data problems');
    // no id and no name of a customer who is not synthetic, in any file
    for (const [p, data] of files) for (const secret of [IMPORTED.givenName, IMPORTED.familyName, imported, bad]) expect(data.toString('utf8').includes(secret), `${secret} in ${p}`).toBe(false);
  });

  it('lapses by itself when the problem no longer stops that customer, and the answer says so', async () => {
    const rec = (await json('GET', `/api/v1/records?documentType=credit-statement&full=1&projectId=${CARD}`)).records.find((r: any) => r.recordId === bad);
    expect((await inj('PUT', `/api/v1/projects/${CARD}/records/${bad}`, { record: { ...rec, card: { ...rec.card, missedPayments: 0 } } })).statusCode).toBe(200);
    const after = await json('GET', BASE);
    expect(after.knownDataProblems.map((k: any) => k.recordId)).toEqual([imported]);
    expect(after.lapsed).toEqual([{ id: expect.any(String), blockerId: DATA, recordId: bad }]);
    expect(after.note).toBe('1 known data problem no longer applies, because the problem no longer stops that customer, so it was removed.');
    // cleaned up: the next read has nothing to say
    expect(await json('GET', BASE)).toMatchObject({ lapsed: [], note: null });
    const events = (await json('GET', `/api/v1/audit?projectId=${CARD}&limit=50`)).events;
    expect(events.find((e: any) => e.action === 'known-data.lapse')).toMatchObject({ detail: { recordId: bad, blockerId: DATA, why: 'no-longer-stops' } });
    // a customer who is removed takes their entry with them
    const gone = await badCopy();
    expect((await mark(gone)).statusCode).toBe(201);
    expect((await inj('DELETE', `/api/v1/projects/${CARD}/records/${gone}`)).statusCode).toBe(200);
    const w = await mark(imported, 'again'); // any write cleans up too
    expect(w.json().error.code).toBe('ALREADY_KNOWN');
    expect((await json('GET', BASE)).knownDataProblems.map((k: any) => k.recordId)).toEqual([imported]);
  });

  it('can be removed (audited); removing it again is not found', async () => {
    await inj('POST', `/api/v1/projects/${CARD}/reset`, { confirm: true });
    expect((await json('GET', BASE)).knownDataProblems).toEqual([]);
    expect((await mark(imported)).statusCode).toBe(201);
    const [k] = (await json('GET', BASE)).knownDataProblems;
    const r = await inj('DELETE', `${BASE}/${k.id}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ removed: k.id });
    expect((await inj('DELETE', `${BASE}/${k.id}`)).statusCode).toBe(404);
    expect((await json('GET', `/api/v1/audit?projectId=${CARD}&limit=50`)).events.find((e: any) => e.action === 'known-data.remove')).toMatchObject({ detail: { id: k.id, recordId: imported } });
  });

  it('restoring the approved sample starts afresh', async () => {
    expect((await mark(imported)).statusCode).toBe(201);
    await save(CARD, (p) => { p.title = 'Changed'; });
    expect((await inj('POST', `/api/v1/projects/${CARD}/reset`, { confirm: true })).statusCode).toBe(200);
    expect((await json('GET', BASE)).knownDataProblems).toEqual([]);
  });

  it('a built-in sample customer is named by id in the release record and the manifest', async () => {
    // A field the document must show that no sample customer has: every customer's data is incomplete.
    const p = await save(CARD, (x) => {
      x.customFields = [{ key: 'branch', label: 'Branch', type: 'string' }];
      x.nodes.find((n: any) => n.id === 'available-credit').binding = 'custom.branch';
      x.nodes.find((n: any) => n.id === 'available-credit').nullPolicy = 'error';
    });
    expect((await mark('CARD-0001', 'Branch is filled in by the print house', 'null-binding~available-credit')).statusCode).toBe(201);
    expect(releaseKnownDataProblems(ctx.store, p)).toEqual([{ blockerId: 'null-binding~available-credit', blocker: 'A value “Available credit” needs is empty', customer: { kind: 'sample', id: 'CARD-0001' }, reason: 'Branch is filled in by the print house', markedBy: 'Local admin', markedAt: expect.any(String) }]);
    const made = ctx.store.transaction(() => createRelease(ctx.store, p, { approvedBy: { id: 'local-admin', name: 'Local admin' }, approvedAt: '2026-11-13T12:00:00.000Z', createdBy: null, origin: 'manual' }));
    expect(made.release.knownDataProblems?.[0].customer).toEqual({ kind: 'sample', id: 'CARD-0001' });
    expect(ctx.store.release(made.release.id)!.knownDataProblems).toEqual(made.release.knownDataProblems);
    // frozen like the rest of the release
    expect(() => ctx.store.db.prepare('UPDATE releases SET known_data_problems=? WHERE release_id=?').run('[]', made.release.id)).toThrow(/frozen/);
    const pkg = await inj('GET', `/api/v1/releases/${made.release.id}/package?wait=1`);
    const zip = pkg.rawPayload;
    const manifest = JSON.parse(zipRead(zip, zipEntries(zip).find((e) => e.name === 'manifest.json')!).toString('utf8'));
    expect(manifest.knownDataProblems).toEqual(made.release.knownDataProblems);
    // a change to the document that ends the problem lapses the entry; the frozen release keeps what it recorded
    await save(CARD, (x) => { x.nodes.find((n: any) => n.id === 'available-credit').nullPolicy = 'fallback'; });
    const after = await json('GET', BASE);
    expect(after).toMatchObject({ knownDataProblems: [], lapsed: [{ blockerId: 'null-binding~available-credit', recordId: 'CARD-0001' }] });
    expect(ctx.store.release(made.release.id)!.knownDataProblems).toHaveLength(1);
  });
});

describe('known data problems with sign-in on: only approvers decide', () => {
  let ctx: Ctx;
  const saved = { ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  const cookies: Record<string, { cookie: string }> = {};
  beforeAll(async () => {
    process.env.ADMIN_EMAIL = 'admin@example.test';
    process.env.ADMIN_PASSWORD = 'correct horse battery';
    ctx = await buildApp({ dataDir: tmp(), logger: false, auth: true, releasePackage: { composer: stubComposer() } });
    const login = async (email: string, password: string) => {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
      expect(r.statusCode).toBe(200);
      return { cookie: String([r.headers['set-cookie']].flat()[0]).split(';')[0] };
    };
    cookies.admin = await login('admin@example.test', 'correct horse battery');
    for (const [role, name] of [['author', 'Olive Author'], ['reviewer', 'Rhea Reviewer'], ['approver', 'Ada Approver']] as const) {
      expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/users', payload: { email: `${role}@example.test`, name, role, password: 'a long enough password' }, headers: cookies.admin })).statusCode).toBe(201);
      cookies[role] = await login(`${role}@example.test`, 'a long enough password');
    }
  });
  afterAll(async () => {
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('authors and reviewers may read them but not set one aside or remove one; approvers may, and are recorded', async () => {
    const inj = (method: any, url: string, payload: any, role: string) => ctx.app.inject({ method, url, payload, headers: cookies[role] });
    expect((await ctx.app.inject({ method: 'GET', url: BASE })).statusCode).toBe(401);
    const made = (await inj('POST', `/api/v1/projects/${CARD}/records`, { copyOf: 'CARD-0001' }, 'author')).json().record;
    expect((await inj('PUT', `/api/v1/projects/${CARD}/records/${made.recordId}`, { record: { ...made, card: { ...made.card, paymentStatus: 'current', missedPayments: 1 } } }, 'author')).statusCode).toBe(200);
    const body = { blockerId: DATA, recordId: made.recordId, reason: 'Known upstream' };
    for (const role of ['author', 'reviewer']) {
      const r = await inj('POST', BASE, body, role);
      expect(r.statusCode, role).toBe(403);
      expect(r.json().error).toMatchObject({ code: 'FORBIDDEN', needs: 'approve' });
      expect((await inj('GET', BASE, undefined, role)).statusCode).toBe(200);
    }
    const ok = await inj('POST', BASE, body, 'approver');
    expect(ok.statusCode).toBe(201);
    expect(ok.json().knownDataProblem.markedBy).toMatchObject({ name: 'Ada Approver' });
    const id = ok.json().knownDataProblem.id;
    expect((await inj('DELETE', `${BASE}/${id}`, undefined, 'author')).statusCode).toBe(403);
    expect((await inj('DELETE', `${BASE}/${id}`, undefined, 'reviewer')).statusCode).toBe(403);
    expect((await inj('DELETE', `${BASE}/${id}`, undefined, 'admin')).statusCode).toBe(200);
  });
});
