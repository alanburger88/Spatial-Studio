import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectContentDigest, type Project } from '@iss/model';
import { buildApp } from '../src/app';
import type { PackageComposer } from '../src/releasePackage';
import { zipEntries, zipRead } from '../src/zip';

/**
 * Blockers phase 4 against the real API: a cause's owner, status and notes; what a person may set; "Fixed" worked out
 * by the studio from the saved document; the "Fixed" listing ending at the next approval; notes never in a release or
 * its package; and, with sign-in on, who may do it.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-work-'));
const CARD = 'aster-card-demo';
const SPANISH = 'required-translation-missing~billing-summary~es-US';
const LAYOUT = 'flow-overflow-no-continuation~transaction-table';
const BASE = `/api/v1/projects/${CARD}/blocker-work`;
const NOTE_MARK = 'Ximena-checks-the-glossary-7Q2';

function stubComposer(): PackageComposer {
  return {
    async pdf(html: string) { return { pdf: Buffer.from(`%PDF-1.4\n% stub ${createHash('sha256').update(html).digest('hex')}\n%%EOF\n`), pageCount: 1, facts: null }; },
    async html() { return { facts: null }; },
  };
}

function helpers(getCtx: () => Ctx) {
  const inj = (method: any, url: string, payload?: any, headers?: any) => getCtx().app.inject({ method, url, payload, headers });
  const json = async (method: any, url: string, payload?: any, headers?: any) => (await inj(method, url, payload, headers)).json();
  const project = async (id: string, headers?: any): Promise<Project> => (await json('GET', `/api/v1/projects/${id}`, undefined, headers)).project;
  const save = async (id: string, edit: (p: any) => void, headers?: any) => {
    const p: any = await project(id, headers);
    edit(p);
    const r = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...p, modelVersion: p.modelVersion + 1 } }, { 'if-match': `"${p.modelVersion}"`, ...(headers ?? {}) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().project as Project;
  };
  /** Approves every missing Spanish wording, as a person would: the Spanish blockers are fixed. */
  const fixSpanish = (headers?: any) => save(CARD, (p) => { for (const part of p.contentParts) if (!part.approvedLocales['es-US']) part.approvedLocales['es-US'] = `ES: ${part.approvedLocales['en-US']}`; }, headers);
  const put = (blockerId: string, body: any, headers?: any) => inj('PUT', `${BASE}/${encodeURIComponent(blockerId)}`, body, headers);
  const note = (blockerId: string, body: any, headers?: any) => inj('POST', `${BASE}/${encodeURIComponent(blockerId)}/notes`, { body }, headers);
  const item = async (blockerId: string, headers?: any) => (await json('GET', BASE, undefined, headers)).items.find((i: any) => i.blockerId === blockerId);
  return { inj, json, project, save, fixSpanish, put, note, item };
}

describe('blocker owner, status and notes (sign-in off: the local admin)', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false, releasePackage: { composer: stubComposer() } }); });
  afterAll(async () => { await ctx.app.close(); });
  const { inj, json, save, fixSpanish, put, note, item } = helpers(() => ctx);

  it('nothing is worked on to begin with; the only possible owner is the local admin', async () => {
    const r = await json('GET', BASE);
    expect(r).toMatchObject({ projectId: CARD, authEnabled: false, items: [], people: [{ id: 'local-admin', name: 'Local admin', role: 'admin' }] });
    expect(await json('GET', '/api/v1/assignable-people')).toEqual({ people: [{ id: 'local-admin', name: 'Local admin', role: 'admin' }], authEnabled: false });
  });

  it('gives a cause an owner and the status "Being fixed"; audited; no notification for one’s own action', async () => {
    const r = await put(SPANISH, { ownerId: 'local-admin', status: 'being-fixed' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().item).toMatchObject({ blockerId: SPANISH, kind: 'wording', speed: 'fast', owner: { id: 'local-admin', name: 'Local admin' }, status: 'being-fixed', statusBy: { name: 'Local admin' }, fixedAt: null, notes: [] });
    expect(r.json().item.title).toMatch(/Spanish/);
    expect(r.json().item.customerCount).toBeGreaterThan(0);
    const actions = (await json('GET', `/api/v1/audit?projectId=${CARD}&limit=20`)).events.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['blocker.assign', 'blocker.status']));
    expect((await json('GET', '/api/v1/notifications')).unread).toBe(0);
  });

  it('refuses what a person may not set: Fixed, Known data problem, an unknown status, an unknown owner, an unknown or unsaved blocker', async () => {
    const cases: Array<[Promise<any>, number, string]> = [
      [put(SPANISH, { status: 'fixed' }), 422, 'STATUS_SET_BY_STUDIO'],
      [put(SPANISH, { status: 'known-data-problem' }), 422, 'STATUS_SET_BY_STUDIO'],
      [put(SPANISH, { status: 'done' }), 400, 'INVALID_STATUS'],
      [put(SPANISH, { ownerId: 'u-nobody' }), 400, 'UNKNOWN_PERSON'],
      [put(SPANISH, {}), 400, 'INVALID_REQUEST'],
      [put('not-a-real-problem~x', { status: 'open' }), 400, 'UNKNOWN_BLOCKER'],
      // a real kind of problem that the saved document does not have (an unsaved change could make it)
      [put('priority-tie~R01+R02', { status: 'being-fixed' }), 409, 'NOT_IN_SAVED_DOCUMENT'],
      [note(SPANISH, '   '), 400, 'EMPTY_NOTE'],
      [note(SPANISH, 'x'.repeat(1001)), 400, 'NOTE_TOO_LONG'],
    ];
    for (const [p, status, code] of cases) {
      const r = await p;
      expect(r.statusCode, `${code}: ${r.body}`).toBe(status);
      expect(r.json().error.code).toBe(code);
    }
    expect((await item(SPANISH)).status).toBe('being-fixed');
  });

  it('notes are plain text with the author and time, oldest first; the note is not copied into the audit log', async () => {
    const r = await note(SPANISH, `  Asked the translators.‮\n\n\n\nThey reply ${NOTE_MARK}.  `);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().note).toMatchObject({ body: `Asked the translators.\n\nThey reply ${NOTE_MARK}.`, author: { id: 'local-admin', name: 'Local admin' } });
    expect(Date.parse(r.json().note.at)).not.toBeNaN();
    await note(SPANISH, 'Second note');
    expect((await item(SPANISH)).notes.map((n: any) => n.body)).toEqual([`Asked the translators.\n\nThey reply ${NOTE_MARK}.`, 'Second note']);
    const ev = (await json('GET', `/api/v1/audit?projectId=${CARD}&action=blocker.note`)).events;
    expect(ev).toHaveLength(2);
    expect(JSON.stringify(ev)).not.toContain(NOTE_MARK);
  });

  it('a cause only the full check sees can be worked on; a full check of another version is refused', async () => {
    const r = await put(LAYOUT, { ownerId: 'local-admin' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().item).toMatchObject({ kind: 'layout', speed: 'full-check', status: 'open' });
    const p = (await json('GET', `/api/v1/projects/${CARD}`)).project;
    const stale = await inj('POST', `${BASE}/full-check`, { modelVersion: p.modelVersion - 1, contentDigest: projectContentDigest(p), blockerIds: [] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('NOT_THE_SAVED_VERSION');
    // the full check of the saved version still finds it: nothing changes
    const same = await inj('POST', `${BASE}/full-check`, { modelVersion: p.modelVersion, contentDigest: projectContentDigest(p), blockerIds: [LAYOUT] });
    expect(same.json()).toMatchObject({ fixed: [], reopened: [] });
  });

  it('keeps the owner, status and notes across a save that leaves the cause in place', async () => {
    await save(CARD, (p) => { p.title = 'Aster, renamed for the test'; });
    expect(await item(SPANISH)).toMatchObject({ owner: { name: 'Local admin' }, status: 'being-fixed', notes: [{}, {}] });
  });

  it('the studio marks it Fixed once the saved document no longer has it, and it cannot be changed by hand then', async () => {
    const saved = await fixSpanish();
    const it1 = await item(SPANISH);
    expect(it1).toMatchObject({ status: 'fixed', fixedInVersion: saved.modelVersion, customerCount: 0, owner: { name: 'Local admin' } });
    expect(Date.parse(it1.fixedAt)).not.toBeNaN();
    const r = await put(SPANISH, { status: 'open' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('ALREADY_FIXED');
    expect((await json('GET', `/api/v1/audit?projectId=${CARD}&action=blocker.fixed`)).events[0]).toMatchObject({ detail: { blockerId: SPANISH, how: 'saved-document' } });
    // the owner made the change: nobody is told about their own fix
    expect((await json('GET', '/api/v1/notifications')).unread).toBe(0);
  });

  it('a fixed cause that comes back is open again, with its owner and notes', async () => {
    await save(CARD, (p) => { const part = p.contentParts.find((c: any) => c.id === 'billing-summary') ?? p.contentParts[0]; delete part.approvedLocales['es-US']; });
    expect(await item(SPANISH)).toMatchObject({ status: 'open', fixedAt: null, owner: { name: 'Local admin' }, notes: [{}, {}] });
    expect((await json('GET', `/api/v1/audit?projectId=${CARD}&action=blocker.reopen`)).events).toHaveLength(1);
    await fixSpanish();
    expect((await item(SPANISH)).status).toBe('fixed');
  });

  it('a full check of the saved version that no longer finds a cause fixes it', async () => {
    const p = (await json('GET', `/api/v1/projects/${CARD}`)).project;
    const r = await inj('POST', `${BASE}/full-check`, { modelVersion: p.modelVersion, contentDigest: projectContentDigest(p), blockerIds: [] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().fixed).toEqual([LAYOUT]);
    expect(await item(LAYOUT)).toMatchObject({ status: 'fixed', fixedInVersion: p.modelVersion });
  });

  it('notes never appear in a release or its package', async () => {
    // a note on a cause that stays open through the approval
    await note(LAYOUT, `Layout note ${NOTE_MARK}`);
    expect((await inj('POST', `/api/v1/projects/${CARD}/workflow`, { action: 'submit' })).statusCode).toBe(200);
    const approved = await inj('POST', `/api/v1/projects/${CARD}/workflow`, { action: 'approve' });
    expect(approved.statusCode, approved.body).toBe(200);
    const rel = approved.json().release.release;
    expect(JSON.stringify(await json('GET', `/api/v1/releases/${rel.id}`))).not.toContain(NOTE_MARK);
    const pkg = await inj('GET', `/api/v1/releases/${rel.id}/package?wait=1`);
    expect(pkg.statusCode).toBe(200);
    const zip = pkg.rawPayload;
    const files = zipEntries(zip);
    expect(files.some((e) => e.name === 'manifest.json')).toBe(true);
    for (const e of files) {
      const text = zipRead(zip, e).toString('utf8');
      expect(text.includes(NOTE_MARK), `note in ${e.name}`).toBe(false);
      expect(text.includes('Asked the translators'), `note in ${e.name}`).toBe(false);
    }
    // and not in the exported document either
    expect(JSON.stringify(await json('GET', `/api/v1/projects/${CARD}/export`))).not.toContain(NOTE_MARK);
  });

  it('a fixed cause drops off, with its notes, at the document’s next approval', async () => {
    const r = await json('GET', BASE);
    expect(r.items.map((i: any) => i.blockerId)).toEqual([]);
    expect(Date.parse(r.lastApprovalAt)).not.toBeNaN();
    expect(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM blocker_notes').get()).toMatchObject({ n: 0 });
  });

  it('deleting a document removes its owners, statuses and notes', async () => {
    const dup = (await json('POST', '/api/v1/projects/aster-card-demo/duplicate', { title: 'Aster copy for work' })).project;
    const b = `/api/v1/projects/${dup.projectId}/blocker-work`;
    expect((await inj('PUT', `${b}/${encodeURIComponent(LAYOUT)}`, { ownerId: 'local-admin' })).statusCode).toBe(200);
    expect((await inj('POST', `${b}/${encodeURIComponent(LAYOUT)}/notes`, { body: 'A note' })).statusCode).toBe(201);
    expect((await inj('DELETE', `/api/v1/projects/${dup.projectId}`)).statusCode).toBe(200);
    expect(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM blocker_work WHERE project_id=?').get(dup.projectId)).toMatchObject({ n: 0 });
    expect(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM blocker_notes WHERE project_id=?').get(dup.projectId)).toMatchObject({ n: 0 });
  });

  it('My work lists the local admin’s open causes and the documents in review', async () => {
    await save(CARD, (p) => { const part = p.contentParts.find((c: any) => c.id === 'billing-summary') ?? p.contentParts[0]; delete part.approvedLocales['es-US']; });
    expect((await put(SPANISH, { ownerId: 'local-admin' })).statusCode).toBe(200);
    const harbor = await inj('POST', '/api/v1/projects/harborcare-demo/workflow', { action: 'submit' });
    expect(harbor.statusCode).toBe(200);
    const w = await json('GET', '/api/v1/my-work');
    expect(w.user).toMatchObject({ id: 'local-admin', role: 'admin' });
    expect(w.blockers).toEqual([expect.objectContaining({ projectId: CARD, blockerId: SPANISH, status: 'open', kind: 'wording' })]);
    expect(w.reviews.map((r: any) => r.projectId)).toContain('harborcare-demo');
    expect(w.reviews.find((r: any) => r.projectId === 'harborcare-demo')).toMatchObject({ canApprove: true, mine: true, modelVersion: expect.any(Number) });
  });
});

describe('blocker owner, status and notes with sign-in on', () => {
  let ctx: Ctx;
  const saved = { ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  const h: Record<string, { cookie: string }> = {};
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    process.env.ADMIN_EMAIL = 'admin@example.test';
    process.env.ADMIN_PASSWORD = 'correct horse battery';
    ctx = await buildApp({ dataDir: tmp(), logger: false, auth: true, releasePackage: { composer: stubComposer() } });
    const login = async (email: string, password: string) => {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
      expect(r.statusCode).toBe(200);
      ids[email] = r.json().user.id;
      return { cookie: String([r.headers['set-cookie']].flat()[0]).split(';')[0] };
    };
    h.admin = await login('admin@example.test', 'correct horse battery');
    for (const [role, name] of [['author', 'Ann Author'], ['reviewer', 'Rita Reviewer'], ['approver', 'Abe Approver']] as const) {
      expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/users', payload: { email: `${role}@example.test`, name, role, password: 'a long enough password' }, headers: h.admin })).statusCode).toBe(201);
      h[role] = await login(`${role}@example.test`, 'a long enough password');
      ids[role] = ids[`${role}@example.test`];
    }
  });
  afterAll(async () => {
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const { inj, json, fixSpanish, put, note, item } = helpers(() => ctx);
  const inbox = async (role: string) => json('GET', '/api/v1/notifications', undefined, h[role]);

  it('needs a session; the owner can be any studio user, listed for everyone signed in', async () => {
    expect((await inj('GET', BASE)).statusCode).toBe(401);
    expect((await put(SPANISH, { status: 'being-fixed' })).statusCode).toBe(401);
    const people = await json('GET', '/api/v1/assignable-people', undefined, h.reviewer);
    expect(people.authEnabled).toBe(true);
    expect(people.people.map((p: any) => p.name).sort()).toEqual(['Abe Approver', 'Administrator', 'Ann Author', 'Rita Reviewer']);
    expect(JSON.stringify(people)).not.toContain('@example.test');
    // the user list itself stays for admins
    expect((await inj('GET', '/api/v1/users', undefined, h.reviewer)).statusCode).toBe(403);
  });

  it('anyone who may comment assigns, sets the status and adds notes; the new owner is told, the actor is not', async () => {
    for (const role of ['reviewer', 'author', 'approver']) expect((await inj('GET', BASE, undefined, h[role])).statusCode).toBe(200);
    const r = await put(SPANISH, { ownerId: ids.approver, status: 'being-fixed' }, h.reviewer);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().item).toMatchObject({ owner: { id: ids.approver, name: 'Abe Approver' }, status: 'being-fixed', statusBy: { name: 'Rita Reviewer' } });
    const abe = await inbox('approver');
    expect(abe.unread).toBe(1);
    expect(abe.notifications[0]).toMatchObject({ kind: 'blocker.assigned', projectId: CARD, read: false, actorName: 'Rita Reviewer', target: { screen: 'blockers', projectId: CARD, blockerId: SPANISH } });
    expect(abe.notifications[0].text).toMatch(/^Rita Reviewer made you the owner of a blocker in “.+”: .*Spanish/);
    expect((await inbox('reviewer')).unread).toBe(0);
    // an author may also set the status and add notes
    expect((await put(SPANISH, { status: 'open' }, h.author)).statusCode).toBe(200);
    expect((await note(SPANISH, 'Translation is booked for Monday.', h.author)).statusCode).toBe(201);
    expect((await item(SPANISH, h.author)).notes[0]).toMatchObject({ author: { id: ids.author, name: 'Ann Author' } });
    // a note on a blocker Abe owns tells Abe; Abe's own note tells nobody
    const after = await inbox('approver');
    expect(after.notifications[0]).toMatchObject({ kind: 'blocker.note', actorName: 'Ann Author' });
    expect((await note(SPANISH, 'Thanks, noted.', h.approver)).statusCode).toBe(201);
    expect((await inbox('approver')).unread).toBe(2);
    // a disabled user cannot be given a cause, and nobody can set Fixed
    expect((await put(SPANISH, { ownerId: 'u-unknown' }, h.reviewer)).json().error.code).toBe('UNKNOWN_PERSON');
    expect((await put(SPANISH, { status: 'fixed' }, h.admin)).json().error.code).toBe('STATUS_SET_BY_STUDIO');
  });

  it('the owner is told when someone else’s save fixes it, and My work no longer lists it', async () => {
    let w = await json('GET', '/api/v1/my-work', undefined, h.approver);
    expect(w.blockers.map((b: any) => b.blockerId)).toEqual([SPANISH]);
    await fixSpanish(h.author);
    const abe = await inbox('approver');
    expect(abe.notifications[0]).toMatchObject({ kind: 'blocker.fixed', actorName: 'Ann Author', target: { screen: 'blockers' } });
    expect(abe.notifications[0].text).toMatch(/is fixed: no customer is stopped by it any more/);
    w = await json('GET', '/api/v1/my-work', undefined, h.approver);
    expect(w.blockers).toEqual([]);
    // the author who fixed it is not told
    expect((await inbox('author')).notifications.filter((n: any) => n.kind === 'blocker.fixed')).toEqual([]);
  });

  it('review moves: submitting tells reviewers and approvers; changes requested and approval tell the submitter', async () => {
    expect((await inj('POST', `/api/v1/projects/${CARD}/workflow`, { action: 'submit' }, h.author)).statusCode).toBe(200);
    for (const role of ['reviewer', 'approver', 'admin']) {
      const n = (await inbox(role)).notifications.find((x: any) => x.kind === 'review.submitted');
      expect(n, role).toMatchObject({ actorName: 'Ann Author', target: { screen: 'review', projectId: CARD }, data: { modelVersion: expect.any(Number) } });
      expect(n.text).toMatch(/^Ann Author submitted “.+” \(version \d+\) for review$/);
    }
    expect((await inbox('author')).notifications.some((x: any) => x.kind === 'review.submitted')).toBe(false);
    // My work: waiting for review or approval, for those who may do it
    expect((await json('GET', '/api/v1/my-work', undefined, h.reviewer)).reviews.map((r: any) => r.projectId)).toEqual([CARD]);
    expect((await json('GET', '/api/v1/my-work', undefined, h.approver)).reviews[0]).toMatchObject({ projectId: CARD, canApprove: true, submittedBy: 'Ann Author' });
    expect((await json('GET', '/api/v1/my-work', undefined, h.author)).reviews).toEqual([]);

    expect((await inj('POST', `/api/v1/projects/${CARD}/workflow`, { action: 'request_changes', comment: 'Please check the totals.' }, h.reviewer)).statusCode).toBe(200);
    const ann = await inbox('author');
    expect(ann.notifications[0]).toMatchObject({ kind: 'review.changes_requested', actorName: 'Rita Reviewer' });
    expect(JSON.stringify(ann)).not.toContain('Please check the totals');
    expect((await inj('POST', `/api/v1/projects/${CARD}/workflow`, { action: 'reopen' }, h.author)).statusCode).toBe(200);
    expect((await inj('POST', `/api/v1/projects/${CARD}/workflow`, { action: 'submit' }, h.author)).statusCode).toBe(200);
    const ok = await inj('POST', `/api/v1/projects/${CARD}/workflow`, { action: 'approve' }, h.approver);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await inbox('author')).notifications[0]).toMatchObject({ kind: 'review.approved', actorName: 'Abe Approver' });
  });

  it('a reply tells the person who started the thread, never the one replying', async () => {
    const node = (await json('GET', `/api/v1/projects/${CARD}`, undefined, h.reviewer)).project.nodes[0];
    const root = (await json('POST', `/api/v1/projects/${CARD}/comments`, { nodeId: node.id, body: 'Is this heading right?' }, h.reviewer)).comment;
    const before = (await inbox('reviewer')).unread;
    expect((await inj('POST', `/api/v1/projects/${CARD}/comments`, { parentId: root.id, body: 'Yes, it is.' }, h.author)).statusCode).toBe(201);
    const rita = await inbox('reviewer');
    expect(rita.unread).toBe(before + 1);
    expect(rita.notifications[0]).toMatchObject({ kind: 'comment.reply', actorName: 'Ann Author', target: { screen: 'comment', projectId: CARD, nodeId: node.id } });
    expect(JSON.stringify(rita.notifications[0])).not.toContain('Yes, it is');
    expect((await inj('POST', `/api/v1/projects/${CARD}/comments`, { parentId: root.id, body: 'Thanks.' }, h.reviewer)).statusCode).toBe(201);
    expect((await inbox('reviewer')).unread).toBe(before + 1);
  });

  it('marks one read (only one’s own) and all read', async () => {
    const abe = await inbox('approver');
    const first = abe.notifications[0];
    expect((await inj('POST', `/api/v1/notifications/${first.id}/read`, {}, h.reviewer)).statusCode).toBe(404);
    const r = await inj('POST', `/api/v1/notifications/${first.id}/read`, {}, h.approver);
    expect(r.statusCode).toBe(200);
    expect(r.json().unread).toBe(abe.unread - 1);
    expect((await json('GET', '/api/v1/notifications?limit=0', undefined, h.approver))).toEqual({ notifications: [], unread: abe.unread - 1 });
    expect((await inj('POST', '/api/v1/notifications/read-all', {}, h.approver)).json()).toMatchObject({ unread: 0 });
    expect((await inbox('approver')).notifications.every((n: any) => n.read)).toBe(true);
    // reading notifications is not an action in the Activity log
    const actions = (await json('GET', '/api/v1/audit?limit=200', undefined, h.admin)).events.map((e: any) => e.action);
    expect(actions.some((a: string) => a.startsWith('api.post'))).toBe(false);
  });
});
