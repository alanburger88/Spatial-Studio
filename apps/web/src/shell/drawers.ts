import { create } from 'zustand';

/** Which right-hand drawer (version history, review & approval) is open. Kept apart from the drawers so the shell can open one without loading it. */
export type DrawerId = 'history' | 'review' | null;
export const useDrawers = create<{ open: DrawerId; show(d: Exclude<DrawerId, null>): void; close(): void }>((set) => ({
  open: null,
  show: (open) => set({ open }),
  close: () => set({ open: null }),
}));
