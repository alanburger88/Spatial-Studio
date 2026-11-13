import { useEffect } from 'react';
import { create } from 'zustand';
import { linkStatus, type LibraryKind, type LibraryLink, type LinkStatus } from '@iss/model';
import { api, ApiFailure, type LibraryCan, type LibraryItemDto } from '../../api/client';

/**
 * The library items as the studio last read them, shared by every screen that shows a link or offers "From the library".
 * Items live on the server; this is only a cache, reloaded after anything changes the library.
 */
export const useLibrary = create<{
  items: LibraryItemDto[];
  can: LibraryCan;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  load(force?: boolean): Promise<void>;
}>((set, get) => ({
  items: [],
  can: { create: false, approve: false },
  status: 'idle',
  error: null,
  async load(force = false) {
    if (!force && (get().status === 'loading' || get().status === 'ready')) return;
    set({ status: 'loading', error: null });
    try {
      const r = await api.libraryItems();
      set({ items: r.items, can: r.can, status: 'ready' });
    } catch (e) {
      set({ status: 'error', error: errorText(e) });
    }
  },
}));

/** The library items, loaded the first time a screen asks. */
export function useLibraryItems(): { items: LibraryItemDto[]; can: LibraryCan; ready: boolean } {
  const items = useLibrary((s) => s.items);
  const can = useLibrary((s) => s.can);
  const status = useLibrary((s) => s.status);
  useEffect(() => { if (status === 'idle') void useLibrary.getState().load(); }, [status]);
  return { items, can, ready: status === 'ready' };
}

/** How a link stands against the library. */
export function useLinkStatus(link: LibraryLink | undefined): { status: LinkStatus | null; latest: number | null; item: LibraryItemDto | undefined } {
  const { items, ready } = useLibraryItems();
  if (!link || !ready) return { status: null, latest: null, item: undefined };
  const item = items.find((i) => i.id === link.itemId);
  return { status: linkStatus(link, items), latest: item?.latest ?? null, item };
}

/** Approved items of one kind, for "From the library". */
export const approvedOf = (items: LibraryItemDto[], kind: LibraryKind) => items.filter((i) => i.kind === kind && i.latest !== null);

/** The item first taken from this document and thing (component, message, brand, glossary), if there is one. */
export const itemFromSource = (items: LibraryItemDto[], kind: LibraryKind, projectId: string, ref: string) =>
  items.find((i) => i.kind === kind && i.source?.projectId === projectId && i.source.ref === ref);

export function errorText(e: unknown): string {
  return e instanceof ApiFailure ? e.message : String((e as Error)?.message ?? e);
}
