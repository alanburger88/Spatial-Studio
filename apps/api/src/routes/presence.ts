import type { FastifyInstance } from 'fastify';
import { LOCAL_ADMIN } from '../auth';
import { PRESENCE_INTERVAL_MS, PRESENCE_TTL_MS, WINDOW_ID_PATTERN, Presence } from '../presence';
import type { RouteDeps } from './deps';

/**
 * Wave 4, item 4: who else has this document open (docs/api/PRESENCE.md). Two routes, both open to any signed-in user and
 * both "read-like" for the audit trail: nothing here is stored in the database or written to the Activity log.
 *
 *   POST /api/v1/projects/:projectId/presence   { windowId, screen?, componentId?, dirty? } → { others, intervalMs, ttlMs }
 *   POST /api/v1/presence/leave                  { windowId }                                → { left }
 */

const SCREEN_PATTERN = /^S\d{2}$/;
const COMPONENT_MAX = 200;

export function registerPresenceRoutes(app: FastifyInstance, deps: RouteDeps, opts: { presence: Presence }): void {
  const { ApiError, projectOr404 } = deps;
  const { presence } = opts;
  const windowIdOf = (v: unknown): string => {
    if (typeof v !== 'string' || !WINDOW_ID_PATTERN.test(v)) throw new ApiError(400, 'INVALID_WINDOW', 'A window id is 8 to 64 letters, digits, - or _.');
    return v;
  };

  app.post<{ Params: { projectId: string }; Body: Record<string, unknown> }>('/api/v1/projects/:projectId/presence', async (req) => {
    const project = projectOr404(req.params.projectId);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const windowId = windowIdOf(b.windowId);
    const screen = typeof b.screen === 'string' && SCREEN_PATTERN.test(b.screen) ? b.screen : null;
    // Only a component the saved document has is kept (an unsaved new one is nobody else's to be on).
    const componentId = typeof b.componentId === 'string' && b.componentId.length <= COMPONENT_MAX && project.nodes.some((n) => n.id === b.componentId) ? b.componentId : null;
    const user = req.user ?? LOCAL_ADMIN;
    const kept = presence.report({ windowId, userId: user.id, userName: user.name, projectId: project.projectId, screen, componentId, dirty: b.dirty === true });
    if (!kept) throw new ApiError(429, 'TOO_MANY_WINDOWS', 'Too many studio windows are open. Close some and try again.');
    return { others: presence.others(project.projectId, user.id, windowId), intervalMs: PRESENCE_INTERVAL_MS, ttlMs: PRESENCE_TTL_MS };
  });

  // Sent when a window leaves a document, hides, or closes (with navigator.sendBeacon, so it carries the session cookie).
  app.post<{ Body: Record<string, unknown> }>('/api/v1/presence/leave', async (req) => {
    const windowId = windowIdOf((req.body ?? {}).windowId);
    const user = req.user ?? LOCAL_ADMIN;
    return { left: presence.leave(user.id, windowId) };
  });
}
