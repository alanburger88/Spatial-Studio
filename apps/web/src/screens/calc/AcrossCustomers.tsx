import { useMemo, useState } from 'react';
import type { CalculatedField } from '@iss/model';
import { useStudio } from '../../state/store';
import { recordSummary } from '../../shell/RecordPicker';
import { formatCalcValue, summarise, whatToDo, type CustomerValue } from './model';

/**
 * One calculation's value for every synthetic customer: smallest, largest, a simple spread as a table (with a bar
 * beside each count), and who has no value and why (the engine's reason). Each customer is a link that makes it the
 * current customer. Every count says "synthetic".
 */
export function AcrossCustomers({ calc, rows, locale }: { calc: CalculatedField; rows: CustomerValue[]; locale: string }) {
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  const current = useStudio((s) => s.ctx.recordId);
  const sum = useMemo(() => summarise(calc.type, rows, locale), [calc.type, rows, locale]);
  const names = useMemo(() => new Map(records.map((r) => [r.recordId, recordSummary(r, personas).name])), [records, personas]);
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const max = Math.max(1, ...sum.bands.map((b) => b.count));
  const pick = (id: string) => useStudio.getState().setRecord(id);
  const who = (id: string) => (
    <button type="button" className="linklike" aria-current={id === current ? 'true' : undefined} onClick={() => pick(id)} title={`Use ${names.get(id) ?? id} as the current customer`}>{names.get(id) ?? id}</button>
  );

  return (
    <div className="calc-across" data-testid="calc-across">
      <p className="calc-count" data-testid="calc-across-count">
        <strong>{sum.withValue}</strong> of {rows.length} synthetic customers have a value{sum.without > 0 && <>; <strong>{sum.without}</strong> do not</>}.
      </p>
      {sum.smallest !== null && (
        <dl className="calc-minmax">
          <div><dt>Smallest</dt><dd data-testid="calc-across-min" data-raw={String(sum.smallest)}>{formatCalcValue(calc.type, sum.smallest, locale)}</dd></div>
          <div><dt>Largest</dt><dd data-testid="calc-across-max" data-raw={String(sum.largest)}>{formatCalcValue(calc.type, sum.largest, locale)}</dd></div>
        </dl>
      )}
      {sum.bands.length > 0 && (
        <table className="table calc-bands" data-testid="calc-across-bands">
          <caption className="calc-cap">{sum.bandsKind === 'bands' ? 'Spread in five bands' : 'Values'} (synthetic customers)</caption>
          <thead><tr><th scope="col">{sum.bandsKind === 'bands' ? 'Band' : 'Value'}</th><th scope="col" className="num">Customers</th></tr></thead>
          <tbody>
            {sum.bands.map((b) => (
              <tr key={b.label}>
                <td>{b.label}</td>
                <td className="num"><span className="calc-bar" aria-hidden="true"><span style={{ width: `${(b.count / max) * 100}%` }} /></span> <span data-testid="calc-band-count">{b.count}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sum.missing.length > 0 && (
        <div className="calc-nomatch" data-testid="calc-across-missing">
          <h4 className="section-title">No value for {sum.without} synthetic customer{sum.without === 1 ? '' : 's'}</h4>
          {sum.missing.map((g) => {
            const open = showAll.has(g.reason);
            const ids = open ? g.recordIds : g.recordIds.slice(0, 5);
            return (
              <div key={g.reason} className="calc-reason">
                <p><strong>{g.recordIds.length}</strong>: {g.reason}</p>
                <p className="muted">{whatToDo(g.code, calc.label)}</p>
                <ul className="calc-people">{ids.map((id) => <li key={id}>{who(id)}</li>)}</ul>
                {g.recordIds.length > 5 && <button type="button" className="btn ghost sm" onClick={() => setShowAll((s) => { const n = new Set(s); if (open) n.delete(g.reason); else n.add(g.reason); return n; })}>{open ? 'Show fewer' : `Show all ${g.recordIds.length}`}</button>}
              </div>
            );
          })}
        </div>
      )}
      {rows.length === 0 && <p className="muted">This document has no synthetic customers yet.</p>}
    </div>
  );
}
