import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app';
import { projectContentDigest } from '@iss/model';

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-collab-'));

describe('collaboration (auth off: local admin)', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false }); });
  afterAll(async () => { await ctx.app.close(); });
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const get = async (id: string) => (await inj('GET', `/api/v1/projects/${id}`)).json().project;
  const save = async (project: any) => inj('PUT', `/api/v1/projects/${project.projectId}`, { project }, { 'if-match': `"${project.modelVersion}"` });

  it('session reports auth off and the built-in local admin', async () => {
    const s = (await inj('GET', '/api/v1/session')).json();
    expect(s).toMatchObject({ authEnabled: false, user: { name: 'Local admin', role: 'admin' } });
    expect(s.permissions).toContain('approve');
  });

  it('version history: seeded v1, every save stored, diff and restore', async () => {
    const p0 = await get('aster-card-demo');
    let list = (await inj('GET', '/api/v1/projects/aster-card-demo/versions')).json();
    expect(list.versions).toHaveLength(1);
    expect(list.versions[0]).toMatchObject({ modelVersion: p0.modelVersion, label: 'Approved sample', current: true });
    expect(list.versions[0].json).toBeUndefined();

    const edited = { ...p0, title: 'Aster edited', modelVersion: p0.modelVersion + 1 };
    edited.rules = p0.rules.map((r: any, i: number) => (i === 0 ? { ...r, priority: r.priority + 1 } : r));
    const s1 = await save(edited);
    expect(s1.statusCode).toBe(200);
    const v2 = s1.json().project.modelVersion;
    list = (await inj('GET', '/api/v1/projects/aster-card-demo/versions')).json();
    expect(list.versions.map((v: any) => v.modelVersion)).toEqual([v2, p0.modelVersion]);
    expect(list.versions[0]).toMatchObject({ savedBy: 'Local admin', current: true });

    const one = (await inj('GET', `/api/v1/projects/aster-card-demo/versions/${p0.modelVersion}`)).json();
    expect(one.project.title).toBe(p0.title);
    expect((await inj('GET', '/api/v1/projects/aster-card-demo/versions/999')).statusCode).toBe(404);

    const d = (await inj('GET', `/api/v1/projects/aster-card-demo/versions/${p0.modelVersion}/diff/${v2}`)).json();
    expect(d.diff.title).toEqual({ from: p0.title, to: 'Aster edited' });
    expect(d.diff.rules.changed[0]).toMatchObject({ id: p0.rules[0].id, priority: { from: p0.rules[0].priority, to: p0.rules[0].priority + 1 } });
    expect(d.diff.summary.counts).toMatchObject({ title: 1, rules: 1 });

    // Restore: confirmation + If-Match like save.
    const url = `/api/v1/projects/aster-card-demo/versions/${p0.modelVersion}/restore`;
    expect((await inj('POST', url, { confirm: true })).statusCode).toBe(428);
    expect((await inj('POST', url, {}, { 'if-match': `"${v2}"` })).statusCode).toBe(400);
    expect((await inj('POST', url, { confirm: true }, { 'if-match': `"${v2 - 1}"` })).statusCode).toBe(409);
    const r = await inj('POST', url, { confirm: true }, { 'if-match': `"${v2}"` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ restored: true, restoredVersion: p0.modelVersion, project: { modelVersion: v2 + 1, title: p0.title } });
    expect(projectContentDigest(r.json().project)).toBe(projectContentDigest(p0));
    list = (await inj('GET', '/api/v1/projects/aster-card-demo/versions')).json();
    expect(list.versions[0]).toMatchObject({ modelVersion: v2 + 1, label: `Restored v${p0.modelVersion}` });
    expect(list.versions).toHaveLength(3);
  });

  it('reset, duplicate and rename each store a labelled version', async () => {
    const reset = (await inj('POST', '/api/v1/projects/aster-card-demo/reset', { confirm: true })).json();
    let v = (await inj('GET', '/api/v1/projects/aster-card-demo/versions')).json().versions;
    expect(v[0]).toMatchObject({ modelVersion: reset.project.modelVersion, label: 'Restored approved sample' });
    const dup = (await inj('POST', '/api/v1/projects/harborcare-demo/duplicate', { title: 'Harbor copy' })).json().project;
    v = (await inj('GET', `/api/v1/projects/${dup.projectId}/versions`)).json().versions;
    expect(v).toHaveLength(1);
    expect(v[0].label).toMatch(/^Duplicated from/);
    await inj('PATCH', `/api/v1/projects/${dup.projectId}`, { title: 'Harbor renamed' });
    v = (await inj('GET', `/api/v1/projects/${dup.projectId}/versions`)).json().versions;
    expect(v[0].label).toBe('Renamed to “Harbor renamed”');
    expect((await inj('DELETE', `/api/v1/projects/${dup.projectId}`)).statusCode).toBe(200);
    expect((await inj('GET', `/api/v1/projects/${dup.projectId}/versions`)).statusCode).toBe(404);
  });

  it('workflow: approval blocked by a blocking finding (missing required translation)', async () => {
    const w0 = (await inj('GET', '/api/v1/projects/aster-card-demo/workflow')).json();
    expect(w0.state).toBe('draft');
    expect(w0.readiness.ready).toBe(false);
    expect(w0.readiness.blocking.some((b: any) => b.code === 'REQUIRED_TRANSLATION_MISSING' && b.recordIds.length > 0)).toBe(true);
    expect((await inj('POST', '/api/v1/projects/aster-card-demo/workflow', { action: 'approve' })).statusCode).toBe(409); // not in review yet
    expect((await inj('POST', '/api/v1/projects/aster-card-demo/workflow', { action: 'submit' })).json().state).toBe('in_review');
    const blocked = await inj('POST', '/api/v1/projects/aster-card-demo/workflow', { action: 'approve' });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('APPROVAL_BLOCKED');
    expect(blocked.json().error.readiness.blocking.length).toBeGreaterThan(0);
    expect((await inj('POST', '/api/v1/projects/aster-card-demo/workflow', { action: 'request_changes' })).statusCode).toBe(400); // comment required
    const rc = (await inj('POST', '/api/v1/projects/aster-card-demo/workflow', { action: 'request_changes', comment: 'Add the Spanish wording.' })).json();
    expect(rc.state).toBe('changes_requested');
    expect((await inj('POST', '/api/v1/projects/aster-card-demo/workflow', { action: 'reopen' })).json().state).toBe('draft');
    expect((await inj('POST', '/api/v1/projects/aster-card-demo/workflow', { action: 'fly' })).statusCode).toBe(400);
  });

  it('workflow: failing test case blocks approval; clean model approves, publishes, and a later save returns to draft', async () => {
    const p = await get('harborcare-demo');
    const vs = p.nodes.find((n: any) => n.type === 'variant-set');
    const failing = { ...p, modelVersion: p.modelVersion + 1, testCases: [{ id: 'tc-wrong', name: 'Wrong expectation', recordId: 'EOB-0001', expect: { selectedVariants: { [vs.id]: 'no-such-variant' } } }] };
    const s = await save(failing);
    expect(s.statusCode).toBe(200);
    await inj('POST', '/api/v1/projects/harborcare-demo/workflow', { action: 'submit' });
    const blocked = await inj('POST', '/api/v1/projects/harborcare-demo/workflow', { action: 'approve' });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.readiness).toMatchObject({ testsRun: 1, testsFailed: 1, blocking: [] });
    expect(blocked.json().error.readiness.tests[0].failures[0]).toMatchObject({ kind: 'selectedVariant', nodeId: vs.id, expected: 'no-such-variant' });

    // Fix the test (still in review: saving does not change the state), then approve and publish.
    const cur = await get('harborcare-demo');
    const fixed = await save({ ...cur, modelVersion: cur.modelVersion + 1, testCases: [] });
    expect(fixed.json().workflow).toEqual({ state: 'in_review', previous: 'in_review' });
    const ok = await inj('POST', '/api/v1/projects/harborcare-demo/workflow', { action: 'approve', comment: 'Looks good' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().state).toBe('approved');
    expect((await inj('POST', '/api/v1/projects/harborcare-demo/workflow', { action: 'publish' })).json().state).toBe('published');

    const pub = await get('harborcare-demo');
    const changed = await save({ ...pub, title: 'HarborCare changed after publishing', modelVersion: pub.modelVersion + 1 });
    expect(changed.json().workflow).toEqual({ state: 'draft', previous: 'published' });
    const w = (await inj('GET', '/api/v1/projects/harborcare-demo/workflow?checks=0')).json();
    expect(w.state).toBe('draft');
    expect(w.readiness).toBeNull();
    expect(w.history[0]).toMatchObject({ action: 'auto_reopen', from: 'published', to: 'draft', user: 'Local admin' });
    expect(w.history[0].comment).toMatch(/saved with changes/);
    expect(w.history.map((h: any) => h.action)).toEqual(['auto_reopen', 'publish', 'approve', 'submit']);
    const versions = (await inj('GET', '/api/v1/projects/harborcare-demo/versions')).json().versions;
    expect(versions[0].workflow[0]).toMatchObject({ action: 'auto_reopen', to: 'draft' });
  });

  it('comments: create, reply, list per node, resolve/reopen, delete, validation', async () => {
    const p = await get('aster-card-demo');
    const nodeId = p.nodes[1].id;
    const base = '/api/v1/projects/aster-card-demo/comments';
    const c = await inj('POST', base, { nodeId, body: '  Please check\u0000 the <b>tone</b>.  ' });
    expect(c.statusCode).toBe(201);
    const root = c.json().comment;
    expect(root).toMatchObject({ nodeId, body: 'Please check the <b>tone</b>.', authorName: 'Local admin', parentId: null, modelVersion: p.modelVersion, mine: true });
    const reply = (await inj('POST', base, { parentId: root.id, body: 'Done.' })).json().comment;
    expect(reply).toMatchObject({ parentId: root.id, nodeId });
    await inj('POST', base, { nodeId: p.nodes[2].id, body: 'Elsewhere' });
    expect((await inj('GET', `${base}?nodeId=${nodeId}`)).json().comments).toHaveLength(2);
    expect((await inj('GET', base)).json().counts).toEqual({ open: 2, resolved: 0 });
    // Resolving a reply resolves its thread.
    const res = (await inj('POST', `${base}/${reply.id}/resolve`, { resolved: true })).json().comment;
    expect(res).toMatchObject({ id: root.id, resolvedBy: 'Local admin' });
    expect((await inj('GET', `${base}?status=open`)).json().comments.map((x: any) => x.nodeId)).toEqual([p.nodes[2].id]);
    expect((await inj('POST', `${base}/${root.id}/resolve`, { resolved: false })).json().comment.resolvedAt).toBeNull();
    expect((await inj('POST', base, { nodeId, body: 'x'.repeat(2001) })).statusCode).toBe(400);
    expect((await inj('POST', base, { nodeId, body: '   ' })).statusCode).toBe(400);
    expect((await inj('POST', base, { nodeId: 'nope', body: 'hi' })).statusCode).toBe(400);
    expect((await inj('DELETE', `${base}/${root.id}`)).json()).toMatchObject({ deleted: true, removed: 2 });
    expect((await inj('GET', `${base}?nodeId=${nodeId}`)).json().comments).toHaveLength(0);
  });

  it('audit log records mutating requests without content bodies', async () => {
    const a = (await inj('GET', '/api/v1/audit?projectId=aster-card-demo&limit=200')).json();
    const actions = a.events.map((e: any) => e.action);
    for (const want of ['project.save', 'project.restore', 'project.reset', 'workflow.submit', 'workflow.request_changes', 'comment.create', 'comment.reply', 'comment.resolve', 'comment.delete']) expect(actions).toContain(want);
    expect(JSON.stringify(a.events)).not.toContain('Please check');
    const save = a.events.find((e: any) => e.action === 'project.save');
    expect(save).toMatchObject({ userName: 'Local admin', projectId: 'aster-card-demo' });
    expect(save.detail.changes).toMatchObject({ title: 1 });
    const filtered = (await inj('GET', '/api/v1/audit?action=comment.&limit=2')).json();
    expect(filtered.events).toHaveLength(2);
    expect(filtered.events.every((e: any) => e.action.startsWith('comment.'))).toBe(true);
    expect(filtered.nextBefore).toBeTruthy();
    const page2 = (await inj('GET', `/api/v1/audit?action=comment.&limit=2&before=${filtered.nextBefore}`)).json();
    expect(page2.events[0].id).toBeLessThan(filtered.nextBefore);
  });
});

describe('collaboration (AUTH=on)', () => {
  let ctx: Ctx;
  const saved = { AUTH: process.env.AUTH, ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  beforeAll(async () => {
    process.env.AUTH = 'on';
    delete process.env.ADMIN_EMAIL; delete process.env.ADMIN_PASSWORD;
    await expect(buildApp({ dataDir: tmp(), logger: false })).rejects.toThrow(/ADMIN_EMAIL/);
    process.env.ADMIN_EMAIL = 'admin@example.test';
    process.env.ADMIN_PASSWORD = 'correct horse battery';
    ctx = await buildApp({ dataDir: tmp(), logger: false });
  });
  afterAll(async () => {
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const cookieOf = (res: any) => String([res.headers['set-cookie']].flat()[0]).split(';')[0];
  async function login(email: string, password: string, ip = '127.0.0.1') {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password }, remoteAddress: ip });
    return { res: r, cookie: r.statusCode === 200 ? cookieOf(r) : '' };
  }

  it('requires a session except for health, session and login', async () => {
    expect((await inj('GET', '/api/v1/health')).statusCode).toBe(200);
    expect((await inj('GET', '/api/v1/session')).json()).toMatchObject({ authEnabled: true, user: null });
    const r = await inj('GET', '/api/v1/projects');
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('login sets an httpOnly SameSite=Lax cookie; logout ends the session', async () => {
    expect((await login('admin@example.test', 'wrong password')).res.statusCode).toBe(401);
    const { res, cookie } = await login('Admin@Example.test', 'correct horse battery');
    expect(res.statusCode).toBe(200);
    const raw = String([res.headers['set-cookie']].flat()[0]);
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect(raw).toMatch(/Max-Age=43200/);
    expect(raw).not.toMatch(/Secure/);
    expect(res.json().user).toMatchObject({ email: 'admin@example.test', role: 'admin' });
    expect((await inj('GET', '/api/v1/session', undefined, { cookie })).json().user.role).toBe('admin');
    expect((await inj('GET', '/api/v1/projects', undefined, { cookie })).statusCode).toBe(200);
    const out = await inj('POST', '/api/v1/auth/logout', {}, { cookie });
    expect(String([out.headers['set-cookie']].flat()[0])).toMatch(/Max-Age=0/);
    expect((await inj('GET', '/api/v1/projects', undefined, { cookie })).statusCode).toBe(401);
  });

  it('brute-force protection per IP + email', async () => {
    for (let i = 0; i < 5; i++) expect((await login('admin@example.test', 'nope-nope', '10.0.0.9')).res.statusCode).toBe(401);
    const locked = await login('admin@example.test', 'correct horse battery', '10.0.0.9');
    expect(locked.res.statusCode).toBe(429);
    expect(locked.res.json().error.code).toBe('TOO_MANY_ATTEMPTS');
    expect((await login('admin@example.test', 'correct horse battery', '10.0.0.10')).res.statusCode).toBe(200);
  });

  it('roles: reviewer can comment and request changes but not save or approve; admin manages users', async () => {
    const admin = (await login('admin@example.test', 'correct horse battery')).cookie;
    const mk = async (email: string, role: string) => inj('POST', '/api/v1/users', { email, name: `${role} person`, role, password: 'password-123' }, { cookie: admin });
    expect((await mk('rev@example.test', 'reviewer')).statusCode).toBe(201);
    expect((await mk('auth@example.test', 'author')).statusCode).toBe(201);
    expect((await mk('rev@example.test', 'reviewer')).statusCode).toBe(409);
    expect((await inj('POST', '/api/v1/users', { email: 'x@example.test', name: 'X', role: 'boss', password: 'password-123' }, { cookie: admin })).statusCode).toBe(400);
    expect((await inj('POST', '/api/v1/users', { email: 'y@example.test', name: 'Y y', role: 'author', password: 'short' }, { cookie: admin })).statusCode).toBe(400);

    const rev = (await login('rev@example.test', 'password-123')).cookie;
    const author = (await login('auth@example.test', 'password-123')).cookie;
    const { project } = (await inj('GET', '/api/v1/projects/harborcare-demo', undefined, { cookie: rev })).json();
    const put = await inj('PUT', '/api/v1/projects/harborcare-demo', { project: { ...project, title: 'Reviewer edit' } }, { cookie: rev, 'if-match': `"${project.modelVersion}"` });
    expect(put.statusCode).toBe(403);
    expect(put.json().error.message).toBe('Reviewers can comment but not edit.');
    expect((await inj('POST', '/api/v1/projects/harborcare-demo/reset', { confirm: true }, { cookie: rev })).statusCode).toBe(403);
    expect((await inj('GET', '/api/v1/users', undefined, { cookie: rev })).statusCode).toBe(403);
    expect((await inj('POST', '/api/v1/resolve', { projectId: 'harborcare-demo', recordId: 'EOB-0001' }, { cookie: rev })).statusCode).toBe(200);

    const c = await inj('POST', '/api/v1/projects/harborcare-demo/comments', { nodeId: project.nodes[1].id, body: 'Reviewer note' }, { cookie: rev });
    expect(c.statusCode).toBe(201);
    expect(c.json().comment.authorName).toBe('reviewer person');
    // Authors cannot delete someone else's comment.
    expect((await inj('DELETE', `/api/v1/projects/harborcare-demo/comments/${c.json().comment.id}`, undefined, { cookie: author })).statusCode).toBe(403);

    expect((await inj('POST', '/api/v1/projects/harborcare-demo/workflow', { action: 'submit' }, { cookie: rev })).statusCode).toBe(403);
    const saveOk = await inj('PUT', '/api/v1/projects/harborcare-demo', { project: { ...project, title: 'Author edit', modelVersion: project.modelVersion + 1 } }, { cookie: author, 'if-match': `"${project.modelVersion}"` });
    expect(saveOk.statusCode).toBe(200);
    expect((await inj('POST', '/api/v1/projects/harborcare-demo/workflow', { action: 'submit' }, { cookie: author })).statusCode).toBe(200);
    expect((await inj('POST', '/api/v1/projects/harborcare-demo/workflow', { action: 'approve' }, { cookie: rev })).statusCode).toBe(403);
    expect((await inj('POST', '/api/v1/projects/harborcare-demo/workflow', { action: 'approve' }, { cookie: author })).statusCode).toBe(403);
    const rc = await inj('POST', '/api/v1/projects/harborcare-demo/workflow', { action: 'request_changes', comment: 'Fix the title' }, { cookie: rev });
    expect(rc.statusCode).toBe(200);
    expect(rc.json().history[0]).toMatchObject({ action: 'request_changes', user: 'reviewer person' });

    // Admin: change a role, disable, reset password; no self-lockout.
    const users = (await inj('GET', '/api/v1/users', undefined, { cookie: admin })).json().users;
    const revUser = users.find((u: any) => u.email === 'rev@example.test');
    expect((await inj('PATCH', `/api/v1/users/${revUser.id}`, { role: 'approver' }, { cookie: admin })).json().user.role).toBe('approver');
    expect((await inj('PATCH', `/api/v1/users/${revUser.id}`, { password: 'new-password-1' }, { cookie: admin })).statusCode).toBe(200);
    expect((await inj('GET', '/api/v1/session', undefined, { cookie: rev })).json().user).toBeNull(); // password reset ends sessions
    expect((await login('rev@example.test', 'new-password-1')).res.statusCode).toBe(200);
    expect((await inj('PATCH', `/api/v1/users/${revUser.id}`, { disabled: true }, { cookie: admin })).json().user.disabled).toBe(true);
    expect((await login('rev@example.test', 'new-password-1')).res.statusCode).toBe(401);
    const me = users.find((u: any) => u.email === 'admin@example.test');
    expect((await inj('PATCH', `/api/v1/users/${me.id}`, { disabled: true }, { cookie: admin })).statusCode).toBe(400);
  });

  it('audit log lists logins, saves, comments, workflow and user admin by real users', async () => {
    const admin = (await login('admin@example.test', 'correct horse battery')).cookie;
    const a = (await inj('GET', '/api/v1/audit?limit=500', undefined, { cookie: admin })).json();
    const actions = new Set(a.events.map((e: any) => e.action));
    for (const want of ['auth.login', 'auth.login_failed', 'auth.logout', 'user.create', 'user.update', 'project.save', 'comment.create', 'workflow.submit', 'workflow.request_changes']) expect(actions).toContain(want);
    const save = a.events.find((e: any) => e.action === 'project.save');
    expect(save.userName).toBe('author person');
    expect(JSON.stringify(a.events)).not.toContain('Reviewer note');
    expect(JSON.stringify(a.events)).not.toContain('password-123');
    expect(a.actors.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Administrator', 'author person', 'reviewer person']));
    // Denied requests are not recorded as actions.
    expect(a.events.filter((e: any) => e.action === 'project.save' && e.userName === 'reviewer person')).toHaveLength(0);
  });
});
