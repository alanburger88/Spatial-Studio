import { useEffect } from 'react';
import { create } from 'zustand';
import { presenceApi, type PresenceOtherDto } from '../api/presence';
import { useIsDirty, useStudio } from '../state/store';

/**
 * Wave 4, item 4: who else has this document open. This window tells the server every 15 seconds which document, screen
 * and component it is on and whether it has unsaved edits, and is told about the other windows on the same document. It
 * stops while the tab is hidden (and leaves at once), starts again when it is visible, and leaves when the document is
 * closed or the tab goes away. Nothing is stored: the server keeps the list in memory and forgets a silent window after
 * 45 seconds (docs/api/PRESENCE.md).
 */

export const PRESENCE_INTERVAL_MS = 15_000;
/** A change of screen, component or saved state is told after this pause, so the others see it soon without a request per click. */
const CHANGE_PAUSE_MS = 1_200;

/** This tab's own id: made once per page load, so two tabs (even duplicated ones) are told apart; a reload is a new window. */
export const WINDOW_ID: string = (() => {
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `w-${crypto.randomUUID()}`; } catch { /* not available */ }
  return `w-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
})();

interface PresenceState {
  projectId: string | null;
  others: PresenceOtherDto[];
  set(projectId: string | null, others: PresenceOtherDto[]): void;
}
export const usePresence = create<PresenceState>((set) => ({
  projectId: null,
  others: [],
  set: (projectId, others) => set({ projectId, others }),
}));

/** The other windows on the open document (empty while alone, or for another document). */
export function useOthers(): PresenceOtherDto[] {
  const projectId = useStudio((s) => s.project?.projectId ?? null);
  const p = usePresence((s) => s.projectId);
  const others = usePresence((s) => s.others);
  return p === projectId ? others : NONE;
}
const NONE: PresenceOtherDto[] = [];

/** The others on one component in Design Studio. */
export function useOthersOnComponent(nodeId: string | null | undefined): PresenceOtherDto[] {
  const others = useOthers();
  return nodeId ? others.filter((o) => o.screen === 'S02' && o.componentId === nodeId) : NONE;
}

/** How another window is named to this one: the person, or "another window" for the same person (sign-in off: always). */
export function otherName(o: PresenceOtherDto, authEnabled: boolean): string {
  if (!o.sameUser) return o.name;
  return authEnabled ? 'You, in another window' : 'Another window';
}
export function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

/* ------------------------------------------------------------------ reporting */

let state: { projectId: string | null; screen: string | null; componentId: string | null; dirty: boolean } = { projectId: null, screen: null, componentId: null, dirty: false };
let seq = 0;

function send(): void {
  const { projectId, screen, componentId, dirty } = state;
  if (!projectId || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  const mine = ++seq;
  presenceApi.report(projectId, { windowId: WINDOW_ID, screen, componentId, dirty }).then(
    (r) => { if (mine === seq && state.projectId === projectId) usePresence.getState().set(projectId, r.others); },
    () => { /* offline or signed out: keep what is shown until the next report */ },
  );
}
function leave(beacon = false): void {
  seq++;
  presenceApi.leave(WINDOW_ID, beacon);
  usePresence.getState().set(null, []);
}

/**
 * Mounted once by the shell. `onDocument`: a document's screen is open (`/studio/...`); `screen` is the id of the screen on
 * view (S02, …) or null; the component is reported only on
 * Design Studio, where the Inspector warns about it.
 */
export function usePresenceReporting(onDocument: boolean, screen: string | null): void {
  // Only while a document's own screens are open: the gallery, the library and Activity are not "on" a document, even
  // though the store still holds the last one opened.
  const projectId = useStudio((s) => (onDocument && s.projectStatus === 'ready' ? s.project?.projectId ?? null : null));
  const signedIn = useStudio((s) => !!s.session?.user);
  const selected = useStudio((s) => s.ctx.selectedNodeId);
  const dirty = useIsDirty();
  const active = signedIn ? projectId : null;
  const componentId = screen === 'S02' ? selected : null;

  // What this window is on (declared first, so the first report below already carries it): told after a short pause, so a
  // run of clicks is one request.
  useEffect(() => {
    const changed = state.screen !== screen || state.componentId !== componentId || state.dirty !== dirty;
    state = { ...state, screen, componentId, dirty };
    if (!changed || !state.projectId) return;
    const t = window.setTimeout(send, CHANGE_PAUSE_MS);
    return () => window.clearTimeout(t);
  }, [screen, componentId, dirty]);

  // Which document: report at once, every 15 seconds while visible, and leave when it closes.
  useEffect(() => {
    if (!active) return;
    state = { ...state, projectId: active };
    send();
    const t = window.setInterval(send, PRESENCE_INTERVAL_MS);
    const onVisibility = () => { if (document.visibilityState === 'visible') send(); else leave(); };
    const onHide = () => leave(true);
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) send(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      state = { ...state, projectId: null };
      leave();
    };
  }, [active]);
}
