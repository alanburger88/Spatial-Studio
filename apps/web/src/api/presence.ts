import { requestJson as json } from './client';

/**
 * Wave 4, item 4: who else has this document open (docs/api/PRESENCE.md). Kept apart from client.ts; small, because the top
 * bar uses it on every screen of a document.
 */

export interface PresenceOtherDto {
  key: string;
  userId: string;
  name: string;
  /** The same signed-in user in another window (with sign-in off: always). */
  sameUser: boolean;
  screen: string | null;
  componentId: string | null;
  dirty: boolean;
  seenSecondsAgo: number;
}
export interface PresenceReportBody { windowId: string; screen: string | null; componentId: string | null; dirty: boolean }

export const presenceApi = {
  report: (projectId: string, body: PresenceReportBody) =>
    json<{ others: PresenceOtherDto[]; intervalMs: number; ttlMs: number }>(`/api/v1/projects/${encodeURIComponent(projectId)}/presence`, { method: 'POST', body: JSON.stringify(body) }),
  /** Leave at once. `beacon` for a closing tab: the browser sends it even as the page goes away (with the session cookie). */
  leave: (windowId: string, beacon = false): void => {
    const body = JSON.stringify({ windowId });
    try {
      if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon?.('/api/v1/presence/leave', new Blob([body], { type: 'application/json' }))) return;
    } catch { /* fall through to a normal request */ }
    void fetch('/api/v1/presence/leave', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => undefined);
  },
};
