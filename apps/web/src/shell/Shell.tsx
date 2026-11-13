import { useEffect, useRef, useState, type ReactNode, type SVGProps } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { create } from 'zustand';
import { ROLE_LABEL, languageName, languageShortName, projectLanguages, type ProfileId } from '@iss/model';
import { editBlockedReason, personaLabel, setPreviewLanguage, useIsDirty, useModelChecks, usePreviewLanguage, useRecord, useResolution, useStudio } from '../state/store';
import { RecordPicker, recordSummary } from './RecordPicker';
import { NoCustomers } from './NoCustomers';
import { Icon } from '../ui/icons';
import { BrandLogo } from '../ui/Brand';
import { Biz, ErrorState, Loading, Named, Tech, Toasts } from '../ui/common';
import { nodeTitle } from '../ui/plain';
import { DemoBanner } from '../screens/GuidedDemo';
import { CommandPalette, useShellUi } from './CommandPalette';
import { MOD, SettingsMenu, ShortcutsSheet, Tour } from './Help';
import { DemoToolsButton, DemoToolsPanel } from './DemoTools';
import { AssistPanel } from '../assist/AssistPanel';
import { HistoryPanel, useDrawers } from './History';
import { ReviewPanel, WorkflowChip } from './Review';
import './shell-extras.css';
import './collab.css';

/** Activity (audit log) nav icon: a pulse line. */
const ActivityIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d="M3 12h4l3-7 4 14 3-7h4" /></svg>
);

export const SCREENS = [
  { id: 'S01', path: '/projects', label: 'Project Gallery', icon: Icon.gallery, group: 'home', hint: 'All projects and samples' },
  { id: 'S02', path: 'design', label: 'Design Studio', icon: Icon.design, group: 'build', hint: 'Lay out the document and edit its content' },
  { id: 'S03', path: 'exploded', label: 'Exploded Document', icon: Icon.exploded, group: 'explore', hint: 'See every alternative message a component can show, and why' },
  { id: 'S04', path: 'cube', label: 'Document Cube', icon: Icon.cube, group: 'explore', hint: 'Compare outcomes across customer types, outputs and journey stages' },
  { id: 'S05', path: 'landscape', label: 'Scenario Landscape', icon: Icon.landscape, group: 'explore', hint: 'Which outcomes customers get, and where the problems are' },
  { id: 'S06', path: 'page-stack', label: 'Page Composition Stack', icon: Icon.stack, group: 'explore', hint: 'How the content flows across printed pages' },
  { id: 'S07', path: 'rules-data', label: 'Rules & Data', icon: Icon.rules, group: 'build', hint: 'Decide who sees what, and test it' },
  { id: 'S08', path: 'journey', label: 'Journey Simulator', icon: Icon.journey, group: 'explore', hint: 'Step a customer through events over time' },
  { id: 'S09', path: 'validate', label: 'Validate & Compare', icon: Icon.validate, group: 'check', hint: 'Check the document for problems before it goes out' },
  { id: 'S10', path: 'outputs', label: 'Preview & Export', icon: Icon.outputs, group: 'check', hint: 'See and download the PDF, web page, email and SMS' },
  { id: 'S11', path: 'demo', label: 'Guided Demo', icon: Icon.demo, group: 'help', hint: 'A narrated walkthrough of the studio' },
  { id: 'S12', path: 'assistant', label: 'AI Assistant', icon: Icon.ai, group: 'help', hint: 'Ask questions and get proposed edits to approve' },
  { id: 'S13', path: 'content', label: 'Content & Translations', icon: Icon.list, group: 'build', hint: 'Manage wording and approved translations' },
  { id: 'S14', path: 'activity', label: 'Activity', icon: ActivityIcon, group: 'help', hint: 'Who changed what, and when' },
  { id: 'S15', path: 'channels', label: 'Email & SMS', icon: MailIcon, group: 'build', hint: 'Edit the email and text-message wording and choose what the email shows' },
  { id: 'S16', path: 'data', label: 'Data Explorer', icon: DataIcon, group: 'build', hint: 'See, edit, add and remove the customers this document is tested with' },
] as const;

/** Menu groups, in working order. Screen IDs and Alt+N shortcuts are unchanged; only the menu order is grouped. */
export const NAV_GROUPS = [
  { id: 'home', label: null, screens: ['S01'] },
  { id: 'build', label: 'Build', screens: ['S02', 'S07', 'S16', 'S13', 'S15'] },
  { id: 'explore', label: 'Explore', screens: ['S03', 'S04', 'S05', 'S06', 'S08'] },
  { id: 'check', label: 'Check & publish', screens: ['S09', 'S10'] },
  { id: 'help', label: 'Help & admin', screens: ['S11', 'S12', 'S14'] },
] as const;

function DataIcon(p: SVGProps<SVGSVGElement>) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}><path d="M5 5h5M5 5v14M5 11h5M5 19h5M10 5h9M13 11h6M13 19h6M10 11h0M10 19h0" /></svg>;
}

function MailIcon(p: SVGProps<SVGSVGElement>) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>;
}

/**
 * Top-bar language switch for the previewed document. "Customer's language" follows the customer's own preference;
 * any project language can be forced as a what-if (a scenario override, so every preview and export request follows it).
 */
function LanguageSelect() {
  const project = useStudio((s) => s.project);
  const record = useRecord();
  const res = useResolution();
  const forced = usePreviewLanguage();
  if (!project) return null;
  const langs = ['en-US', ...projectLanguages(project)];
  const own = (record?.customer?.locale as string | undefined) ?? 'en-US';
  const shown = res?.locale ?? own;
  const options = forced && !langs.includes(forced) ? [...langs, forced] : langs;
  // Short names keep the bar compact; the region is added only when two project languages share a name.
  const short = (l: string) => (options.filter((o) => languageShortName(o) === languageShortName(l)).length > 1 ? languageName(l) : languageShortName(l));
  return (
    <label className="ctx-field ctx-language" title={`The document is shown in ${languageName(shown)}. ${forced ? 'Switched for this preview only.' : 'Auto follows the language this customer prefers.'}`}>
      <span className="ctx-lbl">Language</span>
      <select className="select" aria-label="Document language" value={forced ?? ''} onChange={(e) => setPreviewLanguage(e.target.value || null)} data-testid="select-language" data-language={shown}>
        <option value="">{`Auto · ${languageShortName(own)}`}</option>
        {options.map((l) => <option key={l} value={l}>{short(l)}</option>)}
      </select>
    </label>
  );
}

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
        if (sc) { e.preventDefault(); navigate(sc.path.startsWith('/') ? sc.path : `/studio/${projectId}/${sc.path}${sc.path === 'exploded' ? `/${s.ctx.selectedNodeId ?? (s.project?.documentType === 'custom' ? '' : 'payment-guidance')}`.replace(/\/$/, '') : ''}`); }
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
  // A language switch has its own control in the bar; the chip is for every other what-if change.
  const hasOverrides = Object.keys(ctx.overrides).some((k) => k !== 'customer') || Object.keys((ctx.overrides as { customer?: Record<string, unknown> }).customer ?? {}).some((k) => k !== 'locale');
  // "Show me where" from the gallery: once the project and its picker exist, focus the picker and ring it briefly.
  const [params, setParams] = useSearchParams();
  const [spot, setSpot] = useState(false);
  const wantSpot = params.get('show') === 'customer';
  const pickerReady = !!project && records.length > 0;
  useEffect(() => {
    if (!wantSpot || !pickerReady) return;
    const el = document.querySelector<HTMLElement>('[data-testid=record-selector]');
    if (!el) return;
    el.focus();
    setSpot(true);
    const next = new URLSearchParams(params); next.delete('show');
    setParams(next, { replace: true });
    const t = window.setTimeout(() => setSpot(false), 6000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantSpot, pickerReady]);
  const docRecords = project ? records.filter((r) => r.documentType === project.documentType) : [];
  return (
    <header className="topbar">
      <Link to="/projects" className="brand" aria-label="InfoSlips Spatial Studio — project gallery">
        <span className="brand-wide"><BrandLogo height={30} /></span>
        <span className="brand-narrow"><BrandLogo variant="icon" height={30} /></span>
        <span className="brand-name">Spatial Studio</span>
      </Link>
      <span className="badge-synthetic" title="All customers, accounts, claims and organisations are fictional. AFP output is a simulation.">Synthetic<span className="badge-more"> data</span></span>
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
          <div className={`ctx-field${spot ? ' spot' : ''}`} data-testid="ctx-customer"><span className="ctx-lbl" id="ctx-lbl-customer">Previewing as</span><RecordPicker records={docRecords} personas={personas} value={ctx.recordId} onChange={setRecord} /></div>
          {hasOverrides && <span className="chip variant" title={JSON.stringify(ctx.overrides).slice(0, 300)}>Scenario overrides</span>}
          {ctx.journeyCursor !== null && <span className="chip info">Journey · event {ctx.journeyCursor + 1}</span>}
          <LanguageSelect />
          <label className="ctx-field"><span className="ctx-lbl">Output</span>
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
            <span className={`save-state${dirty ? ' dirty' : ''}`} data-testid="save-state" aria-live="polite"><span className="dot" />{dirty ? 'Unsaved' : 'Saved'}<span className="save-ver"> · v{project.modelVersion}</span></span>
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
        <SettingsMenu />
      </div>
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

/** Whether the person has collapsed the left menu to icons (remembered on this device). Narrow windows collapse it anyway. */
const NAV_KEY = 'iss.navCollapsed';
const readNavCollapsed = () => { try { return localStorage.getItem(NAV_KEY) === '1'; } catch { return false; } };
const useNavCollapsed = create<{ collapsed: boolean; toggle(): void }>((set, get) => ({
  collapsed: readNavCollapsed(),
  toggle() {
    const collapsed = !get().collapsed;
    try { localStorage.setItem(NAV_KEY, collapsed ? '1' : '0'); } catch { /* private mode: the choice lasts for this visit */ }
    set({ collapsed });
  },
}));
const shellClass = (collapsed: boolean) => `shell${collapsed ? ' nav-collapsed' : ''}`;

function Nav() {
  const collapsed = useNavCollapsed((s) => s.collapsed);
  const toggleNav = useNavCollapsed((s) => s.toggle);
  const project = useStudio((s) => s.project);
  const sel = useStudio((s) => s.ctx.selectedNodeId);
  const pid = project?.projectId ?? 'aster-card-demo';
  return (
    <nav className="nav" id="studio-nav" aria-label="Studio views">
      {NAV_GROUPS.map((g) => (
        <div className="nav-group" key={g.id} role="group" aria-label={g.label ?? 'Projects'}>
          {g.label && <div className="nav-title" aria-hidden="true"><span>{g.label}</span></div>}
          {g.screens.map((sid) => {
            const i = SCREENS.findIndex((x) => x.id === sid);
            const s = SCREENS[i];
            const to = s.path.startsWith('/') ? s.path : `/studio/${pid}/${s.path}${s.path === 'exploded' ? `/${sel ?? project?.nodes.find((n) => n.type === 'variant-set')?.id ?? (project?.documentType === 'custom' ? '' : 'payment-guidance')}`.replace(/\/$/, '') : ''}`;
            const Ico = s.icon;
            const key = i >= 1 && i <= 9 ? ` (Alt+${i})` : '';
            return (
              <NavLink key={s.id} to={to} className={({ isActive }) => (isActive || (s.path === 'exploded' && location.pathname.includes('/exploded/')) ? 'active' : '')} title={`${s.label} — ${s.hint}${key}`} data-testid={`nav-${s.id}`}>
                <Ico /><span>{s.label}</span>
              </NavLink>
            );
          })}
        </div>
      ))}
      <button type="button" className="nav-toggle" onClick={toggleNav} aria-expanded={!collapsed} aria-controls="studio-nav" title={collapsed ? 'Show the menu names' : 'Collapse the menu to icons for more room'} data-testid="nav-toggle">
        <Icon.chevron aria-hidden="true" /><span>{collapsed ? 'Expand menu' : 'Collapse menu'}</span>
      </button>
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
      <div className="dock-items">
      <span>Selected <strong data-testid="dock-selected" data-node-id={ctx.selectedNodeId ?? ''}>{ctx.selectedNodeId ? <Named name={nodeTitle(project, ctx.selectedNodeId)} code={ctx.selectedNodeId} /> : 'none'}</strong></span><span className="sep" />
      <span>Customer <strong>{recLabel?.name ?? ctx.recordId}</strong>{recLabel?.tag ? ` · ${recLabel.tag}` : ''}<Tech> · <span className="mono">{ctx.recordId}</span>{rec?.personaId ? ` · ${personaLabel(personas, rec.personaId).split(' · ')[0]}` : ''}</Tech></span><span className="sep" />
      <Tech><span>Run <strong className="mono">{res?.runId ?? '—'}</strong></span><span className="sep" /></Tech>
      <span title={matched.join(' ')}>Rules applied <strong>{matched.length ? <><Tech>{matched.join(' ')}</Tech><Biz>{matched.length}</Biz></> : '—'}</strong></span><span className="sep" />
      </div>
      <span className="dock-end">
        {(res?.translation.draftsShown.length ?? 0) > 0 && <Link to={`/studio/${project.projectId}/content`} className="dock-btn warn" data-testid="dock-drafts" title="This preview shows translations that are not approved yet. Exports use approved text only. Open Content & Translations to review them.">{res!.translation.draftsShown.length} unapproved translation{res!.translation.draftsShown.length === 1 ? '' : 's'} shown</Link>}
        <DemoToolsButton />
      </span>
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
  const records = useStudio((s) => s.records);
  useEffect(() => { if (projectsStatus === 'idle') useStudio.getState().loadProjects(); }, [projectsStatus]);
  useEffect(() => { if (projectId) useStudio.getState().openProject(projectId); }, [projectId]);
  const ready = project && project.projectId === projectId && status === 'ready';
  const recordsStatus = useStudio((s) => s.recordsStatus);
  const noCustomers = !!ready && project.documentType === 'custom' && recordsStatus === 'ready' && records.length === 0;
  const navCollapsed = useNavCollapsed((s) => s.collapsed);
  return (
    <div className={shellClass(navCollapsed)}>
      <TopBar />
      <Nav />
      <main className="main" id="main">
        {status === 'error' ? <ErrorState title="Project could not be loaded" message={error ?? ''} onRetry={() => projectId && useStudio.getState().openProject(projectId)} /> : ready ? (noCustomers ? <NoCustomers /> : children) : <Loading label="Loading project model…" />}
      </main>
      <Dock />
      <DemoBanner />
      <Toasts />
      <Overlays />
      {ready && <><HistoryPanel /><ReviewPanel /><DemoToolsPanel /><AssistPanel /></>}
      <SmallScreenNotice />
    </div>
  );
}

export function PlainShell({ children }: { children: ReactNode }) {
  useEffect(() => { useStudio.getState().loadProjects(); }, []);
  const navCollapsed = useNavCollapsed((s) => s.collapsed);
  return (
    <div className={shellClass(navCollapsed)}>
      <TopBar />
      <Nav />
      <main className="main" id="main">{children}</main>
      <footer className="dock">InfoSlips Spatial Studio · local proof of concept</footer>
      <Toasts />
      <Overlays />
      <SmallScreenNotice />
    </div>
  );
}

/** Below 900px the studio is not usable: say so plainly, and let the user carry on if they insist. */
function SmallScreenNotice() {
  const [small, setSmall] = useState(() => window.matchMedia('(max-width: 899px)').matches);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 899px)');
    const on = () => setSmall(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  if (!small || dismissed) return null;
  return (
    <div className="small-screen" role="alertdialog" aria-modal="true" aria-labelledby="small-screen-title" data-testid="small-screen-notice">
      <div className="small-screen-card">
        <h2 id="small-screen-title">This studio needs a wider window</h2>
        <p>InfoSlips Spatial Studio is designed for laptop and desktop screens. Widen this window to at least 900 pixels, or open it on a larger screen.</p>
        <button type="button" className="btn" onClick={() => setDismissed(true)} data-testid="small-screen-continue">Continue anyway</button>
      </div>
    </div>
  );
}
