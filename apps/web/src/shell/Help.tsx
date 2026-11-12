import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useStudio } from '../state/store';
import { useModal, useShellUi } from './CommandPalette';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

const SHORTCUTS: Array<{ group: string; rows: Array<[string[], string]> }> = [
  { group: 'Anywhere', rows: [
    [[MOD, 'K'], 'Open search / command palette'],
    [['?'], 'Open this keyboard shortcuts sheet'],
    [['Esc'], 'Close the open dialog, palette or menu'],
    [[MOD, 'S'], 'Save the project'],
    [[MOD, 'Z'], 'Undo'],
    [[MOD, 'Y'], 'Redo (also Ctrl+Shift+Z)'],
    [['Alt', '1…9'], 'Jump to views 2D Design … Preview & Export (inside a project)'],
  ] },
  { group: '2D Design canvas (a component selected)', rows: [
    [['←', '↑', '→', '↓'], 'Nudge a fixed component (Shift = 10 pt)'],
    [['Alt', '↑ ↓'], 'Reorder a flowing component within its container'],
    [['Shift', '← →'], 'Narrow / widen the selected component by 5%'],
    [['Enter'], 'Edit the selected rich text'],
    [[MOD, 'D'], 'Duplicate the selected component'],
    [['Delete'], 'Delete the selected component'],
    [['Esc'], 'Clear the selection'],
  ] },
  { group: 'Lists and panels', rows: [
    [['↑', '↓'], 'Move through layers, rules and validation issues'],
    [['Home', 'End'], 'First / last validation issue'],
    [['←', '→'], 'Switch Preview & Export output tabs; move between exploded variant panels'],
  ] },
];

export function ShortcutsSheet() {
  const open = useShellUi((s) => s.shortcutsOpen);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => useShellUi.getState().setShortcuts(false);
  useModal(open, close, ref);
  useEffect(() => { if (open) ref.current?.querySelector<HTMLElement>('button')?.focus(); }, [open]);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog sc-sheet" role="dialog" aria-modal="true" aria-labelledby="sc-title" data-testid="shortcuts-sheet" ref={ref}>
        <header><span id="sc-title">Keyboard shortcuts</span><button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={close} aria-label="Close keyboard shortcuts">Close</button></header>
        <div className="body">
          {SHORTCUTS.map((g) => (
            <section key={g.group} className="sc-group" aria-label={g.group}>
              <h3>{g.group}</h3>
              <dl>
                {g.rows.map(([keys, what]) => (
                  <div className="sc-row" key={what}><dt>{keys.map((k, i) => <kbd className="kbd" key={i}>{k}</kbd>)}</dt><dd>{what}</dd></div>
                ))}
              </dl>
            </section>
          ))}
          <p className="muted sc-note">Single-letter shortcuts such as ? are ignored while you are typing in a field.</p>
        </div>
      </div>
    </div>
  );
}

/** The “?” help button + menu in the top bar. */
export function HelpMenu() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  const [hasAbout, setHasAbout] = useState(false);
  useEffect(() => {
    if (!open) return;
    setHasAbout(!!document.querySelector('.screen-about > summary'));
    wrap.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    const down = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open, pathname]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus(); return; }
    if (e.key === 'Tab') { setOpen(false); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(wrap.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };
  const about = () => {
    const d = document.querySelector<HTMLDetailsElement>('.screen-about');
    if (!d) return;
    d.open = true;
    d.querySelector<HTMLElement>('summary')?.focus();
  };
  return (
    <div className="help-wrap" ref={wrap} onKeyDown={onKey}>
      <button ref={btn} type="button" className="btn ghost icon help-btn" aria-label="Help" aria-haspopup="menu" aria-expanded={open} title="Help, tour and shortcuts" data-testid="open-help" onClick={() => setOpen((o) => !o)}>?</button>
      {open && (
        <div className="help-menu" role="menu" aria-label="Help" data-testid="help-menu">
          <button type="button" role="menuitem" onClick={pick(() => useShellUi.getState().setTour(true))}>Take the tour</button>
          <button type="button" role="menuitem" onClick={pick(() => useShellUi.getState().setShortcuts(true))}>Keyboard shortcuts <kbd className="kbd">?</kbd></button>
          <button type="button" role="menuitem" disabled={!hasAbout} onClick={pick(about)}>About this view</button>
          <div className="help-note" role="note">
            <strong>Business vs Technical view</strong>
            <p>Business view uses plain language and tucks run IDs, hashes and raw rule expressions behind “Proof”. Technical view shows them inline. Nothing is removed — only collapsed.</p>
          </div>
        </div>
      )}
    </div>
  );
}

interface Step { title: string; text: string; selector: string; closest?: string }
const STEPS: Step[] = [
  { title: 'Pick a customer', text: 'Every view shows the document for this customer. Switch customers to see rules change the content.', selector: '[data-testid=record-selector]' },
  { title: 'Choose the output', text: 'Preview the same model as PDF, interactive HTML or a simulated AFP stream.', selector: '[data-testid=select-profile]' },
  { title: 'Business or Technical', text: 'Business view speaks plainly; Technical adds run IDs, hashes and raw expressions.', selector: '[data-testid=view-business]', closest: '.seg' },
  { title: 'Move between views', text: 'The navigation lists the twelve views, from design to validation and export. Alt+1…9 jumps directly.', selector: 'nav.nav' },
  { title: 'About this view', text: 'The ⓘ button next to each title explains what the view is for.', selector: '.screen-about > summary' },
  { title: 'Search everything', text: `Press ${MOD}+K to jump to any view, component, rule, customer or action.`, selector: '[data-testid=open-palette]' },
];
const TOUR_KEY = 'iss.tour.done';
const markDone = () => { try { localStorage.setItem(TOUR_KEY, '1'); } catch { /* storage unavailable */ } };
const isDone = () => { try { return localStorage.getItem(TOUR_KEY) !== null; } catch { return true; } };
const anchorOf = (s: Step): HTMLElement | null => {
  const el = document.querySelector<HTMLElement>(s.selector);
  const t = el && s.closest ? el.closest<HTMLElement>(s.closest) ?? el : el;
  return t && t.getClientRects().length ? t : null;
};

export function Tour() {
  const open = useShellUi((s) => s.tourOpen);
  const [steps, setSteps] = useState<Step[]>([]);
  const [i, setI] = useState(0);
  const [pos, setPos] = useState<{ card: { left: number; top: number }; hole: { left: number; top: number; width: number; height: number } } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();

  // First run: wait for the anchors to render, never under automation, never twice.
  useEffect(() => {
    if (navigator.webdriver === true || isDone()) return;
    let tries = 0;
    const need = pathname.startsWith('/studio/') ? '[data-testid=select-profile]' : 'nav.nav';
    const t = window.setInterval(() => {
      tries += 1;
      if (document.querySelector(need) || tries > 12) { window.clearInterval(t); if (!isDone() && !useShellUi.getState().tourOpen) useShellUi.getState().setTour(true); }
    }, 500);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    const avail = STEPS.filter((s) => anchorOf(s));
    if (!avail.length) { useShellUi.getState().setTour(false); markDone(); return; }
    setSteps(avail); setI(0);
  }, [open]);

  const skip = () => { markDone(); useShellUi.getState().setTour(false); };
  const step = open ? steps[i] : undefined;

  useLayoutEffect(() => {
    if (!step) return;
    const place = () => {
      const a = anchorOf(step);
      if (!a) { setPos(null); return; }
      const r = a.getBoundingClientRect();
      const cw = Math.min(340, window.innerWidth - 24), ch = cardRef.current?.offsetHeight ?? 170;
      let top = r.bottom + 14, left = r.left;
      if (r.left < 120 && r.height > window.innerHeight * 0.5) { left = r.right + 14; top = r.top + 24; } // tall left rail: place beside it
      else if (top + ch > window.innerHeight - 12) top = Math.max(12, r.top - ch - 14);
      left = Math.max(12, Math.min(left, window.innerWidth - cw - 12));
      top = Math.max(12, Math.min(top, window.innerHeight - ch - 12));
      setPos({ card: { left, top }, hole: { left: r.left - 4, top: r.top - 4, width: r.width + 8, height: r.height + 8 } });
    };
    place();
    window.addEventListener('resize', place);
    const t = window.setTimeout(place, 120);
    return () => { window.removeEventListener('resize', place); window.clearTimeout(t); };
  }, [step, open]);

  useEffect(() => { if (step) nextRef.current?.focus({ preventScroll: true }); }, [step]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); skip(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (!open || !step) return null;
  const last = i === steps.length - 1;
  const next = () => { if (last) skip(); else setI(i + 1); };
  return (
    <>
      <div className="tour-spot" aria-hidden="true" style={pos ? { left: pos.hole.left, top: pos.hole.top, width: pos.hole.width, height: pos.hole.height } : { display: 'none' }} />
      <div className="tour-card" role="dialog" aria-label={`Tour: ${step.title}`} data-testid="tour" ref={cardRef} style={pos ? { left: pos.card.left, top: pos.card.top } : { visibility: 'hidden' }}>
        <div className="tour-count" aria-live="polite">Step {i + 1} of {steps.length}</div>
        <h2>{step.title}</h2>
        <p>{step.text}</p>
        <div className="tour-actions">
          <button type="button" className="btn ghost sm" onClick={skip} data-testid="tour-skip">Skip tour</button>
          <span className="spacer" />
          <button type="button" className="btn sm" onClick={() => setI(i - 1)} disabled={i === 0} aria-label="Previous step">Back</button>
          <button type="button" className="btn primary sm" onClick={next} ref={nextRef} data-testid="tour-next">{last ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </>
  );
}
