import type { FastifyInstance, FastifyRequest } from 'fastify';
import { projectContentDigest, roleCan, sanitizeCommentBody, ROLE_LABEL, WORKFLOW_LABEL, type Project, type Role, type WorkflowAction } from '@iss/model';
import { blockerKindOfId } from '@iss/scenarios';
import { LOCAL_ADMIN, audit } from '../auth';
import type { Store } from '../db';
import {
  NOTE_MAX, SETTABLE_STATUSES, addNote, applyFullCheck, clearProjectWork, effectiveStatus, ensureRow, ensureWorkTables, lastApprovalAt, projectsOwnedBy,
  refreshBlockerWork, savedCauses, setOwner, setStatus, workNotes, workRow, workRows, type BlockerWorkRow, type Person, type WorkStatus,
} from '../blockerWork';
import {
  clearProjectNotifications, ensureNotificationTables, markAllNotificationsRead, markNotificationRead, notificationTarget, notificationText, notificationsOf, notify,
} from '../notifications';
import type { RouteDeps } from './deps';

/**
 * Wave 4, items 2 and 3: a blocker's owner, status and notes (docs/api/BLOCKER_WORK.md), and notifications and "My work"
 * in the studio (docs/api/NOTIFICATIONS.md). The rules live in `blockerWork.ts` and `notifications.ts`.
 */

const BLOCKER_ID_MAX = 300;
const actorOf = (req: FastifyRequest): Person | null => (req.user ? { id: req.user.id, name: req.user.name } : null);

/** The people a cause can be given to: every enabled studio user with sign-in on; the local admin alone with it off. */
export function assignablePeople(store: Store, authEnabled: boolean): Array<{ id: string; name: string; role: Role }> {
  if (!authEnabled) return [{ id: LOCAL_ADMIN.id, name: LOCAL_ADMIN.name, role: LOCAL_ADMIN.role }];
  return store.listUsers().filter((u) => !u.disabled && roleCan(u.role, 'comment')).map((u) => ({ id: u.id, name: u.name, role: u.role }));
}

/** Who reviews and approves a document: everyone whose role may ask for changes or approve. */
function reviewersOf(store: Store, authEnabled: boolean): Person[] {
  if (!authEnabled) return [{ id: LOCAL_ADMIN.id, name: LOCAL_ADMIN.name }];
  return store.listUsers().filter((u) => !u.disabled && (roleCan(u.role, 'request_changes') || roleCan(u.role, 'approve'))).map((u) => ({ id: u.id, name: u.name }));
}

/**
 * Called by the review workflow after a move: submitting tells every reviewer and approver; asking for changes or
 * approving tells the person who submitted the version. Never the person who acted.
 */
export function notifyWorkflow(store: Store, a: { authEnabled: boolean; actor: Person | null; project: Project; action: WorkflowAction }): number {
  const data = { modelVersion: a.project.modelVersion };
  const base = { projectId: a.project.projectId, data, actor: a.actor };
  if (a.action === 'submit') return reviewersOf(store, a.authEnabled).filter((p) => notify(store, { ...base, userId: p.id, kind: 'review.submitted' })).length;
  if (a.action !== 'request_changes' && a.action !== 'approve') return 0;
  // The latest submission before this move (the history is newest first; this move is already in it).
  const submitter = store.workflowHistory(a.project.projectId).find((e) => e.action === 'submit')?.userId ?? null;
  return notify(store, { ...base, userId: submitter, kind: a.action === 'approve' ? 'review.approved' : 'review.changes_requested' }) ? 1 : 0;
}

/** Called by the comments route after a reply: tells the person who started the thread (never the one replying). */
export function notifyReply(store: Store, a: { actor: Person | null; projectId: string; rootAuthorId: string; commentId: string; parentId: string; nodeId: string }): boolean {
  return !!notify(store, { userId: a.rootAuthorId, kind: 'comment.reply', projectId: a.projectId, data: { commentId: a.commentId, parentId: a.parentId, nodeId: a.nodeId }, actor: a.actor });
}

export function registerWorkRoutes(app: FastifyInstance, deps: RouteDeps, opts: { authEnabled: boolean }): void {
  const { store, ApiError, projectOr404, allRecords } = deps;
  const { authEnabled } = opts;
  ensureWorkTables(store);
  ensureNotificationTables(store);
  const base = '/api/v1/projects/:projectId/blocker-work';
  const refresh = (p: Project, actor: Person | null) => refreshBlockerWork(store, p, allRecords(p.projectId), actor);

  /* After any successful change to a document (a save, a restore, a customer edited, a problem set aside), judge the
     causes people work on against the saved document, before the answer leaves, so the next read already sees it. A
     deleted document takes its work and notifications with it. Never fails the request it follows. */
  app.addHook('onSend', async (req, reply, payload) => {
    try {
      if (reply.statusCode >= 400 || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return payload;
      const route = req.routeOptions?.url ?? '';
      const projectId = (req.params as Record<string, string> | undefined)?.projectId;
      if (!projectId || !route.startsWith('/api/v1/projects/:projectId') || route.startsWith(base)) return payload;
      if (req.method === 'DELETE' && route === '/api/v1/projects/:projectId') { clearProjectWork(store, projectId); clearProjectNotifications(store, projectId); return payload; }
      if (route.includes('/comments') || route.endsWith('/workflow')) return payload;
      const p = store.getProject(projectId);
      if (p) refresh(p, actorOf(req));
    } catch (e) {
      req.log.error({ message: `blocker work refresh: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
    }
    return payload;
  });

  /* ------------------------------------------------------------ blocker work */

  const notesBy = (projectId: string) => {
    const by = new Map<string, ReturnType<typeof workNotes>>();
    for (const n of workNotes(store, projectId)) { const l = by.get(n.blockerId) ?? []; l.push(n); by.set(n.blockerId, l); }
    return by;
  };
  const view = (p: Project, row: BlockerWorkRow, notes: ReturnType<typeof workNotes>) => {
    const cause = row.speed === 'fast' && !row.fixedAt ? savedCauses(p, allRecords(p.projectId)).get(row.blockerId) : undefined;
    return {
      blockerId: row.blockerId, kind: row.kind, title: row.title, speed: row.speed,
      owner: row.owner, status: effectiveStatus(store, row, cause), statusBy: row.statusBy, statusAt: row.statusAt,
      fixedAt: row.fixedAt, fixedInVersion: row.fixedInVersion, customerCount: row.customerCount,
      notes: notes.map((n) => ({ id: n.id, body: n.body, author: n.author, at: n.at })), updatedAt: row.updatedAt,
    };
  };
  const answer = (p: Project) => {
    const notes = notesBy(p.projectId);
    return {
      projectId: p.projectId, modelVersion: p.modelVersion, authEnabled, lastApprovalAt: lastApprovalAt(store, p.projectId),
      items: workRows(store, p.projectId).map((r) => view(p, r, notes.get(r.blockerId) ?? [])),
      people: assignablePeople(store, authEnabled),
    };
  };

  /** Every cause someone works on in this document (owner, status, notes), judged against the saved document first. */
  app.get<{ Params: { projectId: string } }>(base, async (req) => {
    const p = projectOr404(req.params.projectId);
    refresh(p, null);
    return answer(p);
  });

  /** The cause a write is about: it must be in the saved document, or be one only the full check can see. */
  const causeFor = (p: Project, raw: string) => {
    const blockerId = String(raw ?? '').trim();
    const kind = blockerId.length <= BLOCKER_ID_MAX ? blockerKindOfId(blockerId) : null;
    if (!blockerId || !kind) throw new ApiError(400, 'UNKNOWN_BLOCKER', 'This is not a blocker the studio knows.');
    const existing = workRow(store, p.projectId, blockerId);
    if (existing) return existing;
    const saved = savedCauses(p, allRecords(p.projectId)).get(blockerId);
    if (saved) return ensureRow(store, p.projectId, { blockerId, kind: saved.kind, title: saved.title, speed: 'fast', customerCount: saved.recordIds.size });
    if (kind === 'layout') return ensureRow(store, p.projectId, { blockerId, kind, title: 'A problem found by the full check', speed: 'full-check', customerCount: null });
    throw new ApiError(409, 'NOT_IN_SAVED_DOCUMENT', 'This blocker is not in the saved document. Save your changes first, then give it an owner or a status.');
  };

  /** Sets the owner (`ownerId`, null to clear) and/or the status (`open` or `being-fixed` only). Anyone who may comment. */
  app.put<{ Params: { projectId: string; blockerId: string }; Body: Record<string, unknown> }>(`${base}/:blockerId`, async (req) => {
    const p = projectOr404(req.params.projectId);
    refresh(p, null);
    const b = req.body ?? {};
    const hasOwner = Object.prototype.hasOwnProperty.call(b, 'ownerId');
    const hasStatus = Object.prototype.hasOwnProperty.call(b, 'status');
    if (!hasOwner && !hasStatus) throw new ApiError(400, 'INVALID_REQUEST', 'Say who owns it (ownerId) or its status (status).');
    let status: WorkStatus | null = null;
    if (hasStatus) {
      if (b.status === 'fixed') throw new ApiError(422, 'STATUS_SET_BY_STUDIO', 'Nobody can mark a blocker Fixed: the studio does, when no customer is stopped by it any more.');
      if (b.status === 'known-data-problem') throw new ApiError(422, 'STATUS_SET_BY_STUDIO', 'A blocker becomes a known data problem when an approver sets the problem aside for every customer it stops, in its detail; it cannot be set as a status.');
      if (!(SETTABLE_STATUSES as readonly unknown[]).includes(b.status)) throw new ApiError(400, 'INVALID_STATUS', 'The status can be set to "open" or "being-fixed".');
      status = b.status as WorkStatus;
    }
    let owner: Person | null = null;
    if (hasOwner && b.ownerId !== null) {
      const found = assignablePeople(store, authEnabled).find((x) => x.id === b.ownerId);
      if (!found) throw new ApiError(400, 'UNKNOWN_PERSON', authEnabled ? 'Choose a studio user who can comment.' : 'With sign-in off, the only possible owner is the local admin.');
      owner = { id: found.id, name: found.name };
    }
    const row = causeFor(p, req.params.blockerId);
    if (status && row.fixedAt) throw new ApiError(409, 'ALREADY_FIXED', 'This blocker is fixed: no customer is stopped by it any more. Its status cannot change until it comes back.');
    const actor = actorOf(req);
    if (hasOwner && (row.owner?.id ?? null) !== (owner?.id ?? null)) {
      setOwner(store, p.projectId, row.blockerId, owner);
      audit(store, req, 'blocker.assign', { projectId: p.projectId, modelVersion: p.modelVersion, detail: { blockerId: row.blockerId, blocker: row.title, ownerId: owner?.id ?? null, ownerName: owner?.name ?? null, previousOwnerId: row.owner?.id ?? null } });
      if (owner) notify(store, { userId: owner.id, kind: 'blocker.assigned', projectId: p.projectId, data: { blockerId: row.blockerId }, actor });
    }
    if (status && status !== row.status) {
      setStatus(store, p.projectId, row.blockerId, status, actor);
      audit(store, req, 'blocker.status', { projectId: p.projectId, modelVersion: p.modelVersion, detail: { blockerId: row.blockerId, blocker: row.title, from: row.status, to: status } });
    }
    req.audited = true;
    const out = answer(p);
    return { ...out, item: out.items.find((i) => i.blockerId === row.blockerId) ?? null };
  });

  /** Adds a note (plain text, at most NOTE_MAX characters) with its author and time. Anyone who may comment. */
  app.post<{ Params: { projectId: string; blockerId: string }; Body: Record<string, unknown> }>(`${base}/:blockerId/notes`, async (req, reply) => {
    const p = projectOr404(req.params.projectId);
    refresh(p, null);
    const body = sanitizeCommentBody(req.body?.body);
    if (!body) throw new ApiError(400, 'EMPTY_NOTE', 'Write the note first.');
    if (body.length > NOTE_MAX) throw new ApiError(400, 'NOTE_TOO_LONG', `Notes are limited to ${NOTE_MAX} characters.`);
    const row = causeFor(p, req.params.blockerId);
    const actor = actorOf(req);
    const note = addNote(store, p.projectId, row.blockerId, body, actor);
    audit(store, req, 'blocker.note', { projectId: p.projectId, modelVersion: p.modelVersion, detail: { blockerId: row.blockerId, blocker: row.title, noteId: note.id, length: body.length } });
    if (row.owner) notify(store, { userId: row.owner.id, kind: 'blocker.note', projectId: p.projectId, data: { blockerId: row.blockerId, noteId: note.id }, actor });
    reply.status(201);
    const out = answer(p);
    return { ...out, note, item: out.items.find((i) => i.blockerId === row.blockerId) ?? null };
  });

  /**
   * What a full check of the SAVED version found (the blocker ids of its page layout, PDF/web and PDF accessibility
   * findings). Refused for any other version: only then can its result decide that such a cause is fixed.
   */
  app.post<{ Params: { projectId: string }; Body: Record<string, unknown> }>(`${base}/full-check`, async (req) => {
    const p = projectOr404(req.params.projectId);
    const b = req.body ?? {};
    if (b.modelVersion !== p.modelVersion || b.contentDigest !== projectContentDigest(p)) throw new ApiError(409, 'NOT_THE_SAVED_VERSION', 'This full check was made on a version that is not the saved one, so it cannot say what is fixed.');
    if (!Array.isArray(b.blockerIds) || b.blockerIds.length > 5000 || !b.blockerIds.every((x) => typeof x === 'string' && x.length <= BLOCKER_ID_MAX)) throw new ApiError(400, 'INVALID_REQUEST', 'blockerIds must be a list of blocker ids.');
    const out = applyFullCheck(store, p, new Set(b.blockerIds as string[]), actorOf(req));
    req.audited = true;
    return { ...answer(p), ...out };
  });

  /** The people a blocker can be given to (names and roles only). Anyone signed in. */
  app.get('/api/v1/assignable-people', async () => ({ people: assignablePeople(store, authEnabled), authEnabled }));

  /* ------------------------------------------------------------ notifications */

  const titles = new Map<string, string | null>();
  const docTitle = (projectId: string | null) => {
    if (!projectId) return null;
    if (!titles.has(projectId)) titles.set(projectId, store.getProject(projectId)?.title ?? null);
    return titles.get(projectId)!;
  };
  const shape = (n: ReturnType<typeof notificationsOf>['list'][number]) => {
    const project = n.projectId ? store.getProject(n.projectId) : undefined;
    const blockerId = typeof n.data.blockerId === 'string' ? n.data.blockerId : null;
    const nodeId = typeof n.data.nodeId === 'string' ? n.data.nodeId : null;
    const node = nodeId && project ? project.nodes.find((x) => x.id === nodeId) : undefined;
    const words = { documentTitle: project?.title ?? null, blockerTitle: blockerId && n.projectId ? workRow(store, n.projectId, blockerId)?.title ?? null : null, nodeName: node ? node.name ?? node.id : null };
    return { id: n.id, kind: n.kind, projectId: n.projectId, documentTitle: words.documentTitle, data: n.data, actorName: n.actorName, at: n.at, read: !!n.readAt, text: notificationText(n, words), target: notificationTarget(n) };
  };
  const me = (req: FastifyRequest) => req.user?.id ?? LOCAL_ADMIN.id;

  /** The signed-in person's notifications, newest first, and how many are unread (`limit=0`: the count alone). */
  app.get<{ Querystring: { limit?: string } }>('/api/v1/notifications', async (req) => {
    titles.clear();
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    const { list, unread } = notificationsOf(store, me(req), Number.isFinite(limit) ? limit : 50);
    return { notifications: list.map(shape), unread };
  });
  app.post<{ Params: { id: string } }>('/api/v1/notifications/:id/read', async (req) => {
    if (!markNotificationRead(store, me(req), req.params.id)) throw new ApiError(404, 'NOT_FOUND', 'There is no such notification for you.');
    req.audited = true;
    return { read: req.params.id, unread: notificationsOf(store, me(req), 0).unread };
  });
  app.post('/api/v1/notifications/read-all', async (req) => {
    const marked = markAllNotificationsRead(store, me(req));
    req.audited = true;
    return { marked, unread: 0 };
  });

  /* ------------------------------------------------------------ My work */

  /**
   * What is waiting for the signed-in person across every document: causes they own that are not fixed, and documents
   * in review that their role may review or approve.
   */
  app.get('/api/v1/my-work', async (req) => {
    titles.clear();
    const userId = me(req);
    const role: Role = req.user?.role ?? 'admin';
    const blockers: Array<Record<string, unknown>> = [];
    for (const projectId of projectsOwnedBy(store, userId)) {
      const p = store.getProject(projectId);
      if (!p) continue;
      refresh(p, null);
      const causes = workRows(store, projectId).some((r) => r.owner?.id === userId && !r.fixedAt && r.speed === 'fast') ? savedCauses(p, allRecords(projectId)) : new Map();
      for (const r of workRows(store, projectId)) {
        if (r.owner?.id !== userId || r.fixedAt) continue;
        blockers.push({ projectId, documentTitle: p.title, blockerId: r.blockerId, title: r.title, kind: r.kind, speed: r.speed, status: effectiveStatus(store, r, causes.get(r.blockerId)), customerCount: r.customerCount, updatedAt: r.updatedAt });
      }
    }
    const canReview = roleCan(role, 'request_changes') || roleCan(role, 'approve');
    const reviews = canReview ? store.listProjects().flatMap((s) => {
      const wf = store.getWorkflow(s.projectId);
      if (wf.state !== 'in_review') return [];
      const submitted = store.workflowHistory(s.projectId).find((e) => e.action === 'submit');
      return [{ projectId: s.projectId, documentTitle: docTitle(s.projectId) ?? s.projectId, state: wf.state, label: WORKFLOW_LABEL[wf.state], modelVersion: wf.modelVersion, submittedBy: submitted?.user ?? null, submittedAt: submitted?.at ?? wf.updatedAt, canApprove: roleCan(role, 'approve'), mine: !!submitted && submitted.userId === userId }];
    }) : [];
    return { user: { id: userId, name: req.user?.name ?? LOCAL_ADMIN.name, role, roleLabel: ROLE_LABEL[role] }, authEnabled, blockers, reviews };
  });
}
