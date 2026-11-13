import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  LOOKUP_TABLES_MAX, buildContext, evaluateCalculations, exprDependencies, lookupTableProblems, projectFields, validateLookupTable,
  type CalcType, type LookupKeyColumn, type LookupRow, type LookupTable, type Project,
} from '@iss/model';
import { Dialog, Empty, ScreenHeader, Tech } from '../ui/common';
import { Icon } from '../ui/icons';
import { useCan, useRecord, useResolution, useStudio } from '../state/store';
import { recordSummary } from '../shell/RecordPicker';
import { keyFromLabel, issueDateFor } from './calc/model';
import { Definition } from './lookup/Definition';
import { Grid, type RowProblem } from './lookup/Grid';
import { MATCH_NAME, TYPE_NAME, defaultKeyColumn } from './lookup/model';
import { PasteDialog } from './lookup/PasteDialog';
import { TryIt, type CustomerData } from './lookup/TryIt';
import './LookupTables.css';

/**
 * Lookup tables (S23): small tables kept with the document, such as a fee by tier, that a calculation reads. A list, a
 * table editor (columns, a keyboard-operable grid that shows only the rows in view, paste from a spreadsheet), a
 * "Try it" and where each table is used. Every edit is one undoable command.
 */
export function LookupTables() {
  const project = useStudio((s) => s.project)!;
  const res = useResolution();
  const record = useRecord();
  const personas = useStudio((s) => s.personas);
  const canEdit = useCan('edit');
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [refusal, setRefusal] = useState<{ id: string; message: string } | null>(null);
  const dirtyRef = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const onDirty = useCallback((d: boolean) => { dirtyRef.current = d; }, []);

  const tables = project.lookupTables ?? [];
  const selected = tables.find((t) => t.id === params.get('table')) ?? tables[0] ?? null;
  const locale = res?.locale ?? 'en-US';
  const calcs = project.calculatedFields ?? [];

  const readers = useMemo(() => new Map(tables.map((t) => [t.id, calcs.filter((c) => exprDependencies(c.expr).tables.includes(t.id))])), [tables, calcs]);
  const go = (id: string) => { dirtyRef.current = false; setRefusal(null); setParams({ table: id }, { replace: true }); };
  /** Choosing another table with unsaved changes asks first. */
  const select = (id: string) => { if (dirtyRef.current && id !== selected?.id) setPending(id); else go(id); };

  // The current customer, as the calculations see it (only needed when a calculation reads a table).
  const anyReader = [...readers.values()].some((l) => l.length > 0);
  const customer: CustomerData | null = useMemo(() => {
    const rec = res?.effectiveRecord ?? record;
    if (!rec || !anyReader) return null;
    const data = buildContext(rec) as Record<string, unknown>;
    const issue = issueDateFor(project, data, null);
    if (project.documentDate) data.document = { date: issue };
    const out = evaluateCalculations(project, data, issue);
    return { name: recordSummary(rec, personas).name, ctx: data, issue, missing: out.missing };
  }, [project, res?.effectiveRecord, record, personas, anyReader]);

  const create = (table: LookupTable): string | null => {
    const r = useStudio.getState().dispatch({ type: 'UPSERT_LOOKUP_TABLE', table });
    if (!r.ok) return r.message;
    select(table.id);
    return null;
  };
  const remove = (t: LookupTable) => {
    const r = useStudio.getState().dispatch({ type: 'DELETE_LOOKUP_TABLE', tableId: t.id });
    if (!r.ok) setRefusal({ id: t.id, message: r.message });
    else { setRefusal(null); setParams({}, { replace: true }); useStudio.getState().toast({ kind: 'success', title: 'Table removed', message: `“${t.title}”. Undo with Ctrl+Z.` }); }
  };

  return (
    <section className="screen" data-testid="lookup-tables-screen">
      <ScreenHeader id="S23" title="Lookup tables" subtitle="Small tables, such as a fee by tier, that a calculation reads."
        actions={<button type="button" className="btn sm primary" onClick={() => setAdding(true)} disabled={!canEdit || tables.length >= LOOKUP_TABLES_MAX} data-testid="lk-add"><Icon.plus /> Add a table</button>} />
      {tables.length === 0 ? (
        <div className="screen-body lk-body lk-solo">
          <div className="lk-empty" data-testid="lk-empty">
            <Empty title="No lookup tables yet" message="A lookup table holds values that depend on a key, such as a late fee by account tier or a notice period by state. A calculation reads one value from it with a lookup step. Keys can be exact text, a range of numbers or a range of dates.">
              <button type="button" className="btn primary" onClick={() => setAdding(true)} disabled={!canEdit} data-testid="lk-empty-add"><Icon.plus /> Add a table</button>
            </Empty>
          </div>
        </div>
      ) : (
        <div className="screen-body lk-body">
          <aside className="panel" data-side="left" data-side-title="Tables" aria-label="Lookup tables">
            <div className="panel-head"><h2 className="section-title">Tables <span className="chip count">{tables.length}</span></h2></div>
            <div className="panel-body flush">
              <div className="list-rows" data-testid="lk-list">
                {tables.map((t) => {
                  const errors = validateLookupTable(t).length;
                  const warnings = lookupTableProblems(t).filter((p) => p.severity === 'warning').length;
                  const users = readers.get(t.id) ?? [];
                  return (
                    <button key={t.id} type="button" className={`lk-listrow${t.id === selected?.id ? ' selected' : ''}`} aria-current={t.id === selected?.id ? 'true' : undefined} data-testid={`lk-row-item-${t.id}`} onClick={() => select(t.id)}>
                      <span className="lk-listname">{t.title}</span>
                      <span className="lk-listfoot">
                        <span className="chip count" data-testid={`lk-rows-${t.id}`}>{t.rows.length.toLocaleString('en-US')} row{t.rows.length === 1 ? '' : 's'}</span>
                        {errors > 0 && <span className="chip error">{errors} problem{errors === 1 ? '' : 's'}</span>}
                        {warnings > 0 && <span className="chip warning">{warnings} gap{warnings === 1 ? '' : 's'}</span>}
                        <span className="muted">{users.length ? `Read by ${users.length}` : 'Not used yet'}</span>
                      </span>
                      <Tech><span className="chip code">{t.id}</span></Tech>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          {selected && (
            <Workspace key={selected.id} table={selected} project={project} locale={locale} canEdit={canEdit} customer={customer} onDirty={onDirty}
              readers={readers.get(selected.id) ?? []} refusal={refusal && refusal.id === selected.id ? refusal.message : null} onRemove={() => remove(selected)} />
          )}
        </div>
      )}
      {pending && (
        <Dialog title="Leave without saving?" onClose={() => setPending(null)} labelledBy="lk-leave-title"
          footer={<><button type="button" className="btn" data-testid="lk-leave-stay" onClick={() => setPending(null)}>Keep editing</button><button type="button" className="btn danger" data-testid="lk-leave-discard" onClick={() => { const id = pending; setPending(null); go(id); }}>Discard changes</button></>}>
          <p>“{selected?.title}” has changes that are not saved. Choosing another table discards them.</p>
        </Dialog>
      )}
      {adding && <AddDialog project={project} onClose={() => setAdding(false)} onCreate={(t) => { const m = create(t); if (!m) setAdding(false); return m; }} />}
    </section>
  );
}

function SidePanel({ draft, project, readers, customer, locale }: { draft: LookupTable; project: Project; readers: Array<{ key: string; label: string }>; customer: CustomerData | null; locale: string }) {
  return (
    <div className="panel-body lk-sidebody">
      <h3 className="section-title">Try it</h3>
      <TryIt table={draft} project={project} customer={customer} locale={locale} />
      <h3 className="section-title lk-used-h">Where it is used</h3>
      {readers.length === 0 ? <p className="muted" data-testid="lk-used">No calculation reads this table yet.</p> : (
        <ul className="calc-used" data-testid="lk-used">
          {readers.map((c) => <li key={c.key}><span className="chip">Calculation</span> <Link to={`/studio/${project.projectId}/calculations?calc=${encodeURIComponent(c.key)}`}>{c.label}</Link></li>)}
        </ul>
      )}
    </div>
  );
}

/** The table being edited (the draft is shared by the editor and "Try it", so a change can be tried before it is saved). */
function Workspace({ table, project, locale, canEdit, customer, readers, refusal, onRemove, onDirty }: { onDirty: (d: boolean) => void; table: LookupTable; project: Project; locale: string; canEdit: boolean; customer: CustomerData | null; readers: Array<{ key: string; label: string }>; refusal: string | null; onRemove: () => void }) {
  const savedJson = useMemo(() => JSON.stringify(table), [table]);
  const [draft, setDraft] = useState<LookupTable>(table);
  useEffect(() => { setDraft(table); }, [savedJson]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== savedJson;
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="panel lk-main" aria-label="Edit the table">
        <div className="panel-body">
          {refusal && (
            <div className="callout error lk-refusal" role="alert" data-testid="lk-refusal">
              <strong>It cannot be removed yet.</strong> <span data-testid="lk-refusal-message">{refusal}</span>
              <ul className="calc-used">{readers.map((c) => <li key={c.key}><span className="chip">Calculation</span> <Link to={`/studio/${project.projectId}/calculations?calc=${encodeURIComponent(c.key)}`}>{c.label}</Link></li>)}</ul>
            </div>
          )}
          <TableEditor table={table} draft={draft} setDraft={setDraft} savedJson={savedJson} locale={locale} canEdit={canEdit} onRemove={onRemove} />
        </div>
      </div>
      <aside className="panel lk-side" data-side="right" data-side-title="Try it" aria-label="Try the table and where it is used">
        <SidePanel draft={draft} project={project} readers={readers} customer={customer} locale={locale} />
      </aside>
    </>
  );
}

function TableEditor({ table, draft, setDraft, savedJson, locale, canEdit, onRemove }: { table: LookupTable; draft: LookupTable; setDraft: Dispatch<SetStateAction<LookupTable>>; savedJson: string; locale: string; canEdit: boolean; onRemove: () => void }) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState<string | null>(null);
  const [focusRow, setFocusRow] = useState<{ row: number; tick: number } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [columnsOpen] = useState(() => table.rows.length === 0);

  useEffect(() => { setSaveError(null); }, [savedJson]);

  const problems = useMemo(() => lookupTableProblems(draft), [draft]);
  const refused = useMemo(() => validateLookupTable(draft), [draft]);
  const rowProblems = useMemo(() => {
    const m = new Map<number, RowProblem>();
    for (const p of problems) for (const r of p.rows) {
      const cur = m.get(r);
      m.set(r, { severity: cur?.severity === 'error' || p.severity === 'error' ? 'error' : 'warning', messages: [...(cur?.messages ?? []), p.message] });
    }
    return m;
  }, [problems]);
  const dirty = JSON.stringify(draft) !== savedJson;
  const dupMessages = new Set(problems.map((p) => p.message));
  const otherErrors = refused.filter((m) => !dupMessages.has(m));
  const errorProblems = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');

  const save = () => {
    setSaveError(null);
    const r = useStudio.getState().dispatch({ type: 'UPSERT_LOOKUP_TABLE', table: draft });
    if (r.ok) useStudio.getState().toast({ kind: 'success', title: 'Table saved', message: `“${draft.title}”. Undo with Ctrl+Z; Save in the top bar keeps it.` });
    else setSaveError(r.message);
  };
  const applyPaste = (rows: LookupRow[], mode: 'add' | 'replace') => {
    setDraft((d) => ({ ...d, rows: mode === 'replace' ? rows : [...d.rows, ...rows] }));
    setPasteText(null);
  };

  return (
    <div className="lk-editor" data-testid="lk-editor" data-id={table.id}>
      <div className="lk-ed-head">
        <div className="field"><label htmlFor="lk-title">Name</label>
          <input id="lk-title" ref={nameRef} className="input" value={draft.title} maxLength={80} disabled={!canEdit} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} data-testid="lk-title" />
          <Tech><span className="hint mono">LOOKUP("{table.id}", …)</span></Tech></div>
        <div className="lk-ed-actions">
          <button type="button" className="btn sm" onClick={() => nameRef.current?.focus()} disabled={!canEdit} data-testid="lk-rename">Rename</button>
          <button type="button" className="btn sm" onClick={() => setPasteText('')} disabled={!canEdit} data-testid="lk-paste"><Icon.copy /> Paste from a spreadsheet</button>
          <button type="button" className="btn sm danger" onClick={onRemove} disabled={!canEdit} data-testid="lk-remove"><Icon.trash /> Remove</button>
        </div>
      </div>
      <div className="field"><label htmlFor="lk-desc">What it is for (optional)</label>
        <input id="lk-desc" className="input" value={draft.description ?? ''} maxLength={300} disabled={!canEdit} onChange={(e) => setDraft((d) => { const { description: _x, ...rest } = d; return e.target.value ? { ...rest, description: e.target.value } : rest; })} /></div>

      <details className="lk-details" open={columnsOpen || undefined} data-testid="lk-columns-details">
        <summary>Columns and what happens when nothing matches</summary>
        <Definition table={draft} onChange={setDraft} disabled={!canEdit} />
      </details>

      <section className="lk-problems" aria-labelledby="lk-problems-h" data-testid="lk-problems">
        <h3 className="section-title" id="lk-problems-h">Problems</h3>
        {errorProblems.length + otherErrors.length + warnings.length === 0 ? <p className="muted" data-testid="lk-no-problems">No problems found: no duplicate keys, overlapping ranges or gaps.</p> : (
          <>
            <p className="lk-sum" data-testid="lk-problem-summary">
              {errorProblems.length + otherErrors.length > 0 && <><span className="chip error">{errorProblems.length + otherErrors.length} problem{errorProblems.length + otherErrors.length === 1 ? '' : 's'}</span>{' '}</>}
              {warnings.length > 0 && <span className="chip warning">{warnings.length} gap{warnings.length === 1 ? '' : 's'}</span>}
              {errorProblems.length + otherErrors.length > 0 && <span className="muted"> The studio will not save the table until the problems are fixed.</span>}
            </p>
            <ul className="lk-problem-list">
              {[...errorProblems, ...warnings].slice(0, 12).map((p, i) => (
                <li key={i} data-kind={p.kind} data-severity={p.severity}>
                  <span className={`chip ${p.severity === 'error' ? 'error' : 'warning'}`}>{p.kind === 'duplicate' ? 'Duplicate key' : p.kind === 'overlap' ? 'Overlap' : 'Gap'}</span>{' '}
                  {p.message}{' '}
                  <button type="button" className="linklike" onClick={() => setFocusRow((f) => ({ row: p.rows[p.rows.length - 1], tick: (f?.tick ?? 0) + 1 }))}>Go to row {p.rows[p.rows.length - 1]}</button>
                </li>
              ))}
              {otherErrors.slice(0, 8).map((m, i) => <li key={`o${i}`} data-severity="error"><span className="chip error">Problem</span> {m}</li>)}
              {errorProblems.length + warnings.length > 12 && <li className="muted">and {errorProblems.length + warnings.length - 12} more</li>}
            </ul>
          </>
        )}
      </section>

      <Grid table={draft} onChange={(rows) => setDraft((d) => ({ ...d, rows }))} rowProblems={rowProblems} locale={locale} disabled={!canEdit} onPaste={(t) => setPasteText(t)} focusRow={focusRow} />

      <div className="lk-savebar" data-testid="lk-savebar">
        <span className="lk-savestate" role="status" data-testid="lk-save-state">{!canEdit ? 'You can look at this table but not change it.' : dirty ? 'You have changes that are not saved.' : 'Saved.'}</span>
        <button type="button" className="btn" onClick={() => { setDraft(table); setSaveError(null); }} disabled={!dirty} data-testid="lk-revert">Revert</button>
        <button type="button" className="btn primary" onClick={save} disabled={!canEdit || !dirty} data-testid="lk-save">Save table</button>
      </div>
      {saveError && <p className="callout error" role="alert" data-testid="lk-save-error">{saveError}</p>}
      {pasteText !== null && <PasteDialog table={draft} initialText={pasteText} locale={locale} onApply={applyPaste} onClose={() => setPasteText(null)} />}
    </div>
  );
}

function AddDialog({ project, onClose, onCreate }: { project: Project; onClose: () => void; onCreate: (t: LookupTable) => string | null }) {
  const [title, setTitle] = useState('');
  const [match, setMatch] = useState<LookupKeyColumn['match']>('text');
  const [valueLabel, setValueLabel] = useState('Value');
  const [type, setType] = useState<CalcType>('money');
  const [from, setFrom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const choices = useMemo(() => projectFields(project).filter((f) => f.type === 'enum' && f.enumValues?.length && !f.derived).map((f) => ({ path: f.path, label: f.label, values: f.enumValues! })), [project]);
  const submit = () => {
    const tables = project.lookupTables ?? [];
    const id = keyFromLabel(title, new Set(tables.map((t) => t.id)), 'table');
    const chosen = match === 'text' ? choices.find((c) => c.path === from) : undefined;
    const keyLabel = chosen?.label ?? (match === 'text' ? 'Key' : match === 'number-range' ? 'From value' : 'In effect');
    const valueKey = keyFromLabel(valueLabel, new Set(['key']), 'value');
    const table: LookupTable = {
      id, title: title.trim(),
      keys: [defaultKeyColumn(match, keyLabel, 'key')],
      columns: [{ key: valueKey, label: valueLabel.trim() || 'Value', type }],
      rows: (chosen?.values ?? []).map((v) => ({ keys: { key: v }, values: { [valueKey]: null } })),
    };
    setError(onCreate(table));
  };
  return (
    <Dialog title="Add a lookup table" onClose={onClose} labelledBy="lk-add-title"
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={submit} disabled={!title.trim()} data-testid="lk-add-confirm">Add</button></>}>
      <form className="calc-add" onSubmit={(e) => { e.preventDefault(); if (title.trim()) submit(); }}>
        <div className="field"><label htmlFor="lk-add-name">Name</label>
          <input id="lk-add-name" className="input" autoFocus value={title} maxLength={80} placeholder="For example, Late fee by tier" onChange={(e) => setTitle(e.target.value)} data-testid="lk-add-name" /></div>
        <div className="field"><label htmlFor="lk-add-match">It is looked up by</label>
          <select id="lk-add-match" className="select" value={match} onChange={(e) => setMatch(e.target.value as LookupKeyColumn['match'])} data-testid="lk-add-match">
            {(Object.keys(MATCH_NAME) as Array<LookupKeyColumn['match']>).map((m) => <option key={m} value={m}>{MATCH_NAME[m]}</option>)}
          </select></div>
        {match === 'text' && choices.length > 0 && (
          <div className="field"><label htmlFor="lk-add-from">Start the rows from the values of</label>
            <select id="lk-add-from" className="select" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="lk-add-from">
              <option value="">No rows yet</option>
              {choices.map((c) => <option key={c.path} value={c.path}>{c.label} ({c.values.join(', ')})</option>)}
            </select></div>
        )}
        <div className="field"><label htmlFor="lk-add-value">It gives</label>
          <div className="row">
            <input id="lk-add-value" className="input" value={valueLabel} maxLength={60} onChange={(e) => setValueLabel(e.target.value)} aria-label="Name of the value it gives" />
            <select className="select" value={type} onChange={(e) => setType(e.target.value as CalcType)} aria-label="Kind of the value it gives" data-testid="lk-add-type">
              {(['money', 'number', 'text', 'date', 'bool'] as CalcType[]).map((t) => <option key={t} value={t}>{TYPE_NAME[t]}</option>)}
            </select></div>
          <span className="hint">You can add more key and value columns afterwards.</span></div>
        {error && <p className="callout error" role="alert" data-testid="lk-add-error">{error}</p>}
      </form>
    </Dialog>
  );
}

export default LookupTables;
