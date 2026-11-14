import { useEffect, useState } from 'react';
import { useShellUi } from './CommandPalette';
import './tour.css';

/* -------------------------------------------------------------------------------- remembered in local storage */
export const OFFERED_KEY = 'iss.tour.offered';
const LEGACY_DONE_KEY = 'iss.tour.done';
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
export const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable: the offer is then made on every visit */ } };
const wasOffered = () => read(OFFERED_KEY) !== null || read(LEGACY_DONE_KEY) !== null;
const markOffered = () => write(OFFERED_KEY, '1');

/** Put keyboard focus somewhere sensible when the thing that had it has gone: the main area. */
export function focusMain() {
  const m = document.getElementById('main');
  if (!m) return;
  if (!m.hasAttribute('tabindex')) m.setAttribute('tabindex', '-1');
  m.focus({ preventScroll: true });
}

/** Start the tour (also moves to Overview first when the tour needs it). */
export const startTour = () => useShellUi.getState().setTour(true);

/* -------------------------------------------------------------------------------- the offer */

/**
 * A small, non-modal offer shown once, on the first visit to Overview. It sits in the page (above the screen, covering
 * nothing) and is remembered the moment it has been shown, so it is never offered twice.
 */
export function TourPrompt() {
  const [show, setShow] = useState(() => !wasOffered());
  useEffect(() => { if (show) markOffered(); }, [show]);
  if (!show) return null;
  const dismiss = () => { setShow(false); focusMain(); };
  return (
    <div className="iss-tour-prompt" role="region" aria-label="Tour offer" data-testid="tour-prompt">
      <span className="iss-tour-prompt-text">New to the studio? A short tour shows where things are and what each part is for.</span>
      <button type="button" className="btn primary sm" data-testid="tour-prompt-start" onClick={() => { setShow(false); startTour(); }}>Take a two-minute tour</button>
      <button type="button" className="btn ghost sm" data-testid="tour-prompt-dismiss" onClick={dismiss}>Not now</button>
    </div>
  );
}

