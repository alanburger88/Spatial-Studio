import { create } from 'zustand';

/** What the panel was opened to show. `explain` follows the top-bar customer; `summary` compares with the last approved version. */
export type PanelFocus = { kind: 'explain'; nodeId: string } | { kind: 'summary' } | null;

interface PanelState {
  /** True while the studio shell has mounted the panel; the "Ask AI" button only shows then (not on the gallery or sign-in). */
  available: boolean;
  open: boolean;
  tab: 'help' | 'chat';
  focus: PanelFocus;
  /** The element that had focus when the panel opened, so Escape/close can put it back. */
  opener: HTMLElement | null;
  setAvailable(v: boolean): void;
  setTab(tab: 'help' | 'chat'): void;
  setFocus(focus: PanelFocus): void;
  openPanel(focus?: PanelFocus): void;
  /** `restoreFocus: false` when the caller is about to move focus somewhere else on purpose. */
  close(restoreFocus?: boolean): void;
}

/** Open or closed lives for the session only (never persisted). */
export const usePanel = create<PanelState>((set, get) => ({
  available: false,
  open: false,
  tab: 'help',
  focus: null,
  opener: null,
  setAvailable: (available) => set({ available }),
  setTab: (tab) => set({ tab }),
  setFocus: (focus) => set({ focus }),
  openPanel(focus) {
    const active = document.activeElement;
    const keep = get().open ? get().opener : active instanceof HTMLElement && active !== document.body ? active : null;
    set({ open: true, opener: keep, ...(focus !== undefined ? { focus, tab: 'help' as const } : {}) });
  },
  close(restoreFocus = true) {
    const { opener } = get();
    set({ open: false, opener: null });
    // Return focus after the panel has unmounted its own focus target.
    if (restoreFocus) window.setTimeout(() => { if (opener && opener.isConnected) opener.focus(); }, 0);
  },
}));
