import { useEffect } from 'react';
import { create } from 'zustand';
import type { KnownDataProblem } from '@iss/scenarios';
import { api, type KnownDataAnswer, type KnownDataProblemDto } from '../../api/client';
import { currentPreviewDate, dated, usePreviewDate, useStudio } from '../../state/store';

/**
 * Known data problems as the server holds them, per document, for this browser session. Every answer of the server
 * replaces the list; when the server says some lapsed (the problem no longer stops that customer) the note is kept to
 * show once. Nothing here is model state: setting a problem aside is not an edit of the document and cannot be undone
 * with the top-bar undo; it is removed with "Remove".
 */

interface Entry { list: KnownDataProblemDto[]; loaded: boolean; note: string | null; error: string | null }
interface Store {
  byProject: Record<string, Entry>;
  load(projectId: string): Promise<void>;
  add(projectId: string, body: { blockerId: string; recordId: string; reason: string }): Promise<KnownDataProblemDto>;
  remove(projectId: string, id: string): Promise<void>;
  dismissNote(projectId: string): void;
}

const EMPTY: Entry = { list: [], loaded: false, note: null, error: null };
const pending = new Map<string, Promise<void>>();

export const useKnownData = create<Store>((set, get) => {
  const put = (projectId: string, patch: Partial<Entry>) => set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...(s.byProject[projectId] ?? EMPTY), ...patch } } }));
  const noted = (projectId: string, a: KnownDataAnswer) => { if (a.note) put(projectId, { note: a.note }); };
  return {
    byProject: {},
    async load(projectId) {
      const running = pending.get(projectId);
      if (running) return running;
      const p = api.knownDataProblems(projectId, currentPreviewDate())
        .then((r) => { put(projectId, { list: r.knownDataProblems, loaded: true, error: null }); noted(projectId, r); })
        .catch((e) => { put(projectId, { loaded: true, error: e instanceof Error ? e.message : String(e) }); })
        .finally(() => pending.delete(projectId));
      pending.set(projectId, p);
      return p;
    },
    async add(projectId, body) {
      const r = await api.addKnownDataProblem(projectId, { ...body, ...dated(currentPreviewDate()) });
      noted(projectId, r);
      await get().load(projectId);
      return r.knownDataProblem;
    },
    async remove(projectId, id) {
      const r = await api.removeKnownDataProblem(projectId, id, currentPreviewDate());
      noted(projectId, r);
      await get().load(projectId);
    },
    dismissNote(projectId) { put(projectId, { note: null }); },
  };
});

const NONE: KnownDataProblemDto[] = [];
/** The document's known data problems, loaded on first use and again whenever a version is saved or the customers change. */
export function useKnownDataProblems(): { list: KnownDataProblemDto[]; loaded: boolean; note: string | null; error: string | null } {
  const projectId = useStudio((s) => s.project?.projectId ?? '');
  const serverVersion = useStudio((s) => s.serverVersion);
  const records = useStudio((s) => s.records);
  // Judged on the day the screen shows ("As issued on"), so reload when it changes.
  const issueDate = usePreviewDate();
  const entry = useKnownData((s) => s.byProject[projectId]);
  useEffect(() => { if (projectId) void useKnownData.getState().load(projectId); }, [projectId, serverVersion, records, issueDate]);
  return { list: entry?.list ?? NONE, loaded: !!entry?.loaded, note: entry?.note ?? null, error: entry?.error ?? null };
}

/** What the engine needs from the server's list. */
export const toKnown = (list: KnownDataProblemDto[]): KnownDataProblem[] => list.map((k) => ({ id: k.id, blockerId: k.blockerId, recordId: k.recordId, reason: k.reason, markedBy: k.markedBy, markedAt: k.markedAt }));

/** "13 Nov, 10:42" for when a problem was set aside. */
export const whenText = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
