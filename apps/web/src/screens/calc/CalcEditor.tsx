import { useEffect, useMemo, useRef, useState } from 'react';
import {
  checkFormula, evaluateSteps, exprScopeOf, formulaInWords, printFormula, projectFieldIndex, wordsScopeOf,
  type CalcType, type CalculatedField, type Expr, type FormulaError, type Missing,
} from '@iss/model';
import { useStudio } from '../../state/store';
import { Icon } from '../../ui/icons';
import { Tech } from '../../ui/common';
import { Builder } from './Builder';
import { FormulaEditor } from './FormulaEditor';

import { CALC_TYPES, formatCalcValue, problemsBySlot, TYPE_NAME, whatToDo, type Ctx } from './model';

/**
 * The editor of one calculation: its name and kind of result, the plain-words reading, the formula line and the
 * builder, three views of one expression that always agree. Saving is one undoable command.
 */

export interface Customer { name: string; ctx: Record<string, unknown>; issue: string | null; missing: Record<string, Missing> }

interface Draft { label: string; type: CalcType; description: string; expr: Expr }
const draftOf = (c: CalculatedField): Draft => ({ label: c.label, type: c.type, description: c.description ?? '', expr: c.expr });

export function CalcEditor({ calc, ctx, customer, locale, canEdit, onDuplicate, onRemove, onDirty }: {
  calc: CalculatedField; ctx: Ctx; customer: Customer | null; locale: string; canEdit: boolean; onDirty: (dirty: boolean) => void;
  onDuplicate: () => void; onRemove: () => void;
}) {
  const project = ctx.project;
  const fieldIndex = useMemo(() => projectFieldIndex(project), [project]);
  const tech = useStudio((s) => s.viewMode) === 'technical';
  const savedJson = JSON.stringify(draftOf(calc));
  const [draft, setDraft] = useState<Draft>(() => draftOf(calc));
  const [formula, setFormula] = useState(() => printFormula(calc.expr, fieldIndex));
  const [formulaErrors, setFormulaErrors] = useState<FormulaError[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // The saved calculation changed (saved here, undone, or changed elsewhere): start again from it.
  useEffect(() => {
    setDraft(draftOf(calc));
    setFormula(printFormula(calc.expr, fieldIndex));
    setFormulaErrors([]);
    setSaveError(null);
  }, [savedJson]); // eslint-disable-line react-hooks/exhaustive-deps

  const scope = useMemo(() => {
    const s = exprScopeOf(project);
    s.calcTypes = new Map(s.calcTypes).set(calc.key, draft.type);
    return s;
  }, [project, calc.key, draft.type]);
  const check = useMemo(() => problemsBySlot(draft.expr, scope), [draft.expr, scope]);
  const problems = useMemo(() => {
    const m = new Map(check.byAt);
    if (check.type && check.type !== draft.type) m.set('', [...(m.get('') ?? []), `This calculation gives ${TYPE_NAME[check.type].toLowerCase()}, but its result is set to ${TYPE_NAME[draft.type].toLowerCase()}. Change the result kind, or change the first step.`]);
    return m;
  }, [check, draft.type]);
  const problemCount = [...problems.values()].reduce((n, l) => n + l.length, 0);
  const words = useMemo(() => formulaInWords(draft.expr, wordsScopeOf(project, fieldIndex)), [draft.expr, project, fieldIndex]);

  const evaluated = useMemo(() => {
    if (!customer) return null;
    // Work out on a copy so the customer's data is never touched.
    const copy = JSON.parse(JSON.stringify(customer.ctx)) as Record<string, unknown>;
    return evaluateSteps(project, draft.expr, copy, customer.issue, customer.missing);
  }, [project, draft.expr, customer]);

  const dirty = JSON.stringify(draft) !== savedJson;
  const nameOk = draft.label.trim().length > 0 && draft.label.length <= 60;
  useEffect(() => { onDirty(dirty || formulaErrors.length > 0); return () => onDirty(false); }, [dirty, formulaErrors.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const canSave = canEdit && dirty && formulaErrors.length === 0 && problemCount === 0 && nameOk;

  const setExprFromBuilder = (expr: Expr) => {
    setDraft((d) => ({ ...d, expr }));
    setFormula(printFormula(expr, fieldIndex));
    setFormulaErrors([]);
  };
  const onFormula = (text: string) => {
    setFormula(text);
    const r = checkFormula(text, scope);
    if (r.ok) { setDraft((d) => ({ ...d, expr: r.expr, type: r.type })); setFormulaErrors([]); }
    else setFormulaErrors(r.errors);
  };
  const save = () => {
    setSaveError(null);
    const field: CalculatedField = { key: calc.key, label: draft.label.trim(), type: draft.type, ...(draft.description.trim() ? { description: draft.description.trim() } : {}), expr: draft.expr };
    const res = useStudio.getState().dispatch({ type: 'UPSERT_CALCULATED_FIELD', field });
    if (res.ok) useStudio.getState().toast({ kind: 'success', title: 'Calculation saved', message: `“${field.label}”. Undo with Ctrl+Z; Save in the top bar keeps it.` });
    else setSaveError(res.message);
  };
  const revert = () => { setDraft(draftOf(calc)); setFormula(printFormula(calc.expr, fieldIndex)); setFormulaErrors([]); setSaveError(null); };

  const resultType = check.type ?? draft.type;
  const result = evaluated?.result;
  const shownMissing = result && !result.ok ? result.missing : null;

  return (
    <div className="calc-editor" data-testid="calc-editor" data-key={calc.key}>
      <div className="calc-ed-head">
        <div className="field calc-name">
          <label htmlFor="calc-name">Name</label>
          <input id="calc-name" ref={nameRef} className="input" value={draft.label} maxLength={60} disabled={!canEdit} aria-invalid={!nameOk || undefined} data-testid="calc-name" onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} />
          <Tech><span className="hint mono">calc.{calc.key}</span></Tech>
        </div>
        <div className="field">
          <label htmlFor="calc-type">Result is</label>
          <select id="calc-type" className="select" value={draft.type} disabled={!canEdit} data-testid="calc-type" onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as CalcType }))}>
            {CALC_TYPES.map((t) => <option key={t} value={t}>{TYPE_NAME[t]}</option>)}
          </select>
        </div>
        <div className="calc-ed-actions">
          <button type="button" className="btn sm" onClick={onDuplicate} disabled={!canEdit} data-testid="calc-duplicate"><Icon.copy /> Duplicate</button>
          <button type="button" className="btn sm" onClick={() => nameRef.current?.focus()} disabled={!canEdit} data-testid="calc-rename">Rename</button>
          <button type="button" className="btn sm danger" onClick={onRemove} disabled={!canEdit} data-testid="calc-remove"><Icon.trash /> Remove</button>
        </div>
      </div>
      <div className="field">
        <label htmlFor="calc-desc">What it is for (optional)</label>
        <input id="calc-desc" className="input" value={draft.description} maxLength={300} disabled={!canEdit} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
      </div>

      <section className="calc-view" aria-labelledby="calc-words-h">
        <h3 className="section-title" id="calc-words-h">In plain words</h3>
        <p className="calc-words" data-testid="calc-words">{words}</p>
      </section>

      <section className="calc-view" aria-labelledby="calc-this-h">
        <h3 className="section-title" id="calc-this-h">This customer gets{customer ? <> <span className="muted">({customer.name})</span></> : null}</h3>
        {!customer && <p className="muted">There is no customer to work this out for.</p>}
        {customer && result?.ok && <p className="calc-result" data-testid="calc-current" data-raw={String(result.value)}>{formatCalcValue(resultType, result.value, locale)}</p>}
        {shownMissing && (
          <div className="callout warning" data-testid="calc-missing" role="status">
            <strong>No value for this customer.</strong> <span data-testid="calc-missing-reason">{shownMissing.message}</span>
            <div className="muted">{whatToDo(shownMissing.code, draft.label)}</div>
            <Tech><div className="mono">{shownMissing.code}{shownMissing.path ? ` · ${shownMissing.path}` : ''}{shownMissing.via?.length ? ` · via ${shownMissing.via.join(', ')}` : ''}</div></Tech>
          </div>
        )}
      </section>

      <section className="calc-view" aria-labelledby="calc-formula-h">
        <h3 className="section-title" id="calc-formula-h">Formula</h3>
        <FormulaEditor text={formula} onText={onFormula} errors={formulaErrors} ctx={ctx} disabled={!canEdit} />
        {formulaErrors.length > 0 && (
          <p className="callout warning calc-lastgood" data-testid="calc-lastgood" role="status">
            This formula has a mistake, so it is not used and cannot be saved. The builder and the plain words show the last good version.
          </p>
        )}
      </section>

      <section className="calc-view" aria-labelledby="calc-builder-h">
        <h3 className="section-title" id="calc-builder-h">Builder</h3>
        {problemCount > 0 && formulaErrors.length === 0 && <p className="callout error" role="status" data-testid="calc-problems">{[...problems.values()][0][0]}{problemCount > 1 ? ` (${problemCount - 1} more below)` : ''}</p>}
        <Builder expr={draft.expr} want={draft.type} ctx={ctx} steps={evaluated?.steps ?? []} problems={problems} locale={locale} tech={tech} disabled={!canEdit} onChange={setExprFromBuilder} />
      </section>

      <div className="calc-savebar" data-testid="calc-savebar">
        <span className="calc-savestate" role="status" data-testid="calc-save-state">
          {!canEdit ? 'You can look at this calculation but not change it.' : dirty ? (formulaErrors.length ? 'Not saved: the formula has a mistake.' : problemCount ? 'Not saved: fix the problems first.' : 'You have changes that are not saved.') : 'Saved.'}
        </span>
        <button type="button" className="btn" onClick={revert} disabled={!dirty && formulaErrors.length === 0} data-testid="calc-revert">Revert</button>
        <button type="button" className="btn primary" onClick={save} disabled={!canSave} data-testid="calc-save">Save calculation</button>
      </div>
      {saveError && <p className="callout error" role="alert" data-testid="calc-save-error">{saveError}</p>}
    </div>
  );
}
