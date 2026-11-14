import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app';
import { PRESENCE_TTL_MS, Presence } from '../src/presence';

/**
 * Who else is editing (wave 4, item 4; docs/api/PRESENCE.md). Kept in memory only: a window is forgotten after 45 seconds
 * of silence (tested with a fake clock), two windows on one document see each other and not themselves, leaving removes a
 * window at once, and nothing is ever written to the database or the Activity log. With sign-in off both windows are the
 * local admin (`sameUser`); with it on, two people are told apart and one cannot remove the other's window.
 */

const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-presence-'));
const CARD = 'aster-card-demo';
const W1 = 'window-one-aaaa';
const W2 = 'window-two-bbbb';

class Clock { t = 1_700_000_000_000; now = () => this.t; tick(ms: number) { this.t += ms; } }

describe('Presence (the in-memory list)', () => {
  it('forgets a window after 45 seconds of silence, and keeps one that keeps reporting', () => {
    const c = new Clock();
    const p = new Presence(c.now);
    const r = (windowId: string, userId = 'u1') => p.report({ windowId, userId, userName: 'Dana', projectId: CARD, screen: 'S02', componentId: null, dirty: false });
    r(W1); r(W2);
    expect(p.others(CARD, 'u1', W1).length).toBe(1);
    c.tick(30_000); r(W1);
    c.tick(PRESENCE_TTL_MS - 30_000); // W2 silent for exactly 45 s: still listed
    expect(p.others(CARD, 'u1', W1).length).toBe(1);
    c.tick(1);
    expect(p.others(CARD, 'u1', W1)).toEqual([]);
    expect(p.size).toBe(1);
    c.tick(PRESENCE_TTL_MS + 1);
    expect(p.size).toBe(0);
  });

  it('one entry per window: moving to another document leaves the first', () => {
    const p = new Presence(new Clock().now);
    p.report({ windowId: W1, userId: 'u1', userName: 'Dana', projectId: CARD, screen: 'S02', componentId: null, dirty: false });
    p.report({ windowId: W1, userId: 'u1', userName: 'Dana', projectId: 'harborcare-demo', screen: 'S19', componentId: null, dirty: false });
    expect(p.others(CARD, 'u2', W2)).toEqual([]);
    expect(p.others('harborcare-demo', 'u2', W2).map((o) => o.name)).toEqual(['Dana']);
  });

  it('a window can be removed only by its own user', () => {
    const p = new Presence(new Clock().now);
    p.report({ windowId: W1, userId: 'u1', userName: 'Dana', projectId: CARD, screen: null, componentId: null, dirty: false });
    expect(p.leave('u2', W1)).toBe(false);
    expect(p.size).toBe(1);
    expect(p.leave('u1', W1)).toBe(true);
    expect(p.size).toBe(0);
  });
});

/** Every row of every table, and the connection's change counter: what "nothing was written" is checked against. */
function dbState(store: any): string {
  const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  const counts = tables.map((t) => `${t}:${(store.db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n}`);
  return `${(store.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n}|${counts.join(',')}`;
}

describe('presence routes, sign-in off', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  const clock = new Clock();
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false, presence: new Presence(clock.now) }); });
  afterAll(async () => { await ctx.app.close(); });
  const report = (windowId: string, body: Record<string, unknown> = {}, projectId = CARD) => ctx.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/presence`, payload: { windowId, ...body } });

  it('two windows on one document each see the other, as the local admin in another window, and never themselves', async () => {
    const a = await report(W1, { screen: 'S02', componentId: 'payment-guidance', dirty: true });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ others: [], intervalMs: 15_000, ttlMs: 45_000 });
    const b = (await report(W2, { screen: 'S17' })).json();
    expect(b.others).toEqual([expect.objectContaining({ userId: 'local-admin', name: 'Local admin', sameUser: true, screen: 'S02', componentId: 'payment-guidance', dirty: true })]);
    expect(JSON.stringify(b)).not.toContain(W1); // a window is never told another window's id
    const a2 = (await report(W1, { screen: 'S02', componentId: 'payment-guidance' })).json();
    expect(a2.others).toEqual([expect.objectContaining({ sameUser: true, screen: 'S17', componentId: null, dirty: false })]);
  });

  it('keeps only a known screen and a component the saved document has', async () => {
    await report(W1, { screen: 'design; drop table', componentId: 'no-such-component' });
    const seen = (await report(W2)).json().others[0];
    expect(seen).toMatchObject({ screen: null, componentId: null });
  });

  it('refuses a bad window id and an unknown document', async () => {
    expect((await report('x')).statusCode).toBe(400);
    expect((await report(W1, {}, 'no-such-document')).statusCode).toBe(404);
  });

  it('leaving removes a window at once; silence removes it after 45 seconds', async () => {
    await report(W1); await report(W2);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/presence/leave', payload: { windowId: W1 } })).json()).toEqual({ left: true });
    expect((await report(W2)).json().others).toEqual([]);
    await report(W1);
    clock.tick(PRESENCE_TTL_MS + 1_000);
    expect((await report(W2)).json().others).toEqual([]);
  });

  it('writes nothing to the database or the Activity log', async () => {
    const before = dbState(ctx.store);
    for (let i = 0; i < 5; i++) { await report(W1, { screen: 'S02', dirty: i % 2 === 0 }); await report(W2, { screen: 'S19' }); }
    await ctx.app.inject({ method: 'POST', url: '/api/v1/presence/leave', payload: { windowId: W1 } });
    expect(dbState(ctx.store)).toBe(before);
    const activity = (await ctx.app.inject({ method: 'GET', url: '/api/v1/audit?limit=50' })).json();
    expect(JSON.stringify(activity)).not.toMatch(/presence/i);
  });
});

describe('presence routes, sign-in on', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  const saved = { ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  const h: Record<string, { cookie: string }> = {};
  beforeAll(async () => {
    process.env.ADMIN_EMAIL = 'admin@example.test';
    process.env.ADMIN_PASSWORD = 'correct horse battery';
    ctx = await buildApp({ dataDir: tmp(), logger: false, auth: true, presence: new Presence(new Clock().now) });
    const login = async (email: string, password: string) => {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
      expect(r.statusCode).toBe(200);
      return { cookie: String([r.headers['set-cookie']].flat()[0]).split(';')[0] };
    };
    h.admin = await login('admin@example.test', 'correct horse battery');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/users', payload: { email: 'reviewer@example.test', name: 'Dana Reviewer', role: 'reviewer', password: 'a long enough password' }, headers: h.admin })).statusCode).toBe(201);
    h.dana = await login('reviewer@example.test', 'a long enough password');
  });
  afterAll(async () => {
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const report = (who: string | null, windowId: string, body: Record<string, unknown> = {}) => ctx.app.inject({ method: 'POST', url: `/api/v1/projects/${CARD}/presence`, payload: { windowId, ...body }, headers: who ? h[who] : {} });

  it('needs a session', async () => {
    expect((await report(null, W1)).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/presence/leave', payload: { windowId: W1 } })).statusCode).toBe(401);
  });

  it('two people are told apart by name; a reviewer (who cannot edit) is listed too; two tabs of one person are "the same user"', async () => {
    await report('admin', W1, { screen: 'S02', componentId: 'payment-guidance' });
    const dana = (await report('dana', W2, { screen: 'S02', componentId: 'payment-guidance' })).json();
    expect(dana.others).toEqual([expect.objectContaining({ name: 'Administrator', sameUser: false, componentId: 'payment-guidance' })]);
    const admin2 = (await report('admin', 'window-three-cc', { screen: 'S19' })).json();
    expect(admin2.others.map((o: any) => [o.name, o.sameUser])).toEqual([['Dana Reviewer', false], ['Administrator', true]]);
  });

  it('one person cannot remove another person’s window, even knowing its id', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/presence/leave', payload: { windowId: W1 }, headers: h.dana })).json()).toEqual({ left: false });
    expect((await report('dana', W2)).json().others.some((o: any) => o.name === 'Administrator')).toBe(true);
  });

  it('writes nothing to the database or the Activity log', async () => {
    const before = dbState(ctx.store);
    await report('dana', W2, { screen: 'S17' });
    await report('admin', W1, { dirty: true });
    await ctx.app.inject({ method: 'POST', url: '/api/v1/presence/leave', payload: { windowId: W2 }, headers: h.dana });
    expect(dbState(ctx.store)).toBe(before);
  });
});

describe('a refused save says who saved first, and when', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false }); });
  afterAll(async () => { await ctx.app.close(); });

  it('409 VERSION_CONFLICT carries the newer version, its saver and the time it was saved', async () => {
    const { project } = (await ctx.app.inject({ method: 'GET', url: `/api/v1/projects/${CARD}` })).json();
    const first = await ctx.app.inject({ method: 'PUT', url: `/api/v1/projects/${CARD}`, payload: { project: { ...project, title: `${project.title} (theirs)` } }, headers: { 'if-match': `"${project.modelVersion}"` } });
    expect(first.statusCode).toBe(200);
    const theirs = first.json().project;
    const mine = await ctx.app.inject({ method: 'PUT', url: `/api/v1/projects/${CARD}`, payload: { project: { ...project, title: `${project.title} (mine)` } }, headers: { 'if-match': `"${project.modelVersion}"` } });
    expect(mine.statusCode).toBe(409);
    expect(mine.json().error).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: theirs.modelVersion, savedBy: 'Local admin' });
    expect(Date.parse(mine.json().error.savedAt)).toBeGreaterThan(0);
  });
});
