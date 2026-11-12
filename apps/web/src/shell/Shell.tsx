import { useEffect, useRef, useState, type ReactNode, type SVGProps } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ROLE_LABEL, type ProfileId } from '@iss/model';
import { editBlockedReason, personaLabel, useIsDirty, useModelChecks, useResolution, useStudio } from '../state/store';
import { RecordPicker, recordSummary } from './RecordPicker';
import { BrandMark, Icon } from '../ui/icons';
import { Biz, ErrorState, Loading, Tech, Toasts } from '../ui/common';
import { DemoBanner } from '../screens/GuidedDemo';
import { CommandPalette, useShellUi } from './CommandPalette';
import { HelpMenu, MOD, ShortcutsSheet, Tour } from './Help';
import { HistoryPanel, useDrawers } from './History';
import { ReviewPanel, WorkflowChip } from './Review';
import './shell-extras.css';
import './collab.css';

/** Activity (audit log) nav icon: a pulse line. */
const ActivityIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d="M3 12h4l3-7 4 14 3-7h4" /></svg>
);

export const SCREENS = [
  { id: 'S01', path: '/projects', label: 'Project Gallery', icon: Icon.gallery },
  { id: 'S02', path: 'design', label: '2D Design Studio', icon: Icon.design },
  { id: 'S03', path: 'exploded', label: 'Exploded Document', icon: Icon.exploded },
  { id: 'S04', path: 'cube', label: 'Document Cube', icon: Icon.cube },
  { id: 'S05', path: 'landscape', label: 'Scenario Landscape', icon: Icon.landscape },
  { id: 'S06', path: 'page-stack', label: 'Page Composition Stack', icon: Icon.stack },
  { id: 'S07', path: 'rules-data', label: 'Rules & Data', icon: Icon.rules },
  { id: 'S08', path: 'journey', label: 'Journey Simulator', icon: Icon.journey },
  { id: 'S09', path: 'validate', label: 'Validate & Compare', icon: Icon.validate },
  { id: 'S10', path: 'outputs', label: 'Preview & Export', icon: Icon.outputs },
  { id: 'S11', path: 'demo', label: 'Guided Demo', icon: Icon.demo },
  { id: 'S12', path: 'assistant', label: 'AI Assistant', icon: Icon.ai },
  { id: 'S13', path: 'content', label: 'Content & Translations', icon: Icon.list },
  { id: 'S14', path: 'activity', label: 'Activity', icon: ActivityIcon },
] as const;

function isTyping(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function useGlobalShortcuts() {
  const navigate = useNavigate();
  const { project: projectId } = useParams();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStudio.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); s.save(); return; }
      if (isTyping(e.target)) return;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); s.undo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); s.redo(); }
      else if (e.altKey && /^[1-9]$/.test(e.key) && projectId) {
        const sc = SCREENS[Number(e.key)];
        if (sc) { e.preventDefault(); navigate(sc.path.startsWith('/') ? sc.path : `/studio/${projectId}/${sc.path}${sc.path === 'exploded' ? `/${s.ctx.selectedNodeId ?? 'payment-guidance'}` : ''}`); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, projectId]);
}

/** Ctrl/Cmd+K palette and ? shortcuts sheet; mounted once per shell (works on the gallery too). */
function useUiShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useShellUi.getState();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); ui.setPalette(!ui.paletteOpen); return; }
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target) && !ui.paletteOpen) { e.preventDefault(); ui.setShortcuts(!ui.shortcutsOpen); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function Overlays() {
  useUiShortcuts();
  return <><CommandPalette /><ShortcutsSheet /><Tour /></>;
}

function DisplayToggles() {
  const viewMode = useStudio((s) => s.viewMode);
  const theme = useStudio((s) => s.theme);
  const { setViewMode, setTheme } = useStudio.getState();
  return (
    <div className="row display-toggles" style={{ gap: 6 }}>
      <div className="seg" role="group" aria-label="Detail level">
        <button type="button" aria-pressed={viewMode === 'business'} onClick={() => setViewMode('business')} data-testid="view-business" title="Plain-language view: engine internals collapse behind Proof">Business</button>
        <button type="button" aria-pressed={viewMode === 'technical'} onClick={() => setViewMode('technical')} data-testid="view-technical" title="Show run IDs, hashes, raw rule expressions and JSON">Technical</button>
      </div>
      <button type="button" className="btn ghost icon" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'} title={theme === 'light' ? 'Dark theme' : 'Light theme'} data-testid="theme-toggle">
        {theme === 'light' ? <Icon.moon /> : <Icon.sun />}
      </button>
    </div>
  );
}

function TopBar() {
  const navigate = useNavigate();
  const projects = useStudio((s) => s.projects);
  const project = useStudio((s) => s.project);
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  const ctx = useStudio((s) => s.ctx);
  const past = useStudio((s) => s.past.length);
  const future = useStudio((s) => s.future.length);
  const saving = useStudio((s) => s.saving);
  const { undo, redo, save, setRecord, setProfile } = useStudio.getState();
  const dirty = useIsDirty();
  const session = useStudio((s) => s.session);
  const readOnly = editBlockedReason(session);
  const { pathname } = useLocation();
  const inStudio = pathname.startsWith('/studio/');
  const hasOverrides = Object.keys(ctx.overrides).length > 0;
  const docRecords = project ? records.filter((r) => r.documentType === project.documentType) : [];
  return (
    <header className="topbar">
      <Link to="/projects" className="brand" aria-label="InfoSlips Spatial Studio — project gallery">
        <span className="brand-mark"><BrandMark /></span>
        <span className="brand-logo" aria-hidden="true" />
        <span className="brand-name">InfoSlips <span>Spatial Studio</span></span>
      </Link>
      <span className="badge-synthetic" title="All customers, accounts, claims and organisations are fictional. AFP output is a simulation.">Synthetic data</span>
      {project && (
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/projects">Projects</Link><span aria-hidden="true">/</span>
          <label className="field-inline"><span className="lbl">Project</span>
            <select className="crumb-select" aria-label="Project" value={project.projectId} onChange={(e) => { const p = e.target.value; navigate(window.location.pathname.replace(`/studio/${project.projectId}`, `/studio/${p}`)); }} data-testid="project-switcher">
              {(projects.length ? projects : [{ projectId: project.projectId, title: project.title }]).map((p) => <option key={p.projectId} value={p.projectId}>{p.title}</option>)}
            </select>
          </label>
        </nav>
      )}
      <div className="spacer" />
      {project && (
        <div className="topbar-group">
          <RecordPicker records={docRecords} personas={personas} value={ctx.recordId} onChange={setRecord} />
          {hasOverrides && <span className="chip variant" title={JSON.stringify(ctx.overrides).slice(0, 300)}>Scenario overrides</span>}
          {ctx.journeyCursor !== null && <span className="chip info">Journey · event {ctx.journeyCursor + 1}</span>}
          <label className="field-inline"><span className="lbl">Output</span>
            <select className="select" aria-label="Output profile" value={ctx.profileId} onChange={(e) => setProfile(e.target.value as ProfileId)} data-testid="select-profile">
              <option value="paged-pdf">PDF</option>
              <option value="html-responsive">Interactive HTML</option>
              <option value="paged-afp-sim">AFP (simulated)</option>
            </select>
          </label>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn icon" onClick={undo} disabled={!past || !!readOnly} aria-label={`Undo (${past} available)`} title={readOnly ?? 'Undo (Ctrl+Z)'} data-testid="undo"><Icon.undo /></button>
            <button className="btn icon" onClick={redo} disabled={!future || !!readOnly} aria-label={`Redo (${future} available)`} title={readOnly ?? 'Redo (Ctrl+Y)'} data-testid="redo"><Icon.redo /></button>
            <button className={`btn${dirty ? ' primary' : ''}`} onClick={() => save()} disabled={saving || !!readOnly} data-testid="save-project" title={readOnly ?? 'Save (Ctrl+S)'}><Icon.save /> <span className="save-label">{saving ? 'Saving…' : 'Save'}</span></button>
          </div>
          <button type="button" className="save-state-btn" onClick={() => useDrawers.getState().show('history')} data-testid="open-history" aria-haspopup="dialog" title={`${dirty ? 'Unsaved changes' : 'Saved'} — open version history`}>
            <span className={`save-state${dirty ? ' dirty' : ''}`} data-testid="save-state" aria-live="polite"><span className="dot" />{dirty ? 'Unsaved' : 'Saved'} · v{project.modelVersion}</span>
          </button>
          <WorkflowChip />
          {readOnly && <span className="chip warning readonly-chip" title={`${readOnly}.`} data-testid="read-only"><Icon.lock width={13} height={13} /><span className="ro-text">Read-only</span></span>}
        </div>
      )}
      <div className="topbar-tools">
        {!inStudio && pathname !== '/activity' && <Link to="/activity" className="btn ghost sm" data-testid="open-activity" title="Activity: who changed what, when"><ActivityIcon width={16} height={16} /> Activity</Link>}
        <button type="button" className="btn ghost palette-btn" onClick={() => useShellUi.getState().setPalette(true)} aria-label="Search (Command palette)" aria-haspopup="dialog" title={`Search everything (${MOD}+K)`} data-testid="open-palette">
          <Icon.search /><span className="pal-btn-label">Search</span><kbd className="kbd">{MOD} K</kbd>
        </button>
        <HelpMenu />
      </div>
      <DisplayToggles />
      <UserChip />
    </header>
  );
}

/** Signed-in user + Sign out (only when AUTH=on; local mode shows nothing). Compact avatar that opens an account menu. */
function UserChip() {
  const session = useStudio((s) => s.session);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector<HTMLElement>('button')?.focus(); } };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  if (!session?.authEnabled || !session.user) return null;
  const u = session.user;
  const initials = u.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="userchip" ref={ref} data-testid="current-user" data-role={u.role}>
      <button type="button" className="user-avatar-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={`${u.name} · ${ROLE_LABEL[u.role]}`}>
        <span className="user-avatar" aria-hidden="true">{initials}</span>
        <span className="user-name"><strong>{u.name}</strong><span className="role-text">{ROLE_LABEL[u.role]}</span></span>
        <span className="sr-only">Account: {u.name}, {ROLE_LABEL[u.role]}</span>
      </button>
      {open && (
        <div className="user-menu" role="menu" aria-label="Account">
          <div className="user-menu-head"><strong>{u.name}</strong>{u.email && <span className="muted">{u.email}</span>}<span className="chip accent">{ROLE_LABEL[u.role]}</span></div>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); navigate('/activity'); }}>Activity{u.role === 'admin' ? ' & users' : ''}</button>
          <button type="button" role="menuitem" onClick={async () => { setOpen(false); await useStudio.getState().signOut(); navigate('/login'); }} data-testid="sign-out">Sign out</button>
        </div>
      )}
    </div>
  );
}

function Nav() {
  const project = useStudio((s) => s.project);
  const sel = useStudio((s) => s.ctx.selectedNodeId);
  const pid = project?.projectId ?? 'aster-card-demo';
  return (
    <nav className="nav" aria-label="Studio views">
      {SCREENS.map((s, i) => {
        const to = s.path.startsWith('/') ? s.path : `/studio/${pid}/${s.path}${s.path === 'exploded' ? `/${sel ?? project?.nodes.find((n) => n.type === 'variant-set')?.id ?? 'payment-guidance'}` : ''}`;
        const Ico = s.icon;
        const key = i >= 1 && i <= 9 ? ` (Alt+${i})` : '';
        return (
          <NavLink key={s.id} to={to} className={({ isActive }) => (isActive || (s.path === 'exploded' && location.pathname.includes('/exploded/')) ? 'active' : '')} title={`${s.label}${key}`} data-testid={`nav-${s.id}`}>
            <Ico /><span>{s.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

function Dock() {
  const project = useStudio((s) => s.project);
  const ctx = useStudio((s) => s.ctx);
  const personas = useStudio((s) => s.personas);
  const records = useStudio((s) => s.records);
  const lastValidation = useStudio((s) => s.lastValidation);
  const res = useResolution();
  const checks = useModelChecks();
  if (!project) return <footer className="dock">No project open</footer>;
  const rec = records.find((r) => r.recordId === ctx.recordId);
  const recLabel = rec ? recordSummary(rec, personas) : null;
  const validated = lastValidation && res && lastValidation.runId === res.runId ? lastValidation.counts : null;
  const blocking = validated ? validated.blocking ?? 0 : checks.blocking;
  const errors = validated ? validated.error ?? 0 : checks.errors;
  const warnings = validated ? validated.warning ?? 0 : checks.warnings;
  const scope = validated ? 'Full validation' : 'Rule & binding checks';
  const matched = res?.result.matchedRuleIds ?? [];
  return (
    <footer className="dock" aria-label="Scenario status">
      <span>Selected <strong data-testid="dock-selected">{ctx.selectedNodeId ?? 'none'}</strong></span><span className="sep" />
      <span>Customer <strong>{recLabel?.name ?? ctx.recordId}</strong>{recLabel?.tag ? ` · ${recLabel.tag}` : ''}<Tech> · <span className="mono">{ctx.recordId}</span>{rec?.personaId ? ` · ${personaLabel(personas, rec.personaId).split(' · ')[0]}` : ''}</Tech></span><span className="sep" />
      <Tech><span>Run <strong className="mono">{res?.runId ?? '—'}</strong></span><span className="sep" /></Tech>
      <span title={matched.join(' ')}>Rules applied <strong>{matched.length ? <><Tech>{matched.join(' ')}</Tech><Biz>{matched.length}</Biz></> : '—'}</strong></span><span className="sep" />
      <Link to={`/studio/${project.projectId}/validate`} className={`dock-status ${blocking || errors ? 'sev blocking' : warnings ? 'sev warning' : 'sev ok'}`} data-testid="dock-status" title={`${scope} for this scenario — open Validate & Compare`}>
        {scope}: {blocking ? `${blocking} blocking` : errors ? `${errors} errors` : warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : 'no issues'}
      </Link>
    </footer>
  );
}

/** Loads the project referenced in the URL; renders loading/error states; keeps selection when switching views. */
export function StudioShell({ children }: { children: ReactNode }) {
  useGlobalShortcuts();
  const { project: projectId } = useParams();
  const status = useStudio((s) => s.projectStatus);
  const error = useStudio((s) => s.projectError);
  const project = useStudio((s) => s.project);
  const projectsStatus = useStudio((s) => s.projectsStatus);
  useEffect(() => { if (projectsStatus === 'idle') useStudio.getState().loadProjects(); }, [projectsStatus]);
  useEffect(() => { if (projectId) useStudio.getState().openProject(projectId); }, [projectId]);
  const ready = project && project.projectId === projectId && status === 'ready';
  return (
    <div className="shell">
      <TopBar />
      <Nav />
      <main className="main" id="main">
        {status === 'error' ? <ErrorState title="Project could not be loaded" message={error ?? ''} onRetry={() => projectId && useStudio.getState().openProject(projectId)} /> : ready ? children : <Loading label="Loading project model…" />}
      </main>
      <Dock />
      <DemoBanner />
      <Toasts />
      <Overlays />
      {ready && <><HistoryPanel /><ReviewPanel /></>}
    </div>
  );
}

export function PlainShell({ children }: { children: ReactNode }) {
  useEffect(() => { useStudio.getState().loadProjects(); }, []);
  return (
    <div className="shell">
      <TopBar />
      <Nav />
      <main className="main" id="main">{children}</main>
      <footer className="dock">InfoSlips Spatial Studio · local proof of concept</footer>
      <Toasts />
      <Overlays />
    </div>
  );
}
