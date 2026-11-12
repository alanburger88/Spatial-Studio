import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Project, SyntheticRecord } from '@iss/model';
import { resolve, type Resolution } from '@iss/resolver';
import { api } from '../api/client';
import { useStudio } from '../state/store';
import { Dialog, Empty, ErrorState, Loading, ScreenHeader } from '../ui/common';
import { Icon } from '../ui/icons';
import { PagePreview } from '../doc/PagePreview';
import './ProjectGallery.css';

function useMiniPreview(projectId: string, recordId: string, version: number) {
  const [state, setState] = useState<{ res: Resolution; project: Project } | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([api.project(projectId), fetch(`/api/v1/records/${recordId}`).then((r) => r.json())])
      .then(([{ project }, { record }]) => { if (live) setState({ project, res: resolve({ project, record: record as SyntheticRecord }) }); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [projectId, recordId, version]);
  return state;
}

function ProjectCard({ p, hero }: { p: ReturnType<typeof useStudio.getState>['projects'][number]; hero: boolean }) {
  const recordId = p.documentType === 'eob' ? 'EOB-0001' : 'CARD-0001';
  const mini = useMiniPreview(p.projectId, recordId, p.modelVersion);
  const [confirm, setConfirm] = useState(false);
  const navigate = useNavigate();
  const reset = async () => {
    await api.resetProject(p.projectId);
    try { localStorage.removeItem(`iss.ctx.${p.projectId}`); } catch { /* ignore */ }
    if (useStudio.getState().project?.projectId === p.projectId) useStudio.setState({ projectStatus: 'idle', project: null });
    useStudio.getState().toast({ kind: 'success', title: 'Approved sample restored', message: `${p.title} reset to the seeded fixture.` });
    await useStudio.getState().loadProjects();
    setConfirm(false);
  };
  return (
    <article className={`gal-card${hero ? ' hero' : ''}`} data-testid={`project-card-${p.projectId}`} aria-labelledby={`t-${p.projectId}`}>
      <div className="gal-preview" aria-hidden="true">
        {mini ? <div className="gal-paper"><PagePreview res={mini.res} project={mini.project} scale={hero ? 0.36 : 0.32} showGuides={false} ia={{ selectedId: null }} /></div> : <div className="gal-paper-skel"><span className="spinner" /></div>}
      </div>
      <div className="gal-body">
        <div className="row wrap">
          <span className="chip accent">{p.documentType === 'eob' ? 'Healthcare EOB' : 'Credit-card statement'}</span>
          {p.modified ? <span className="chip warning">Modified · v{p.modelVersion}</span> : <span className="chip">Approved sample · v{p.modelVersion}</span>}
        </div>
        <h2 id={`t-${p.projectId}`}>{p.issuer?.name ?? p.title}</h2>
        <p className="muted">{p.documentType === 'eob' ? 'Functional explanation of benefits proving the same engine across domains. Shows THIS IS NOT A BILL and guards unconfirmed member liability.' : 'Hero demo: fictional US credit-card statement with conditional payment guidance, 250-row continuation and journey-driven communications.'}</p>
        <dl className="kv">
          <dt>Components</dt><dd>{p.nodeCount}</dd>
          <dt>Rules</dt><dd>{p.ruleCount}</dd>
          <dt>Last saved</dt><dd>{new Date(p.updatedAt).toLocaleString()}</dd>
          <dt>Content digest</dt><dd className="mono">{p.contentDigest.slice(0, 12)}</dd>
        </dl>
        <div className="row wrap gal-actions">
          <Link className="btn primary" to={`/studio/${p.projectId}/design`} data-testid={`open-${p.projectId}`}><Icon.design /> Open project</Link>
          <a className="btn" href={`/api/v1/projects/${p.projectId}/export`} download><Icon.download /> Export JSON</a>
          <button className="btn ghost" onClick={() => setConfirm(true)} data-testid={`restore-${p.projectId}`}><Icon.reset /> Restore approved sample</button>
          <button className="btn ghost" onClick={() => navigate(`/studio/${p.projectId}/demo`)}><Icon.demo /> Guided demo</button>
        </div>
      </div>
      {confirm && (
        <Dialog title="Restore approved sample?" onClose={() => setConfirm(false)} footer={<><button className="btn" onClick={() => setConfirm(false)}>Cancel</button><button className="btn danger" onClick={reset} data-testid="confirm-restore">Restore sample</button></>}>
          <p>This replaces the saved model of <strong>{p.title}</strong> with the approved seeded fixture (a new model version is recorded) and clears issued journey snapshots for this project. Synthetic records are never modified.</p>
        </Dialog>
      )}
    </article>
  );
}

export function ProjectGallery() {
  const projects = useStudio((s) => s.projects);
  const status = useStudio((s) => s.projectsStatus);
  const error = useStudio((s) => s.projectsError);
  const [counts, setCounts] = useState<{ records: number; card: number; eob: number } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  useEffect(() => {
    fetch('/api/v1/records').then((r) => r.json()).then((b) => setCounts({ records: b.records.length, card: b.records.filter((r: any) => r.documentType === 'credit-statement').length, eob: b.records.filter((r: any) => r.documentType === 'eob').length })).catch(() => undefined);
  }, []);
  const resetAll = async () => {
    for (const p of projects) { await api.resetProject(p.projectId); try { localStorage.removeItem(`iss.ctx.${p.projectId}`); } catch { /* ignore */ } }
    useStudio.setState({ project: null, projectStatus: 'idle', past: [], future: [] });
    await useStudio.getState().loadProjects();
    useStudio.getState().toast({ kind: 'success', title: 'Demo reset', message: 'Both projects restored to the approved seeded fixtures; issued snapshots cleared.' });
    setConfirmAll(false);
  };
  const ordered = [...projects].sort((a) => (a.projectId === 'aster-card-demo' ? -1 : 1));
  return (
    <section className="screen" data-testid="project-gallery">
      <ScreenHeader id="S01" title="Project Gallery" subtitle="Design in 2D. Understand in 2.5D. Simulate across personas and time. Compose into faithful paged and interactive outputs."
        actions={<button className="btn" onClick={() => setConfirmAll(true)} data-testid="reset-demo"><Icon.reset /> Reset demo</button>} />
      <div className="screen-body gal-grid">
        <div className="gal-cards">
          {status === 'loading' && !projects.length && <Loading label="Loading projects…" />}
          {status === 'error' && <ErrorState title="Projects could not be loaded" message={error ?? ''} onRetry={() => useStudio.getState().loadProjects()} />}
          {status === 'ready' && !projects.length && <Empty title="No projects" message="The local store is empty. Restart the API to re-seed the approved samples." />}
          {ordered.map((p) => <ProjectCard key={p.projectId} p={p} hero={p.projectId === 'aster-card-demo'} />)}
        </div>
        <aside className="panel gal-side">
          <div className="panel-head">Demonstration bundle</div>
          <div className="panel-body">
            <div className="gal-stats">
              <div><strong>15</strong><span>component types</span></div>
              <div><strong>20</strong><span>seeded rules</span></div>
              <div><strong>{counts?.records ?? '…'}</strong><span>synthetic records</span></div>
              <div><strong>12</strong><span>personas</span></div>
            </div>
            <p className="muted" style={{ fontSize: 12.5 }}>{counts ? `${counts.card} credit-card and ${counts.eob} EOB records` : ''} generated from seed SPATIAL-STUDIO-DEMO-2026-11. All people, accounts, providers and organisations are fictional. Nothing here is a production data connection.</p>
            <div className="section-title">What is real</div>
            <ul className="gal-list">
              <li>Deterministic rule engine with traceable decisions</li>
              <li>Measured paged composition → genuine PDF</li>
              <li>Standalone interactive HTML with sort/filter/expand</li>
              <li>Four spatial projections of the same model</li>
              <li>Immutable issued journey snapshots</li>
            </ul>
            <div className="section-title">What is simulated</div>
            <ul className="gal-list sim">
              <li>AFP output (profile simulation only — no AFP bytes)</li>
              <li>Credit disclosures and EOB adjudication (illustrative)</li>
              <li>Population “reach” = synthetic fixture counts</li>
            </ul>
          </div>
        </aside>
      </div>
      {confirmAll && (
        <Dialog title="Reset the whole demo?" onClose={() => setConfirmAll(false)} footer={<><button className="btn" onClick={() => setConfirmAll(false)}>Cancel</button><button className="btn danger" onClick={resetAll} data-testid="confirm-reset-demo">Reset both projects</button></>}>
          <p>Both projects return to their approved seeded models, issued snapshots are cleared and saved view context is forgotten. Use this before a stakeholder run.</p>
        </Dialog>
      )}
    </section>
  );
}
