import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import type { ProfileId } from '@iss/model';
import { personaLabel, useIsDirty, useResolution, useStudio } from '../state/store';
import { BrandMark, Icon } from '../ui/icons';
import { ErrorState, Loading, Toasts } from '../ui/common';
import { DemoBanner } from '../screens/GuidedDemo';

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
  const hasOverrides = Object.keys(ctx.overrides).length > 0;
  const docRecords = project ? records.filter((r) => r.documentType === project.documentType) : [];
  return (
    <header className="topbar">
      <Link to="/projects" className="brand" aria-label="InfoSlips Spatial Studio — project gallery">
        <span className="brand-mark"><BrandMark /></span>
        <span className="brand-logo" aria-hidden="true" />
        <span className="brand-name">InfoSlips <span>Spatial Studio</span></span>
      </Link>
      <span className="badge-synthetic" title="All customers, accounts, claims and organisations are fictional">Synthetic data</span>
      <div className="spacer" />
      {project && (
        <div className="topbar-group">
          <label className="field-inline"><span className="lbl">Project</span>
            <select className="select" aria-label="Project" value={project.projectId} onChange={(e) => { const p = e.target.value; navigate(window.location.pathname.replace(`/studio/${project.projectId}`, `/studio/${p}`)); }} data-testid="project-switcher">
              {(projects.length ? projects : [{ projectId: project.projectId, title: project.title }]).map((p) => <option key={p.projectId} value={p.projectId}>{p.title}</option>)}
            </select>
          </label>
          <label className="field-inline"><span className="lbl">Record</span>
            <select className="select" aria-label="Synthetic record and persona" value={ctx.recordId} onChange={(e) => setRecord(e.target.value)} data-testid="record-selector" style={{ maxWidth: 250 }}>
              {docRecords.map((r) => <option key={r.recordId} value={r.recordId}>{r.recordId} · {r.customer.givenName} {r.customer.familyName}{r.personaId ? ` · ${personaLabel(personas, r.personaId).split(' · ')[1]}` : (r.claims?.[0] as any)?.status ? ` · ${(r.claims![0] as any).status}` : ''}</option>)}
            </select>
          </label>
          {hasOverrides && <span className="chip variant" title={JSON.stringify(ctx.overrides).slice(0, 300)}>Scenario overrides</span>}
          {ctx.journeyCursor !== null && <span className="chip info">Journey · event {ctx.journeyCursor + 1}</span>}
          <label className="field-inline"><span className="lbl">Output</span>
            <select className="select" aria-label="Output profile" value={ctx.profileId} onChange={(e) => setProfile(e.target.value as ProfileId)} data-testid="select-profile">
              <option value="paged-pdf">Paged · PDF</option>
              <option value="html-responsive">Interactive HTML</option>
              <option value="paged-afp-sim">AFP (simulation)</option>
            </select>
          </label>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn icon" onClick={undo} disabled={!past} aria-label={`Undo (${past} available)`} title="Undo (Ctrl+Z)" data-testid="undo"><Icon.undo /></button>
            <button className="btn icon" onClick={redo} disabled={!future} aria-label={`Redo (${future} available)`} title="Redo (Ctrl+Y)" data-testid="redo"><Icon.redo /></button>
            <button className={`btn${dirty ? ' primary' : ''}`} onClick={() => save()} disabled={saving} data-testid="save-project" title="Save (Ctrl+S)"><Icon.save /> {saving ? 'Saving…' : 'Save'}</button>
          </div>
          <span className={`save-state${dirty ? ' dirty' : ''}`} data-testid="save-state" aria-live="polite"><span className="dot" />{dirty ? 'Unsaved changes' : 'Saved'} · v{project.modelVersion}</span>
          <Link className="btn ghost" to={`/studio/${project.projectId}/demo`}><Icon.demo /> Demo</Link>
        </div>
      )}
    </header>
  );
}

function Nav() {
  const project = useStudio((s) => s.project);
  const sel = useStudio((s) => s.ctx.selectedNodeId);
  const pid = project?.projectId ?? 'aster-card-demo';
  return (
    <nav className="nav" aria-label="Studio views">
      <div className="nav-title">Studio views</div>
      {SCREENS.map((s, i) => {
        const to = s.path.startsWith('/') ? s.path : `/studio/${pid}/${s.path}${s.path === 'exploded' ? `/${sel ?? project?.nodes.find((n) => n.type === 'variant-set')?.id ?? 'payment-guidance'}` : ''}`;
        const Ico = s.icon;
        return (
          <NavLink key={s.id} to={to} className={({ isActive }) => (isActive || (s.path === 'exploded' && location.pathname.includes('/exploded/')) ? 'active' : '')} title={`${s.label} (Alt+${i})`} data-testid={`nav-${s.id}`}>
            <Ico /><span>{s.label}</span><span className="num">{s.id.slice(1)}</span>
          </NavLink>
        );
      })}
      <div className="nav-foot">All names, accounts and claims are fictional synthetic data. AFP output is simulated. <br />Alt+1…9 switches views.</div>
    </nav>
  );
}

function Dock() {
  const project = useStudio((s) => s.project);
  const ctx = useStudio((s) => s.ctx);
  const personas = useStudio((s) => s.personas);
  const records = useStudio((s) => s.records);
  const res = useResolution();
  if (!project) return <footer className="dock">No project open</footer>;
  const rec = records.find((r) => r.recordId === ctx.recordId);
  const blocking = res?.findings.filter((f) => f.severity === 'blocking').length ?? 0;
  const warnings = res?.findings.filter((f) => f.severity === 'warning').length ?? 0;
  return (
    <footer className="dock" aria-label="Scenario status">
      <span>Selected <strong data-testid="dock-selected">{ctx.selectedNodeId ?? 'none'}</strong></span><span className="sep" />
      <span>Record <strong>{ctx.recordId}</strong>{rec?.personaId ? ` · ${personaLabel(personas, rec.personaId)}` : ''}</span><span className="sep" />
      <span>Run <strong className="mono">{res?.runId ?? '—'}</strong></span><span className="sep" />
      <span>Rules <strong>{res?.result.matchedRuleIds.join(' ') || '—'}</strong></span><span className="sep" />
      <span className={blocking ? 'sev blocking' : warnings ? 'sev warning' : 'sev ok'}>{blocking ? `${blocking} blocking` : warnings ? `${warnings} warnings` : 'No blocking issues'}</span>
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
      <footer className="dock">InfoSlips Spatial Studio · local POC · synthetic data only · no external publication</footer>
      <Toasts />
    </div>
  );
}
