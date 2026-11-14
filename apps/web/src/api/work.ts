import type { Role, WorkflowState } from '@iss/model';
import type { BlockerKind } from '@iss/scenarios';
import { requestJson as json } from './client';

/**
 * Wave 4 routes: a blocker's owner, status and notes (docs/api/BLOCKER_WORK.md), and notifications and "My work"
 * (docs/api/NOTIFICATIONS.md). Kept apart from client.ts so the bell in the top bar stays small.
 */

export type WorkStatus = 'open' | 'being-fixed' | 'fixed' | 'known-data-problem';
export interface WorkPerson { id: string; name: string }
export interface WorkNoteDto { id: string; body: string; author: WorkPerson | null; at: string }
export interface BlockerWorkItem {
  blockerId: string; kind: BlockerKind; title: string; speed: 'fast' | 'full-check';
  owner: WorkPerson | null; status: WorkStatus; statusBy: WorkPerson | null; statusAt: string | null;
  fixedAt: string | null; fixedInVersion: number | null; customerCount: number | null;
  notes: WorkNoteDto[]; updatedAt: string;
}
export interface BlockerWorkDto { projectId: string; modelVersion: number; authEnabled: boolean; lastApprovalAt: string | null; items: BlockerWorkItem[]; people: Array<WorkPerson & { role: Role }> }

export type NotificationTargetDto =
  | { screen: 'blockers'; projectId: string; blockerId: string | null }
  | { screen: 'review'; projectId: string }
  | { screen: 'comment'; projectId: string; nodeId: string | null; commentId: string | null };
export interface NotificationDto { id: string; kind: string; projectId: string | null; documentTitle: string | null; data: Record<string, string | number>; actorName: string | null; at: string; read: boolean; text: string; target: NotificationTargetDto | null }
export interface MyWorkDto {
  user: { id: string; name: string; role: Role; roleLabel: string }; authEnabled: boolean;
  blockers: Array<{ projectId: string; documentTitle: string; blockerId: string; title: string; kind: BlockerKind; speed: 'fast' | 'full-check'; status: WorkStatus; customerCount: number | null; updatedAt: string }>;
  reviews: Array<{ projectId: string; documentTitle: string; state: WorkflowState; label: string; modelVersion: number | null; submittedBy: string | null; submittedAt: string | null; canApprove: boolean; mine: boolean }>;
  /** Comments through review links you made that nobody in the studio has answered yet. */
  linkComments: Array<{ projectId: string; documentTitle: string; commentId: string; nodeId: string; linkId: string; label: string; createdAt: string }>;
}

const enc = encodeURIComponent;
export const workApi = {
  blockerWork: (projectId: string) => json<BlockerWorkDto>(`/api/v1/projects/${enc(projectId)}/blocker-work`),
  setBlockerWork: (projectId: string, blockerId: string, body: { ownerId?: string | null; status?: 'open' | 'being-fixed' }) =>
    json<BlockerWorkDto & { item: BlockerWorkItem | null }>(`/api/v1/projects/${enc(projectId)}/blocker-work/${enc(blockerId)}`, { method: 'PUT', body: JSON.stringify(body) }),
  addBlockerNote: (projectId: string, blockerId: string, body: string) =>
    json<BlockerWorkDto & { item: BlockerWorkItem | null; note: WorkNoteDto }>(`/api/v1/projects/${enc(projectId)}/blocker-work/${enc(blockerId)}/notes`, { method: 'POST', body: JSON.stringify({ body }) }),
  reportFullCheck: (projectId: string, body: { modelVersion: number; contentDigest: string; blockerIds: string[] }) =>
    json<BlockerWorkDto & { fixed: string[]; reopened: string[] }>(`/api/v1/projects/${enc(projectId)}/blocker-work/full-check`, { method: 'POST', body: JSON.stringify(body) }),
  notifications: (limit = 50) => json<{ notifications: NotificationDto[]; unread: number }>(`/api/v1/notifications?limit=${limit}`),
  readNotification: (id: string) => json<{ read: string; unread: number }>(`/api/v1/notifications/${enc(id)}/read`, { method: 'POST', body: '{}' }),
  readAllNotifications: () => json<{ marked: number; unread: number }>('/api/v1/notifications/read-all', { method: 'POST', body: '{}' }),
  myWork: () => json<MyWorkDto>('/api/v1/my-work'),
};
