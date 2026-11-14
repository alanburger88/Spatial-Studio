import { useEffect } from 'react';
import { create } from 'zustand';
import { blockerIdOf, type BlockerWithStatus } from '@iss/scenarios';
import { workApi, type BlockerWorkDto, type BlockerWorkItem, type WorkStatus } from '../../api/work';
import { useStudio } from '../../state/store';
import { useNotifyState } from '../../shell/notifyState';
import type { FullCheckResult } from './fullCheck';

/**
 * Blockers phase 4 in the browser: each cause's owner, status and notes as the server holds them, per document, for
 * this browser session. Nothing here is model state: giving a cause an owner is not an edit of the document and is not
 * undone with the top-bar undo. "Fixed" is worked out by the server against the saved document (see the API notes).
 */

interface Entry { data: BlockerWorkDto | null; error: string | null }
interface Store {
  byProject: Record<string, Entry>;
  load(projectId: string): Promise<void>;
  set(projectId: string, blockerId: string, body: { ownerId?: string | null; status?: 'open' | 'being-fixed' }): Promise<void>;
  note(projectId: string, blockerId: string, body: string): Promise<void>;
  /** Tells the server what a full check of the saved version found, so causes only it can see can be judged fixed. */
  reportFull(projectId: string, body: { modelVersion: number; contentDigest: string; blockerIds: string[] }): Promise<void>;
}

const pending = new Map<string, Promise<void>>();

export const useBlockerWorkStore = create<Store>((set, get) => {
  const put = (projectId: string, patch: Partial<Entry>) => set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...(s.byProject[projectId] ?? { data: null, error: null }), ...patch } } }));
  // What changes here can create or clear notifications (one's own never do, but a fix noticed on a read can).
  const after = (projectId: string, data: BlockerWorkDto) => { put(projectId, { data, error: null }); void useNotifyState.getState().refresh(); };
  return {
    byProject: {},
    async load(projectId) {
      const running = pending.get(projectId);
      if (running) return running;
      const p = workApi.blockerWork(projectId)
        .then((d) => after(projectId, d))
        .catch((e) => put(projectId, { error: e instanceof Error ? e.message : String(e) }))
        .finally(() => pending.delete(projectId));
      pending.set(projectId, p);
      return p;
    },
    async set(projectId, blockerId, body) { after(projectId, await workApi.setBlockerWork(projectId, blockerId, body)); },
    async note(projectId, blockerId, body) { after(projectId, await workApi.addBlockerNote(projectId, blockerId, body)); },
    async reportFull(projectId, body) {
      if (!get().byProject[projectId]?.data?.items.some((i) => i.speed === 'full-check')) return;
      try { after(projectId, await workApi.reportFullCheck(projectId, body)); } catch { /* a full check of an older version says nothing */ }
    },
  };
});

const NONE: BlockerWorkItem[] = [];
/** The document's blocker work, loaded on first use and again after every save or change of customers. */
export function useBlockerWork(): { items: BlockerWorkItem[]; data: BlockerWorkDto | null; error: string | null } {
  const projectId = useStudio((s) => s.project?.projectId ?? '');
  const serverVersion = useStudio((s) => s.serverVersion);
  const records = useStudio((s) => s.records);
  const entry = useBlockerWorkStore((s) => s.byProject[projectId]);
  useEffect(() => { if (projectId) void useBlockerWorkStore.getState().load(projectId); }, [projectId, serverVersion, records]);
  return { items: entry?.data?.items ?? NONE, data: entry?.data ?? null, error: entry?.error ?? null };
}

/** After a full check of exactly the saved version, report the causes it found (once per check). */
export function useReportFullCheck(full: FullCheckResult): void {
  const projectId = useStudio((s) => s.project?.projectId ?? '');
  const serverVersion = useStudio((s) => s.serverVersion);
  const savedDigest = useStudio((s) => s.savedDigest);
  useEffect(() => {
    if (!projectId || full.status !== 'done' || full.ranAtMs === null || full.failed > 0) return;
    if (full.modelVersion !== serverVersion || full.digest !== savedDigest) return;
    const blockerIds = [...new Set(full.findings.map((x) => blockerIdOf(x.finding)))];
    void useBlockerWorkStore.getState().reportFull(projectId, { modelVersion: serverVersion, contentDigest: savedDigest, blockerIds });
  }, [projectId, full.ranAtMs]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The status a live blocker shows: Known data problem from phase 2, otherwise what a person set (Open by default). */
export function statusOf(b: Pick<BlockerWithStatus, 'status'>, item: BlockerWorkItem | undefined): WorkStatus {
  if (b.status === 'known-data-problem') return 'known-data-problem';
  return item?.status === 'being-fixed' ? 'being-fixed' : 'open';
}

export const STATUS_LABEL: Record<WorkStatus, string> = { open: 'Open', 'being-fixed': 'Being fixed', fixed: 'Fixed', 'known-data-problem': 'Known data problem' };
export const STATUS_CHIP: Record<WorkStatus, string> = { open: '', 'being-fixed': 'info', fixed: 'accent', 'known-data-problem': 'warning' };

/** Who the person using the studio is (the local admin with sign-in off). */
export function useMe(): { id: string; name: string } {
  const user = useStudio((s) => s.session?.user);
  return { id: user?.id ?? 'local-admin', name: user?.name ?? 'Local admin' };
}
