import { useEffect, useState } from 'react';
import { printCondition, type FieldDef, type Predicate, type Scalar } from '@iss/model';
import { Icon } from '../../ui/icons';
import { fromVisual, toVisual, type Cond, type LeafOp } from '../conditionShape';

/**
 * A condition on one level (all or any of several tests), the same shapes a rule's condition has. A condition nested
 * deeper can only be edited in the formula view, and this says so instead of showing it wrongly.
 */

const OP_LABEL: Record<LeafOp, string> = { eq: 'is', ne: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most', in: 'is one of', isNull: 'is empty', notNull: 'has a value' };
const DATE_OP_LABEL: Partial<Record<LeafOp, string>> = { gt: 'is after', gte: 'is on or after', lt: 'is before', lte: 'is on or before' };

function opsFor(f: FieldDef | undefined): LeafOp[] {
  if (!f) return ['eq', 'ne'];
  switch (f.type) {
    case 'enum': return ['eq', 'ne', 'in', 'isNull', 'notNull'];
    case 'bool': case 'string': return ['eq', 'ne', 'isNull', 'notNull'];
    default: return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'isNull', 'notNull'];
  }
}
function defaultValue(f: FieldDef | undefined, op: LeafOp): Scalar | Scalar[] {
  if (op === 'isNull' || op === 'notNull') return null;
  if (op === 'in') return f?.enumValues?.[0] ? [f.enumValues[0]] : [];
  switch (f?.type) {
    case 'bool': return true;
    case 'enum': return f.enumValues?.[0] ?? '';
    case 'int': case 'points': case 'cents': case 'number': return 0;
    case 'date': return '2026-01-01';
    default: return '';
  }
}

function NumberBox({ value, onCommit, label, money }: { value: number; onCommit: (n: number) => void; label: string; money?: boolean }) {
  const show = (n: number) => (money ? (n / 100).toFixed(2) : String(n));
  const [txt, setTxt] = useState(show(value));
  useEffect(() => { setTxt((t) => ((money ? Math.round(Number(t) * 100) : Number(t)) === value ? t : show(value))); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const ok = money ? /^-?\d+(\.\d{1,2})?$/.test(txt.trim()) : /^-?\d+(\.\d+)?$/.test(txt.trim());
  return (
    <span className="cb-valwrap">
      {money && <span className="muted" aria-hidden="true">$</span>}
      <input className="input cb-num" aria-label={label} inputMode="decimal" value={txt} aria-invalid={!ok || undefined}
        onChange={(e) => { setTxt(e.target.value); const t = e.target.value.trim(); if (money ? /^-?\d+(\.\d{1,2})?$/.test(t) : /^-?\d+(\.\d+)?$/.test(t)) onCommit(money ? Math.round(Number(t) * 100) : Number(t)); }} />
    </span>
  );
}

function ValueEditor({ field, op, value, onChange, label }: { field: FieldDef | undefined; op: LeafOp; value: Scalar | Scalar[]; onChange: (v: Scalar | Scalar[]) => void; label: string }) {
  if (op === 'isNull' || op === 'notNull') return <span className="muted">no value needed</span>;
  if (op === 'in') {
    const vals = Array.isArray(value) ? value.map(String) : [];
    return (
      <fieldset className="cb-multi"><legend className="cb-sr">{label}</legend>
        {(field?.enumValues ?? []).map((v) => <label key={v}><input type="checkbox" checked={vals.includes(v)} onChange={(e) => onChange(e.target.checked ? [...vals, v] : vals.filter((x) => x !== v))} /> {v}</label>)}
      </fieldset>
    );
  }
  const scalar = Array.isArray(value) ? null : value;
  switch (field?.type) {
    case 'enum': return <select className="select" aria-label={label} value={String(scalar ?? '')} onChange={(e) => onChange(e.target.value)}>{(field.enumValues ?? []).map((v) => <option key={v} value={v}>{v}</option>)}</select>;
    case 'bool': return <select className="select" aria-label={label} value={String(scalar)} onChange={(e) => onChange(e.target.value === 'true')}><option value="true">Yes</option><option value="false">No</option></select>;
    case 'int': case 'points': case 'number': case 'cents':
      return <NumberBox label={label} value={typeof scalar === 'number' ? scalar : 0} money={field.type === 'cents'} onCommit={onChange} />;
    case 'date': return <input className="input" type="date" aria-label={label} value={String(scalar ?? '')} onChange={(e) => onChange(e.target.value)} />;
    default: return <input className="input" aria-label={label} value={String(scalar ?? '')} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** Edits a condition; `fields` are the fields (or, for a row of a list, the columns) it may test. */
export function ConditionEditor({ value, fields, onChange, label, fieldIndex }: { value: Predicate; fields: FieldDef[]; onChange: (p: Predicate) => void; label: string; fieldIndex: ReadonlyMap<string, FieldDef> }) {
  const visual = toVisual(value);
  const byPath = new Map(fields.map((f) => [f.path, f]));
  if (!visual) {
    return <p className="callout warning cb-note">This condition has several levels, so it is shown only in the formula view: <span className="mono">{printCondition(value, fieldIndex)}</span></p>;
  }
  const update = (i: number, c: Partial<Cond>) => onChange(fromVisual({ ...visual, conds: visual.conds.map((x, j) => (j === i ? { ...x, ...c } : x)) }));
  const changeField = (i: number, path: string) => {
    const f = byPath.get(path);
    const ops = opsFor(f);
    const op = ops.includes(visual.conds[i].op) ? visual.conds[i].op : ops[0];
    update(i, { path, op, value: defaultValue(f, op) });
  };
  const addOne = () => {
    const f = fields[0];
    if (f) onChange(fromVisual({ ...visual, conds: [...visual.conds, { path: f.path, op: 'eq', value: defaultValue(f, 'eq'), neg: false }] }));
  };
  return (
    <div className="cb-cond" role="group" aria-label={label}>
      {visual.conds.length > 1 && (
        <div className="row cb-combiner">
          <span className="muted">Match</span>
          <div className="segmented" role="group" aria-label={`${label}: combine with`}>
            <button type="button" aria-pressed={visual.combiner === 'and'} onClick={() => onChange(fromVisual({ ...visual, combiner: 'and' }))}>All of</button>
            <button type="button" aria-pressed={visual.combiner === 'or'} onClick={() => onChange(fromVisual({ ...visual, combiner: 'or' }))}>Any of</button>
          </div>
        </div>
      )}
      <ol className="cb-conds">
        {visual.conds.map((c, i) => {
          const f = byPath.get(c.path);
          const ops = opsFor(f);
          const word = (o: LeafOp) => (f?.type === 'date' ? DATE_OP_LABEL[o] : undefined) ?? OP_LABEL[o];
          return (
            <li key={i} className="cb-cond-row">
              <label className="cb-not"><input type="checkbox" checked={c.neg} onChange={(e) => update(i, { neg: e.target.checked })} /> Not</label>
              <select className="select" aria-label={`${label}, test ${i + 1} field`} value={c.path} onChange={(e) => changeField(i, e.target.value)}>
                {!f && <option value={c.path}>{c.path} (unknown)</option>}
                {fields.map((x) => <option key={x.path} value={x.path}>{x.label}</option>)}
              </select>
              <select className="select" aria-label={`${label}, test ${i + 1} comparison`} value={c.op} onChange={(e) => update(i, { op: e.target.value as LeafOp, value: defaultValue(f, e.target.value as LeafOp) })}>
                {ops.map((o) => <option key={o} value={o}>{word(o)}</option>)}
              </select>
              <ValueEditor field={f} op={c.op} value={c.value} onChange={(v) => update(i, { value: v })} label={`${label}, test ${i + 1} value`} />
              <button type="button" className="btn ghost sm icon" aria-label={`Remove test ${i + 1} of ${label}`} disabled={visual.conds.length < 2} onClick={() => onChange(fromVisual({ ...visual, conds: visual.conds.filter((_, j) => j !== i) }))}><Icon.close /></button>
            </li>
          );
        })}
      </ol>
      <button type="button" className="btn sm" onClick={addOne} disabled={!fields.length}><Icon.plus /> Add a test</button>
    </div>
  );
}
