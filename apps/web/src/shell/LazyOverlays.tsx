import { Suspense, lazy, useEffect } from 'react';
import { useShellUi } from './CommandPalette';
import { useDrawers } from './drawers';
import { Loading } from '../ui/common';
import { loadAssistPanel } from '../assist/AssistHost';

/**
 * Help, the tour, version history and review are each their own download, fetched the first time they are opened. They are
 * also fetched when the app is idle, so on a normal connection they open without waiting; while a download is still in
 * flight a loading placeholder shows in the same place.
 */
export const overlayLoaders = {
  help: () => import('./HelpSheet'),
  tour: () => import('./Tour'),
  history: () => import('./History'),
  review: () => import('./Review'),
  assist: loadAssistPanel,
};
const HelpSheet = lazy(() => overlayLoaders.help().then((m) => ({ default: m.HelpSheet })));
const Tour = lazy(() => overlayLoaders.tour().then((m) => ({ default: m.Tour })));
const HistoryPanel = lazy(() => overlayLoaders.history().then((m) => ({ default: m.HistoryPanel })));
const ReviewPanel = lazy(() => overlayLoaders.review().then((m) => ({ default: m.ReviewPanel })));

function DialogLoading({ label }: { label: string }) {
  return <div className="dialog-backdrop"><div className="dialog" role="status" aria-busy="true" style={{ padding: 24 }}><Loading label={label} /></div></div>;
}

function DrawerLoading() {
  const close = useDrawers((s) => s.close);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [close]);
  return <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}><aside className="drawer" role="status" aria-busy="true"><Loading label="Loading…" /></aside></div>;
}

/** Help sheet and tour: mounted only while open. */
export function LazyOverlays() {
  const help = useShellUi((s) => s.shortcutsOpen);
  const tour = useShellUi((s) => s.tourOpen);
  return (
    <>
      {help && <Suspense fallback={<DialogLoading label="Loading help…" />}><HelpSheet /></Suspense>}
      {tour && <Suspense fallback={null}><Tour /></Suspense>}
    </>
  );
}

/** Version history and review drawers: mounted only while open. */
export function LazyDrawers() {
  const open = useDrawers((s) => s.open);
  if (!open) return null;
  return <Suspense fallback={<DrawerLoading />}>{open === 'history' ? <HistoryPanel /> : <ReviewPanel />}</Suspense>;
}

/** Fetches the overlay downloads in the background (called once the app is idle). */
export function prefetchOverlays() {
  for (const load of Object.values(overlayLoaders)) void load().catch(() => undefined);
}
