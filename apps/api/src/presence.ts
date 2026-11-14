import { createHash } from 'node:crypto';

/**
 * Wave 4, item 4 (docs/design/WAVE4_TEAMS.md §4, docs/api/PRESENCE.md): who else has a document open.
 *
 * Each open studio window reports every 15 seconds which document, screen and component it is on, and whether it has
 * unsaved edits. This module keeps those reports IN MEMORY ONLY: nothing is written to the database or the Activity log,
 * and a window that has not reported for 45 seconds is forgotten. A restart forgets everyone, which is correct: every
 * window reports again within 15 seconds.
 *
 * A window is identified by the id its browser tab made for itself together with the signed-in user, so two tabs of the
 * same person are told apart, and one person can never move or remove another person's window.
 */

export const PRESENCE_INTERVAL_MS = 15_000;
export const PRESENCE_TTL_MS = 45_000;
/** Safety limits: a window id is a short random token; the whole map stays small whatever a client sends. */
export const WINDOW_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_WINDOWS = 2_000;
export const MAX_WINDOWS_PER_USER = 50;

export interface PresenceReport {
  windowId: string;
  userId: string;
  userName: string;
  projectId: string;
  /** The screen id (S02, S17, …), or null when the window is on none of them. */
  screen: string | null;
  /** The component selected in Design Studio, or null. */
  componentId: string | null;
  dirty: boolean;
}

interface Entry extends PresenceReport { seenAt: number }

/** What a window is told about another window on the same document. Never the other window's id. */
export interface PresenceOther {
  /** An opaque, stable key for the other window (for lists); it cannot be used to act for that window. */
  key: string;
  userId: string;
  name: string;
  /** The same signed-in user (with sign-in off: always, since everyone is the local admin): the screen says "another window". */
  sameUser: boolean;
  screen: string | null;
  componentId: string | null;
  dirty: boolean;
  /** Seconds since that window last reported. */
  seenSecondsAgo: number;
}

const keyOf = (userId: string, windowId: string): string => `${userId}\u0000${windowId}`;
const opaque = (userId: string, windowId: string): string => createHash('sha256').update(keyOf(userId, windowId)).digest('base64url').slice(0, 12);

export class Presence {
  private windows = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = PRESENCE_TTL_MS) {}

  /** Forget every window that has been silent for longer than the time limit. */
  sweep(): void {
    const limit = this.now() - this.ttlMs;
    for (const [k, e] of this.windows) if (e.seenAt < limit) this.windows.delete(k);
  }

  /** Record (or move) a window. Returns false when the limits refuse a new window. */
  report(r: PresenceReport): boolean {
    this.sweep();
    const k = keyOf(r.userId, r.windowId);
    if (!this.windows.has(k)) {
      if (this.windows.size >= MAX_WINDOWS) return false;
      let mine = 0;
      for (const e of this.windows.values()) if (e.userId === r.userId) mine++;
      if (mine >= MAX_WINDOWS_PER_USER) return false;
    }
    this.windows.set(k, { ...r, seenAt: this.now() });
    return true;
  }

  /** The other windows on a document: other people first, then the same person's other windows, each by name, so the list is stable. */
  others(projectId: string, userId: string, windowId: string): PresenceOther[] {
    this.sweep();
    const self = keyOf(userId, windowId);
    const now = this.now();
    const out: PresenceOther[] = [];
    for (const [k, e] of this.windows) {
      if (k === self || e.projectId !== projectId) continue;
      out.push({ key: opaque(e.userId, e.windowId), userId: e.userId, name: e.userName, sameUser: e.userId === userId, screen: e.screen, componentId: e.componentId, dirty: e.dirty, seenSecondsAgo: Math.max(0, Math.round((now - e.seenAt) / 1000)) });
    }
    return out.sort((a, b) => (a.sameUser === b.sameUser ? 0 : a.sameUser ? 1 : -1) || a.name.localeCompare(b.name) || (a.key < b.key ? -1 : 1));
  }

  /** Remove a window at once (it left the document or closed). Only its own user can remove it. */
  leave(userId: string, windowId: string): boolean {
    return this.windows.delete(keyOf(userId, windowId));
  }

  get size(): number { this.sweep(); return this.windows.size; }
}
