import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app';
import { NOTIFICATION_KINDS, cleanNotificationData, notificationTarget, notificationText, notify, notificationsOf } from '../src/notifications';

/**
 * Notifications: the one function that creates them never tells a person about their own action and keeps ids and
 * counts only; every kind has words and a place to open; and, as for the Activity log, no stored row ever holds a
 * customer's name or values (a scan after the actions that touch a customer's data problem).
 */

const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-notify-'));
const CARD = 'aster-card-demo';
const DATA = 'inconsistent-payment-state~payment-guidance';
const NAME = { givenName: 'Wilhelmina', familyName: 'Featherstonehaugh' };
const AMOUNT = 987654;
const DATE = '2031-07-19';

describe('notify', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false }); });
  afterAll(async () => { await ctx.app.close(); });

  it('never notifies the person whose action it is, nor nobody', () => {
    expect(notify(ctx.store, { userId: 'u-1', kind: 'blocker.assigned', projectId: CARD, data: { blockerId: DATA }, actor: { id: 'u-1', name: 'Dana' } })).toBeNull();
    expect(notify(ctx.store, { userId: null, kind: 'blocker.assigned', projectId: CARD, actor: { id: 'u-2', name: 'Dana' } })).toBeNull();
    expect(notify(ctx.store, { userId: 'u-1', kind: 'not.a.kind' as any, projectId: CARD })).toBeNull();
    expect(notificationsOf(ctx.store, 'u-1').unread).toBe(0);
  });

  it('keeps ids and whole numbers only: names, sentences and unknown keys are dropped', () => {
    expect(cleanNotificationData({ blockerId: DATA, modelVersion: 4, count: 2.5, nodeId: 'Wilhelmina Featherstonehaugh', name: 'Wilhelmina', recordId: 'CARD-6001', commentId: 'cmt-abc' })).toEqual({ blockerId: DATA, modelVersion: 4, commentId: 'cmt-abc' });
    const n = notify(ctx.store, { userId: 'u-1', kind: 'blocker.note', projectId: CARD, data: { blockerId: DATA, noteId: '7', body: 'Call Wilhelmina tomorrow' } as any, actor: { id: 'u-2', name: 'Dana' } });
    expect(n).toMatchObject({ userId: 'u-1', kind: 'blocker.note', data: { blockerId: DATA, noteId: '7' }, actorName: 'Dana', readAt: null });
    expect(JSON.stringify(n)).not.toContain('Wilhelmina');
  });

  it('a comment through a review link: created directly (the review-links module calls notify), worded, and opens the Review panel', async () => {
    const n = notify(ctx.store, { userId: 'local-admin', kind: 'review_link.comment', projectId: CARD, data: { linkId: 'rl-1', commentId: 'cmt-9' }, actor: null })!;
    expect(n).toMatchObject({ kind: 'review_link.comment', data: { linkId: 'rl-1', commentId: 'cmt-9' }, actorId: null });
    const list = (await ctx.app.inject({ method: 'GET', url: '/api/v1/notifications' })).json();
    expect(list.unread).toBe(1);
    expect(list.notifications[0]).toMatchObject({ kind: 'review_link.comment', target: { screen: 'review', projectId: CARD } });
    expect(list.notifications[0].text).toMatch(/^A comment arrived through a review link you made for “.+”$/);
  });

  it('every kind has words and a place to open', () => {
    const words = { documentTitle: 'Aster card', blockerTitle: 'Spanish wording is missing', nodeName: 'Heading' };
    for (const kind of NOTIFICATION_KINDS) {
      const text = notificationText({ kind, data: { blockerId: DATA, modelVersion: 3, nodeId: 'heading' }, actorName: 'Dana' }, words);
      expect(text, kind).toContain('“Aster card”');
      expect(text, kind).not.toMatch(/Something changed/);
      expect(notificationTarget({ kind, projectId: CARD, data: { blockerId: DATA, nodeId: 'heading' } }), kind).not.toBeNull();
    }
    expect(notificationText({ kind: 'blocker.assigned', data: {}, actorName: null }, { documentTitle: null, blockerTitle: null, nodeName: null })).toBe('Someone made you the owner of a blocker in a document that no longer exists');
  });
});

describe('notifications carry ids, never customer values', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false }); });
  afterAll(async () => { await ctx.app.close(); });
  const inj = (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });

  it('assigning, noting and fixing a customer-data blocker on a customer with distinctive values stores none of them', async () => {
    const made = await inj('POST', `/api/v1/projects/${CARD}/records`, { copyOf: 'CARD-0001' });
    const rec = made.json().record;
    const edited = { ...rec, customer: { ...rec.customer, ...NAME }, card: { ...rec.card, dueDate: DATE, minimumDueCents: AMOUNT, paymentStatus: 'current', missedPayments: 3 } };
    expect((await inj('PUT', `/api/v1/projects/${CARD}/records/${rec.recordId}`, { record: edited })).statusCode).toBe(200);
    const b = `/api/v1/projects/${CARD}/blocker-work/${encodeURIComponent(DATA)}`;
    expect((await inj('PUT', b, { ownerId: 'local-admin', status: 'being-fixed' })).statusCode).toBe(200);
    expect((await inj('POST', `${b}/notes`, { body: `${NAME.givenName} ${NAME.familyName} owes ${AMOUNT} by ${DATE}` })).statusCode).toBe(201);
    // the local admin's own actions notify nobody; the studio noticing the fix on a read tells the owner
    ctx.store.db.prepare('DELETE FROM project_records WHERE record_id=?').run(rec.recordId);
    const list = (await inj('GET', `/api/v1/projects/${CARD}/blocker-work`)).json();
    expect(list.items[0]).toMatchObject({ blockerId: DATA, status: 'fixed' });
    const inbox = (await inj('GET', '/api/v1/notifications')).json();
    expect(inbox.notifications.map((n: any) => n.kind)).toEqual(['blocker.fixed']);
    // also one created by hand with customer values in every field it accepts
    notify(ctx.store, { userId: 'u-x', kind: 'blocker.note', projectId: CARD, data: { blockerId: DATA, nodeId: `${NAME.familyName} ${AMOUNT}`, count: AMOUNT, noteId: DATE }, actor: { id: 'u-y', name: 'Dana' } });
    const rows = ctx.store.db.prepare('SELECT * FROM notifications').all() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      const text = JSON.stringify(row);
      for (const v of [NAME.familyName, `${NAME.givenName} ${NAME.familyName}`]) expect(text.includes(v), `${v} in ${text}`).toBe(false);
      expect(text.includes(rec.recordId), `record id in ${text}`).toBe(false);
    }
    // the hand-made one kept only what is id-like (a value with a space is dropped; whole numbers are counts)
    const hand = rows.find((r) => r.user_id === 'u-x')!;
    expect(JSON.parse(String(hand.data))).toEqual({ blockerId: DATA, count: AMOUNT, noteId: DATE });
  });
});
