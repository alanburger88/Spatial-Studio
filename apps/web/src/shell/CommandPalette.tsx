import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { CATALOG_BY_TYPE } from '@iss/model';
import { useStudio } from '../state/store';
import { useDemo } from '../demo/demo';
import { ruleTitle } from '../ui/plain';
import { Icon } from '../ui/icons';
import { recordSummary } from './RecordPicker';
import { SCREENS } from './Shell';
import { useDrawers } from './History';

/** Tiny UI-only store for the overlays owned by the shell (palette, shortcuts sheet, tour). */
interface ShellUi {
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  tourOpen: boolean;
  setPalette(v: boolean): void;
  setShortcuts(v: boolean): void;
  setTour(v: boolean): void;
}
export const useShellUi = create<ShellUi>((set) => ({
  paletteOpen: false, shortcutsOpen: false, tourOpen: false,
  setPalette: (v) => set({ paletteOpen: v, ...(v ? { shortcutsOpen: false } : {}) }),
  setShortcuts: (v) => set({ shortcutsOpen: v, ...(v ? { paletteOpen: false } : {}) }),
  setTour: (v) => set({ tourOpen: v }),
}));

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Modal behaviour: trap Tab inside the container, Esc closes, focus returns to the opener. */
export function useModal(open: boolean, onClose: () => void, ref: RefObject<HTMLElement>) {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const els = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!els.length) { e.preventDefault(); return; }
      const first = els[0], last = els[els.length - 1], a = document.activeElement;
      if (!ref.current.contains(a)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener && document.contains(opener)) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

type Kind = 'view' | 'component' | 'rule' | 'customer' | 'project' | 'action';
interface Item { kind: Kind; id: string; label: string; sub?: string; tag?: string; hint?: string; haystack: string; run: () => void }

const GROUPS: Array<{ kind: Kind; title: string; cap: number }> = [
  { kind: 'view', title: 'Views', cap: 12 },
  { kind: 'action', title: 'Actions', cap: 12 },
  { kind: 'component', title: 'Components', cap: 6 },
  { kind: 'rule', title: 'Rules', cap: 6 },
  { kind: 'customer', title: 'Customers', cap: 6 },
  { kind: 'project', title: 'Projects', cap: 8 },
];

function score(it: Item, tokens: string[]): number {
  if (!tokens.length) return 0;
  const label = it.label.toLowerCase();
  const words = `${label} ${(it.tag ?? '').toLowerCase()} ${it.id.toLowerCase()}`.split(/[\s\-_/·]+/);
  let total = 0;
  for (const t of tokens) {
    if (!it.haystack.includes(t)) return -1;
    total += label.startsWith(t) ? 0 : words.some((w) => w.startsWith(t)) ? 1 : 2;
  }
  return total;
}

export function CommandPalette() {
  const open = useShellUi((s) => s.paletteOpen);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const project = useStudio((s) => s.project);
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  const projects = useStudio((s) => s.projects);
  const theme = useStudio((s) => s.theme);
  const viewMode = useStudio((s) => s.viewMode);
  const past = useStudio((s) => s.past.length);
  const future = useStudio((s) => s.future.length);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => useShellUi.getState().setPalette(false);
  useModal(open, close, boxRef);
  useEffect(() => { if (open) { setQ(''); setActive(0); } }, [open]);

  const inStudio = pathname.startsWith('/studio/') && !!project;

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const st = useStudio.getState();
    const out: Item[] = [];
    const go = (to: string) => () => { navigate(to); };
    const pid = project?.projectId;
    const sel = st.ctx.selectedNodeId;
    for (const s of SCREENS) {
      if (s.path !== '/projects' && !(inStudio && pid)) continue;
      const to = s.path.startsWith('/') ? s.path : `/studio/${pid}/${s.path}${s.path === 'exploded' ? `/${sel ?? project?.nodes.find((n) => n.type === 'variant-set')?.id ?? 'payment-guidance'}` : ''}`;
      const idx = SCREENS.indexOf(s);
      out.push({ kind: 'view', id: s.id, label: s.label, tag: s.id, hint: inStudio && idx >= 1 && idx <= 9 ? `Alt+${idx}` : undefined, haystack: `${s.label} ${s.id} view go to`.toLowerCase(), run: go(to) });
    }
    if (inStudio && project && pid) {
      for (const n of project.nodes) {
        const type = CATALOG_BY_TYPE[n.type]?.label ?? n.type;
        out.push({ kind: 'component', id: n.id, label: n.name ?? n.id, sub: type, tag: n.id, haystack: `${n.name ?? ''} ${n.id} ${type}`.toLowerCase(), run: () => { useStudio.getState().select(n.id); navigate(`/studio/${pid}/design`); } });
      }
      for (const r of project.rules) {
        const title = ruleTitle(project, r);
        out.push({ kind: 'rule', id: r.id, label: title, tag: r.id, haystack: `${title} ${r.id}`.toLowerCase(), run: go(`/studio/${pid}/rules-data?rule=${encodeURIComponent(r.id)}`) });
      }
      for (const r of records.filter((x) => x.documentType === project.documentType)) {
        const s = recordSummary(r, personas);
        out.push({ kind: 'customer', id: r.recordId, label: s.name, sub: [s.tag, s.locale].filter(Boolean).join(' · '), tag: r.recordId, haystack: `${s.name} ${s.tag ?? ''} ${r.recordId} ${s.locale}`.toLowerCase(), run: () => useStudio.getState().setRecord(r.recordId) });
      }
    }
    for (const p of projects) out.push({ kind: 'project', id: p.projectId, label: p.title, tag: p.projectId, haystack: `${p.title} ${p.projectId}`.toLowerCase(), run: go(`/studio/${p.projectId}/design`) });
    const act = (id: string, label: string, run: () => void, hint?: string, kw = '') => out.push({ kind: 'action', id, label, hint, haystack: `${label} ${kw}`.toLowerCase(), run });
    act('theme', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme', () => st.setTheme(theme === 'light' ? 'dark' : 'light'), undefined, 'toggle light dark theme appearance');
    act('view-mode', viewMode === 'business' ? 'Switch to Technical view' : 'Switch to Business view', () => st.setViewMode(viewMode === 'business' ? 'technical' : 'business'), undefined, 'business technical detail level');
    if (inStudio) {
      act('save', 'Save project', () => { void st.save(); }, 'Ctrl+S');
      if (past) act('undo', 'Undo', () => st.undo(), 'Ctrl+Z');
      if (future) act('redo', 'Redo', () => st.redo(), 'Ctrl+Y');
      act('history', 'Open version history', () => useDrawers.getState().show('history'), undefined, 'versions compare restore diff changes saved');
      act('review', 'Open review & approval', () => useDrawers.getState().show('review'), undefined, 'workflow submit approve publish comments status');
    }
    act('activity', 'Open activity log', () => navigate(inStudio && pid ? `/studio/${pid}/activity` : '/activity'), undefined, 'audit log who changed what when');
    act('shortcuts', 'Open keyboard shortcuts', () => useShellUi.getState().setShortcuts(true), '?', 'help keys');
    act('tour', 'Take the tour', () => useShellUi.getState().setTour(true), undefined, 'help onboarding walkthrough');
    act('demo', 'Start guided demo', () => { void useDemo.getState().start((to: string) => navigate(to)); }, undefined, 'walkthrough narrative');
    return out;
  }, [open, inStudio, project, records, personas, projects, theme, viewMode, past, future, navigate]);

  const { groups, flat, hidden } = useMemo(() => {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const groups: Array<{ kind: Kind; title: string; items: Item[] }> = [];
    let hidden = 0;
    for (const g of GROUPS) {
      const ranked = items.filter((i) => i.kind === g.kind)
        .map((i, n) => ({ i, s: score(i, tokens), n })).filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s || a.n - b.n);
      const shown = ranked.slice(0, tokens.length ? g.cap + 4 : g.cap).map((x) => x.i);
      hidden += ranked.length - shown.length;
      if (shown.length) groups.push({ kind: g.kind, title: g.title, items: shown });
    }
    return { groups, flat: groups.flatMap((g) => g.items), hidden };
  }, [items, q]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active, flat]);

  if (!open) return null;
  const choose = (it: Item | undefined) => { if (!it) return; close(); it.run(); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (flat.length ? (a + 1) % flat.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0)); }
    else if (e.key === 'Home' && !q) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && !q) { e.preventDefault(); setActive(Math.max(0, flat.length - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(flat[active]); }
  };
  const activeItem = flat[active];
  const optId = (it: Item) => `pal-${it.kind}-${it.id}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return (
    <div className="dialog-backdrop pal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="pal" role="dialog" aria-modal="true" aria-label="Command palette" data-testid="command-palette" ref={boxRef}>
        <div className="pal-search">
          <Icon.search />
          <input data-testid="palette-input" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" aria-activedescendant={activeItem ? optId(activeItem) : undefined}
            aria-label="Search views, components, rules, customers, projects and actions" placeholder={inStudio ? 'Search views, components, rules, customers, actions…' : 'Search projects, views and actions…'}
            value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} autoFocus autoComplete="off" spellCheck={false} />
          <kbd className="kbd">Esc</kbd>
        </div>
        <div className="pal-list" id="pal-list" role="listbox" aria-label="Results" ref={listRef}>
          {!flat.length && <div className="pal-empty" role="status">No matches for “{q}”.</div>}
          {groups.map((g) => (
            <div key={g.kind} role="group" aria-labelledby={`pal-h-${g.kind}`}>
              <div className="pal-head" id={`pal-h-${g.kind}`} role="presentation">{g.title}</div>
              {g.items.map((it) => {
                const idx = flat.indexOf(it);
                return (
                  <div key={it.id} id={optId(it)} role="option" aria-selected={idx === active} className={`pal-opt${idx === active ? ' active' : ''}`} data-testid={`palette-option-${it.kind}-${it.id}`}
                    onMouseMove={() => idx !== active && setActive(idx)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(it)}>
                    <span className="pal-label">{it.label}</span>
                    {it.sub && <span className="pal-sub">{it.sub}</span>}
                    {it.tag && it.tag !== it.label && <span className="pal-tag">{it.tag}</span>}
                    {it.hint && <kbd className="kbd">{it.hint}</kbd>}
                  </div>
                );
              })}
            </div>
          ))}
          {hidden > 0 && <div className="pal-more" aria-hidden="true">{hidden} more — keep typing to narrow</div>}
        </div>
        <div className="pal-foot" aria-hidden="true"><span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> move</span><span><kbd className="kbd">Enter</kbd> open</span><span><kbd className="kbd">Esc</kbd> close</span></div>
      </div>
    </div>
  );
}
