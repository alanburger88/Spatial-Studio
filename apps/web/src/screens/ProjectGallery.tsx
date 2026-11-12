import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { buildContext, fieldsFor, getPath, parseCsv, projectFields, type DocumentType, type FieldDef, type Project, type SyntheticRecord } from '@iss/model';
import { resolve, type Resolution } from '@iss/resolver';
import { api, ApiFailure, type ImportResult, type ProjectSummary, type TemplateInfoDto } from '../api/client';
import { useStudio } from '../state/store';
import { Dialog, Empty, ErrorState, Loading, ScreenHeader, Tech } from '../ui/common';
import { Icon } from '../ui/icons';
import { PagePreview } from '../doc/PagePreview';
import './ProjectGallery.css';

const DOC_LABEL: Record<DocumentType, string> = { 'credit-statement': 'Credit-card statement', eob: 'Healthcare EOB' };

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

function forgetContext(projectId: string) {
  try { localStorage.removeItem(`iss.ctx.${projectId}`); } catch { /* ignore */ }
  if (useStudio.getState().project?.projectId === projectId) useStudio.setState({ projectStatus: 'idle', project: null, past: [], future: [] });
}

type CardDialog = 'restore' | 'duplicate' | 'rename' | 'delete' | null;

function ProjectCard({ p, hero, sourceTitle }: { p: ProjectSummary; hero: boolean; sourceTitle?: string }) {
  const recordId = p.documentType === 'eob' ? 'EOB-0001' : 'CARD-0001';
  const mini = useMiniPreview(p.projectId, recordId, p.modelVersion);
  const [dialog, setDialog] = useState<CardDialog>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();
  const toast = useStudio.getState().toast;

  const openDialog = (d: CardDialog) => { setErr(null); setTitle(d === 'duplicate' ? `${p.title} (copy)` : d === 'rename' ? p.title : ''); setDialog(d); };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); setDialog(null); await useStudio.getState().loadProjects(); }
    catch (e) { setErr(e instanceof ApiFailure ? e.message : String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };
  const restore = () => run(async () => { await api.resetProject(p.projectId); forgetContext(p.projectId); toast({ kind: 'success', title: 'Approved sample restored', message: `${p.title} reset to the seeded fixture.` }); });
  const duplicate = () => run(async () => { const { project } = await api.duplicateProject(p.projectId, title); toast({ kind: 'success', title: 'Project duplicated', message: `“${project.title}” is ready to edit.` }); });
  const rename = () => run(async () => { await api.renameProject(p.projectId, title); forgetContext(p.projectId); toast({ kind: 'success', title: 'Project renamed', message: title }); });
  const remove = () => run(async () => { await api.deleteProject(p.projectId); forgetContext(p.projectId); toast({ kind: 'success', title: 'Project deleted', message: p.title }); });

  const description = !p.sample
    ? `Your copy${sourceTitle ? ` of ${sourceTitle}` : ''}. Edit freely — the approved sample stays untouched.`
    : p.documentType === 'eob'
      ? 'Explanation of benefits on the same engine: shows THIS IS NOT A BILL and never presents unconfirmed amounts as owed.'
      : 'Credit-card statement with conditional payment guidance, multi-page transaction tables and journey-driven messages.';

  return (
    <article className={`gal-card${hero ? ' hero' : ''}${p.sample ? '' : ' copy'}`} data-testid={`project-card-${p.projectId}`} aria-labelledby={`t-${p.projectId}`}>
      <Link className="gal-preview" to={`/studio/${p.projectId}/design`} tabIndex={-1} aria-hidden="true">
        {mini ? <div className="gal-paper"><PagePreview res={mini.res} project={mini.project} scale={hero ? 0.34 : 0.28} showGuides={false} ia={{ selectedId: null }} /></div> : <div className="gal-paper-skel"><span className="spinner" /></div>}
      </Link>
      <div className="gal-body">
        <div className="row wrap">
          <span className="chip accent">{DOC_LABEL[p.documentType]}</span>
          {p.sample
            ? p.modified ? <span className="chip warning">Edited sample · v{p.modelVersion}</span> : <span className="chip">Approved sample · v{p.modelVersion}</span>
            : <span className="chip info">Your project · v{p.modelVersion}</span>}
        </div>
        <h2 id={`t-${p.projectId}`}>{p.sample ? p.issuer?.name ?? p.title : p.title}</h2>
        <p className="muted">{description}</p>
        <dl className="kv">
          <dt>Components</dt><dd>{p.nodeCount}</dd>
          <dt>Rules</dt><dd>{p.ruleCount}</dd>
          <dt>Last saved</dt><dd>{new Date(p.updatedAt).toLocaleString()}</dd>
          <Tech><dt>Content digest</dt><dd className="mono">{p.contentDigest.slice(0, 12)}</dd></Tech>
        </dl>
        <div className="row wrap gal-actions">
          <Link className="btn primary" to={`/studio/${p.projectId}/design`} data-testid={`open-${p.projectId}`}><Icon.design /> Open</Link>
          <button className="btn" onClick={() => openDialog('duplicate')} data-testid={`duplicate-${p.projectId}`}><Icon.copy /> Duplicate</button>
          {!p.sample && <button className="btn" onClick={() => openDialog('rename')} data-testid={`rename-${p.projectId}`}>Rename</button>}
          <a className="btn ghost" href={`/api/v1/projects/${p.projectId}/export`} download><Icon.download /> Export JSON</a>
          {p.sample && <button className="btn ghost" onClick={() => openDialog('restore')} data-testid={`restore-${p.projectId}`}><Icon.reset /> Restore sample</button>}
          {p.sample && <button className="btn ghost" onClick={() => navigate(`/studio/${p.projectId}/demo`)}><Icon.demo /> Guided demo</button>}
          {!p.sample && <button className="btn ghost danger-text" onClick={() => openDialog('delete')} data-testid={`delete-${p.projectId}`}><Icon.trash /> Delete</button>}
        </div>
      </div>
      {dialog === 'restore' && (
        <Dialog title="Restore approved sample?" onClose={() => setDialog(null)} footer={<><button className="btn" onClick={() => setDialog(null)}>Cancel</button><button className="btn danger" onClick={restore} disabled={busy} data-testid="confirm-restore">Restore sample</button></>}>
          <p>This replaces the saved model of <strong>{p.title}</strong> with the approved seeded fixture (a new model version is recorded) and clears issued journey snapshots for this project. Records are never modified.</p>
          {err && <p className="callout error" role="alert">{err}</p>}
        </Dialog>
      )}
      {(dialog === 'duplicate' || dialog === 'rename') && (
        <Dialog title={dialog === 'duplicate' ? `Duplicate “${p.title}”` : 'Rename project'} onClose={() => setDialog(null)}
          footer={<><button className="btn" onClick={() => setDialog(null)}>Cancel</button><button className="btn primary" onClick={dialog === 'duplicate' ? duplicate : rename} disabled={busy || title.trim().length < 2} data-testid="confirm-title">{dialog === 'duplicate' ? 'Create copy' : 'Rename'}</button></>}>
          <form onSubmit={(e) => { e.preventDefault(); if (title.trim().length >= 2) void (dialog === 'duplicate' ? duplicate() : rename()); }}>
            <div className="field">
              <label htmlFor={`title-${p.projectId}`}>Project name</label>
              <input id={`title-${p.projectId}`} className="input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} data-testid="project-title-input" />
              {dialog === 'duplicate' && <span className="hint">The copy starts at version 1 with the same components, rules and content. The original is not changed.</span>}
            </div>
          </form>
          {err && <p className="callout error" role="alert">{err}</p>}
        </Dialog>
      )}
      {dialog === 'delete' && (
        <Dialog title="Delete project?" onClose={() => setDialog(null)} footer={<><button className="btn" onClick={() => setDialog(null)}>Cancel</button><button className="btn danger" onClick={remove} disabled={busy} data-testid="confirm-delete">Delete project</button></>}>
          <p><strong>{p.title}</strong> and its issued journey snapshots will be removed from this computer. Exported files you downloaded are not affected. This cannot be undone.</p>
          {err && <p className="callout error" role="alert">{err}</p>}
        </Dialog>
      )}
    </article>
  );
}

/** CSV template: every importable contract path for the document type plus one example row from a seeded record. */
function csvTemplate(documentType: DocumentType, example?: SyntheticRecord): string {
  const cols = fieldsFor(documentType).filter((f) => !f.derived && f.type !== 'array' && f.path !== 'documentType' && f.path !== 'recordId').map((f) => f.path);
  const header = ['recordId', ...cols];
  const q = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [header.join(',')];
  if (example) { const ctx = buildContext(example); lines.push(['EXAMPLE-1', ...cols.map((c) => q(getPath(ctx, c)))].join(',')); }
  return lines.join('\r\n') + '\r\n';
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const IGNORE = '';
const SOURCE_ID = '__recordId';

/** Best-effort automatic match of a CSV header to a data-contract path (exact path, label, or last path segment). */
function autoMatch(header: string, fields: FieldDef[]): string {
  const h = header.trim();
  if (/^record ?id$|^id$|^customer ?id$/i.test(h)) return SOURCE_ID;
  const exact = fields.find((f) => f.path === h); if (exact) return exact.path;
  const n = norm(h);
  const byLabel = fields.find((f) => norm(f.label) === n); if (byLabel) return byLabel.path;
  const byLeaf = fields.filter((f) => norm(f.path.split('.').slice(-1)[0]) === n); if (byLeaf.length === 1) return byLeaf[0].path;
  return IGNORE;
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [docType, setDocType] = useState<DocumentType>('credit-statement');
  const [format, setFormat] = useState<'json' | 'csv'>('csv');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const projects = useStudio((st) => st.projects);
  const targets = projects.filter((p) => p.documentType === docType);
  const [targetId, setTargetId] = useState<string>('');
  const [target, setTarget] = useState<Project | null>(null);
  useEffect(() => {
    const id = targetId && targets.some((t) => t.projectId === targetId) ? targetId : targets[0]?.projectId ?? '';
    if (id !== targetId) { setTargetId(id); return; }
    if (!id) { setTarget(null); return; }
    let live = true;
    api.project(id).then(({ project }) => { if (live) setTarget(project); }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docType, targetId, projects]);
  const fields = useMemo(() => projectFields(target ?? { documentType: docType }).filter((f) => !f.derived && f.path !== 'documentType' && f.path !== 'recordId'), [target, docType]);
  const csvRows = useMemo(() => (format === 'csv' && text.trim() ? parseCsv(text) : []), [format, text]);
  const headers = csvRows[0] ?? [];
  const [mapping, setMapping] = useState<string[]>([]);
  useEffect(() => { setMapping(headers.map((h) => autoMatch(h.replace(/^\uFEFF/, ''), fields))); setCheck(null); }, [headers.join('\u0001'), fields]);
  const mapped = mapping.filter((m) => m !== IGNORE).length;
  const dupTargets = mapping.filter((m, i) => m && mapping.indexOf(m) !== i);
  const missingRequired = fields.filter((f) => f.required && f.type !== 'array' && !mapping.includes(f.path)).map((f) => f.label);
  /** Rewrites the CSV with mapped data-contract headers, dropping ignored columns. */
  const mappedCsv = () => {
    const keep = mapping.map((m, i) => [m, i] as const).filter(([m]) => m !== IGNORE);
    return csvRows.map((row, r) => keep.map(([m, i]) => csvCell(r === 0 ? (m === SOURCE_ID ? 'recordId' : m) : row[i] ?? '')).join(',')).join('\r\n') + '\r\n';
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileName(f.name); setCheck(null); setErr(null);
    setFormat(/\.json$/i.test(f.name) ? 'json' : 'csv');
    setText(await f.text());
  };
  const call = async (dryRun: boolean) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.importRecords({ documentType: docType, format, data: format === 'csv' ? mappedCsv() : text, dryRun, projectId: targetId || undefined });
      if (dryRun) setCheck(r);
      else {
        useStudio.getState().toast({ kind: r.rejected.length ? 'warning' : 'success', title: `Imported ${r.imported.length} record${r.imported.length === 1 ? '' : 's'}`, message: r.rejected.length ? `${r.rejected.length} row(s) were rejected.` : `${r.imported.map((x) => x.recordId).join(', ').slice(0, 120)}` });
        onDone();
      }
    } catch (e) { setErr(e instanceof ApiFailure ? e.message : String((e as Error).message ?? e)); setCheck(null); }
    finally { setBusy(false); }
  };
  const downloadTemplate = async () => {
    const { record } = await fetch(`/api/v1/records/${docType === 'eob' ? 'EOB-0001' : 'CARD-0001'}`).then((r) => r.json()).catch(() => ({ record: undefined }));
    const blob = new Blob([csvTemplate(docType, record)], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${docType}-import-template.csv`; a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <Dialog title="Import scenario records" onClose={onClose} labelledBy="import-title"
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => call(true)} disabled={busy || !text.trim() || (format === 'csv' && (!mapped || dupTargets.length > 0))} data-testid="import-check">Check file</button>
        <button className="btn primary" onClick={() => call(false)} disabled={busy || !check || !check.imported.length} data-testid="import-commit">Import {check ? check.imported.length : ''} record{check?.imported.length === 1 ? '' : 's'}</button>
      </>}>
      <div className="imp">
        <p className="callout warning imp-warn"><strong>Use synthetic or anonymised data only.</strong> Imported records stay on this computer (the local <span className="mono">.data</span> folder) and are never sent to any external service.</p>
        <div className="field">
          <span className="label">Document type</span>
          <div className="seg" role="group" aria-label="Document type">
            <button type="button" aria-pressed={docType === 'credit-statement'} onClick={() => { setDocType('credit-statement'); setCheck(null); }}>Credit-card statement</button>
            <button type="button" aria-pressed={docType === 'eob'} onClick={() => { setDocType('eob'); setCheck(null); }}>Healthcare EOB</button>
          </div>
        </div>
        <div className="field">
          <span className="label">File (.csv or .json)</span>
          <div className="row wrap">
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}><Icon.download style={{ transform: 'rotate(180deg)' }} /> Choose file…</button>
            <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={(e) => onFile(e.target.files?.[0])} data-testid="import-file" />
            <span className="muted">{fileName ?? 'No file chosen'}</span>
            <button type="button" className="btn ghost sm" onClick={downloadTemplate} style={{ marginLeft: 'auto' }}><Icon.download /> CSV template</button>
          </div>
          <span className="hint">CSV: any column names — you match them to data fields below (amounts in whole cents, dates YYYY-MM-DD). JSON: the same shape as the sample records.</span>
        </div>
        <details className="imp-paste">
          <summary>…or paste data</summary>
          <div className="row" style={{ margin: '6px 0' }}>
            <div className="seg" role="group" aria-label="Pasted format">
              <button type="button" aria-pressed={format === 'csv'} onClick={() => { setFormat('csv'); setCheck(null); }}>CSV</button>
              <button type="button" aria-pressed={format === 'json'} onClick={() => { setFormat('json'); setCheck(null); }}>JSON</button>
            </div>
          </div>
          <textarea className="textarea mono" rows={6} value={text} onChange={(e) => { setText(e.target.value); setFileName(null); setCheck(null); }} aria-label="Pasted records" data-testid="import-text" />
        </details>
        {targets.length > 1 && (
          <div className="field">
            <label htmlFor="imp-target">Use data fields of</label>
            <select id="imp-target" className="select" value={targetId} onChange={(e) => setTargetId(e.target.value)} data-testid="import-target">
              {targets.map((t) => <option key={t.projectId} value={t.projectId}>{t.title}</option>)}
            </select>
            <span className="hint">Its custom fields can be imported too. Records are shared by every {docType === 'eob' ? 'EOB' : 'credit-card'} project.</span>
          </div>
        )}
        {format === 'csv' && headers.length > 0 && (
          <div className="imp-map" data-testid="import-mapping">
            <div className="row"><strong>Match columns</strong><span className="muted">{mapped} of {headers.length} columns used</span></div>
            <div className="imp-map-scroll">
              <table className="table">
                <thead><tr><th>Your column</th><th>First value</th><th>Data field</th></tr></thead>
                <tbody>
                  {headers.map((h, i) => (
                    <tr key={i}>
                      <td><strong>{h || <em className="faint">(blank)</em>}</strong></td>
                      <td className="faint imp-sample" title={csvRows[1]?.[i] ?? ''}>{csvRows[1]?.[i] ?? ''}</td>
                      <td>
                        <select className="select" value={mapping[i] ?? IGNORE} onChange={(e) => setMapping((m) => m.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Data field for column ${h}`} data-testid={`map-${i}`}>
                          <option value={IGNORE}>— Ignore —</option>
                          <option value={SOURCE_ID}>Your record ID (kept for reference)</option>
                          {fields.filter((f) => f.type !== 'array').map((f) => <option key={f.path} value={f.path}>{f.label}{f.path.startsWith('custom.') ? ' (custom)' : ''}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {dupTargets.length > 0 && <p className="callout error">Two columns are matched to the same field. Each field can be used once.</p>}
            {missingRequired.length > 0 && <p className="callout warning">Not matched yet (required): {missingRequired.slice(0, 6).join(', ')}{missingRequired.length > 6 ? ` +${missingRequired.length - 6} more` : ''}. Rows without them will be rejected.</p>}
          </div>
        )}
        {err && <p className="callout error" role="alert" data-testid="import-error">{err}</p>}
        {check && (
          <div className="imp-result" data-testid="import-result" aria-live="polite">
            <p><span className="sev ok">✓ {check.imported.length} valid</span>{check.rejected.length > 0 && <> · <span className="sev blocking">{check.rejected.length} rejected</span></>} <span className="muted">of {check.total} row{check.total === 1 ? '' : 's'}</span></p>
            {check.imported.length > 0 && <p className="muted">They will be added as {check.imported[0].recordId}{check.imported.length > 1 ? ` – ${check.imported[check.imported.length - 1].recordId}` : ''}.</p>}
            {check.rejected.length > 0 && (
              <ul className="imp-rejects">
                {check.rejected.slice(0, 8).map((r) => <li key={r.row}><strong>Row {r.row}{r.sourceId ? ` (${r.sourceId})` : ''}</strong>: {r.errors.slice(0, 3).join(' ')}{r.errors.length > 3 ? ` (+${r.errors.length - 3} more)` : ''}</li>)}
                {check.rejected.length > 8 && <li className="muted">…and {check.rejected.length - 8} more rows.</li>}
              </ul>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------ new project */

function TemplateThumb({ templateId, documentType }: { templateId: string; documentType?: DocumentType }) {
  const [state, setState] = useState<{ res: Resolution; project: Project } | null>(null);
  useEffect(() => {
    let live = true;
    setState(null);
    api.templateProject(templateId, templateId === 'blank-letter' ? documentType : undefined)
      .then(async ({ project }) => {
        const { record } = await fetch(`/api/v1/records/${project.documentType === 'eob' ? 'EOB-0001' : 'CARD-0001'}`).then((r) => r.json());
        if (live) setState({ project, res: resolve({ project, record: record as SyntheticRecord }) });
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [templateId, documentType]);
  return state ? <PagePreview res={state.res} project={state.project} scale={0.2} showGuides={false} ia={{ selectedId: null }} /> : <div className="gal-paper-skel np-skel"><span className="spinner" /></div>;
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<TemplateInfoDto[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string>('blank-letter');
  const [title, setTitle] = useState('');
  const [letterData, setLetterData] = useState<DocumentType>('credit-statement');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.templates().then((r) => setTemplates(r.templates)).catch((e) => setLoadErr(e instanceof ApiFailure ? e.message : String(e.message ?? e))); }, []);
  const chosen = templates?.find((t) => t.id === sel);
  const create = async () => {
    if (!chosen || title.trim().length < 2) return;
    setBusy(true); setErr(null);
    try {
      const { project } = await api.createProject({ templateId: chosen.id, title: title.trim(), ...(chosen.id === 'blank-letter' ? { documentType: letterData } : {}) });
      await useStudio.getState().loadProjects();
      useStudio.getState().toast({ kind: 'success', title: 'Project created', message: `“${project.title}” is ready to design.` });
      onClose();
      navigate(`/studio/${project.projectId}/design`);
    } catch (e) { setErr(e instanceof ApiFailure ? e.message : String((e as Error).message ?? e)); setBusy(false); }
  };
  return (
    <Dialog title="New project" onClose={onClose} labelledBy="new-project-title"
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={create} disabled={busy || !chosen || title.trim().length < 2} data-testid="create-project">Create project</button></>}>
      <form className="np-root" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        {loadErr && <p className="callout error" role="alert">{loadErr}</p>}
        {!templates && !loadErr && <Loading label="Loading templates…" />}
        <div className="np-cards" role="radiogroup" aria-label="Template">
          {templates?.map((t) => (
            <button type="button" key={t.id} role="radio" aria-checked={sel === t.id} className={`np-card${sel === t.id ? ' on' : ''}`} onClick={() => setSel(t.id)} data-testid={`template-${t.id}`}>
              <span className="np-thumb" aria-hidden="true"><TemplateThumb templateId={t.id} documentType={letterData} /></span>
              <span className="np-name">{t.title}</span>
              <span className="chip accent">{DOC_LABEL[t.id === 'blank-letter' ? letterData : t.documentType]}</span>
              <span className="muted np-desc">{t.description}</span>
            </button>
          ))}
        </div>
        {sel === 'blank-letter' && (
          <div className="field">
            <label htmlFor="np-data">Sample data for the letter</label>
            <select id="np-data" className="select" value={letterData} onChange={(e) => setLetterData(e.target.value as DocumentType)} data-testid="blank-letter-data">
              <option value="credit-statement">Credit-card statement data</option>
              <option value="eob">Healthcare EOB data</option>
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="np-title">Project name</label>
          <input id="np-title" className="input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Welcome letter" data-testid="new-project-title" />
        </div>
        {err && <p className="callout error" role="alert">{err}</p>}
      </form>
    </Dialog>
  );
}

export function ProjectGallery() {
  const projects = useStudio((s) => s.projects);
  const status = useStudio((s) => s.projectsStatus);
  const error = useStudio((s) => s.projectsError);
  const [counts, setCounts] = useState<{ card: number; eob: number; importedCard: number; importedEob: number } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    fetch('/api/v1/records').then((r) => r.json()).then((b) => {
      const recs = b.records as Array<{ documentType: string; imported?: boolean }>;
      const n = (dt: string, imp: boolean) => recs.filter((r) => r.documentType === dt && !!r.imported === imp).length;
      setCounts({ card: n('credit-statement', false), eob: n('eob', false), importedCard: n('credit-statement', true), importedEob: n('eob', true) });
    }).catch(() => undefined);
  }, [tick]);
  const recordsChanged = async () => {
    setImporting(false); setTick((t) => t + 1);
    if (useStudio.getState().project) await useStudio.getState().refreshRecords(); else useStudio.setState({ records: [] });
  };
  const clearImported = async () => {
    const { removed } = await api.clearImportedRecords();
    useStudio.getState().toast({ kind: 'success', title: 'Imported records removed', message: `${removed} record(s) removed.` });
    await recordsChanged();
  };
  const resetAll = async () => {
    for (const p of projects.filter((x) => x.sample)) { await api.resetProject(p.projectId); try { localStorage.removeItem(`iss.ctx.${p.projectId}`); } catch { /* ignore */ } }
    useStudio.setState({ project: null, projectStatus: 'idle', past: [], future: [] });
    await useStudio.getState().loadProjects();
    useStudio.getState().toast({ kind: 'success', title: 'Demo reset', message: 'Both sample projects restored to the approved models; issued snapshots cleared.' });
    setConfirmAll(false);
  };
  const ordered = useMemo(() => [...projects].sort((a, b) => (a.sample !== b.sample ? (a.sample ? -1 : 1) : a.sample ? (a.projectId === 'aster-card-demo' ? -1 : 1) : b.updatedAt.localeCompare(a.updatedAt))), [projects]);
  const titleOf = (id?: string) => projects.find((x) => x.projectId === id)?.title;
  const imported = (counts?.importedCard ?? 0) + (counts?.importedEob ?? 0);
  return (
    <section className="screen" data-testid="project-gallery">
      <ScreenHeader id="S01" title="Project Gallery" subtitle="Design in 2D. Understand in 2.5D. Simulate across personas and time. Compose into faithful paged and interactive outputs."
        actions={<>
          <button className="btn primary" onClick={() => setCreating(true)} data-testid="new-project"><Icon.plus /> New project</button>
          <button className="btn" onClick={() => setImporting(true)} data-testid="import-records"><Icon.plus /> Import records</button>
          <button className="btn" onClick={() => setConfirmAll(true)} data-testid="reset-demo"><Icon.reset /> Reset demo</button>
        </>} />
      <div className="screen-body gal-grid">
        <div className="gal-cards">
          {status === 'loading' && !projects.length && <Loading label="Loading projects…" />}
          {status === 'error' && <ErrorState title="Projects could not be loaded" message={error ?? ''} onRetry={() => useStudio.getState().loadProjects()} />}
          {status === 'ready' && !projects.length && <Empty title="No projects" message="The local store is empty. Restart the API to re-seed the approved samples." />}
          {ordered.map((p) => <ProjectCard key={p.projectId} p={p} hero={p.projectId === 'aster-card-demo'} sourceTitle={titleOf(p.derivedFrom?.projectId)} />)}
        </div>
        <aside className="panel gal-side">
          <div className="panel-head">About this studio</div>
          <div className="panel-body">
            <div className="gal-stats">
              <div><strong>15</strong><span>component types</span></div>
              <div><strong>20</strong><span>sample rules</span></div>
              <div><strong>{counts ? counts.card + counts.eob : '…'}</strong><span>synthetic records</span></div>
              <div><strong>12</strong><span>personas</span></div>
            </div>
            <p className="muted gal-note" data-testid="synthetic-statement">All sample people, accounts, providers and organisations are fictional ({counts ? `${counts.card} card and ${counts.eob} EOB records` : '…'}, seed SPATIAL-STUDIO-DEMO-2026-11). Nothing here connects to production data.</p>
            <div className="section-title">Your records</div>
            <p className="muted gal-note">{imported ? <>{counts!.importedCard} card and {counts!.importedEob} EOB record{imported === 1 ? '' : 's'} imported. They appear in the customer picker and in every view.</> : 'Import your own scenario records (CSV or JSON) to test the design against them.'}</p>
            <div className="row wrap">
              <button className="btn sm" onClick={() => setImporting(true)}><Icon.plus /> Import records</button>
              {imported > 0 && <button className="btn sm ghost" onClick={clearImported} data-testid="clear-imported"><Icon.trash /> Remove imported</button>}
            </div>
            <div className="section-title">Real</div>
            <ul className="gal-list">
              <li>Deterministic rule engine with traceable decisions</li>
              <li>Measured page composition → genuine PDF</li>
              <li>Standalone interactive HTML (sort, filter, expand)</li>
              <li>Spatial views of the same model</li>
              <li>Write-once issued journey snapshots</li>
            </ul>
            <div className="section-title">Simulated</div>
            <ul className="gal-list sim">
              <li>AFP output (profile simulation — no AFP bytes)</li>
              <li>Credit disclosures and EOB adjudication (illustrative)</li>
              <li>“Reach” = counts of synthetic records</li>
            </ul>
          </div>
        </aside>
      </div>
      {confirmAll && (
        <Dialog title="Reset the demo?" onClose={() => setConfirmAll(false)} footer={<><button className="btn" onClick={() => setConfirmAll(false)}>Cancel</button><button className="btn danger" onClick={resetAll} data-testid="confirm-reset-demo">Reset sample projects</button></>}>
          <p>Both sample projects return to their approved models, issued snapshots are cleared and saved view context is forgotten. Your own projects and imported records are kept. Use this before a stakeholder run.</p>
        </Dialog>
      )}
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={recordsChanged} />}
    </section>
  );
}
