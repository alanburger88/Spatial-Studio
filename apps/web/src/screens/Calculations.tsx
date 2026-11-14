import { useCallback, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { buildContext, calculationUsage, checkExpr, evaluateCalculations, exprScopeOf, formulaInWords, projectFieldIndex, scopeFieldIndex, wordsScopeOf, CALC_MAX, type CalcType, type CalculatedField } from '@iss/model';
import { Dialog, Empty, ScreenHeader, Tech } from '../ui/common';
import { Icon } from '../ui/icons';
import { useCan, usePreviewDate, useRecord, useResolution, useStudio } from '../state/store';
import { recordSummary } from '../shell/RecordPicker';
import { AcrossCustomers } from './calc/AcrossCustomers';
import { CalcEditor, type Customer } from './calc/CalcEditor';
import { examplesFor } from './calc/examples';
import { CALC_TYPES, evaluateForCustomers, formatCalcValue, issueDateFor, keyFromLabel, makeCtx, seed, TYPE_NAME } from './calc/model';
import { UsedBy, usePlaces } from './calc/UsedBy';
import { PreviewDateField } from './dates/PreviewDateField';
import './Calculations.css';

/**
 * Calculations (S22): values worked out from a customer's data, for rules and wording. A list, an editor with three
 * views of one expression (builder, formula, plain words), the value for every synthetic customer, and where each is used.
 */
export function Calculations() {
  const project = useStudio((s) => s.project)!;
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  const res = useResolution();
  const record = useRecord();
  const canEdit = useCan('edit');
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [refusal, setRefusal] = useState<{ key: string; message: string } | null>(null);
  const dirtyRef = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const onDirty = useCallback((d: boolean) => { dirtyRef.current = d; }, []);

  const calcs = project.calculatedFields ?? [];
  const selected = calcs.find((c) => c.key === params.get('calc')) ?? calcs[0] ?? null;
  const locale = res?.locale ?? 'en-US';
  // "As issued on": the studio's shared preview date (the status bar and the Dates screen show the same day).
  const given = usePreviewDate();

  const scope = useMemo(() => exprScopeOf(project), [project]);
  const ctx = useMemo(() => makeCtx(project, selected?.key ?? null), [project, selected?.key]);
  const fieldIndex = useMemo(() => projectFieldIndex(project), [project]);
  const wordsScope = useMemo(() => wordsScopeOf(project, fieldIndex), [project, fieldIndex]);
  const usage = useMemo(() => new Map(calculationUsage(project).map((u) => [u.key, u.uses])), [project]);

  // The current customer, as the document would see it (overrides and journey included).
  const customer = useMemo(() => {
    const rec = res?.effectiveRecord ?? record;
    if (!rec || !calcs.length) return null;
    const data = buildContext(rec) as Record<string, unknown>;
    const issue = issueDateFor(project, data, given);
    if (project.documentDate) data.document = { date: issue };
    const out = evaluateCalculations(project, data, issue);
    return { rec, data, issue, ...out };
  }, [project, res?.effectiveRecord, record, given, calcs.length]);
  const customerForEditor: Customer | null = customer ? { name: recordSummary(customer.rec, personas).name, ctx: customer.data, issue: customer.issue, missing: customer.missing } : null;

  const everyone = useMemo(() => evaluateForCustomers(project, records, given), [project, records, given]);

  const go = (key: string) => { dirtyRef.current = false; setRefusal(null); setParams({ calc: key }, { replace: true }); };
  /** Choosing another calculation with unsaved changes asks first. */
  const select = (key: string) => { if (dirtyRef.current && key !== selected?.key) setPending(key); else go(key); };

  const create = (field: CalculatedField): string | null => {
    const r = useStudio.getState().dispatch({ type: 'UPSERT_CALCULATED_FIELD', field });
    if (!r.ok) return r.message;
    select(field.key);
    return null;
  };
  const duplicate = (c: CalculatedField) => {
    const labels = new Set(calcs.map((x) => x.label.toLowerCase()));
    let label = `${c.label} copy`, n = 2;
    while (labels.has(label.toLowerCase())) label = `${c.label} copy ${n++}`;
    const key = keyFromLabel(label, new Set(calcs.map((x) => x.key)), 'calc');
    const r = useStudio.getState().dispatch({ type: 'UPSERT_CALCULATED_FIELD', field: { ...c, key, label: label.slice(0, 60) }, index: calcs.findIndex((x) => x.key === c.key) + 1 });
    if (r.ok) select(key);
  };
  const remove = (c: CalculatedField) => {
    const r = useStudio.getState().dispatch({ type: 'DELETE_CALCULATED_FIELD', key: c.key });
    if (!r.ok) setRefusal({ key: c.key, message: r.message });
    else { setRefusal(null); setParams({}, { replace: true }); useStudio.getState().toast({ kind: 'success', title: 'Calculation removed', message: `“${c.label}”. Undo with Ctrl+Z.` }); }
  };

  return (
    <section className="screen" data-testid="calculations-screen">
      <ScreenHeader id="S22" title="Calculations" subtitle="Values worked out from the customer’s data, for rules and wording."
        actions={<button type="button" className="btn sm primary" onClick={() => setAdding(true)} disabled={!canEdit || calcs.length >= CALC_MAX} data-testid="calc-add"><Icon.plus /> Add a calculation</button>} />
      {calcs.length === 0 ? (
        <div className="screen-body calc-body calc-solo">
          <EmptyStart project={project} canEdit={canEdit} onCreate={create} onAdd={() => setAdding(true)} />
        </div>
      ) : (
        <div className="screen-body calc-body">
          <aside className="panel calc-list-panel" data-side="left" data-side-title="Calculations" aria-label="Calculations">
            <div className="panel-head"><h2 className="section-title">Calculations <span className="chip count">{calcs.length}</span></h2></div>
            <div className="panel-body flush">
              <div className="list-rows" data-testid="calc-list">
                {calcs.map((c) => {
                  const mine = customer?.values[c.key];
                  const miss = customer?.missing[c.key];
                  const bad = checkExpr(c.expr, c.list ? exprScopeOf(project, c.list) : scope).problems.length > 0;
                  const perItem = c.list ? fieldIndex.get(c.list)?.label ?? c.list : null;
                  const unused = !usage.has(c.key);
                  return (
                    <button key={c.key} type="button" className={`calc-row${c.key === selected?.key ? ' selected' : ''}`} aria-current={c.key === selected?.key ? 'true' : undefined} data-testid={`calc-row-${c.key}`} onClick={() => select(c.key)}>
                      <span className="calc-row-top">
                        <span className="calc-row-name">{c.label}</span>
                        <span className="chip">{TYPE_NAME[c.type]}</span>
                      </span>
                      <span className="calc-row-words">{formulaInWords(c.expr, c.list ? wordsScopeOf(project, scopeFieldIndex(project, c.list)) : wordsScope)}</span>
                      <span className="calc-row-foot">
                        {perItem ? <span className="chip" data-testid={`calc-row-per-item-${c.key}`}>For each item of “{perItem}”</span> : customer ? (mine !== null && mine !== undefined
                          ? <span className="calc-row-val" data-testid={`calc-row-value-${c.key}`} data-raw={String(mine)}>{formatCalcValue(c.type, mine, locale)}</span>
                          : <span className="calc-row-val missing" data-testid={`calc-row-value-${c.key}`} title={miss?.message}>No value</span>) : null}
                        {bad && <span className="chip error">Has a problem</span>}
                        {unused && <span className="chip" title="No rule, wording or other calculation uses it yet">Not used yet</span>}
                      </span>
                      <Tech><span className="chip code">calc.{c.key}</span></Tech>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          <div className="panel calc-main" aria-label="Edit the calculation">
            <div className="panel-body">
              {refusal && selected && refusal.key === selected.key && (
                <div className="callout error calc-refusal" role="alert" data-testid="calc-refusal">
                  <strong>It cannot be removed yet.</strong> <span data-testid="calc-refusal-message">{refusal.message}</span>
                  <UsedBy testId="calc-refusal-used" places={usePlaces(project, usage.get(refusal.key) ?? [])} />
                </div>
              )}
              {selected && (
                <CalcEditor key={selected.key} calc={selected} ctx={ctx} customer={customerForEditor} locale={locale} canEdit={canEdit} onDirty={onDirty}
                  onDuplicate={() => duplicate(selected)} onRemove={() => remove(selected)} />
              )}
            </div>
          </div>

          <aside className="panel calc-side" data-side="right" data-side-title="Results" aria-label="Results and uses">
            {selected && (
              <div className="panel-body">
                <PreviewDateField project={project} testId="calc-asof" what="The values here are worked out" />
                <h3 className="section-title">Across all customers</h3>
                <AcrossCustomers calc={selected} rows={Object.values(everyone.get(selected.key) ?? {})} locale={locale} />
                <h3 className="section-title calc-used-h">Where it is used</h3>
                <UsedBy testId="calc-used" places={usePlaces(project, usage.get(selected.key) ?? [])} />
              </div>
            )}
          </aside>
        </div>
      )}
      {pending && (
        <Dialog title="Leave without saving?" onClose={() => setPending(null)} labelledBy="calc-leave-title"
          footer={<><button type="button" className="btn" data-testid="calc-leave-stay" onClick={() => setPending(null)}>Keep editing</button><button type="button" className="btn danger" data-testid="calc-leave-discard" onClick={() => { const k = pending; setPending(null); go(k); }}>Discard changes</button></>}>
          <p>“{selected?.label}” has changes that are not saved. Choosing another calculation discards them.</p>
        </Dialog>
      )}
      {adding && <AddDialog project={project} onClose={() => setAdding(false)} onCreate={(f) => { const m = create(f); if (!m) setAdding(false); return m; }} />}
    </section>
  );
}

function EmptyStart({ project, canEdit, onCreate, onAdd }: { project: Parameters<typeof examplesFor>[0]; canEdit: boolean; onCreate: (f: CalculatedField) => string | null; onAdd: () => void }) {
  const examples = useMemo(() => examplesFor(project), [project]);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="calc-empty" data-testid="calc-empty">
      <Empty title="No calculations yet" message="A calculation is a value worked out from a customer’s data, such as the days until a payment is due or the total of some fees. Rules and wording can then use it like any data field.">
        <button type="button" className="btn primary" onClick={onAdd} disabled={!canEdit} data-testid="calc-empty-add"><Icon.plus /> Add a calculation</button>
      </Empty>
      {examples.length > 0 ? (
        <div className="calc-examples" role="group" aria-label="Worked examples">
          <h2 className="section-title">Or start from an example made from this document’s own fields</h2>
          <ul>
            {examples.map((x) => (
              <li key={x.field.key}>
                <button type="button" className="btn calc-example" disabled={!canEdit} data-testid={`calc-example-${x.id}`} onClick={() => setError(onCreate(x.field))}>
                  <span className="calc-example-title"><Icon.plus /> {x.title}</span>
                  <span className="muted">{x.words}</span>
                </button>
              </li>
            ))}
          </ul>
          {error && <p className="callout error" role="alert">{error}</p>}
        </div>
      ) : <p className="muted calc-none">This document has no dates, amounts or lists yet that an example could use. Add data fields first (Rules & data, Data fields), or add a calculation with a fixed value.</p>}
    </div>
  );
}

function AddDialog({ project, onClose, onCreate }: { project: Parameters<typeof examplesFor>[0]; onClose: () => void; onCreate: (f: CalculatedField) => string | null }) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<CalcType>('number');
  const [error, setError] = useState<string | null>(null);
  // Richer data shapes (wave 5): worked out once for the document, or once for each item of one of its lists.
  const lists = (project.customFields ?? []).filter((f) => f.type === 'list');
  const [forList, setForList] = useState('');
  const submit = () => {
    const calcs = project.calculatedFields ?? [];
    const key = keyFromLabel(label, new Set(calcs.map((c) => c.key)), 'calc');
    const draft = forList ? { ...project, calculatedFields: [...calcs, { key, label: label.trim(), type, list: forList, expr: { op: 'number' as const, value: 0 } }] } : project;
    const ctx = makeCtx(draft as typeof project, key);
    setError(onCreate({ key, label: label.trim(), type, expr: seed(type, ctx), ...(forList ? { list: forList } : {}) }));
  };
  return (
    <Dialog title="Add a calculation" onClose={onClose} labelledBy="calc-add-title"
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={submit} disabled={!label.trim()} data-testid="calc-add-confirm">Add</button></>}>
      <form className="calc-add" onSubmit={(e) => { e.preventDefault(); if (label.trim()) submit(); }}>
        <div className="field"><label htmlFor="calc-add-name">Name</label>
          <input id="calc-add-name" className="input" autoFocus value={label} maxLength={60} placeholder="For example, Days to due date" onChange={(e) => setLabel(e.target.value)} data-testid="calc-add-name" /></div>
        <div className="field"><label htmlFor="calc-add-type">The result is</label>
          <select id="calc-add-type" className="select" value={type} onChange={(e) => setType(e.target.value as CalcType)} data-testid="calc-add-type">
            {CALC_TYPES.map((t) => <option key={t} value={t}>{TYPE_NAME[t]}</option>)}
          </select>
          <span className="hint">It starts with a simple step that you then change in the builder or the formula.</span></div>
        {lists.length > 0 && (
          <div className="field"><label htmlFor="calc-add-for">Worked out</label>
            <select id="calc-add-for" className="select" value={forList} onChange={(e) => setForList(e.target.value)} data-testid="calc-add-for">
              <option value="">Once for the whole document</option>
              {lists.map((l) => <option key={l.key} value={`custom.${l.key}`}>For each item of “{l.label}”</option>)}
            </select>
            <span className="hint">For each item: a subtotal per account, for example. It can be shown inside a repeating section of that list, as a table total and in its conditions.</span></div>
        )}
        {error && <p className="callout error" role="alert" data-testid="calc-add-error">{error}</p>}
      </form>
    </Dialog>
  );
}

export default Calculations;
