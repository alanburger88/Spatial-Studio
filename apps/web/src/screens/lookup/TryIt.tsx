import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { evaluateSteps, exprChildren, lookupRowFor, type CalculatedField, type Expr, type LookupTable, type Missing, type Project } from '@iss/model';
import { MATCH_NAME, parseCell, rowKeyWords, valueText, type GridCol } from './model';

/** The current customer's data as the calculations see it (see Calculations). */
export interface CustomerData { name: string; ctx: Record<string, unknown>; issue: string | null; missing: Record<string, Missing> }

interface Reader { calc: CalculatedField; at: string }

/** The places a calculation reads this table (the path of each lookup step in its tree). */
function readers(project: Project, tableId: string): Reader[] {
  const out: Reader[] = [];
  for (const calc of project.calculatedFields ?? []) {
    const walk = (e: Expr, at: string) => {
      if (e.op === 'lookup' && e.table === tableId) out.push({ calc, at });
      for (const [k, c] of exprChildren(e)) walk(c, at ? `${at}.${k}` : k);
    };
    walk(calc.expr, '');
  }
  return out;
}

/** Enter key values (or take the current customer's) and see which row matches and what each value column gives. */
export function TryIt({ table, project, customer, locale }: { table: LookupTable; project: Project; customer: CustomerData | null; locale: string }) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const places = useMemo(() => readers(project, table.id), [project, table.id]);

  const keyCols = table.keys.map((k) => {
    const kind = k.match === 'text' ? 'text' : k.match === 'date-range' ? 'date' : k.unit === 'money' ? 'money' : 'number';
    return { k, kind, col: { id: k.key, head: k.label, sub: '', role: 'value', key: k.key, kind } as GridCol };
  });
  const parsed = keyCols.map(({ k, kind, col }) => {
    const text = inputs[k.key] ?? '';
    if (!text.trim()) return { ok: false as const, empty: true, message: '' };
    if (kind === 'text') return { ok: true as const, value: text };
    const p = parseCell(col, text);
    return p.ok ? { ok: true as const, value: p.value as number | string } : { ok: false as const, empty: false, message: p.message };
  });
  const ready = parsed.every((p) => p.ok);
  const keys = parsed.map((p) => (p.ok ? p.value : undefined));
  const row = ready ? lookupRowFor(table, keys) : null;
  const values = ready ? (row?.values ?? table.defaultRow ?? null) : null;
  const rowNo = row ? table.rows.indexOf(row) + 1 : 0;

  const useCustomer = (r: Reader) => {
    if (!customer) return;
    const ev = evaluateSteps(project, r.calc.expr, JSON.parse(JSON.stringify(customer.ctx)), customer.issue, customer.missing);
    const next: Record<string, string> = {};
    const bad: string[] = [];
    table.keys.forEach((k, i) => {
      const st = ev.steps.find((s) => s.at === (r.at ? `${r.at}.keys.${i}` : `keys.${i}`));
      if (!st || st.value === null) { bad.push(st?.missing?.message ?? `No value for ${k.label}.`); return; }
      next[k.key] = k.match === 'number-range' && k.unit === 'money' && typeof st.value === 'number' ? (st.value / 100).toFixed(2) : String(st.value);
    });
    setInputs((cur) => ({ ...cur, ...next }));
    setNote(bad.length ? `“${r.calc.label}” has no value to look up for ${customer.name}: ${bad[0]}` : `Values taken from ${customer.name} through “${r.calc.label}”.`);
  };

  return (
    <div className="lk-try" data-testid="lk-try">
      <div className="lk-try-inputs">
        {keyCols.map(({ k, kind }, i) => (
          <div key={k.key} className="field">
            <label htmlFor={`lk-try-${i}`}>{k.label} <span className="muted">({MATCH_NAME[k.match].toLowerCase()})</span></label>
            <input id={`lk-try-${i}`} className="input" value={inputs[k.key] ?? ''} data-testid={`lk-try-${i}`}
              type={kind === 'date' ? 'date' : 'text'} inputMode={kind === 'number' || kind === 'money' ? 'decimal' : undefined}
              placeholder={kind === 'money' ? 'Dollars, for example 250.00' : kind === 'number' ? 'A number' : kind === 'date' ? '' : 'Exact text'}
              aria-invalid={(!parsed[i].ok && !(parsed[i] as { empty?: boolean }).empty) || undefined}
              onChange={(e) => { setNote(null); setInputs((cur) => ({ ...cur, [k.key]: e.target.value })); }} />
            {!parsed[i].ok && !(parsed[i] as { empty?: boolean }).empty && <span className="hint lk-err">{(parsed[i] as { message: string }).message}</span>}
          </div>
        ))}
      </div>
      {places.length > 0 && customer && (
        <div className="lk-try-use">
          {places.map((r) => <button key={`${r.calc.key}:${r.at}`} type="button" className="btn sm" onClick={() => useCustomer(r)} data-testid="lk-try-use">Use {customer.name}’s values (through “{r.calc.label}”)</button>)}
        </div>
      )}
      {note && <p className="muted lk-try-note" role="status" data-testid="lk-try-note">{note}</p>}
      <div className="lk-try-result" aria-live="polite" data-testid="lk-try-result">
        {!ready && <p className="muted">Enter a value for {keyCols.length === 1 ? 'the key' : 'each key'} to see which row matches.</p>}
        {ready && !values && <p className="callout warning" data-testid="lk-try-none">No row matches{table.rows.length ? '' : ' (the table has no rows yet)'}, and there is no default row, so a calculation reading this table has no value for these keys.</p>}
        {ready && values && (
          <>
            <p data-testid="lk-try-which">{row ? <>Matches <strong>row {rowNo}</strong> ({rowKeyWords(table, row)}).</> : <>No row matches, so the <strong>default row</strong> is used.</>}</p>
            <dl className="lk-try-values">
              {table.columns.map((c) => {
                const v = values[c.key];
                return <div key={c.key}><dt>{c.label}</dt><dd data-testid={`lk-try-value-${c.key}`} data-raw={v === null || v === undefined ? '' : String(v)}>{v === null || v === undefined ? <span className="muted">empty (a calculation has no value here)</span> : valueText(c.type === 'money' ? 'money' : c.type === 'bool' ? 'bool' : 'text', v, locale)}</dd></div>;
              })}
            </dl>
          </>
        )}
      </div>
      {places.length === 0 && <p className="muted">No calculation reads this table yet, so there is no customer data to take values from. <Link to={`/studio/${project.projectId}/calculations`}>Go to Calculations</Link></p>}
    </div>
  );
}
