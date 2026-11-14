import type { Store } from './db';

/**
 * Notifications in the studio (wave 4, item 3): one list per user, stored on the server, read by the bell in the top
 * bar. Nothing leaves the studio: no email, no push. Routes: docs/api/NOTIFICATIONS.md.
 *
 * Rules every caller relies on:
 * - `notify` never tells a person about their own action (`actorId` equal to `userId` stores nothing).
 * - A notification holds ids and counts only, like the Activity log: `data` keeps only known keys whose values are ids
 *   (no spaces) or whole numbers, so no customer's name, amount or a person's free text can be stored in it. The words a
 *   person reads are made when the list is read, from the document and the blocker as they are then.
 */

export const NOTIFICATION_KINDS = [
  'blocker.assigned', 'blocker.note', 'blocker.fixed',
  'review.submitted', 'review.changes_requested', 'review.approved',
  'comment.reply',
  // Connected by the integrator to the review-links module: a comment that arrived through a review link you made.
  'review_link.comment',
] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];

/** The only keys `data` may hold; anything else is dropped. */
const DATA_KEYS = ['blockerId', 'noteId', 'commentId', 'parentId', 'nodeId', 'modelVersion', 'count', 'linkId', 'releaseId', 'versionId'] as const;
type DataKey = typeof DATA_KEYS[number];
export type NotificationData = Partial<Record<DataKey, string | number>>;
const ID = /^[A-Za-z0-9_.~+:@\-]{1,200}$/;

export interface StoredNotification { id: string; userId: string; kind: NotificationKind; projectId: string | null; data: NotificationData; actorId: string | null; actorName: string | null; at: string; readAt: string | null }

/** Creates the table on first use (kept out of the shared schema so this module stays self-contained). */
export function ensureNotificationTables(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, project_id TEXT, data TEXT NOT NULL, actor_id TEXT, actor_name TEXT, at TEXT NOT NULL, read_at TEXT);
    CREATE INDEX IF NOT EXISTS notifications_by_user ON notifications(user_id, id);
  `);
}

/** Keeps only known keys with id-like or whole-number values. */
export function cleanNotificationData(data: Record<string, unknown> | undefined): NotificationData {
  const out: NotificationData = {};
  for (const k of DATA_KEYS) {
    const v = data?.[k];
    if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < 1e12) out[k] = v;
    else if (typeof v === 'string' && ID.test(v)) out[k] = v;
  }
  return out;
}

const mapRow = (r: any): StoredNotification => ({ id: String(r.id), userId: r.user_id, kind: r.kind, projectId: r.project_id ?? null, data: JSON.parse(r.data), actorId: r.actor_id ?? null, actorName: r.actor_name ?? null, at: r.at, readAt: r.read_at ?? null });

/**
 * The one way to create a notification. Returns null (and stores nothing) for the person's own action, an unknown kind
 * or a missing recipient. `actor` is the person whose action it is (null when the studio itself noticed it, as when a
 * blocker turns out fixed); only their id and the name they have in the studio are kept.
 */
export function notify(store: Store, n: { userId: string | null | undefined; kind: NotificationKind; projectId: string | null; data?: Record<string, unknown>; actor?: { id: string; name: string } | null }): StoredNotification | null {
  if (!n.userId || !(NOTIFICATION_KINDS as readonly string[]).includes(n.kind)) return null;
  if (n.actor && n.actor.id === n.userId) return null;
  ensureNotificationTables(store);
  const done = store.db.prepare('INSERT INTO notifications(user_id,kind,project_id,data,actor_id,actor_name,at,read_at) VALUES (?,?,?,?,?,?,?,NULL)')
    .run(n.userId, n.kind, n.projectId, JSON.stringify(cleanNotificationData(n.data)), n.actor?.id ?? null, n.actor?.name ?? null, new Date().toISOString());
  return mapRow(store.db.prepare('SELECT * FROM notifications WHERE id=?').get(Number(done.lastInsertRowid)));
}

/** A person's notifications, newest first, and how many are unread. */
export function notificationsOf(store: Store, userId: string, limit = 50): { list: StoredNotification[]; unread: number } {
  ensureNotificationTables(store);
  const lim = Math.min(Math.max(Math.floor(limit) || 0, 0), 200);
  const list = lim ? (store.db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT ?').all(userId, lim) as any[]).map(mapRow) : [];
  const unread = Number((store.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL').get(userId) as any).n);
  return { list, unread };
}

/** Marks one of the person's notifications read; false when it is not theirs or does not exist. */
export function markNotificationRead(store: Store, userId: string, id: string): boolean {
  ensureNotificationTables(store);
  const row = store.db.prepare('SELECT * FROM notifications WHERE id=? AND user_id=?').get(Number(id), userId) as any;
  if (!row) return false;
  if (!row.read_at) store.db.prepare('UPDATE notifications SET read_at=? WHERE id=?').run(new Date().toISOString(), Number(id));
  return true;
}

export function markAllNotificationsRead(store: Store, userId: string): number {
  ensureNotificationTables(store);
  return Number(store.db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(new Date().toISOString(), userId).changes);
}

/** A deleted document takes its notifications with it (they would open nothing). */
export function clearProjectNotifications(store: Store, projectId: string): number {
  ensureNotificationTables(store);
  return Number(store.db.prepare('DELETE FROM notifications WHERE project_id=?').run(projectId).changes);
}

/* ------------------------------------------------------------------ words and where each opens */

/** Where a notification opens in the studio. */
export type NotificationTarget =
  | { screen: 'blockers'; projectId: string; blockerId: string | null }
  | { screen: 'review'; projectId: string }
  | { screen: 'comment'; projectId: string; nodeId: string | null; commentId: string | null };

export function notificationTarget(n: Pick<StoredNotification, 'kind' | 'projectId' | 'data'>): NotificationTarget | null {
  if (!n.projectId) return null;
  const s = (v: unknown) => (typeof v === 'string' ? v : null);
  switch (n.kind) {
    case 'blocker.assigned': case 'blocker.note': case 'blocker.fixed': return { screen: 'blockers', projectId: n.projectId, blockerId: s(n.data.blockerId) };
    case 'comment.reply': return { screen: 'comment', projectId: n.projectId, nodeId: s(n.data.nodeId), commentId: s(n.data.commentId) };
    default: return { screen: 'review', projectId: n.projectId };
  }
}

/** What the words of a notification are made from when it is read. */
export interface NotificationWords { documentTitle: string | null; blockerTitle: string | null; nodeName: string | null }

/** One plain sentence: what happened, in which document. */
export function notificationText(n: Pick<StoredNotification, 'kind' | 'data' | 'actorName'>, w: NotificationWords): string {
  const who = n.actorName ?? 'Someone';
  const doc = w.documentTitle ? `“${w.documentTitle}”` : 'a document that no longer exists';
  const blocker = w.blockerTitle ? `: ${w.blockerTitle}` : '';
  const v = typeof n.data.modelVersion === 'number' ? ` (version ${n.data.modelVersion})` : '';
  switch (n.kind) {
    case 'blocker.assigned': return `${who} made you the owner of a blocker in ${doc}${blocker}`;
    case 'blocker.note': return `${who} added a note to a blocker you own in ${doc}${blocker}`;
    case 'blocker.fixed': return `A blocker you own in ${doc} is fixed: no customer is stopped by it any more${w.blockerTitle ? ` (${w.blockerTitle})` : ''}`;
    case 'review.submitted': return `${who} submitted ${doc}${v} for review`;
    case 'review.changes_requested': return `${who} asked for changes to ${doc}${v}, which you submitted`;
    case 'review.approved': return `${who} approved ${doc}${v}, which you submitted`;
    case 'comment.reply': return `${who} replied to your comment${w.nodeName ? ` on “${w.nodeName}”` : ''} in ${doc}`;
    case 'review_link.comment': return `A comment arrived through a review link you made for ${doc}`;
    default: return `Something changed in ${doc}`;
  }
}
