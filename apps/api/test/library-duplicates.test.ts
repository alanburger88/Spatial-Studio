import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyCommand, projectContentDigest, type Command, type Project } from '@iss/model';
import { buildApp } from '../src/app';

/** Duplicate wording across documents (wave 3, section 2): the scan route, its cache and roles, keeping a wording, "Link here" and linking exact duplicates in draft documents. */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-dups-'));
const NOTICE = 'Interest is charged on any balance you carry past the due date; see the terms for the current rate.';
const NEAR = 'Interest is charged on any balance you carry past the due date; see the terms for the annual rate.';
const ES = 'Se cobran intereses sobre cualquier saldo que mantenga después de la fecha de vencimiento.';
const PART = 'payment-standard';

function helpers(getCtx: () => Ctx) {
  const inj = (method: any, url: string, payload?: any, headers?: any) => getCtx().app.inject({ method, url, payload, headers });
  const json = async (method: any, url: string, payload?: any, headers?: any) => (await inj(method, url, payload, headers)).json();
  const project = async (id: string): Promise<Project> => (await json('GET', `/api/v1/projects/${id}`)).project;
  const apply = async (id: string, ...cmds: Command[]): Promise<Project> => {
    let p = await project(id);
    const v = p.modelVersion;
    for (const c of cmds) { const r = applyCommand(p, c); if (!r.ok) throw new Error(r.message); p = r.project; }
    const put = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...p, modelVersion: v + 1 } }, { 'if-match': `"${v}"` });
    expect(put.statusCode, put.body).toBe(200);
    return put.json().project;
  };
  /** A copy of the card statement whose demonstration disclosure reads `locales`. */
  const copyWith = async (title: string, locales: Record<string, string>, partId = PART): Promise<string> => {
    const r = await inj('POST', '/api/v1/projects/aster-card-demo/duplicate', { title });
    expect(r.statusCode, r.body).toBeLessThan(300);
    const id = r.json().project.projectId as string;
    const p = await project(id);
    const part = p.contentParts.find((c) => c.id === partId)!;
    const cmds: Command[] = [{ type: 'UPSERT_CONTENT_PART', part: { ...part, approvedLocales: locales }, advanced: true, reason: 'Test wording' }];
    await apply(id, ...cmds);
    return id;
  };
  return { inj, json, project, apply, copyWith };
}

const groupOf = (scan: any, needle: string) => scan.groups.find((g: any) => g.members.some((m: any) => m.plain.includes(needle)));

describe('duplicate wording (sign-in off: the local admin)', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, extraSamples: false, auth: false }); });
  afterAll(async () => { await ctx.app.close(); });
  const { inj, json, project, apply, copyWith } = helpers(() => ctx);
  let a = '', b = '', c = '', d = '';

  it('scans every saved document and the library, says what it covered and how long it took, and caches by the documents’ versions', async () => {
    a = await copyWith('Doc A', { 'en-US': NOTICE, 'es-US': ES });
    b = await copyWith('Doc B', { 'en-US': NOTICE.toUpperCase(), 'es-US': ES });
    c = await copyWith('Doc C', { 'en-US': NEAR, 'es-US': ES });
    const first = await json('GET', '/api/v1/library/duplicates');
    expect(first.cached).toBe(false);
    expect(first.threshold).toBe(0.85);
    expect(first.kinds).toEqual(['messages', 'disclosures']);
    expect(first.coverage.documents).toBe(5); // the two samples and the three copies
    expect(first.coverage.texts).toBeGreaterThan(20);
    expect(first.coverage.skippedShort).toBeGreaterThan(0);
    expect(typeof first.tookMs).toBe('number');
    expect(first.documents.map((x: any) => x.projectId).sort()).toEqual(['aster-card-demo', 'harborcare-demo', a, b, c].sort());
    expect(first.documents.find((x: any) => x.projectId === a)).toMatchObject({ title: 'Doc A', workflowState: 'draft' });
    expect(first.can).toEqual({ create: true, approve: true, setSeverity: true, link: true });
    const g = groupOf(first, 'see the terms');
    expect(g).toMatchObject({ locale: 'en-US', match: 'near', documents: 3, forms: 2, kinds: ['messages'] });
    expect(g.members.map((m: any) => m.projectId)).toEqual([a, b, c]);
    expect(g.members[2].pieces.filter((p: any) => p.changed).map((p: any) => p.text)).toEqual(['annual']);
    // Wording only: ids, titles and texts; no customer record is read.
    expect(JSON.stringify(first)).not.toMatch(/CARD-0\d{3}|EOB-0\d{3}/);

    const second = await json('GET', '/api/v1/library/duplicates');
    expect(second.cached).toBe(true);
    expect(second.groups).toEqual(first.groups);
    // Another question is another scan; a saved change is seen at once.
    expect((await json('GET', '/api/v1/library/duplicates?threshold=0.97')).cached).toBe(false);
    expect(groupOf(await json('GET', '/api/v1/library/duplicates?threshold=0.97'), 'see the terms').documents).toBe(2);
    d = await copyWith('Doc D', { 'en-US': NOTICE });
    const third = await json('GET', '/api/v1/library/duplicates');
    expect(third.cached).toBe(false);
    expect(groupOf(third, 'see the terms').documents).toBe(4);
    // Filters and plain refusals
    expect((await json('GET', '/api/v1/library/duplicates?language=es-US')).groups.every((x: any) => x.locale === 'es-US')).toBe(true);
    expect(groupOf(await json('GET', '/api/v1/library/duplicates?language=es-US'), 'Se cobran').documents).toBe(3);
    expect((await json('GET', '/api/v1/library/duplicates?kinds=labels')).groups.every((x: any) => x.kinds.every((k: string) => k === 'labels'))).toBe(true);
    expect((await inj('GET', '/api/v1/library/duplicates?threshold=0.2')).json().error.code).toBe('INVALID_THRESHOLD');
    expect((await inj('GET', '/api/v1/library/duplicates?kinds=posters')).json().error.code).toBe('INVALID_KINDS');
    expect((await inj('GET', '/api/v1/library/duplicates?language=xx-YY')).json().error.code).toBe('INVALID_LANGUAGE');
  });

  it('keeping a wording makes a library draft with only the translations every member shares', async () => {
    const before = (await json('GET', '/api/v1/library')).items.length;
    const members = [a, b, d].map((projectId) => ({ projectId, textId: PART }));
    // d has no Spanish: no translation is carried
    const r1 = await inj('POST', '/api/v1/library/duplicates/keep', { title: 'Interest notice (no Spanish)', text: NOTICE, type: 'text', members });
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r1.json()).toMatchObject({ translations: [], notCarried: ['es-US'], edited: false, item: { kind: 'wording', latest: null, draft: 1 } });
    // a and b (B is in capitals: the same wording) share the Spanish exactly
    const r2 = await inj('POST', '/api/v1/library/duplicates/keep', { title: 'Interest notice', text: NOTICE, type: 'text', members: [a, b].map((projectId) => ({ projectId, textId: PART })), source: { projectId: a, ref: PART } });
    expect(r2.statusCode, r2.body).toBe(201);
    expect(r2.json()).toMatchObject({ translations: ['es-US'], notCarried: [] });
    const v = await json('GET', `/api/v1/library/${r2.json().item.id}/versions/1`);
    expect(v.version.state).toBe('draft');
    expect(v.content.part).toEqual({ id: 'interest-notice', title: 'Payment instructions', type: 'text', approvedLocales: { 'en-US': NOTICE, 'es-US': ES } });
    expect(r2.json().item.source).toMatchObject({ projectId: a, ref: PART });
    // An edited text carries no translation (they translate the old words)
    const r3 = await inj('POST', '/api/v1/library/duplicates/keep', { title: 'Interest notice edited', text: `${NOTICE} Ask us for help.`, members: [a, b].map((projectId) => ({ projectId, textId: PART })) });
    expect(r3.json()).toMatchObject({ translations: [], edited: true });
    expect((await json('GET', '/api/v1/library')).items.length).toBe(before + 3);
    expect((await inj('POST', '/api/v1/library/duplicates/keep', { title: 'Interest notice', text: NOTICE, members })).json().error.code).toBe('LIBRARY_NAME_TAKEN');
    expect((await inj('POST', '/api/v1/library/duplicates/keep', { title: 'Nothing', text: NOTICE, members: [] })).json().error.code).toBe('NO_MEMBERS');
    expect((await inj('POST', '/api/v1/library/duplicates/keep', { title: 'Wrong', text: NOTICE, members: [{ projectId: a, textId: 'no-such' }] })).statusCode).toBe(404);
    const rows = (ctx.store as any).db.prepare("SELECT detail FROM audit WHERE action='library.create'").all().map((r: any) => JSON.parse(r.detail));
    expect(rows.filter((x: any) => x.fromDuplicates)).toHaveLength(3);
    expect(rows.find((x: any) => x.itemId === 'interest-notice')).toMatchObject({ fromDuplicates: true, members: 2, documents: 2, languages: ['es-US'] });
    // The draft shows in the group as a library member, not yet approved
    expect(groupOf(await json('GET', '/api/v1/library/duplicates'), 'see the terms').library.map((l: any) => [l.itemId, l.state])).toContainEqual(['interest-notice', 'draft']);
  });

  it('“Link here” is a dry run: none for an exact duplicate, the customers who would read something different for a near one', async () => {
    expect((await inj('POST', '/api/v1/library/interest-notice/link-preview', { projectId: a, partId: PART })).json().error.code).toBe('NO_APPROVED_VERSION');
    await json('POST', '/api/v1/library/interest-notice/approve', {});
    const exact = await json('POST', '/api/v1/library/interest-notice/link-preview', { projectId: a, partId: PART });
    expect(exact.identical).toBe(true);
    expect(exact.comparison.customers.every((x: any) => x.outcome === 'same')).toBe(true);
    expect(exact.content.part.approvedLocales['en-US']).toBe(NOTICE);
    const near = await json('POST', '/api/v1/library/interest-notice/link-preview', { projectId: c, partId: PART });
    expect(near.identical).toBe(false);
    expect(near.before.approvedLocales['en-US']).toBe(NEAR);
    expect(near.after.approvedLocales['en-US']).toBe(NOTICE);
    expect(near.comparison.customers.filter((x: any) => x.outcome !== 'same').length).toBeGreaterThan(0);
    // capitals are a different text for the reader: not identical, so it is reviewed in the document
    expect((await json('POST', '/api/v1/library/interest-notice/link-preview', { projectId: b, partId: PART })).identical).toBe(false);
    // nothing was stored
    expect((await project(a)).libraryLinks ?? []).toEqual([]);
    expect((await inj('POST', '/api/v1/library/interest-notice/link-preview', { projectId: a, partId: 'no-such' })).json().error.code).toBe('CANNOT_LINK');
  });

  it('linking in draft documents: only exact duplicates in draft, saved as a new version, audited per document, never approving anything', async () => {
    const st = ctx.store;
    // e is in review, f approved: both are refused and listed
    const e = await copyWith('Doc E', { 'en-US': NOTICE, 'es-US': ES });
    const f = await copyWith('Doc F', { 'en-US': NOTICE, 'es-US': ES });
    const pe = await project(e), pf = await project(f);
    st.setWorkflow(e, 'submit', 'in_review', pe.modelVersion, projectContentDigest(pe), null, null);
    st.setWorkflow(f, 'approve', 'approved', pf.modelVersion, projectContentDigest(pf), null, null);
    const va = (await project(a)).modelVersion;
    const r = await json('POST', '/api/v1/library/interest-notice/link-drafts', { targets: [
      { projectId: a, partId: PART, modelVersion: va }, { projectId: b, partId: PART }, { projectId: c, partId: PART }, { projectId: d, partId: PART },
      { projectId: e, partId: PART }, { projectId: f, partId: PART }, { projectId: 'nope', partId: PART },
    ] });
    expect(r.linked.map((x: any) => [x.projectId, x.fromVersion, x.toVersion])).toEqual([[a, va, va + 1]]);
    expect(Object.fromEntries(r.refused.map((x: any) => [x.projectId, x.code]))).toEqual({ [b]: 'NOT_EXACT', [c]: 'NOT_EXACT', [d]: 'NOT_EXACT', [e]: 'NOT_DRAFT', [f]: 'NOT_DRAFT', nope: 'NOT_FOUND' });
    expect(r.refused.find((x: any) => x.projectId === e)).toMatchObject({ state: 'in_review', reason: expect.stringMatching(/in review: open it and link it there/) });
    expect(r.refused.find((x: any) => x.projectId === d).reason).toMatch(/translations/);
    const saved = await project(a);
    expect(saved.modelVersion).toBe(va + 1);
    expect(saved.libraryLinks).toEqual([expect.objectContaining({ itemId: 'interest-notice', kind: 'wording', version: 1, target: { kind: 'wording', partId: PART } })]);
    expect((await json('GET', `/api/v1/projects/${a}/workflow?checks=0`)).state).toBe('draft');
    expect(st.getWorkflow(f).state).toBe('approved');
    const audits = (st as any).db.prepare("SELECT project_id, detail FROM audit WHERE action='library.link'").all();
    expect(audits.map((x: any) => [x.project_id, JSON.parse(x.detail).bulk, JSON.parse(x.detail).toVersion])).toEqual([[a, true, va + 1]]);
    // the version history says why
    expect((await json('GET', `/api/v1/projects/${a}/versions`)).versions[0].label).toMatch(/Linked “Interest notice” from the library/);
    // a stale version and an already-linked message are refused
    expect((await json('POST', '/api/v1/library/interest-notice/link-drafts', { targets: [{ projectId: a, partId: PART, modelVersion: va }] })).refused[0].code).toBe('VERSION_CONFLICT');
    expect((await json('POST', '/api/v1/library/interest-notice/link-drafts', { targets: [{ projectId: a, partId: PART }] })).refused[0].code).toBe('CANNOT_LINK');
    // A disclosure shows its version number, which linking raises: even an exact duplicate is linked in the document
    const g1 = await copyWith('Doc G', { 'en-US': NOTICE }, 'sample-disclosure-set');
    const g2 = await copyWith('Doc H', { 'en-US': NOTICE }, 'sample-disclosure-set');
    const kept = await json('POST', '/api/v1/library/duplicates/keep', { title: 'Interest disclosure', text: NOTICE, type: 'disclosure', members: [g1, g2].map((projectId) => ({ projectId, textId: 'sample-disclosure-set' })) });
    await json('POST', `/api/v1/library/${kept.item.id}/approve`, {});
    const disc = await json('POST', `/api/v1/library/${kept.item.id}/link-drafts`, { targets: [{ projectId: g1, partId: 'sample-disclosure-set' }] });
    expect(disc.linked).toEqual([]);
    expect(disc.refused[0]).toMatchObject({ code: 'NOT_EXACT', reason: expect.stringMatching(/new version number/) });
    // and the group now shows the document as linked
    const g = groupOf(await json('GET', '/api/v1/library/duplicates'), 'see the terms');
    expect(g.members.find((m: any) => m.projectId === a).linked).toMatchObject({ itemId: 'interest-notice', version: 1 });
    // a wording that is not approved yet cannot be linked
    expect((await inj('POST', '/api/v1/library/interest-notice-no-spanish/link-drafts', { targets: [{ projectId: d, partId: PART }] })).json().error.code).toBe('NO_APPROVED_VERSION');
  });

  it('a near duplicate linked in the document (the studio’s way: one command, then the document’s own save) joins the exact group', async () => {
    const r = await json('POST', '/api/v1/library/interest-notice/link-preview', { projectId: c, partId: PART });
    await apply(c, { type: 'LINK_LIBRARY_ITEM', item: { id: 'interest-notice', kind: 'wording', title: 'Interest notice' }, version: r.version.version, content: r.content, placement: { partId: PART } });
    const g = groupOf(await json('GET', '/api/v1/library/duplicates'), 'see the terms');
    expect(g.members.filter((m: any) => m.linked?.itemId === 'interest-notice').map((m: any) => m.projectId).sort()).toEqual([a, c].sort());
    expect(g.members.find((m: any) => m.projectId === c).form).toBe(0);
  });
});

describe('duplicate wording with sign-in on: who may do what', () => {
  let ctx: Ctx;
  const saved = { ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  const cookies: Record<string, { cookie: string }> = {};
  beforeAll(async () => {
    process.env.ADMIN_EMAIL = 'admin@example.test';
    process.env.ADMIN_PASSWORD = 'correct horse battery';
    ctx = await buildApp({ dataDir: tmp(), logger: false, extraSamples: false, auth: true });
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

  it('anyone signed in scans; authors keep wording and link drafts; reviewers and approvers do not; refusals in plain words', async () => {
    expect((await inj('GET', '/api/v1/library/duplicates', undefined, null)).statusCode).toBe(401);
    for (const r of ['author', 'reviewer', 'approver', 'admin']) expect((await inj('GET', '/api/v1/library/duplicates', undefined, r)).statusCode, r).toBe(200);
    expect((await inj('GET', '/api/v1/library/duplicates', undefined, 'reviewer')).json().can).toEqual({ create: false, approve: false, setSeverity: false, link: false });
    expect((await inj('GET', '/api/v1/library/duplicates', undefined, 'author')).json().can).toEqual({ create: true, approve: false, setSeverity: false, link: true });
    const body = { title: 'Payment reminder', text: 'We noticed your scheduled payment has not yet arrived.', members: [{ projectId: 'aster-card-demo', textId: 'payment-reminder' }] };
    const rev = await inj('POST', '/api/v1/library/duplicates/keep', body, 'reviewer');
    expect(rev.statusCode).toBe(403);
    expect(rev.json().error.message).toBe('Reviewers cannot add to the library or draft a new version; ask an author.');
    expect((await inj('POST', '/api/v1/library/duplicates/keep', body, 'approver')).statusCode).toBe(403);
    expect((await inj('POST', '/api/v1/library/duplicates/keep', body, 'author')).statusCode).toBe(201);
    expect((await inj('POST', '/api/v1/library/payment-reminder/approve', {}, 'author')).statusCode).toBe(403);
    expect((await inj('POST', '/api/v1/library/payment-reminder/approve', {}, 'approver')).statusCode).toBe(200);
    // the dry run is for anyone; linking documents needs edit rights
    expect((await inj('POST', '/api/v1/library/payment-reminder/link-preview', { projectId: 'aster-card-demo', partId: 'payment-reminder' }, 'reviewer')).json().identical).toBe(true);
    const link = await inj('POST', '/api/v1/library/payment-reminder/link-drafts', { targets: [{ projectId: 'aster-card-demo', partId: 'payment-reminder' }] }, 'reviewer');
    expect(link.statusCode).toBe(403);
    expect(link.json().error.message).toBe('Reviewers cannot change documents; ask an author.');
    const ok = await inj('POST', '/api/v1/library/payment-reminder/link-drafts', { targets: [{ projectId: 'aster-card-demo', partId: 'payment-reminder' }] }, 'author');
    expect(ok.json().linked).toHaveLength(1);
    const row = (ctx.store as any).db.prepare("SELECT user_name, project_id FROM audit WHERE action='library.link'").get();
    expect(row).toEqual({ user_name: 'author person', project_id: 'aster-card-demo' });
  });
});
