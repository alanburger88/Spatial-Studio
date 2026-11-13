import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useStudio } from '../state/store';
import { GLOSSARY, SCREEN_HELP, type GlossaryEntry, type ScreenHelp } from '../help/content';
import { useModal, useShellUi } from './CommandPalette';
import { SCREENS, SECTIONS, TAB_LABEL, screenOfPath, screenTo, sectionOf } from './Shell';
import { startTour } from './Tour';
import '../help/help.css';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

const SHORTCUTS: Array<{ group: string; rows: Array<[string[], string]> }> = [
  { group: 'Anywhere', rows: [
    [[MOD, 'K'], 'Open search / command palette'],
    [['?'], 'Open help for the screen you are on (this sheet)'],
    [['Esc'], 'Close the open dialog, palette or menu'],
    [[MOD, 'S'], 'Save the project'],
    [[MOD, 'Z'], 'Undo'],
    [[MOD, 'Y'], 'Redo (also Ctrl+Shift+Z)'],
    [['Alt', '1…8'], 'Open the 1st to 8th entry of the left menu, on the tab you last used there (inside a project)'],
  ] },
  { group: 'Design Studio canvas (a component selected)', rows: [
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

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Everything searchable about one screen, lower-cased. */
function haystack(id: string, h: ScreenHelp | undefined): string {
  const s = SCREENS.find((x) => x.id === id);
  const sec = sectionOf(id);
  return [s?.label, TAB_LABEL[id], sec?.label, s?.hint, h?.purpose, ...(h?.actions ?? []), ...(h?.next.map((n) => n.why) ?? []), ...(h?.read?.flatMap((r) => [r.what, r.means]) ?? []), h?.building].filter(Boolean).join(' ').toLowerCase();
}

function ScreenArticle({ id, current, onGo }: { id: string; current: boolean; onGo: () => void }) {
  const project = useStudio((s) => s.project);
  const s = SCREENS.find((x) => x.id === id);
  const help = SCREEN_HELP[id];
  const sec = sectionOf(id);
  if (!s) return null;
  const to = (sid: string): string | null => {
    const t = SCREENS.find((x) => x.id === sid);
    if (!t) return null;
    if (t.path.startsWith('/')) return t.path;
    return project ? screenTo(t, project, null, project.projectId) : null;
  };
  const here = to(id);
  return (
    <article className="help-article" aria-labelledby="help-article-h" data-testid="help-article" data-screen={id}>
      <p className="help-crumb">{sec?.label}{TAB_LABEL[id] && sec && sec.screens.length > 1 ? ` › ${TAB_LABEL[id]}` : ''}{current ? ' · you are here' : ''}</p>
      <h2 id="help-article-h" tabIndex={-1}>{s.label}</h2>
      {!help ? <p className="callout warning" data-testid="help-missing">Help for this screen has not been written yet.</p> : (
        <>
          <h3>What this screen is for</h3>
          <p>{help.purpose}</p>
          <h3>What you can do here</h3>
          <ul>{help.actions.map((a) => <li key={a}>{a}</li>)}</ul>
          {help.read && (
            <>
              <h3>How to read it</h3>
              <dl className="help-read">{help.read.map((r) => <div key={r.what}><dt>{r.what}</dt><dd>{r.means}</dd></div>)}</dl>
            </>
          )}
          {help.building && <p className="callout accent" data-testid="help-building">{help.building}</p>}
          <h3>Where to go next</h3>
          <ul className="help-next">
            {help.next.map((n) => {
              const t = SCREENS.find((x) => x.id === n.screen);
              const href = to(n.screen);
              return (
                <li key={n.screen}>
                  {href && t ? <Link to={href} onClick={onGo} data-testid={`help-next-${n.screen}`}>{t.label}</Link> : <strong>{t?.label}</strong>}
                  {' '}<span className="muted">to {n.why}{!href ? ' (open a document first)' : ''}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {!current && here && <p><Link className="btn sm" to={here} onClick={onGo} data-testid="help-open-screen">Go to {s.label}</Link></p>}
    </article>
  );
}

/** Help: opens on the screen you are on (the ? key, or Settings and help). A searchable list of every screen, the shortcuts and the studio's own words. */
export function HelpSheet() {
  const open = useShellUi((s) => s.shortcutsOpen);
  const { pathname } = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [topic, setTopic] = useState('S19');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState<string | null>(null);
  const hereId = screenOfPath(pathname)?.id ?? null;
  const close = () => useShellUi.getState().setShortcuts(false);
  useModal(open, close, ref);
  useEffect(() => {
    if (!open) return;
    setTopic(hereId ?? 'S01'); setQ(''); setTerm(null);
    searchRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const screens = useMemo(() => SECTIONS.map((sec) => ({
    sec,
    items: (sec.screens as readonly string[]).filter((id) => tokens.every((t) => haystack(id, SCREEN_HELP[id]).includes(t))),
  })).filter((g) => g.items.length > 0), [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const words = useMemo(() => GLOSSARY.filter((g: GlossaryEntry) => tokens.every((t) => `${g.term} ${g.means}`.toLowerCase().includes(t))), [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const nothing = tokens.length > 0 && screens.length === 0 && words.length === 0;

  if (!open) return null;
  const pick = (id: string) => { setTopic(id); setTerm(null); bodyRef.current?.scrollTo({ top: 0 }); window.setTimeout(() => document.getElementById('help-article-h')?.focus({ preventScroll: true }), 0); };
  const jump = (anchor: string, t: string | null = null) => { setTerm(t); document.getElementById(anchor)?.scrollIntoView({ block: 'start' }); document.getElementById(anchor)?.focus({ preventScroll: true }); };
  const startFromHelp = () => { close(); startTour(); };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" data-testid="help-sheet" ref={ref}>
        <header>
          <span id="help-title">Help</span>
          <button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={close} aria-label="Close help" data-testid="help-close">Close</button>
        </header>
        {/* The old shortcuts sheet's test ID stays on the whole body, so existing specs that press ? still find their shortcuts. */}
        <div className="help-layout" data-testid="shortcuts-sheet">
          <nav className="help-rail" aria-label="Help topics">
            <label className="help-search"><span className="sr-only">Search help</span>
              <input ref={searchRef} className="input" type="search" placeholder="Search help" value={q} onChange={(e) => setQ(e.target.value)} data-testid="help-search" autoComplete="off" />
            </label>
            <button type="button" className="btn primary sm help-tour" onClick={startFromHelp} data-testid="help-start-tour">Start the tour</button>
            <div className="help-jumps">
              <button type="button" className="btn ghost sm" onClick={() => jump('help-shortcuts')} data-testid="help-jump-shortcuts">Keyboard shortcuts</button>
              <button type="button" className="btn ghost sm" onClick={() => jump('help-glossary')} data-testid="help-jump-glossary">Words we use</button>
            </div>
            {nothing && <p className="muted" role="status" data-testid="help-nothing">Nothing matches “{q}”. Try a shorter word, such as “rule” or “release”.</p>}
            <div className="help-list" data-testid="help-list">
              {screens.map(({ sec, items }) => (
                <section key={sec.id} aria-label={sec.label} data-section={sec.id}>
                  <h3>{sec.label}</h3>
                  <ul>
                    {items.map((id) => {
                      const s = SCREENS.find((x) => x.id === id)!;
                      const sel = topic === id && !term;
                      return (
                        <li key={id}>
                          <button type="button" className={`help-item${sel ? ' selected' : ''}`} aria-current={sel ? 'true' : undefined} onClick={() => pick(id)} data-testid={`help-topic-${id}`} data-has-help={SCREEN_HELP[id] ? 'true' : 'false'}>
                            <span>{s.label}</span>{id === hereId && <span className="chip accent help-here">here</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
              {tokens.length > 0 && words.length > 0 && (
                <section aria-label="Words we use" data-section="words">
                  <h3>Words we use</h3>
                  <ul>{words.map((g) => <li key={g.term}><button type="button" className="help-item" onClick={() => jump(`help-term-${slug(g.term)}`, g.term)} data-testid={`help-word-${slug(g.term)}`}><span>{g.term}</span></button></li>)}</ul>
                </section>
              )}
            </div>
          </nav>
          <div className="help-main" ref={bodyRef}>
            <ScreenArticle id={topic} current={topic === hereId} onGo={close} />
            <section className="help-block sc-group" id="help-shortcuts" tabIndex={-1} aria-labelledby="help-sc-h" data-testid="help-shortcuts">
              <h2 id="help-sc-h">Keyboard shortcuts</h2>
              {SHORTCUTS.map((g) => (
                <section key={g.group} className="sc-group" aria-label={g.group}>
                  <h3>{g.group}</h3>
                  <dl>{g.rows.map(([keys, what]) => (
                    <div className="sc-row" key={what}><dt>{keys.map((k, i) => <kbd className="kbd" key={i}>{k}</kbd>)}</dt><dd>{what}</dd></div>
                  ))}</dl>
                </section>
              ))}
              <p className="muted sc-note">Single-letter shortcuts such as ? are ignored while you are typing in a field.</p>
            </section>
            <section className="help-block" id="help-glossary" tabIndex={-1} aria-labelledby="help-gl-h" data-testid="help-glossary">
              <h2 id="help-gl-h">Words we use</h2>
              <dl className="help-words">
                {GLOSSARY.map((g) => {
                  const id = `help-term-${slug(g.term)}`;
                  const t = g.screen ? SCREENS.find((x) => x.id === g.screen) : undefined;
                  return (
                    <div key={g.term} id={id} tabIndex={-1} className={term === g.term ? 'flash' : undefined} data-testid={id}>
                      <dt>{g.term}</dt>
                      <dd>{g.means}{t && <> <button type="button" className="help-linkbtn" onClick={() => pick(t.id)}>About {t.label}</button></>}</dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

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

