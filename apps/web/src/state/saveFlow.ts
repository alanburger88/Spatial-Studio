import { create } from 'zustand';
import { projectContentDigest, type Project } from '@iss/model';
import { editBlockedReason, useStudio } from './store';
import type { SaveWarning } from '../shell/saveCheck';

/**
 * Blockers phase 6 (docs/design/BLOCKERS.md, "Warn before saving"): a save that a person starts (the Save button, Ctrl/Cmd+S,
 * the command palette, "Save changes" in version history) first works out whether it would ADD a fast root cause that the
 * last saved version does not have. If it would, a dialog lists the new causes and offers Go back and Save anyway; if not,
 * the save goes ahead at once. Saving is never prevented, and the check never stops a save when it cannot be worked out.
 *
 * Saves started by other flows call `useStudio.getState().save()` directly and are not warned (the decisions are listed in
 * the as-built notes): the guided demo, and "add fields and a customer" (Rules & data), which must save to make the customer.
 *
 * The comparison itself is a separate download (`shell/saveCheck.ts`), fetched when the document is first edited.
 */

export type SaveSource = 'button' | 'keyboard' | 'palette' | 'history';

interface SaveFlowState {
  /** The comparison is being worked out (the Save button says so). */
  checking: boolean;
  /** The dialog's content while it is open. */
  warning: (SaveWarning & { source: SaveSource }) | null;
  /** The last comparison: how long it took and how many causes it added (for Technical view and the tests). */
  last: { ms: number; added: number; at: number } | null;
  answer(saveAnyway: boolean): void;
}

let pending: ((saveAnyway: boolean) => void) | null = null;
export const useSaveFlow = create<SaveFlowState>((set) => ({
  checking: false,
  warning: null,
  last: null,
  answer(saveAnyway) { const p = pending; pending = null; set({ warning: null }); p?.(saveAnyway); },
}));

export const loadSaveCheck = () => import('../shell/saveCheck');

/* ------------------------------------------------------------------ the last saved version, as the store holds it */

let saved: Project | null = null;
/** The last saved version of the open document, when the store still holds it (it does after opening and after every save). */
export function savedProjectFor(projectId: string): Project | null {
  return saved && saved.projectId === projectId ? saved : null;
}
const idle = (fn: () => void) => {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 4000 }); else window.setTimeout(fn, 300);
};
let warmed: Project | null = null;
if (typeof window !== 'undefined') {
  useStudio.subscribe((s, prev) => {
    if (s.savedDigest !== prev.savedDigest || s.project?.projectId !== prev.project?.projectId) {
      saved = s.project && projectContentDigest(s.project) === s.savedDigest ? s.project : null;
    }
    // The first edit after a save: work out the saved version's causes while the person is still editing, so Save only
    // has to work out the new version's.
    if (s.project !== prev.project && saved && s.project !== saved && warmed !== saved && !editBlockedReason(s.session)) {
      const base = saved;
      warmed = base;
      idle(() => { void loadSaveCheck().then((m) => m.warm(base, useStudio.getState().records)).catch(() => undefined); });
    }
  });
}

/* ------------------------------------------------------------------ a save a person starts */

/** Save the open document, warning first when the save would add a blocker. Resolves true when it was saved. */
export async function requestSave(source: SaveSource = 'button'): Promise<boolean> {
  const st = useStudio.getState();
  const flow = useSaveFlow.getState();
  if (!st.project || st.saving || flow.checking || flow.warning) return false;
  // Read-only people get the store's own answer; a save with nothing changed adds nothing.
  if (editBlockedReason(st.session) || projectContentDigest(st.project) === st.savedDigest) return st.save();
  const project = st.project;
  useSaveFlow.setState({ checking: true });
  let warning: SaveWarning | null = null;
  try {
    const m = await loadSaveCheck();
    warning = await m.saveWarning(project, useStudio.getState().records, savedProjectFor(project.projectId), st.serverVersion);
    useSaveFlow.setState({ last: { ms: warning.ms, added: warning.causes.length, at: Date.now() } });
  } catch {
    warning = null; // the check must never stop a save
  } finally {
    useSaveFlow.setState({ checking: false });
  }
  if (!warning || !warning.causes.length) return useStudio.getState().save();
  const go = await new Promise<boolean>((resolve) => { pending = resolve; useSaveFlow.setState({ warning: { ...warning!, source } }); });
  return go ? useStudio.getState().save() : false;
}
