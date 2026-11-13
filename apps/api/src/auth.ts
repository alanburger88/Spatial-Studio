import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ROLES, ROLE_LABEL, permissionsFor, roleCan, type Permission, type Role } from '@iss/model';
import type { Store, StoredUser } from './db';

/**
 * Local accounts, sessions, role checks and the audit trail.
 *
 * Auth is OFF unless AUTH=on: every request then acts as the built-in "Local admin" so the local, single-user
 * experience (and the existing test suites) are unchanged. With AUTH=on every /api/v1 route except health,
 * session and login needs a session cookie, and mutating routes are checked against the caller's role.
 */

export interface AuthUser { id: string; name: string; email: string | null; role: Role; local?: boolean }
export const LOCAL_ADMIN: AuthUser = { id: 'local-admin', name: 'Local admin', email: null, role: 'admin', local: true };

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
    /** Set once a handler wrote its own audit entry, so the generic fallback does not duplicate it. */
    audited: boolean;
  }
}

type ApiErrorCtor = new (status: number, code: string, message: string, extra?: Record<string, unknown>) => Error;

export const SESSION_COOKIE = 'iss_session';
export const SESSION_HOURS = 12;
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_MIN = 8;

/* ------------------------------------------------------------------ crypto */

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): { salt: string; hash: string } {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
export function verifyPassword(password: string, salt: string, hash: string): boolean {
  const a = scryptSync(password, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function sessionCookie(req: FastifyRequest, value: string, maxAgeSec: number) {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${req.protocol === 'https' ? '; Secure' : ''}`;
}

/* ------------------------------------------------------------------ route permissions */

/** `public` = no session needed; `any` = any signed-in user (read-like POSTs, or checked inside the handler). */
type Need = Permission | 'any' | 'public';
const ROUTES: Record<string, Need> = {
  'GET /api/v1/health': 'public',
  'GET /api/v1/session': 'public',
  'POST /api/v1/auth/login': 'public',
  'POST /api/v1/auth/logout': 'public',
  'PUT /api/v1/projects/:projectId': 'edit',
  'PATCH /api/v1/projects/:projectId': 'edit',
  'DELETE /api/v1/projects/:projectId': 'edit',
  'POST /api/v1/projects/:projectId/reset': 'edit',
  'POST /api/v1/projects/:projectId/duplicate': 'edit',
  'POST /api/v1/projects': 'edit',
  'POST /api/v1/projects/import': 'edit',
  // Setting a document up from a description or sample data: creating it needs edit rights; the proposal stores nothing.
  'POST /api/v1/projects/setup': 'edit',
  'POST /api/v1/projects/setup/draft': 'any',
  // Publishing a starter for everyone is an approver's decision, like approving a document.
  'POST /api/v1/templates': 'approve',
  'PATCH /api/v1/templates/:templateId': 'approve',
  'POST /api/v1/templates/reset': 'manage_users',
  'POST /api/v1/projects/:projectId/versions/:version/restore': 'edit',
  'POST /api/v1/projects/:projectId/workflow': 'any',
  'POST /api/v1/projects/:projectId/comments': 'comment',
  'POST /api/v1/projects/:projectId/comments/:commentId/resolve': 'comment',
  'DELETE /api/v1/projects/:projectId/comments/:commentId': 'comment',
  'POST /api/v1/assets': 'edit',
  'DELETE /api/v1/assets/:assetId': 'edit',
  'POST /api/v1/batches': 'edit',
  'POST /api/v1/batches/:batchId/cancel': 'edit',
  'POST /api/v1/records/import': 'edit',
  'DELETE /api/v1/records/imported': 'edit',
  'POST /api/v1/snapshots/reset': 'edit',
  'GET /api/v1/users': 'manage_users',
  'POST /api/v1/users': 'manage_users',
  'PATCH /api/v1/users/:userId': 'manage_users',
  // Read-like POSTs: they compute previews/checks from a (possibly unsaved) model but never change saved state.
  'POST /api/v1/resolve': 'any',
  'POST /api/v1/compose/pdf': 'any',
  'POST /api/v1/compose/html': 'any',
  'POST /api/v1/compose/pages': 'any',
  'POST /api/v1/compose/afp-sim': 'any',
  'POST /api/v1/parity': 'any',
  'POST /api/v1/validate': 'any',
  'POST /api/v1/journeys/replay': 'any',
  'POST /api/v1/scenarios/generate': 'any',
  'POST /api/v1/analysis/cube': 'any',
  'POST /api/v1/analysis/landscape': 'any',
  'POST /api/v1/assistant/message': 'any',
  'POST /api/v1/compose/email': 'any',
  'POST /api/v1/compose/sms': 'any',
  'POST /api/v1/projects/:projectId/translations/import': 'any',
  'POST /api/v1/projects/:projectId/test-data/plan': 'any',
  'POST /api/v1/projects/:projectId/records/check': 'any',
  'POST /api/v1/assistant/proposals/:id/decision': 'any',
  // Releases: approvers and admins create them and keep the handover log; only admins move one between stages.
  'POST /api/v1/projects/:projectId/releases': 'approve',
  'POST /api/v1/releases/:releaseId/handover': 'approve',
  'POST /api/v1/releases/:releaseId/promote': 'promote_release',
  'POST /api/v1/releases/:releaseId/withdraw': 'promote_release',
  'POST /api/v1/releases/reset': 'manage_users',
  // Preparing a package changes no document or release; anyone who may download it may ask for it (the handler records who did).
  'POST /api/v1/releases/:releaseId/package': 'any',
};
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Routes not listed above: reads need a session; anything that writes needs edit rights (safe default for new modules). */
function needFor(method: string, route: string | undefined): Need {
  const key = `${method} ${route ?? ''}`;
  if (key in ROUTES) return ROUTES[key];
  return MUTATING.has(method) ? 'edit' : 'any';
}
function isReadLike(method: string, route: string | undefined): boolean {
  if (!MUTATING.has(method)) return true;
  const need = ROUTES[`${method} ${route ?? ''}`];
  return need === 'public' || (need === 'any' && !(route ?? '').endsWith('/workflow'));
}

function forbiddenMessage(role: Role, need: Permission): string {
  if (role === 'reviewer' && need === 'edit') return 'Reviewers can comment but not edit.';
  if (need === 'edit') return `${ROLE_LABEL[role]}s cannot change documents; ask an author.`;
  if (need === 'manage_users') return 'Only admins can manage users.';
  if (need === 'promote_release') return 'Only admins can move a release to Production or withdraw it.';
  return `${ROLE_LABEL[role]}s are not allowed to do this.`;
}

/* ------------------------------------------------------------------ audit */

/** Write an audit entry for this request (never pass content bodies in `detail`). */
export function audit(store: Store, req: FastifyRequest, action: string, e: { projectId?: string | null; modelVersion?: number | null; detail?: Record<string, unknown> } = {}) {
  req.audited = true;
  store.audit({ user: req.user?.id ?? null, userName: req.user?.name ?? null, action, projectId: e.projectId ?? null, modelVersion: e.modelVersion ?? null, detail: e.detail });
}

/* ------------------------------------------------------------------ registration */

export interface AuthOptions { store: Store; ApiError: ApiErrorCtor; enabled: boolean }

export function publicUser(u: StoredUser | AuthUser) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, ...('disabled' in u ? { disabled: u.disabled, createdAt: u.createdAt, updatedAt: u.updatedAt } : {}), ...('local' in u && u.local ? { local: true } : {}) };
}

export function registerAuth(app: FastifyInstance, { store, ApiError, enabled }: AuthOptions) {
  if (enabled && store.countUsers() === 0) {
    const email = process.env.ADMIN_EMAIL?.trim();
    const password = process.env.ADMIN_PASSWORD ?? '';
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email) || password.length < PASSWORD_MIN) {
      throw new Error(`AUTH=on but no user accounts exist yet. Set ADMIN_EMAIL (an email address) and ADMIN_PASSWORD (at least ${PASSWORD_MIN} characters) to create the first admin, then start the API again.`);
    }
    store.addUser({ id: `u-${randomUUID().slice(0, 8)}`, email, name: 'Administrator', role: 'admin', ...hashPassword(password) });
  }

  app.decorateRequest('user', null as unknown as AuthUser);
  app.decorateRequest('audited', false);

  const attempts = new Map<string, { count: number; first: number }>();

  function sessionUser(req: FastifyRequest): { user: AuthUser; expiresAt: string } | null {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const s = store.getSession(tokenHash(token));
    if (!s) return null;
    if (s.expiresAt < new Date().toISOString()) { store.deleteSession(tokenHash(token)); return null; }
    const u = store.getUser(s.userId);
    if (!u || u.disabled) return null;
    return { user: { id: u.id, name: u.name, email: u.email, role: u.role }, expiresAt: s.expiresAt };
  }

  app.addHook('onRequest', async (req) => {
    req.audited = false;
    if (!enabled) { req.user = LOCAL_ADMIN; return; }
    if (!req.url.startsWith('/api/')) return;
    const found = sessionUser(req);
    if (found) req.user = found.user;
    const need = needFor(req.method, req.routeOptions?.url);
    if (need === 'public') return;
    if (!found) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to use Spatial Studio.');
  });

  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || !req.user) return;
    const need = needFor(req.method, req.routeOptions?.url);
    if (need === 'public' || need === 'any') return;
    if (!roleCan(req.user.role, need)) throw new ApiError(403, 'FORBIDDEN', forbiddenMessage(req.user.role, need), { role: req.user.role, needs: need });
  });

  /** Generic fallback so every successful mutating request is in the audit log, including routes added by other modules. */
  app.addHook('onResponse', async (req, reply) => {
    if (req.audited || !req.url.startsWith('/api/') || !MUTATING.has(req.method) || reply.statusCode >= 400) return;
    const route = req.routeOptions?.url;
    if (isReadLike(req.method, route)) return;
    const params = (req.params ?? {}) as Record<string, string>;
    const body = (req.body ?? {}) as Record<string, unknown>;
    store.audit({ user: req.user?.id ?? null, userName: req.user?.name ?? null, action: `api.${req.method.toLowerCase()}`, projectId: params.projectId ?? (typeof body.projectId === 'string' ? body.projectId : null), detail: { route, status: reply.statusCode } });
  });

  /* ------------------------------------------------------------ session routes */

  app.get('/api/v1/session', async (req) => {
    if (!enabled) return { authEnabled: false, user: publicUser(LOCAL_ADMIN), permissions: permissionsFor('admin'), roles: ROLES, expiresAt: null };
    const found = sessionUser(req);
    return { authEnabled: true, user: found ? publicUser(found.user) : null, permissions: found ? permissionsFor(found.user.role) : [], roles: ROLES, expiresAt: found?.expiresAt ?? null };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/auth/login', async (req, reply: FastifyReply) => {
    if (!enabled) return { authEnabled: false, user: publicUser(LOCAL_ADMIN), permissions: permissionsFor('admin') };
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!email || !password) throw new ApiError(400, 'INVALID_REQUEST', 'Enter your email and password.');
    const key = `${req.ip}|${email}`;
    const now = Date.now();
    const a = attempts.get(key);
    if (a && now - a.first > ATTEMPT_WINDOW_MS) attempts.delete(key);
    const cur = attempts.get(key);
    if (cur && cur.count >= MAX_ATTEMPTS) {
      const wait = Math.ceil((cur.first + ATTEMPT_WINDOW_MS - now) / 60000);
      reply.header('Retry-After', String(Math.ceil((cur.first + ATTEMPT_WINDOW_MS - now) / 1000)));
      throw new ApiError(429, 'TOO_MANY_ATTEMPTS', `Too many sign-in attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`);
    }
    const cred = store.userCredentials(email);
    const ok = !!cred && !cred.user.disabled && verifyPassword(password, cred.salt, cred.hash);
    if (!ok) {
      if (!cred) hashPassword(password); // equalise timing for unknown accounts
      attempts.set(key, { count: (cur?.count ?? 0) + 1, first: cur?.first ?? now });
      store.audit({ user: null, userName: null, action: 'auth.login_failed', detail: { email, reason: cred?.user.disabled ? 'disabled' : 'bad-credentials' } });
      req.audited = true;
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is not correct.');
    }
    attempts.delete(key);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now + SESSION_HOURS * 3600 * 1000).toISOString();
    store.addSession(tokenHash(token), cred.user.id, expiresAt);
    reply.header('Set-Cookie', sessionCookie(req, token, SESSION_HOURS * 3600));
    req.user = { id: cred.user.id, name: cred.user.name, email: cred.user.email, role: cred.user.role };
    audit(store, req, 'auth.login', { detail: { email } });
    return { authEnabled: true, user: publicUser(req.user), permissions: permissionsFor(req.user.role), expiresAt };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (enabled && token) {
      const found = sessionUser(req);
      store.deleteSession(tokenHash(token));
      if (found) { req.user = found.user; audit(store, req, 'auth.logout'); }
    }
    reply.header('Set-Cookie', sessionCookie(req, '', 0));
    req.audited = true;
    return { signedOut: true };
  });

  /* ------------------------------------------------------------ user admin */

  const roleOf = (r: unknown): Role => { if (typeof r !== 'string' || !(ROLES as readonly string[]).includes(r)) throw new ApiError(400, 'INVALID_ROLE', `Role must be one of ${ROLES.join(', ')}.`); return r as Role; };
  const nameOf = (n: unknown) => { const s = typeof n === 'string' ? n.trim().replace(/\s+/g, ' ') : ''; if (s.length < 2 || s.length > 80) throw new ApiError(400, 'INVALID_NAME', 'Name must be 2–80 characters.'); return s; };
  const passwordOf = (p: unknown) => { if (typeof p !== 'string' || p.length < PASSWORD_MIN || p.length > 200) throw new ApiError(400, 'WEAK_PASSWORD', `Passwords must be at least ${PASSWORD_MIN} characters.`); return p; };
  const activeAdmins = () => store.listUsers().filter((u) => u.role === 'admin' && !u.disabled).length;

  app.get('/api/v1/users', async () => ({ users: store.listUsers().map(publicUser), roles: ROLES, authEnabled: enabled }));

  app.post<{ Body: Record<string, unknown> }>('/api/v1/users', async (req, reply) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw new ApiError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
    if (store.userCredentials(email)) throw new ApiError(409, 'USER_EXISTS', 'An account with this email already exists.');
    const user = store.addUser({ id: `u-${randomUUID().slice(0, 8)}`, email, name: nameOf(req.body?.name), role: roleOf(req.body?.role), ...hashPassword(passwordOf(req.body?.password)) });
    audit(store, req, 'user.create', { detail: { userId: user.id, email: user.email, role: user.role } });
    reply.status(201);
    return { user: publicUser(user) };
  });

  app.patch<{ Params: { userId: string }; Body: Record<string, unknown> }>('/api/v1/users/:userId', async (req) => {
    const cur = store.getUser(req.params.userId);
    if (!cur) throw new ApiError(404, 'NOT_FOUND', 'Unknown user.');
    const b = req.body ?? {};
    const patch: Parameters<Store['updateUser']>[1] = {};
    if (b.name !== undefined) patch.name = nameOf(b.name);
    if (b.role !== undefined) patch.role = roleOf(b.role);
    if (b.disabled !== undefined) patch.disabled = b.disabled === true;
    if (b.password !== undefined) Object.assign(patch, hashPassword(passwordOf(b.password)));
    const self = req.user?.id === cur.id;
    if (self && (patch.disabled || (patch.role && patch.role !== 'admin' && cur.role === 'admin'))) throw new ApiError(400, 'SELF_LOCKOUT', 'You cannot disable your own account or remove your own admin role.');
    const losesAdmin = cur.role === 'admin' && !cur.disabled && ((patch.role && patch.role !== 'admin') || patch.disabled);
    if (losesAdmin && activeAdmins() <= 1) throw new ApiError(400, 'LAST_ADMIN', 'At least one active admin is required.');
    const user = store.updateUser(cur.id, patch)!;
    if (patch.disabled || patch.hash) store.deleteUserSessions(cur.id);
    audit(store, req, 'user.update', { detail: { userId: user.id, email: user.email, changed: Object.keys(b).filter((k) => ['name', 'role', 'disabled', 'password'].includes(k)), role: user.role, disabled: user.disabled } });
    return { user: publicUser(user) };
  });
}
