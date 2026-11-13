import { useEffect, useState } from 'react';
import { LOOKUP_TABLE_MAX_COLUMNS, LOOKUP_TABLE_MAX_KEYS, type CalcType, type LookupKeyColumn, type LookupRow, type LookupTable, type LookupValueColumn, type Scalar } from '@iss/model';
import { Icon } from '../../ui/icons';
import { keyFromLabel } from '../calc/model';
import { MATCH_NAME, TYPE_NAME, defaultKeyColumn, parseCell, valueText, type GridCol, type CellKind } from './model';

const CALC_TYPES: CalcType[] = ['number', 'money', 'date', 'text', 'bool'];
const KIND_FOR: Record<CalcType, CellKind> = { number: 'number', money: 'money', date: 'date', text: 'text', bool: 'bool' };

/** The cells of one key column as they start when its kind changes or it is added. */
const emptyKeyCell = (match: LookupKeyColumn['match']): LookupRow['keys'][string] => (match === 'text' ? '' : {});

/** One value typed into a box; commits when it reads, and says why when it does not. */
export function ValueInput({ type, value, onCommit, label, disabled }: { type: CalcType; value: Scalar | undefined; onCommit: (v: Scalar) => void; label: string; disabled?: boolean }) {
  const kind = KIND_FOR[type];
  const show = (v: Scalar | undefined) => (kind === 'money' ? valueText(kind, v).replace(/^\$/, '') : valueText(kind, v));
  const [txt, setTxt] = useState(show(value));
  const [err, setErr] = useState<string | null>(null);
  const col: GridCol = { id: 'x', head: label, sub: '', role: 'value', key: 'x', kind };
  // Follow the value when it changes from elsewhere, but not while what is typed already reads as it.
  useEffect(() => {
    const p = parseCell(col, txt);
    if (!(p.ok && (p.value ?? null) === (value ?? null))) { setTxt(show(value)); setErr(null); }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className="lk-valbox">
      <input className="input" aria-label={label} disabled={disabled} value={txt} aria-invalid={!!err || undefined} placeholder={kind === 'date' ? 'YYYY-MM-DD' : kind === 'bool' ? 'yes or no' : ''}
        onChange={(e) => { setTxt(e.target.value); const p = parseCell(col, e.target.value); if (p.ok) { setErr(null); onCommit((p.value ?? null) as Scalar); } else setErr(p.message); }} />
      {err && <span className="hint lk-err">{err}</span>}
    </span>
  );
}

/** The table's key columns, value columns and what happens when no row matches. */
export function Definition({ table, onChange, disabled }: { table: LookupTable; onChange: (t: LookupTable) => void; disabled: boolean }) {
  const taken = () => new Set([...table.keys.map((k) => k.key), ...table.columns.map((c) => c.key)]);
  const setKey = (i: number, patch: Partial<LookupKeyColumn>) => {
    const old = table.keys[i];
    const next: LookupKeyColumn = { ...old, ...patch };
    if (next.match !== 'number-range') delete next.unit;
    else if (!next.unit) next.unit = 'number';
    const kindChanged = next.match !== old.match || (next.unit ?? 'number') !== (old.unit ?? 'number');
    const rows = kindChanged ? table.rows.map((r) => ({ ...r, keys: { ...r.keys, [old.key]: emptyKeyCell(next.match) } })) : table.rows;
    onChange({ ...table, keys: table.keys.map((k, j) => (j === i ? next : k)), rows });
  };
  const addKey = () => {
    const key = keyFromLabel('Key', taken(), 'key');
    const k = defaultKeyColumn('text', `Key ${table.keys.length + 1}`, key);
    onChange({ ...table, keys: [...table.keys, k], rows: table.rows.map((r) => ({ ...r, keys: { ...r.keys, [key]: '' } })) });
  };
  const removeKey = (i: number) => {
    const k = table.keys[i];
    onChange({ ...table, keys: table.keys.filter((_, j) => j !== i), rows: table.rows.map((r) => { const { [k.key]: _gone, ...keys } = r.keys; return { ...r, keys }; }) });
  };
  const setCol = (i: number, patch: Partial<LookupValueColumn>) => {
    const old = table.columns[i];
    const next = { ...old, ...patch };
    const typeChanged = next.type !== old.type;
    const rows = typeChanged ? table.rows.map((r) => ({ ...r, values: { ...r.values, [old.key]: null } })) : table.rows;
    const defaultRow = table.defaultRow && typeChanged ? { ...table.defaultRow, [old.key]: null } : table.defaultRow;
    onChange({ ...table, columns: table.columns.map((c, j) => (j === i ? next : c)), rows, ...(defaultRow ? { defaultRow } : {}) });
  };
  const addCol = () => {
    const key = keyFromLabel('Value', taken(), 'value');
    const c: LookupValueColumn = { key, label: `Value ${table.columns.length + 1}`, type: 'number' };
    onChange({ ...table, columns: [...table.columns, c], rows: table.rows.map((r) => ({ ...r, values: { ...r.values, [key]: null } })), ...(table.defaultRow ? { defaultRow: { ...table.defaultRow, [key]: null } } : {}) });
  };
  const removeCol = (i: number) => {
    const c = table.columns[i];
    const next: LookupTable = { ...table, columns: table.columns.filter((_, j) => j !== i), rows: table.rows.map((r) => { const { [c.key]: _gone, ...values } = r.values; return { ...r, values }; }) };
    if (table.defaultRow) { const { [c.key]: _g, ...rest } = table.defaultRow; next.defaultRow = rest; }
    onChange(next);
  };
  const useDefault = !!table.defaultRow;

  return (
    <div className="lk-def" data-testid="lk-definition">
      <fieldset className="lk-fs">
        <legend className="section-title">Looked up by (key columns)</legend>
        <ul className="lk-cols">
          {table.keys.map((k, i) => (
            <li key={k.key} className="lk-colrow" data-testid={`lk-key-${i}`}>
              <div className="field"><label htmlFor={`lk-key-label-${i}`}>Name</label>
                <input id={`lk-key-label-${i}`} className="input" value={k.label} maxLength={60} disabled={disabled} onChange={(e) => setKey(i, { label: e.target.value })} data-testid={`lk-key-label-${i}`} /></div>
              <div className="field"><label htmlFor={`lk-key-match-${i}`}>Matched by</label>
                <select id={`lk-key-match-${i}`} className="select" value={k.match} disabled={disabled} onChange={(e) => setKey(i, { match: e.target.value as LookupKeyColumn['match'] })} data-testid={`lk-key-match-${i}`}>
                  {(Object.keys(MATCH_NAME) as Array<LookupKeyColumn['match']>).map((m) => <option key={m} value={m}>{MATCH_NAME[m]}</option>)}
                </select></div>
              {k.match === 'number-range' && (
                <div className="field"><label htmlFor={`lk-key-unit-${i}`}>The numbers are</label>
                  <select id={`lk-key-unit-${i}`} className="select" value={k.unit ?? 'number'} disabled={disabled} onChange={(e) => setKey(i, { unit: e.target.value as 'number' | 'money' })} data-testid={`lk-key-unit-${i}`}>
                    <option value="number">Plain numbers</option><option value="money">Amounts in dollars</option>
                  </select></div>
              )}
              <button type="button" className="btn ghost sm icon" aria-label={`Remove key column ${k.label}`} disabled={disabled || table.keys.length <= 1} title={table.keys.length <= 1 ? 'A table needs at least one key column' : 'Remove this key column and its cells'} onClick={() => removeKey(i)}><Icon.trash /></button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn sm" disabled={disabled || table.keys.length >= LOOKUP_TABLE_MAX_KEYS} onClick={addKey} data-testid="lk-add-key"><Icon.plus /> Add a key column</button>
        <span className="hint">A range is from a value (included) until another (not included); a row with no end covers everything above its start. Changing how a key is matched clears that column’s cells.</span>
      </fieldset>

      <fieldset className="lk-fs">
        <legend className="section-title">Values it gives (value columns)</legend>
        <ul className="lk-cols">
          {table.columns.map((c, i) => (
            <li key={c.key} className="lk-colrow" data-testid={`lk-col-${i}`}>
              <div className="field"><label htmlFor={`lk-col-label-${i}`}>Name</label>
                <input id={`lk-col-label-${i}`} className="input" value={c.label} maxLength={60} disabled={disabled} onChange={(e) => setCol(i, { label: e.target.value })} data-testid={`lk-col-label-${i}`} /></div>
              <div className="field"><label htmlFor={`lk-col-type-${i}`}>Kind</label>
                <select id={`lk-col-type-${i}`} className="select" value={c.type} disabled={disabled} onChange={(e) => setCol(i, { type: e.target.value as CalcType })} data-testid={`lk-col-type-${i}`}>
                  {CALC_TYPES.map((t) => <option key={t} value={t}>{TYPE_NAME[t]}</option>)}
                </select></div>
              <button type="button" className="btn ghost sm icon" aria-label={`Remove value column ${c.label}`} disabled={disabled || table.columns.length <= 1} title={table.columns.length <= 1 ? 'A table needs at least one value column' : 'Remove this value column and its cells'} onClick={() => removeCol(i)}><Icon.trash /></button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn sm" disabled={disabled || table.columns.length >= LOOKUP_TABLE_MAX_COLUMNS} onClick={addCol} data-testid="lk-add-col"><Icon.plus /> Add a value column</button>
        <span className="hint">Changing the kind of a value column clears its cells.</span>
      </fieldset>

      <fieldset className="lk-fs" data-testid="lk-nomatch">
        <legend className="section-title">When no row matches</legend>
        <div className="row lk-nomatch-opts" role="radiogroup" aria-label="When no row matches">
          <label><input type="radio" name="lk-nomatch" checked={!useDefault} disabled={disabled} onChange={() => { const { defaultRow: _d, ...rest } = table; onChange(rest as LookupTable); }} data-testid="lk-nomatch-missing" /> The calculation has no value (“missing”)</label>
          <label><input type="radio" name="lk-nomatch" checked={useDefault} disabled={disabled} onChange={() => onChange({ ...table, defaultRow: Object.fromEntries(table.columns.map((c) => [c.key, null])) })} data-testid="lk-nomatch-default" /> Use a default row</label>
        </div>
        {useDefault && (
          <div className="lk-default" data-testid="lk-default-row">
            {table.columns.map((c) => (
              <div key={c.key} className="field"><label>{c.label} <span className="muted">({TYPE_NAME[c.type].toLowerCase()})</span></label>
                <ValueInput type={c.type} value={table.defaultRow?.[c.key]} label={`Default ${c.label}`} disabled={disabled} onCommit={(v) => onChange({ ...table, defaultRow: { ...table.defaultRow, [c.key]: v } })} /></div>
            ))}
          </div>
        )}
      </fieldset>
    </div>
  );
}
