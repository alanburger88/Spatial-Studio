import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useStudio } from '../state/store';
import { useShellUi } from './CommandPalette';
import { startTour } from './TourPrompt';
import '../help/help.css';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

/** Settings menu in the top bar: detail level, theme, tour, shortcuts and help in one place. */
export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  const [hasAbout, setHasAbout] = useState(false);
  const viewMode = useStudio((s) => s.viewMode);
  const theme = useStudio((s) => s.theme);
  const { setViewMode, setTheme } = useStudio.getState();
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    setHasAbout(!!document.querySelector('.screen-about > summary'));
    wrap.current?.querySelector<HTMLElement>('[aria-pressed=true], [role=menuitem]')?.focus();
    const down = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(wrap.current?.querySelectorAll<HTMLButtonElement>('.settings-menu button:not(:disabled)') ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  // Focus goes back to the button first, so whatever the item opens (help, the tour) returns focus there when it closes.
  const pick = (fn: () => void) => () => { setOpen(false); btn.current?.focus(); fn(); };
  const about = () => {
    const d = document.querySelector<HTMLDetailsElement>('.screen-about');
    if (!d) return;
    d.open = true;
    d.querySelector<HTMLElement>('summary')?.focus();
  };
  return (
    <div className="help-wrap" ref={wrap} onKeyDown={onKey}>
      <button ref={btn} type="button" className="btn ghost icon" aria-label="Settings and help" aria-haspopup="true" aria-expanded={open} title="Settings and help" data-testid="open-settings" data-view={viewMode} onClick={() => setOpen((o) => !o)}><SettingsIcon /></button>
      {open && (
        <div className="help-menu settings-menu" role="group" aria-label="Settings and help" data-testid="settings-menu">
          <div className="set-row">
            <span className="set-lbl" id="set-view">Detail</span>
            <div className="seg" role="group" aria-labelledby="set-view">
              <button type="button" aria-pressed={viewMode === 'business'} onClick={() => setViewMode('business')} data-testid="view-business" title="Plain language; technical proof is tucked away">Business</button>
              <button type="button" aria-pressed={viewMode === 'technical'} onClick={() => setViewMode('technical')} data-testid="view-technical" title="Show IDs, hashes and raw rule expressions">Technical</button>
            </div>
          </div>
          <p className="set-note">{viewMode === 'business' ? 'Plain language. Codes and proof are one click away.' : 'Shows IDs, hashes and raw rule expressions.'}</p>
          <div className="set-row">
            <span className="set-lbl" id="set-theme">Theme</span>
            <div className="seg" role="group" aria-labelledby="set-theme">
              <button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')} data-testid="theme-light">Light</button>
              <button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')} data-testid="theme-dark">Dark</button>
            </div>
          </div>
          <div className="set-sep" role="separator" />
          <button type="button" role="menuitem" onClick={pick(() => useShellUi.getState().setShortcuts(true))} data-testid="open-help">Help for this screen <kbd className="kbd">?</kbd></button>
          <button type="button" role="menuitem" onClick={pick(startTour)} data-testid="menu-take-tour">Take the tour</button>
          <button type="button" role="menuitem" onClick={pick(() => useShellUi.getState().setShortcuts(true))}>Keyboard shortcuts</button>
          <button type="button" role="menuitem" disabled={!hasAbout} onClick={pick(about)}>About this screen</button>
        </div>
      )}
    </div>
  );
}

const SettingsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
);

