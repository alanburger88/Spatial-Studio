import { create } from 'zustand';
import { workApi } from '../api/work';

/**
 * The bell's own state: how many notifications are unread, and whether the panel is open (and on which tab). The bell
 * asks for the count every 30 seconds while the studio is open and its tab is visible; the panel itself is a separate
 * download (LazyOverlays).
 */
export type NotifyTab = 'news' | 'work';
interface NotifyState {
  unread: number;
  open: boolean;
  tab: NotifyTab;
  /** Bumped whenever the count changed, so an open panel reloads its list. */
  rev: number;
  refresh(): Promise<void>;
  setUnread(n: number): void;
  show(tab?: NotifyTab): void;
  close(): void;
}

export const useNotifyState = create<NotifyState>((set, get) => ({
  unread: 0,
  open: false,
  tab: 'news',
  rev: 0,
  async refresh() {
    try {
      const r = await workApi.notifications(0);
      if (r.unread !== get().unread) set({ unread: r.unread, rev: get().rev + 1 });
    } catch { /* offline or signed out: keep what is shown */ }
  },
  setUnread: (unread) => set({ unread }),
  show: (tab) => set({ open: true, ...(tab ? { tab } : {}) }),
  close: () => set({ open: false }),
}));

export const POLL_MS = 30_000;
