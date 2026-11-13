import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStudio } from '../state/store';
import { useShellUi } from './CommandPalette';
import { SCREENS, screenOfPath, screenTo } from './Shell';
import './tour.css';

/**
 * The first-visit tour: a short walk through the studio in the order of work (Overview, Design, Rules & data, Explore,
 * Check, Releases, Help). Each step points at a real element and says in words what it is for, so the highlight is never
 * the only cue. It moves to the right screen itself, can be skipped at any time, and is never opened automatically: the
 * first visit to Overview only offers it (TourPrompt), and Help and the Help & activity tab row start it again.
 */

interface TourStep {
  id: string;
  title: string;
  text: string;
  /** The screen the step needs to be on (S02, S07, …). */
  screen: string;
  /** What the step points at. */
  target: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  { id: 'overview', screen: 'S19', target: '[data-testid=overview-steps]', title: 'Overview: what to do next',
    text: 'Overview is the home page of a document. It shows where the document stands and lists the next steps in order, each with a button that takes you to the right place. Come back here whenever you are not sure what to do next.' },
  { id: 'customer', screen: 'S19', target: '[data-testid=ctx-customer]', title: 'Previewing as: pick a customer',
    text: 'The studio shows the document for one made-up customer at a time, chosen with “Previewing as” in the top bar. Switch customers to see wording and sections change. Use it whenever you want to know what a particular kind of customer would receive.' },
  { id: 'design', screen: 'S02', target: '[data-testid=section-tabs]', title: 'Design: layout and wording',
    text: 'Design, in the left menu, is where you build the document: its layout, its wording and translations, and the email and text message. Its screens are the tabs in this row, and every stage in the menu with more than one screen has a row like it. Use it when you want to change how the document looks or what it says.' },
  { id: 'rules-data', screen: 'S07', target: '[data-testid=nav-section-rules-data]', title: 'Rules & data: who sees what',
    text: 'Rules & data in the menu is where you decide who sees what, for example “when missed payments is at least 2, show the payment support message”. It is also where you manage the customers you test with. Use it when different customers should get different messages.' },
  { id: 'explore', screen: 'S03', target: '[data-testid=nav-section-explore]', title: 'Explore: every angle',
    text: 'Explore shows the same document from different angles: every alternative of a section, a cube of outcomes, groups of customers and the real pages. Use it to understand what customers will get, rather than to change anything.' },
  { id: 'check', screen: 'S17', target: '[data-testid=nav-section-check]', title: 'Check: before it goes out',
    text: 'Check lists what stops this document being issued (blockers), runs the checks, and shows the real PDF, web page, email and text message. Use it before you ask for approval, and whenever Overview says something needs attention.' },
  { id: 'releases', screen: 'S18', target: '[data-testid=nav-section-releases]', title: 'Releases: approved versions',
    text: 'Releases holds the approved, frozen versions of the document. Approving makes a numbered release that goes to Test first and then to Production. Use it to hand a version over, and to compare it with another.' },
  { id: 'assistant', screen: 'S18', target: '[data-testid=assist-open]', title: 'Ask AI: help on any screen',
    text: 'The Ask AI button, at the top right of each screen, opens the assistant beside what you are doing. Ask why a customer got a message, or describe a change in words. It only proposes: nothing changes until you approve it.' },
  { id: 'help', screen: 'S14', target: '[data-testid=nav-section-help]', title: 'Help & activity',
    text: 'Help & activity holds the guided demo of the sample documents, the assistant and the activity log of who changed what. For help on the screen you are on, press ? or open “Settings and help” at the top right. You can take this tour again from there.' },
];

/* -------------------------------------------------------------------------------- remembered in local storage */
const OFFERED_KEY = 'iss.tour.offered';
const LEGACY_DONE_KEY = 'iss.tour.done';
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable: the offer is then made on every visit */ } };
const wasOffered = () => read(OFFERED_KEY) !== null || read(LEGACY_DONE_KEY) !== null;
const markOffered = () => write(OFFERED_KEY, '1');

/** Put keyboard focus somewhere sensible when the thing that had it has gone: the main area. */
function focusMain() {
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

/* -------------------------------------------------------------------------------- placement */
interface Box { left: number; top: number; width: number; height: number }
const MARGIN = 12;
const GAP = 14;

const overlap = (a: Box, b: Box) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

/** Where the card goes: beside the highlighted element without covering it when the window allows, always inside the window. */
export function placeCard(target: Box | null, cw: number, ch: number, vw: number, vh: number): { left: number; top: number } {
  const clampX = (x: number) => Math.max(MARGIN, Math.min(x, vw - cw - MARGIN));
  const clampY = (y: number) => Math.max(MARGIN, Math.min(y, vh - ch - MARGIN));
  if (!target) return { left: clampX((vw - cw) / 2), top: clampY((vh - ch) / 3) };
  const inLeftRail = target.left + target.width < 320 && target.height < vh * 0.7;
  const below = { left: clampX(target.left), top: target.top + target.height + GAP };
  const above = { left: clampX(target.left), top: target.top - ch - GAP };
  const right = { left: target.left + target.width + GAP, top: clampY(target.top) };
  const left = { left: target.left - cw - GAP, top: clampY(target.top) };
  const order = inLeftRail ? [right, below, above, left] : [below, above, right, left];
  const fits = (p: { left: number; top: number }) => p.left >= MARGIN && p.top >= MARGIN && p.left + cw <= vw - MARGIN && p.top + ch <= vh - MARGIN && !overlap({ ...p, width: cw, height: ch }, target);
  const chosen = order.find(fits);
  if (chosen) return chosen;
  // Nothing clear: the bottom corner farthest from the target's centre, so as little as possible is covered.
  const cx = target.left + target.width / 2;
  return { left: clampX(cx > vw / 2 ? MARGIN : vw - cw - MARGIN), top: clampY(vh - ch - MARGIN) };
}

const visibleBox = (el: HTMLElement | null): Box | null => {
  if (!el || !el.getClientRects().length) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

/* -------------------------------------------------------------------------------- the tour */

export function Tour() {
  const open = useShellUi((s) => s.tourOpen);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [found, setFound] = useState(false);
  const [late, setLate] = useState(false);
  const [card, setCard] = useState<{ left: number; top: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const step = open ? TOUR_STEPS[i] : undefined;

  const close = useCallback(() => {
    useShellUi.getState().setTour(false);
    const o = opener.current;
    opener.current = null;
    // Return focus to what had it, or to the main area when that has gone (for example the offer's own button).
    window.setTimeout(() => { if (o && o.isConnected && o !== document.body) o.focus({ preventScroll: true }); else focusMain(); }, 0);
  }, []);

  // Opening: remember who had focus and start from the first step.
  useEffect(() => {
    setI(0); setBox(null); setFound(false); setCard(null); setLate(false);
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    write(OFFERED_KEY, '1');
  }, [open]);

  // Say so only if a target is still missing after a moment: a screen needs a little time to draw itself.
  useEffect(() => {
    setLate(false);
    if (!step) return;
    const t = window.setTimeout(() => setLate(true), 2500);
    return () => window.clearTimeout(t);
  }, [step?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each step: be on the right screen (the project's own address), then keep measuring the target until the screen has drawn it.
  useEffect(() => {
    if (!step) return;
    const st = useStudio.getState();
    const pid = st.project?.projectId ?? st.projects[0]?.projectId ?? 'aster-card-demo';
    const wanted = SCREENS.find((s) => s.id === step.screen)!;
    const here = screenOfPath(pathname);
    const inThisProject = pathname.startsWith(`/studio/${pid}/`);
    if (here?.id !== wanted.id || !inThisProject) navigate(screenTo(wanted, st.project, null, pid));
  }, [step?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!step) return;
    let scrolled = false;
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const onScreen = screenOfPath(window.location.pathname)?.id === step.screen;
      const el = onScreen ? document.querySelector<HTMLElement>(step.target) : null;
      let b = visibleBox(el);
      if (el && b && !scrolled) {
        scrolled = true;
        if (b.top < 0 || b.top + Math.min(b.height, 80) > window.innerHeight) { el.scrollIntoView({ block: 'center', inline: 'nearest' }); b = visibleBox(el); }
      }
      setFound(!!b);
      setBox((old) => (old && b && old.left === b.left && old.top === b.top && old.width === b.width && old.height === b.height ? old : b));
    };
    measure();
    const t = window.setInterval(measure, 200);
    window.addEventListener('resize', measure);
    return () => { alive = false; window.clearInterval(t); window.removeEventListener('resize', measure); };
  }, [step?.id, open, pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!step) return;
    const c = cardRef.current;
    const next = placeCard(box, c?.offsetWidth ?? 360, c?.offsetHeight ?? 220, window.innerWidth, window.innerHeight);
    setCard((old) => (old && old.left === next.left && old.top === next.top ? old : next));
  }, [box, step?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the step (the card is a labelled dialog) when it changes, and once more when its target has appeared.
  useEffect(() => { if (step) cardRef.current?.focus({ preventScroll: true }); }, [step?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab' || !cardRef.current) return;
      // Keep Tab inside the step: the page behind it is not part of the tour.
      const els = Array.from(cardRef.current.querySelectorAll<HTMLElement>('button:not([disabled])'));
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1], a = document.activeElement;
      if (!cardRef.current.contains(a) || a === cardRef.current) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  if (!open || !step) return null;
  const last = i === TOUR_STEPS.length - 1;
  const pad = 5;
  const hole = box ? { left: Math.max(0, box.left - pad), top: Math.max(0, box.top - pad), width: box.width + pad * 2, height: box.height + pad * 2 } : null;
  return (
    <>
      {hole
        ? <div className="iss-tour-spot" aria-hidden="true" data-testid="tour-spot" style={{ left: hole.left, top: hole.top, width: hole.width, height: hole.height }} />
        : <div className="iss-tour-dim" aria-hidden="true" />}
      <div className="iss-tour-card" ref={cardRef} tabIndex={-1} role="dialog" aria-label={`Tour, step ${i + 1} of ${TOUR_STEPS.length}: ${step.title}`}
        data-testid="tour" data-step={step.id} data-target-found={found ? 'true' : 'false'}
        style={card ? { left: card.left, top: card.top } : { visibility: 'hidden', left: 0, top: 0 }}>
        <div className="iss-tour-count" data-testid="tour-count">Step {i + 1} of {TOUR_STEPS.length}</div>
        <h2 className="iss-tour-title">{step.title}</h2>
        <p className="iss-tour-text">{step.text}</p>
        {!found && late && <p className="iss-tour-missing" role="status">The part this step points at is not showing right now, but the text above still applies.</p>}
        <div className="iss-tour-actions">
          <button type="button" className="btn ghost sm" onClick={close} data-testid="tour-skip">Skip tour</button>
          <span className="iss-tour-spacer" />
          <button type="button" className="btn sm" onClick={() => setI(i - 1)} disabled={i === 0} data-testid="tour-back">Back</button>
          <button type="button" className="btn primary sm" onClick={() => (last ? close() : setI(i + 1))} data-testid="tour-next">{last ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </>
  );
}
