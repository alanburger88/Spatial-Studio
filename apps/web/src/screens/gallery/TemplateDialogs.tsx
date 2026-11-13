import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiFailure, type ProjectImportReport, type ProjectSummary, type TemplateInfoDto, type TemplateVersionDto } from '../../api/client';
import { useStudio } from '../../state/store';
import { Dialog, Loading, Tech } from '../../ui/common';
import { Icon } from '../../ui/icons';

const errText = (e: unknown) => (e instanceof ApiFailure ? e.message : String((e as Error)?.message ?? e));

export const SAVE_TEMPLATE_DENIED = 'Only approvers and admins can save templates';
export const NOT_BROUGHT_IN = 'Customers, Version history, Review state, Comments';

/** "Taken from" counts, shared by the template detail and the import report. */
export function CountsList({ counts }: { counts: TemplateVersionDto['counts'] }) {
  return (
    <dl className="kv tpl-counts">
      <dt>Components</dt><dd>{counts.components}</dd>
      <dt>Rules</dt><dd>{counts.rules}</dd>
      <dt>Messages</dt><dd>{counts.messages}</dd>
      <dt>Languages</dt><dd>{counts.languages}</dd>
      <dt>Pinned tests</dt><dd>{counts.tests}</dd>
    </dl>
  );
}

/* ------------------------------------------------------------ save as template */

export function SaveTemplateDialog({ p, onClose }: { p: ProjectSummary; onClose: () => void }) {
  const [saved, setSaved] = useState<TemplateInfoDto[] | null>(null);
  const [mode, setMode] = useState<'new' | 'version'>('new');
  const [existingId, setExistingId] = useState('');
  const [name, setName] = useState(p.title);
  const [description, setDescription] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.templates(true).then((r) => { if (live) setSaved(r.templates.filter((t) => t.source === 'saved' && t.documentType === p.documentType)); }).catch((e) => { if (live) { setSaved([]); setErr(errText(e)); } });
    return () => { live = false; };
  }, [p.documentType]);
  const existing = saved?.find((t) => t.id === existingId);
  const pick = (id: string) => {
    setExistingId(id);
    const t = saved?.find((x) => x.id === id);
    if (t) { setName(t.title); setDescription(t.description); }
  };
  const chooseMode = (m: 'new' | 'version') => {
    setMode(m); setErr(null);
    if (m === 'version') { if (saved?.length) pick(existingId || saved[0].id); }
    else { setName(p.title); setDescription(''); }
  };
  const canSubmit = !busy && saved !== null && (mode === 'new' ? name.trim().length >= 2 : !!existing);
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.saveTemplate(mode === 'new'
        ? { projectId: p.projectId, title: name.trim(), description: description.trim(), note: note.trim() }
        : { projectId: p.projectId, templateId: existingId, description: description.trim(), note: note.trim() });
      useStudio.getState().toast({ kind: 'success', title: `Saved as template “${r.template.title}” (version ${r.version})`, message: 'It is now offered when you start a new project.' });
      onClose();
    } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  return (
    <Dialog title={<>Save “{p.title}” as a template</>} onClose={onClose} labelledBy="save-template-title"
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={submit} disabled={!canSubmit} data-testid="save-template-confirm">{mode === 'new' ? 'Save template' : 'Save new version'}</button></>}>
      <form className="tpl-form" data-testid="save-template-dialog" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {saved === null && <Loading label="Loading templates…" />}
        <fieldset className="tpl-choice">
          <legend className="label">Save it as</legend>
          <label className="tpl-radio"><input type="radio" name="tpl-mode" checked={mode === 'new'} onChange={() => chooseMode('new')} data-testid="save-template-mode-new" /> A new template</label>
          {!!saved?.length && <label className="tpl-radio"><input type="radio" name="tpl-mode" checked={mode === 'version'} onChange={() => chooseMode('version')} data-testid="save-template-mode-version" /> A new version of an existing template</label>}
        </fieldset>
        {mode === 'version' && saved && (
          <div className="field">
            <label htmlFor="st-existing">Template</label>
            <select id="st-existing" className="select" value={existingId} onChange={(e) => pick(e.target.value)} data-testid="save-template-existing">
              {saved.map((t) => <option key={t.id} value={t.id}>{t.title} · currently version {t.version}{t.retired ? ' (retired)' : ''}</option>)}
            </select>
            <span className="hint">Earlier versions are kept as they are and stay usable.</span>
          </div>
        )}
        <div className="field">
          <label htmlFor="st-name">Template name</label>
          <input id="st-name" className="input" value={name} maxLength={80} readOnly={mode === 'version'} onChange={(e) => setName(e.target.value)} data-testid="save-template-name" />
        </div>
        <div className="field">
          <label htmlFor="st-desc">Description</label>
          <textarea id="st-desc" className="textarea" rows={2} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} data-testid="save-template-description" />
          <span className="hint">Shown on the template’s card in “New project”. {description.length}/300</span>
        </div>
        <div className="field">
          <label htmlFor="st-note">What changed <span className="muted">(optional)</span></label>
          <input id="st-note" className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={mode === 'new' ? 'e.g. First version' : 'e.g. Updated the payment wording'} data-testid="save-template-note" />
        </div>
        <div className="callout tpl-incl">
          <p><strong>Included:</strong> layout, rules, wording, translations, email and SMS wording, glossary and pinned tests.</p>
          <p><strong>Not included:</strong> customers, version history, review state and comments.</p>
          <p className="muted">It is taken from the document’s last saved version<Tech> (version {p.modelVersion})</Tech>. Changes you have not saved are not included.</p>
        </div>
        {err && <p className="callout error" role="alert" data-testid="save-template-error">{err}</p>}
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------ import a project file */

type Problem = { code?: string; message: string };
type Check = { report: ProjectImportReport; title: string };
const MAX_BYTES = 8 * 1024 * 1024;

export function ImportProjectDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [file, setFile] = useState<unknown>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [title, setTitle] = useState('');
  const [problems, setProblems] = useState<Problem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => {
    const list = e instanceof ApiFailure ? (e.body as { error?: { problems?: Problem[] } } | undefined)?.error?.problems : undefined;
    if (e instanceof ApiFailure && e.status === 422 && list?.length) { setProblems(list); setErr(null); }
    else if (e instanceof ApiFailure && e.status === 422) { setProblems([{ message: e.message }]); setErr(null); }
    else setErr(errText(e));
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileName(f.name); setCheck(null); setFile(null); setProblems([]); setErr(null);
    if (f.size > MAX_BYTES) { setErr('This file is larger than 8 MB, which is too big for a studio project file.'); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(await f.text()); }
    catch { setProblems([{ message: 'This file is not a studio project file' }]); return; }
    setFile(parsed); setBusy(true);
    try {
      const r = await api.importProject(parsed, { dryRun: true });
      setCheck({ report: r.report, title: r.wouldCreate?.title ?? r.report.from.title });
      setTitle(r.wouldCreate?.title ?? r.report.from.title);
    } catch (e) { fail(e); }
    finally { setBusy(false); }
  };
  const canImport = !!check && !busy && problems.length === 0 && title.trim().length >= 2;
  const submit = async () => {
    if (!canImport) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.importProject(file, { title: title.trim() });
      const created = r.project!;
      await useStudio.getState().loadProjects();
      useStudio.getState().toast({ kind: 'success', title: 'Project imported', message: `“${created.title}” was added as a new draft. Nothing was replaced.` });
      onClose();
      navigate(`/studio/${created.projectId}/design`);
    } catch (e) { fail(e); setBusy(false); }
  };
  const report = check?.report;
  return (
    <Dialog title="Import project" onClose={onClose} labelledBy="import-project-title"
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={submit} disabled={!canImport} data-testid="import-project-confirm">Import as a new project</button></>}>
      <form className="tpl-form" data-testid="import-project-dialog" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="muted">Choose a project file downloaded with “Export project file”. It is checked first and always becomes a <strong>new draft</strong>; it never replaces an existing document.</p>
        <div className="field">
          <span className="label">Project file (.json, up to 8 MB)</span>
          <div className="row wrap">
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}><Icon.download style={{ transform: 'rotate(180deg)' }} /> {fileName ? 'Choose another file…' : 'Choose file…'}</button>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden aria-label="Project file" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} data-testid="import-project-file" />
            <span className="muted tpl-filename" title={fileName ?? undefined}>{fileName ?? 'No file chosen'}</span>
          </div>
        </div>
        {busy && !check && <Loading label="Checking the file…" />}
        {problems.length > 0 && (
          <div className="callout error" role="alert" data-testid="import-project-problems">
            <p><strong>This file cannot be imported. Nothing was imported.</strong></p>
            <ul className="tpl-list">{problems.map((pr, i) => <li key={i} data-testid="import-project-problem">{pr.message}</li>)}</ul>
          </div>
        )}
        {err && <p className="callout error" role="alert" data-testid="import-project-error">{err}</p>}
        {report && (
          <div className="tpl-report" data-testid="import-project-report" aria-live="polite">
            <p><strong>“{report.from.title}”</strong> <span className="muted">· saved as version {report.from.modelVersion} in the file</span></p>
            <CountsList counts={report.counts} />
            {report.warnings.length > 0 && <ul className="tpl-list tpl-warnings">{report.warnings.map((w, i) => <li key={i} data-testid="import-project-warning"><span className="chip warning">Note</span> {w}</li>)}</ul>}
            <p className="muted"><strong>Not brought in:</strong> {report.notImported.join(', ')}</p>
            <div className="field">
              <label htmlFor="ip-title">Name for the new project</label>
              <input id="ip-title" className="input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} data-testid="import-project-title" />
            </div>
          </div>
        )}
      </form>
    </Dialog>
  );
}
