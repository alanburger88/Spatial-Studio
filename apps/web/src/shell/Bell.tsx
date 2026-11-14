import { useEffect, useRef } from 'react';
import { useStudio } from '../state/store';
import { POLL_MS, useNotifyState } from './notifyState';
import { overlayLoaders } from './LazyOverlays';
import './bell.css';

/**
 * The bell in the top bar: the number of unread notifications, and a button that opens the panel (notifications and
 * "My work"). It asks the server for the count every 30 seconds while the studio's tab is visible, and at once when the
 * tab becomes visible again. No websockets, no email: nothing leaves the studio.
 */
export function Bell() {
  const signedIn = useStudio((s) => !!s.session?.user);
  const unread = useNotifyState((s) => s.unread);
  const open = useNotifyState((s) => s.open);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!signedIn) return;
    const tick = () => { if (document.visibilityState === 'visible') void useNotifyState.getState().refresh(); };
    tick();
    const t = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', tick); };
  }, [signedIn]);
  // When the panel closes, focus returns to the bell.
  const was = useRef(open);
  useEffect(() => { if (was.current && !open) btn.current?.focus(); was.current = open; }, [open]);
  if (!signedIn) return null;
  const label = unread ? `Notifications: ${unread} unread` : 'Notifications and My work';
  return (
    <button ref={btn} type="button" className="btn ghost icon bell-btn" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open}
      onMouseEnter={() => void overlayLoaders.notifications().catch(() => undefined)}
      onClick={() => (open ? useNotifyState.getState().close() : useNotifyState.getState().show())} data-testid="bell" data-unread={unread}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" /></svg>
      {unread > 0 && <span className="bell-count" data-testid="bell-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}
