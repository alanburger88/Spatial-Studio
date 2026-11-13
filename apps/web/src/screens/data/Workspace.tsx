import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, SyntheticRecord } from '@iss/model';
import { buildContext } from '@iss/model';
import { api, ApiFailure, type RecordProblem } from '../../api/client';
import { useStudio } from '../../state/store';
import { Dialog, Tech } from '../../ui/common';
import { Icon } from '../../ui/icons';
import { JsonEditor } from './JsonEditor';
import { OutcomePanel } from './Outcome';
import { GroupView, OtherValues } from './Tree';
import { EditorContext, type EditorCtx } from './Fields';
import { BlockerBanner } from './BlockerBanner';
import { bookkeepingOf, buildSections, editablePart, isOwn, ORIGIN_LABEL, originOf, otherValues, problemsFor, plainProblem, recordName, setIn, stableStringify, type Problem, type Rec } from './explorerModel';

type Mode = 'form' | 'json';
const NO_HIGHLIGHT: string[] = [];

const format = (r: Rec) => JSON.stringify(editablePart(r), null, 2);

/** The centre (the customer as a nested tree or JSON) and the right panel (what this customer gets) for ONE customer. Remounted per customer. */
export function Workspace({ project, saved, canEdit, blockedReason, onDirty, onMakeCopy, onDeleted, onPreview, highlight = NO_HIGHLIGHT, blockerId = null }: {
  project: Project; saved: SyntheticRecord; canEdit: boolean; blockedReason: string | null;
  onDirty: (dirty: boolean) => void; onMakeCopy: (id: string) => void; onDeleted: (id: string) => void; onPreview: (id: string) => void;
  /** Opened from a blocker: the values it is about (highlighted and scrolled to) and the blocker (banner with a link back). */
  highlight?: string[]; blockerId?: string | null;
}) {
  const refreshRecords = useStudio((s) => s.refreshRecords);
  const technical = useStudio((s) => s.viewMode) === 'technical';
  const origin = originOf(saved);
  const own = isOwn(origin);
  const readOnly = !canEdit || !own;
  const [draft, setDraft] = useState<Rec>(() => JSON.parse(JSON.stringify(saved)));
  const [mode, setMode] = useState<Mode>('form');
  const [jsonText, setJsonText] = useState(() => format(saved));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>(() => problemsFor(saved, project));
  const [serverProblems, setServerProblems] = useState<RecordProblem[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Opened from a blocker: open and scroll to the first value it is about.
  const [jump, setJump] = useState<{ path: string; n: number } | null>(() => (highlight.length ? { path: highlight[0], n: 1 } : null));
  const [allProblems, setAllProblems] = useState(false);
  const [busy, setBusy] = useState(false);

  const dirty = useMemo(() => stableStringify(editablePart(draft)) !== stableStringify(editablePart(saved)), [draft, saved]);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  useEffect(() => { onDirtyRef.current(dirty); }, [dirty]);
  useEffect(() => () => onDirtyRef.current(false), []);

  // Check the values as they are typed (debounced) against the document's data fields.
  useEffect(() => {
    const h = setTimeout(() => setProblems(problemsFor(draft, project)), 120);
    return () => clearTimeout(h);
  }, [draft, project]);

  const update = useCallback((next: Rec) => { setDraft(next); setJsonText(format(next)); setJsonError(null); setServerProblems([]); }, []);
  const set = useCallback((segs: Array<string | number>, value: unknown) => { setDraft((d) => { const next = setIn(d, segs, value); setJsonText(format(next)); setJsonError(null); return next; }); setServerProblems([]); }, []);

  const onJson = (text: string) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { setJsonError('The customer must be one JSON object, written between { and }.'); return; }
      setJsonError(null); setServerProblems([]);
      setDraft({ ...bookkeepingOf(saved), ...editablePart(parsed) });
    } catch (e) { setJsonError(e instanceof Error ? e.message : 'The text could not be read.'); }
  };
  const switchMode = (m: Mode) => { if (m === 'form' && jsonError) { setJsonText(format(draft)); setJsonError(null); } setMode(m); };

  const sections = useMemo(() => buildSections(project), [project]);
  const values = useMemo(() => { try { return buildContext(draft as SyntheticRecord); } catch { return draft; } }, [draft]);
  const others = useMemo(() => otherValues(draft, project), [draft, project]);
  const ctx: EditorCtx = useMemo(() => ({ project, record: draft, values, readOnly, problems, set, jump, highlight }), [project, draft, values, readOnly, problems, set, jump, highlight]);

  const jumpTo = (path: string | null) => {
    if (!path) return;
    if (mode === 'json') setMode('form');
    setJump({ path, n: Date.now() });
  };
  useEffect(() => {
    if (!jump) return;
    const t = setTimeout(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement>('[data-dx-path]')).find((e) => e.dataset.dxPath === jump.path);
      el?.scrollIntoView({ block: 'center' });
      el?.focus();
    }, 80);
    return () => clearTimeout(t);
  }, [jump]);

  const hasProblems = problems.length > 0 || !!jsonError;
  const deferred = useDeferredValue(draft);
  const name = recordName(draft);

  const save = async () => {
    const now = problemsFor(draft, project);
    if (now.length || jsonError) { setProblems(now); return; }
    setSaving(true);
    try {
      const r = await api.saveRecord(project.projectId, saved.recordId, editablePart(draft));
      await refreshRecords();
      setServerProblems([]);
      useStudio.getState().toast({ kind: 'success', title: 'Customer saved', message: r.wasGenerated ? `${recordName(r.record)} is now one of your own customers; generating again will not replace it.` : recordName(r.record) });
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 422) setServerProblems((e.body?.error?.problems as RecordProblem[]) ?? []);
      else useStudio.getState().toast({ kind: 'error', title: 'The customer was not saved', message: e instanceof Error ? e.message : undefined });
    } finally { setSaving(false); }
  };
  const discard = () => update(JSON.parse(JSON.stringify(saved)));
  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteRecord(project.projectId, saved.recordId);
      useStudio.getState().toast({ kind: 'success', title: 'Customer deleted', message: name });
      setConfirmDelete(false);
      onDirtyRef.current(false);
      onDeleted(saved.recordId);
    } catch (e) { useStudio.getState().toast({ kind: 'error', title: 'The customer was not deleted', message: e instanceof Error ? e.message : undefined }); } finally { setBusy(false); }
  };

  const saveBlockedBy = !canEdit ? blockedReason ?? 'You cannot edit' : jsonError ? 'Fix the JSON first' : problems.length ? 'Fix the values marked in the form first' : !dirty ? 'Nothing has changed' : null;
  const shownProblems = allProblems ? problems : problems.slice(0, 5);

  return (
    <>
      <div className="panel dx-main" data-testid="dx-record" data-record={saved.recordId} data-origin={origin}>
        <div className="dx-record-head">
          <div className="dx-record-title">
            <h2 data-testid="dx-record-name">{name}</h2>
            <span className={`chip ${origin === 'yours' ? 'accent' : origin === 'generated' ? 'info' : origin === 'imported' ? 'variant' : ''}`} data-testid="dx-origin">{ORIGIN_LABEL[origin]}</span>
            {dirty && <span className="chip warning" data-testid="dx-dirty">Unsaved changes</span>}
            <Tech><span className="chip code">{saved.recordId}</span></Tech>
          </div>
          <div className="dx-record-actions">
            <div className="segmented" role="group" aria-label="View as">
              <button type="button" data-testid="dx-mode-form" aria-pressed={mode === 'form'} className={mode === 'form' ? 'active' : ''} onClick={() => switchMode('form')}>Form</button>
              <button type="button" data-testid="dx-mode-json" aria-pressed={mode === 'json'} className={mode === 'json' ? 'active' : ''} onClick={() => switchMode('json')}>JSON</button>
            </div>
            {own && <button type="button" className="btn ghost danger sm" data-testid="dx-delete" disabled={!canEdit} title={canEdit ? 'Delete this customer' : blockedReason ?? undefined} onClick={() => setConfirmDelete(true)}><Icon.trash width={14} height={14} /> Delete</button>}
            {own && <button type="button" className="btn sm" data-testid="dx-discard" disabled={!dirty || saving} onClick={discard}>Discard changes</button>}
            {own && <button type="button" className="btn primary sm" data-testid="dx-save" disabled={saving || saveBlockedBy !== null} title={saveBlockedBy ?? 'Save this customer'} onClick={save}><Icon.save width={14} height={14} /> {saving ? 'Saving…' : 'Save'}</button>}
          </div>
        </div>

        <div className="dx-scroll">
          {blockerId && <BlockerBanner project={project} saved={saved} draft={deferred as SyntheticRecord} blockerId={blockerId} own={own} canEdit={canEdit} onMakeCopy={() => onMakeCopy(saved.recordId)} />}
          {(!canEdit || origin !== 'yours') && <div className={`callout dx-banner ${!canEdit ? 'warning' : origin === 'generated' ? 'accent' : ''}`} data-testid="dx-banner">
            {!canEdit ? (
              <>
              <p><strong>Read-only.</strong> {blockedReason ?? 'You cannot edit customers'}. You can look at every customer but not change, add or delete them.</p>
              {!own && <button type="button" className="btn primary sm" data-testid="dx-copy" disabled title={blockedReason ?? undefined}><Icon.copy width={14} height={14} /> Make an editable copy</button>}
              </>
            ) : !own ? (
              <>
                <p>{origin === 'imported' ? 'Imported customers are shared by every document and cannot be changed.' : 'Sample customers are shared by every document and cannot be changed.'}</p>
                <button type="button" className="btn primary sm" data-testid="dx-copy" onClick={() => onMakeCopy(saved.recordId)}><Icon.copy width={14} height={14} /> Make an editable copy</button>
              </>
            ) : origin === 'generated' ? (
              <div><p>Generated for this document. If you change it, it is kept as your own and generating again will not replace it.</p>{saved.generated?.label && <p className="muted dx-why" data-testid="dx-generated-why">Why this customer exists: {saved.generated.label}</p>}</div>
            ) : null}
          </div>}

          {(problems.length > 0 || serverProblems.length > 0) && (
            <div className="callout error dx-problems" data-testid="dx-problems" role="group" aria-label="Values to fix">
              <strong>{problems.length} {problems.length === 1 ? 'value does' : 'values do'} not fit the data fields</strong>
              <ul>
                {shownProblems.map((p) => (
                  <li key={(p.path ?? '') + p.message}>{p.path ? <button type="button" className="dx-linkish" onClick={() => jumpTo(p.path)}>{plainProblem(p.message, technical)}</button> : plainProblem(p.message, technical)}</li>
                ))}
              </ul>
              {problems.length > 5 && <button type="button" className="btn ghost sm" onClick={() => setAllProblems(!allProblems)}>{allProblems ? 'Show fewer' : `Show all ${problems.length}`}</button>}
              {serverProblems.length > 0 && <div data-testid="dx-server-problems"><strong>The server did not accept this customer:</strong><ul>{serverProblems.map((p) => <li key={p.message}>{p.message}</li>)}</ul></div>}
            </div>
          )}

          {mode === 'json' ? (
            <JsonEditor text={jsonText} error={jsonError} onChange={onJson} readOnly={readOnly} fixed={bookkeepingOf(saved)} />
          ) : (
            <EditorContext.Provider value={ctx}>
              <div className="dx-tree" data-testid="dx-tree">
                {sections.map((s) => <GroupView key={s.key} node={s} depth={0} />)}
                <OtherValues items={others} />
              </div>
            </EditorContext.Provider>
          )}
        </div>
      </div>

      <OutcomePanel project={project} saved={saved} draft={deferred as SyntheticRecord} hasProblems={hasProblems} jsonBroken={!!jsonError} dirty={dirty} recordId={saved.recordId}
        canPreview={!dirty} previewHint={dirty ? 'Save or discard your changes to preview this customer.' : null} onPreview={() => onPreview(saved.recordId)} />

      {confirmDelete && (
        <Dialog title="Delete this customer?" onClose={() => setConfirmDelete(false)} labelledBy="dx-del-title"
          footer={<><button type="button" className="btn" onClick={() => setConfirmDelete(false)}>Keep customer</button><button type="button" className="btn danger" data-testid="dx-delete-confirm" disabled={busy} onClick={remove}>Delete {name}</button></>}>
          <p data-testid="dx-delete-dialog">{name} will be removed from this document’s customers. Sample customers are not affected. This cannot be undone.</p>
        </Dialog>
      )}
    </>
  );
}

