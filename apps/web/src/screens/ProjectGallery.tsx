import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DOCUMENT_TYPE_LABEL, NEUTRAL_ACCENT, BLANK_PROJECT_TEMPLATE_ID, ISSUER_NAME_MAX, ISSUER_NAME_MIN, ACCENT_PATTERN, type DocumentType, type Project, type SyntheticRecord } from '@iss/model';
import { resolve, type Resolution } from '@iss/resolver';
import { api, ApiFailure, type ImportResult, type ProjectSummary, type TemplateInfoDto } from '../api/client';
import { editBlockedReason, useCan, useStudio } from '../state/store';
import { ImportDialog } from './gallery/ImportRecords';
import { SetupDialog } from './gallery/SetupDialog';
import { CountsList, ImportProjectDialog, SAVE_TEMPLATE_DENIED, SaveTemplateDialog } from './gallery/TemplateDialogs';
import { Biz, Dialog, Empty, ErrorState, Loading, ScreenHeader, Tech } from '../ui/common';
import { Icon } from '../ui/icons';
import { PagePreview } from '../doc/PagePreview';
import './ProjectGallery.css';

const DOC_LABEL = DOCUMENT_TYPE_LABEL;

/** The customer a document is drawn with in a gallery card or template thumbnail: a shared sample for the two sample kinds; a document with its own data has only its own customers. */
const sampleRecordId = (t: DocumentType) => (t === 'eob' ? 'EOB-0001' : 'CARD-0001');
const sampleRecord = (t: DocumentType) => fetch(`/api/v1/records/${sampleRecordId(t)}`).then((r) => r.json()).then((b) => b.record as SyntheticRecord);

function useMiniPreview(p: ProjectSummary) {
  const { projectId, documentType, modelVersion: version } = p;
  const [state, setState] = useState<{ res: Resolution; project: Project } | null>(null);
  useEffect(() => {
    let live = true;
    const record = documentType === 'custom' ? api.records('custom', projectId).then((r) => r.records[0]) : sampleRecord(documentType);
    Promise.all([api.project(projectId), record])
      .then(([{ project }, record]) => { if (live && record) setState({ project, res: resolve({ project, record }) }); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [projectId, documentType, version]);
  return state;
}

function forgetContext(projectId: string) {
  try { localStorage.removeItem(`iss.ctx.${projectId}`); } catch { /* ignore */ }
  if (useStudio.getState().project?.projectId === projectId) useStudio.setState({ projectStatus: 'idle', project: null, past: [], future: [] });
}

/** Overflow ("…") menu: button + role=menu popup. Escape / outside click close it; arrow keys move between items. */
function OverflowMenu({ id, label, children }: { id: string; label: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const close = (refocus = false) => { setOpen(false); if (refocus) btn.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    items()[0]?.focus();
    const onDoc = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(true); return; }
      const list = items(); const i = list.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
      else if (e.key === 'Tab') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  return (
    <div className="gal-menu" ref={wrap}>
      <button type="button" ref={btn} className="btn icon" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `menu-${id}` : undefined} aria-label={label} title="More actions" data-testid={`card-menu-${id}`}
        onClick={() => setOpen((o) => !o)} onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}>
        <span aria-hidden="true" className="gal-dots">…</span>
      </button>
      {open && <div id={`menu-${id}`} role="menu" aria-label={label} className="gal-menu-pop">{children(() => close(false))}</div>}
    </div>
  );
}

type CardDialog = 'restore' | 'duplicate' | 'rename' | 'delete' | 'template' | null;

function ProjectCard({ p, hero, sourceTitle }: { p: ProjectSummary; hero: boolean; sourceTitle?: string }) {
  const mini = useMiniPreview(p);
  const [dialog, setDialog] = useState<CardDialog>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();
  const toast = useStudio.getState().toast;
  const canSaveTemplate = useCan('approve');
  const closeTemplate = useCallback(() => setDialog(null), []);

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
    ? (p.documentType === 'custom' && !sourceTitle ? 'Your own document: its own data fields, layout, rules and customers.' : `Your copy${sourceTitle ? ` of ${sourceTitle}` : ''}. Edit freely — the approved sample stays untouched.`)
    : p.documentType === 'eob'
      ? 'Explanation of benefits on the same engine: shows THIS IS NOT A BILL and never presents unconfirmed amounts as owed.'
      : 'Credit-card statement with conditional payment guidance, multi-page transaction tables and journey-driven messages.';

  return (
    <article className={`gal-card${hero ? ' hero' : ''}${p.sample ? '' : ' copy'}`} data-testid={`project-card-${p.projectId}`} aria-labelledby={`t-${p.projectId}`}>
      <Link className="gal-preview" to={`/studio/${p.projectId}/overview`} tabIndex={-1} aria-hidden="true">
        {mini ? <div className="gal-paper"><PagePreview res={mini.res} project={mini.project} scale={hero ? 0.34 : 0.28} showGuides={false} ia={{ selectedId: null }} /></div> : <div className="gal-paper-skel"><span className="spinner" /></div>}
      </Link>
      <div className="gal-body">
        <div className="row wrap">
          <span className="chip accent">{DOC_LABEL[p.documentType]}</span>
          {p.sample
            ? p.modified ? <span className="chip warning">Edited sample<Tech> · v{p.modelVersion}</Tech></span> : <span className="chip">Sample<Tech> · v{p.modelVersion}</Tech></span>
            : <span className="chip info">Your project<Tech> · v{p.modelVersion}</Tech></span>}
        </div>
        <h2 id={`t-${p.projectId}`}>{p.sample ? p.issuer?.name ?? p.title : p.title}</h2>
        <p className="muted">{description}</p>
        {p.fromTemplate && <p className="gal-origin" data-testid={`origin-${p.projectId}`}>Started from the template “{p.fromTemplate.title}”, version {p.fromTemplate.version}</p>}
        {p.importedFrom && <p className="gal-origin" data-testid={`origin-${p.projectId}`}>Imported from the file “{p.importedFrom.title}”<Tech> (version {p.importedFrom.modelVersion})</Tech></p>}
        <dl className="kv">
          <dt>Components</dt><dd>{p.nodeCount}</dd>
          <dt>Rules</dt><dd>{p.ruleCount}</dd>
          <dt>Last saved</dt><dd>{new Date(p.updatedAt).toLocaleString()}</dd>
          <Tech><dt>Content digest</dt><dd className="mono">{p.contentDigest.slice(0, 12)}</dd></Tech>
        </dl>
        <div className="row wrap gal-actions">
          <Link className="btn primary" to={`/studio/${p.projectId}/overview`} data-testid={`open-${p.projectId}`}><Icon.design /> Open</Link>
          <OverflowMenu id={p.projectId} label={`More actions for ${p.sample ? p.issuer?.name ?? p.title : p.title}`}>
            {(close) => <>
              <button role="menuitem" type="button" className="gal-item" onClick={() => { close(); openDialog('duplicate'); }} data-testid={`duplicate-${p.projectId}`}><Icon.copy /> Duplicate</button>
              {!p.sample && <button role="menuitem" type="button" className="gal-item" onClick={() => { close(); openDialog('rename'); }} data-testid={`rename-${p.projectId}`}>Rename</button>}
              <a role="menuitem" className="gal-item" href={`/api/v1/projects/${p.projectId}/export`} download onClick={close} data-testid={`export-${p.projectId}`}><Icon.download /> Export project file</a>
              <button role="menuitem" type="button" className="gal-item gal-item-stack" aria-disabled={!canSaveTemplate} onClick={() => { if (!canSaveTemplate) return; close(); openDialog('template'); }} data-testid={`save-template-${p.projectId}`}>
                <span className="gal-item-line"><Icon.plus /> Save as template…</span>
                {!canSaveTemplate && <span className="gal-item-why" data-testid={`save-template-why-${p.projectId}`}>{SAVE_TEMPLATE_DENIED}</span>}
              </button>
              {p.sample && <button role="menuitem" type="button" className="gal-item" onClick={() => { close(); openDialog('restore'); }} data-testid={`restore-${p.projectId}`}><Icon.reset /> Restore sample</button>}
              {p.sample && <button role="menuitem" type="button" className="gal-item" onClick={() => { close(); navigate(`/studio/${p.projectId}/demo`); }} data-testid={`guided-demo-${p.projectId}`}><Icon.demo /> Guided demo</button>}
              {!p.sample && <button role="menuitem" type="button" className="gal-item danger-text" onClick={() => { close(); openDialog('delete'); }} data-testid={`delete-${p.projectId}`}><Icon.trash /> Delete</button>}
            </>}
          </OverflowMenu>
        </div>
      </div>
      {dialog === 'restore' && (
        <Dialog title="Restore approved sample?" onClose={() => setDialog(null)} footer={<><button className="btn" onClick={() => setDialog(null)}>Cancel</button><button className="btn danger" onClick={restore} disabled={busy} data-testid="confirm-restore">Restore sample</button></>}>
          <p>This replaces the saved model of <strong>{p.title}</strong> with the approved seeded fixture and clears issued journey snapshots for this project. Records are never modified.</p>
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
      {dialog === 'template' && <SaveTemplateDialog p={p} onClose={closeTemplate} />}
      {dialog === 'delete' && (
        <Dialog title="Delete project?" onClose={() => setDialog(null)} footer={<><button className="btn" onClick={() => setDialog(null)}>Cancel</button><button className="btn danger" onClick={remove} disabled={busy} data-testid="confirm-delete">Delete project</button></>}>
          <p><strong>{p.title}</strong> and its issued journey snapshots will be removed from this computer. Exported files you downloaded are not affected. This cannot be undone.</p>
          {err && <p className="callout error" role="alert">{err}</p>}
        </Dialog>
      )}
    </article>
  );
}

/* ------------------------------------------------------------ new project */

function TemplateThumb({ templateId, documentType, version }: { templateId: string; documentType?: DocumentType; version?: number }) {
  const [state, setState] = useState<{ res: Resolution; project: Project } | null>(null);
  useEffect(() => {
    let live = true;
    setState(null);
    api.templateProject(templateId, templateId === 'blank-letter' ? documentType : undefined, version)
      .then(async ({ project, previewRecord }) => {
        // A document with its own data brings the customer to draw it with (an empty page for the blank project).
        const record = previewRecord ?? await sampleRecord(project.documentType);
        if (live) setState({ project, res: resolve({ project, record }) });
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [templateId, documentType, version]);
  return state ? <PagePreview res={state.res} project={state.project} scale={0.2} showGuides={false} ia={{ selectedId: null }} /> : <div className="gal-paper-skel np-skel"><span className="spinner" /></div>;
}

function NewProjectDialog({ onClose, onDescribe }: { onClose: () => void; onDescribe: () => void }) {
  const navigate = useNavigate();
  const canEditHere = useCan('edit');
  const editWhy = useStudio((st) => editBlockedReason(st.session)) ?? 'You do not have permission to create documents';
  const [templates, setTemplates] = useState<TemplateInfoDto[] | null>(null);
  const [canSave, setCanSave] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string>('blank-letter');
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [title, setTitle] = useState('');
  const [letterData, setLetterData] = useState<DocumentType>('credit-statement');
  const [issuer, setIssuer] = useState<string | null>(null);
  const [accent, setAccent] = useState<string>(NEUTRAL_ACCENT);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback((retired: boolean) => api.templates(retired).then((r) => { setTemplates(r.templates); setCanSave(r.canSave); setLoadErr(null); }).catch((e) => setLoadErr(e instanceof ApiFailure ? e.message : String(e.message ?? e))), []);
  useEffect(() => { void load(showRetired); }, [load, showRetired]);
  const builtIn = templates?.filter((t) => t.source !== 'saved') ?? [];
  const saved = templates?.filter((t) => t.source === 'saved') ?? [];
  const chosen = templates?.find((t) => t.id === sel);
  const isSaved = chosen?.source === 'saved';
  const versions = chosen?.versions ?? [];
  const latest = chosen?.version;
  const shownVersion = isSaved ? version ?? latest : undefined;
  const detail = versions.find((v) => v.version === shownVersion);
  const select = (id: string) => { setSel(id); setVersion(undefined); setConfirmRetire(false); setErr(null); };
  const isBlank = sel === BLANK_PROJECT_TEMPLATE_ID;
  const issuerName = (issuer ?? title).trim().replace(/\s+/g, ' ');
  const issuerOk = !isBlank || (issuerName.length >= ISSUER_NAME_MIN && issuerName.length <= ISSUER_NAME_MAX);
  const accentOk = !isBlank || ACCENT_PATTERN.test(accent);
  const usable = !!chosen && !chosen.retired && issuerOk && accentOk;
  const create = async () => {
    if (!chosen || !usable || title.trim().length < 2) return;
    setBusy(true); setErr(null);
    try {
      const { project } = await api.createProject({ templateId: chosen.id, title: title.trim(), ...(chosen.id === 'blank-letter' ? { documentType: letterData } : {}), ...(isBlank ? { issuerName, accent: accent.toLowerCase() } : {}), ...(isSaved && shownVersion ? { templateVersion: shownVersion } : {}) });
      await useStudio.getState().loadProjects();
      useStudio.getState().toast({ kind: 'success', title: 'Project created', message: `“${project.title}” is ready to design.` });
      onClose();
      navigate(`/studio/${project.projectId}/overview`);
    } catch (e) { setErr(e instanceof ApiFailure ? e.message : String((e as Error).message ?? e)); setBusy(false); }
  };
  const setRetired = async (retired: boolean, t: TemplateInfoDto) => {
    setBusy(true); setErr(null);
    try {
      await api.setTemplateRetired(t.id, retired);
      useStudio.getState().toast({ kind: 'success', title: retired ? 'Template retired' : 'Template brought back', message: retired ? `“${t.title}” is no longer offered for new projects. Projects already started from it are unchanged.` : `“${t.title}” can be chosen again.` });
      setConfirmRetire(false);
      if (retired && !showRetired) select('blank-letter');
      await load(showRetired);
    } catch (e) { setErr(e instanceof ApiFailure ? e.message : String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };
  const card = (t: TemplateInfoDto) => {
    const savedT = t.source === 'saved';
    const on = sel === t.id;
    return (
      <div key={t.id} className="np-item">
        <button type="button" role="radio" aria-checked={on} disabled={!!t.retired} className={`np-card${on ? ' on' : ''}${t.retired ? ' retired' : ''}`} onClick={() => select(t.id)} data-testid={`template-${t.id}`}>
          <span className="np-thumb" aria-hidden="true"><TemplateThumb templateId={t.id} documentType={letterData} version={savedT && on ? shownVersion : undefined} /></span>
          <span className="np-name">{t.title}</span>
          <span className="row wrap np-chips">
            <span className="chip accent">{DOC_LABEL[t.id === 'blank-letter' ? letterData : t.documentType]}</span>
            {savedT && <span className="chip">Saved · v{t.version}</span>}
            {t.retired && <span className="chip warning">Retired</span>}
          </span>
          <span className="muted np-desc">{t.description || (savedT ? 'No description.' : '')}</span>
        </button>
        {t.retired && canSave && <button type="button" className="btn sm" onClick={() => setRetired(false, t)} disabled={busy} data-testid="template-unretire" aria-label={`Bring back “${t.title}”`}>Bring back</button>}
      </div>
    );
  };
  return (
    <Dialog title="New project" onClose={onClose} labelledBy="new-project-title"
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={create} disabled={busy || !usable || title.trim().length < 2} data-testid="create-project">Create project</button></>}>
      <form className="np-root" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <div className="np-describe" data-testid="setup-entry">
          <div className="np-describe-text">
            <h3 className="np-heading">Describe your document</h3>
            <p className="muted">Say what it is for and what it shows; the assistant proposes the fields, layout, messages and rules for you to approve.</p>
            {!canEditHere && <p className="np-bad" data-testid="setup-open-why">{editWhy}, so this is not available to you.</p>}
          </div>
          <button type="button" className="btn primary" onClick={onDescribe} disabled={!canEditHere} title={canEditHere ? 'Describe the document and let the assistant propose a setup' : editWhy} data-testid="setup-open">Describe your document</button>
        </div>
        <h3 className="np-heading">Or start from a template</h3>
        {loadErr && <p className="callout error" role="alert">{loadErr}</p>}
        {!templates && !loadErr && <Loading label="Loading templates…" />}
        <div className="np-cards" role="radiogroup" aria-label="Template">
          {builtIn.map(card)}
        </div>
        {(saved.length > 0 || canSave) && (
          <>
            <div className="row np-saved-head">
              <h3 className="np-heading">Saved templates</h3>
              {canSave && <label className="np-check"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} data-testid="template-show-retired" /> Show retired templates</label>}
            </div>
            {saved.length === 0 && <p className="muted np-empty">No saved templates yet. Use “Save as template…” in a project’s menu to add one.</p>}
            <div className="np-cards" role="radiogroup" aria-label="Saved templates">
              {saved.map(card)}
            </div>
          </>
        )}
        {sel === 'blank-letter' && (
          <div className="field">
            <label htmlFor="np-data">Sample data for the letter</label>
            <select id="np-data" className="select" value={letterData} onChange={(e) => setLetterData(e.target.value as DocumentType)} data-testid="blank-letter-data">
              <option value="credit-statement">Credit-card statement data</option>
              <option value="eob">Healthcare EOB data</option>
            </select>
          </div>
        )}
        {isBlank && (
          <div className="np-detail np-blank" data-testid="blank-project-options">
            <p className="muted">An empty page with <strong>your own data fields</strong>. Only the customer’s name and language are given; you add the fields (text, numbers, amounts, dates, choices, yes/no and lists), the layout and the rules. Customers to preview with are generated for you.</p>
            <div className="field">
              <label htmlFor="np-issuer">Who the document is from</label>
              <input id="np-issuer" className="input" value={issuer ?? title} maxLength={ISSUER_NAME_MAX + 20} aria-invalid={!issuerOk} onChange={(e) => setIssuer(e.target.value)} placeholder="e.g. Northside Gym" data-testid="blank-issuer-name" />
              <span className={`hint${issuerOk ? '' : ' np-bad'}`} role={issuerOk ? undefined : 'alert'}>{issuerOk ? `${ISSUER_NAME_MIN}–${ISSUER_NAME_MAX} characters. It appears as the sender on the page.` : `The name must be ${ISSUER_NAME_MIN}–${ISSUER_NAME_MAX} characters.`}</span>
            </div>
            <div className="field">
              <label htmlFor="np-accent">Brand colour</label>
              <div className="row np-accent">
                <input id="np-accent" type="color" className="np-swatch" value={ACCENT_PATTERN.test(accent) ? accent.toLowerCase() : NEUTRAL_ACCENT} onChange={(e) => setAccent(e.target.value)} data-testid="blank-accent" />
                <input className="input mono np-hex" aria-label="Brand colour as a hex value" value={accent} maxLength={7} aria-invalid={!accentOk} onChange={(e) => setAccent(e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`)} data-testid="blank-accent-hex" />
              </div>
              <span className={`hint${accentOk ? '' : ' np-bad'}`}>{accentOk ? 'Used for headings and accents.' : 'Use a 6-digit hex value such as #1F4E79.'}</span>
            </div>
          </div>
        )}
        {isSaved && chosen && (
          <div className="np-detail" data-testid="template-detail">
            <div className="row wrap">
              <strong>{chosen.title}</strong>
              {chosen.retired && <span className="chip warning">Retired</span>}
              {versions.length > 1 && (
                <span className="np-ver">
                  <label htmlFor="np-version">Version</label>
                  <select id="np-version" className="select" value={shownVersion} onChange={(e) => setVersion(Number(e.target.value))} data-testid="template-version">
                    {versions.map((v) => <option key={v.version} value={v.version}>v{v.version}{v.version === latest ? ' (latest)' : ''}</option>)}
                  </select>
                </span>
              )}
            </div>
            {detail && (
              <>
                <p className="np-who">Version {detail.version} saved by {detail.savedBy?.name ?? 'someone who is no longer listed'} on {new Date(detail.savedAt).toLocaleString()}, from the document “{detail.from.title}”<Tech> (its version {detail.from.modelVersion})</Tech>.</p>
                {detail.note && <p className="np-note"><span className="muted">What changed:</span> {detail.note}</p>}
                <CountsList counts={detail.counts} />
              </>
            )}
            {canSave && !chosen.retired && (
              confirmRetire
                ? (
                  <div className="callout warning np-retire" role="group" aria-label="Confirm retiring">
                    <p>Retire “{chosen.title}”? It will no longer be offered for new projects. Projects already started from it are not changed, and you can bring it back later.</p>
                    <div className="row"><button type="button" className="btn danger sm" onClick={() => setRetired(true, chosen)} disabled={busy} data-testid="template-retire-confirm">Retire template</button><button type="button" className="btn ghost sm" onClick={() => setConfirmRetire(false)}>Keep it</button></div>
                  </div>
                )
                : <div className="row"><button type="button" className="btn sm" onClick={() => setConfirmRetire(true)} data-testid="template-retire">Retire this template</button></div>
            )}
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
  const [importingProject, setImportingProject] = useState(false);
  const canEdit = useCan('edit');
  const editBlock = useStudio((st) => editBlockedReason(st.session)) ?? 'You do not have permission to import projects';
  const [creating, setCreating] = useState(false);
  const [describing, setDescribing] = useState(false);
  const closeDescribe = useCallback(() => setDescribing(false), []);
  const closeCreating = useCallback(() => setCreating(false), []);
  const openDescribe = useCallback(() => { setCreating(false); setDescribing(true); }, []);
  const [tick, setTick] = useState(0);
  const closeImportProject = useCallback(() => setImportingProject(false), []);
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
  const navigate = useNavigate();
  // The studio shell highlights and focuses the customer picker once the project has actually loaded (?show=customer).
  const tryCustomer = () => navigate('/studio/aster-card-demo/design?show=customer');
  const imported = (counts?.importedCard ?? 0) + (counts?.importedEob ?? 0);
  return (
    <section className="screen" data-testid="project-gallery">
      <ScreenHeader id="S01" title="Project Gallery" subtitle="Design in 2D. Understand in 2.5D. Simulate across personas and time. Compose into faithful paged and interactive outputs."
        actions={<>
          <button className="btn primary" onClick={() => setCreating(true)} data-testid="new-project"><Icon.plus /> New project</button>
          <button className="btn" onClick={() => setImportingProject(true)} disabled={!canEdit} title={canEdit ? 'Import a studio project file as a new draft' : editBlock} data-testid="import-project"><Icon.download style={{ transform: 'rotate(180deg)' }} /> Import project</button>
          <button className="btn ghost" onClick={() => setImporting(true)} data-testid="import-records"><Icon.plus /> Import records</button>
        </>} />
      <div className="screen-body gal-grid">
        <div className="gal-cards">
          {status === 'loading' && !projects.length && <Loading label="Loading projects…" />}
          {status === 'error' && <ErrorState title="Projects could not be loaded" message={error ?? ''} onRetry={() => useStudio.getState().loadProjects()} />}
          {status === 'ready' && !projects.length && <Empty title="No projects" message="The local store is empty. Restart the API to re-seed the approved samples." />}
          {ordered.map((p) => <ProjectCard key={p.projectId} p={p} hero={p.projectId === 'aster-card-demo'} sourceTitle={titleOf(p.derivedFrom?.projectId)} />)}
          <div className="gal-foot">
            <button type="button" className="btn ghost sm" onClick={() => setConfirmAll(true)} data-testid="reset-demo" title="Return both sample projects to their approved models (your own projects are kept)"><Icon.reset /> Restore both samples</button>
          </div>
        </div>
        <aside className="panel gal-side" data-side="right" data-side-title="Start here">
          <div className="panel-head">Start here</div>
          <div className="panel-body">
            <ol className="gal-steps">
              <li><span className="gal-step-n" aria-hidden="true">1</span><div><strong>Open a sample</strong><span className="muted">See the document Aster Card sends.</span> <Link to="/studio/aster-card-demo/overview" data-testid="start-open-sample">Open Aster Card</Link></div></li>
              <li><span className="gal-step-n" aria-hidden="true">2</span><div><strong>Switch the customer</strong><span className="muted">Use the customer picker in the top bar and watch the document change.</span> <button type="button" className="gal-link" onClick={tryCustomer} data-testid="start-switch-customer">Show me where</button></div></li>
              <li><span className="gal-step-n" aria-hidden="true">3</span><div><strong>Check and export it</strong><span className="muted">Run the checks, compare outputs, then download a PDF.</span> <Link to="/studio/aster-card-demo/validate" data-testid="start-validate">Go to Validate &amp; Compare</Link></div></li>
            </ol>
            <p className="muted gal-note" data-testid="synthetic-statement">All sample people, accounts, providers and organisations are fictional ({counts ? `${counts.card} card and ${counts.eob} EOB records` : '…'}, seed SPATIAL-STUDIO-DEMO-2026-11). Nothing here connects to production data.</p>
            <div className="section-title">Your records</div>
            <p className="muted gal-note">{imported ? <>{counts!.importedCard} card and {counts!.importedEob} EOB record{imported === 1 ? '' : 's'} imported. They appear in the customer picker and in every view.</> : 'Import your own scenario records (CSV or JSON) to test the design against them.'}</p>
            <div className="row wrap">
              <button className="btn sm" onClick={() => setImporting(true)}><Icon.plus /> Import records</button>
              {imported > 0 && <button className="btn sm ghost" onClick={clearImported} data-testid="clear-imported"><Icon.trash /> Remove imported</button>}
            </div>
            <details className="gal-real" data-testid="real-vs-simulated">
              <summary>What is real and what is simulated</summary>
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
            </details>
            <p className="muted gal-stats-line">{counts ? `${counts.card + counts.eob} synthetic records` : '…'} · 12 personas · 15 component types · 20 sample rules</p>
          </div>
        </aside>
      </div>
      {confirmAll && (
        <Dialog title="Restore both samples?" onClose={() => setConfirmAll(false)} footer={<><button className="btn" onClick={() => setConfirmAll(false)}>Cancel</button><button className="btn danger" onClick={resetAll} data-testid="confirm-reset-demo">Restore both samples</button></>}>
          <p>Both sample projects return to their approved models, issued snapshots are cleared and saved view context is forgotten. Your own projects and imported records are kept. Use this before a stakeholder run.</p>
        </Dialog>
      )}
      {creating && <NewProjectDialog onClose={closeCreating} onDescribe={openDescribe} />}
      {describing && <SetupDialog onClose={closeDescribe} />}
      {importingProject && <ImportProjectDialog onClose={closeImportProject} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={recordsChanged} />}
    </section>
  );
}
