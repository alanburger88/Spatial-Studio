import { useEffect } from 'react';
import { create } from 'zustand';
import { WORKFLOW_LABEL, type WorkflowState } from '@iss/model';
import { api, type WorkflowDto } from '../api/client';
import { useStudio } from '../state/store';
import { useDrawers } from './drawers';

/* ------------------------------------------------------------------ workflow state shared by chip + panel */

interface WfStore { wf: WorkflowDto | null; loading: boolean; error: string | null; load(projectId: string, checks: boolean): Promise<WorkflowDto | null>; set(wf: WorkflowDto): void }
export const useWorkflow = create<WfStore>((set, get) => ({
  wf: null, loading: false, error: null,
  async load(projectId, checks) {
    set({ loading: true });
    try {
      const wf = await api.workflow(projectId, checks);
      // Keep readiness from a previous full load when this one skipped the checks for the same saved version.
      const prev = get().wf;
      set({ wf: !checks && prev && prev.projectId === wf.projectId && prev.modelVersion === wf.modelVersion && prev.readiness ? { ...wf, readiness: prev.readiness } : wf, loading: false, error: null });
      return wf;
    } catch (e: any) { set({ loading: false, error: e.message }); return null; }
  },
  set(wf) { set({ wf }); },
}));

const STATE_TONE: Record<WorkflowState, string> = { draft: '', in_review: 'info', changes_requested: 'warning', approved: 'accent', published: 'accent' };
const SHORT_LABEL: Record<WorkflowState, string> = { draft: 'Draft', in_review: 'Review', changes_requested: 'Changes', approved: 'Approved', published: 'Published' };
const STATE_GLYPH: Record<WorkflowState, string> = { draft: '○', in_review: '◐', changes_requested: '!', approved: '✓', published: '★' };

export function StateChip({ state, testId }: { state: WorkflowState; testId?: string }) {
  return <span className={`chip ${STATE_TONE[state]}`} data-testid={testId} data-state={state}><span aria-hidden="true">{STATE_GLYPH[state]}</span> {WORKFLOW_LABEL[state]}</span>;
}

/** Top-bar status chip; opens the Review panel. Refreshes whenever a new version is saved. */
export function WorkflowChip() {
  const project = useStudio((s) => s.project);
  const serverVersion = useStudio((s) => s.serverVersion);
  const wf = useWorkflow((s) => s.wf);
  const pid = project?.projectId;
  useEffect(() => {
    if (!pid) return;
    const before = useWorkflow.getState().wf;
    useWorkflow.getState().load(pid, false).then((next) => {
      if (!next || !before || before.projectId !== next.projectId) return;
      if (before.state !== 'draft' && next.state === 'draft' && next.history[0]?.action === 'auto_reopen') {
        useStudio.getState().toast({ kind: 'warning', title: 'Back to draft', message: `v${next.modelVersion} changed the ${WORKFLOW_LABEL[before.state].toLowerCase()} document, so it needs review again.` });
      }
    });
  }, [pid, serverVersion]);
  if (!project) return null;
  const state = wf && wf.projectId === pid ? wf.state : null;
  return (
    <button type="button" className={`chip wf-chip ${state ? STATE_TONE[state] : 'loading'}`} onClick={() => useDrawers.getState().show('review')} data-testid="workflow-status" data-state={state ?? ''}
      aria-haspopup="dialog" title={state ? `Review status: ${WORKFLOW_LABEL[state]} — open review & approval` : 'Loading review status'}>
      <span className="wf-glyph" aria-hidden="true">{state ? STATE_GLYPH[state] : '…'}</span>
      <span className="wf-full">{state ? WORKFLOW_LABEL[state] : 'Status'}</span>
      <span className="wf-short" aria-hidden="true">{state ? SHORT_LABEL[state] : 'Status'}</span>
    </button>
  );
}
