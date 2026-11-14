import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app';
import type { PackageComposer } from '../src/releasePackage';

/**
 * Review links joined to notifications and "My work" (docs/design/WAVE4_TEAMS.md sections 1 and 3): a comment that
 * arrives through a link tells the person who made the link, and waits in their "My work" until someone in the studio
 * answers or resolves it. Sign-in is off here, so the link's maker is the local admin and the commenter is outside.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const EOB = 'harborcare-demo';
const stub: PackageComposer = { async pdf() { return { pdf: Buffer.from('%PDF-1.4\n%%EOF\n'), pageCount: 1, facts: null }; }, async html() { return { facts: null }; } } as unknown as PackageComposer;

describe('a comment through a review link reaches the person who made the link', () => {
  let ctx: Ctx;
  const inj = (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });
  const json = async (method: any, url: string, payload?: any) => (await inj(method, url, payload)).json();
  let token = '';
  let commentId = '';

  beforeAll(async () => {
    ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-link-notify-')), logger: false, auth: false, extraSamples: false, releasePackage: { composer: stub } });
    const version = (await json('GET', `/api/v1/projects/${EOB}`)).project.modelVersion as number;
    const made = await inj('POST', `/api/v1/projects/${EOB}/review-links`, { version, label: 'Wording check', customers: ['EOB-0001'] });
    expect(made.statusCode, made.body.slice(0, 300)).toBe(201);
    token = made.json().token;
  });
  afterAll(async () => { await ctx.app.close(); });

  it('nothing is waiting before any comment arrives', async () => {
    expect((await json('GET', '/api/v1/notifications')).unread).toBe(0);
    expect((await json('GET', '/api/v1/my-work')).linkComments).toEqual([]);
  });

  it('a comment notifies the link’s maker, in words without the typed name or the text, and opens the Review panel', async () => {
    const r = await inj('POST', `/api/v1/review/${token}/comments`, { name: 'Zephyrine Quillfeather', body: 'Please soften the second sentence xyzzy-plugh.', customer: 'EOB-0001', output: 'html' });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(201);
    commentId = r.json().comment.id;
    const news = await json('GET', '/api/v1/notifications');
    expect(news.unread).toBe(1);
    const n = news.notifications[0];
    expect(n.kind).toBe('review_link.comment');
    expect(n.projectId).toBe(EOB);
    expect(n.data.commentId).toBe(commentId);
    expect(n.target?.projectId).toBe(EOB);
    expect(n.text).toMatch(/review link/i);
    // Ids only are stored: neither the typed name nor the comment's text is in the notification.
    const stored = JSON.stringify((ctx.store as any).db.prepare('SELECT * FROM notifications').all());
    expect(stored).not.toContain('Zephyrine');
    expect(stored).not.toContain('xyzzy-plugh');
    expect(JSON.stringify(news)).not.toContain('Zephyrine');
  });

  it('the comment waits in My work, by document and link label only', async () => {
    const work = await json('GET', '/api/v1/my-work');
    expect(work.linkComments).toHaveLength(1);
    expect(work.linkComments[0]).toMatchObject({ projectId: EOB, commentId, label: 'Wording check' });
    expect(JSON.stringify(work.linkComments)).not.toContain('Zephyrine');
    expect(JSON.stringify(work.linkComments)).not.toContain('xyzzy-plugh');
  });

  it('a second comment through the link does not count as an answer; a reply from the studio does', async () => {
    const second = await inj('POST', `/api/v1/review/${token}/comments`, { name: 'Zephyrine Quillfeather', body: 'One more thing.', customer: 'EOB-0001', output: 'sms' });
    expect(second.statusCode).toBe(201);
    expect((await json('GET', '/api/v1/my-work')).linkComments).toHaveLength(2);
    const reply = await inj('POST', `/api/v1/projects/${EOB}/comments`, { parentId: commentId, body: 'Thank you, changed.' });
    expect(reply.statusCode, reply.body.slice(0, 300)).toBe(201);
    const left = (await json('GET', '/api/v1/my-work')).linkComments;
    expect(left).toHaveLength(1);
    expect(left[0].commentId).toBe(second.json().comment.id);
    // Resolving the other one clears it too.
    const resolved = await inj('POST', `/api/v1/projects/${EOB}/comments/${left[0].commentId}/resolve`, { resolved: true });
    expect(resolved.statusCode, resolved.body.slice(0, 300)).toBe(200);
    expect((await json('GET', '/api/v1/my-work')).linkComments).toEqual([]);
  });

  it('the maker’s own reply does not notify the maker', async () => {
    // Two link comments arrived, so two notifications; the studio's reply and the resolve added none.
    expect((await json('GET', '/api/v1/notifications')).notifications.filter((n: any) => n.kind === 'review_link.comment')).toHaveLength(2);
    expect((await json('GET', '/api/v1/notifications')).notifications).toHaveLength(2);
  });
});
