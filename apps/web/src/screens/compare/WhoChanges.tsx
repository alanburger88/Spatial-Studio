import { useEffect, useMemo, useRef, useState } from 'react';
import { COMPARISON_OUTCOMES, COMPARISON_OUTCOME_LABEL, type ComparisonOutcome, type CustomerComparison, type VersionComparison } from '@iss/scenarios';
import { Named } from '../../ui/common';

const SHOW_FIRST = 200;

/**
 * Part 1: who changes. Every customer worked out under both versions by the engine, sorted into the engine's groups.
 * The list is the table alternative: every number on this panel is also a customer you can choose.
 */
export function WhoChanges({ comparison, selected, onSelect }: { comparison: VersionComparison; selected: string | null; onSelect: (recordId: string) => void }) {
  const [filter, setFilter] = useState('');
  const [all, setAll] = useState<Partial<Record<ComparisonOutcome, boolean>>>({});
  const q = filter.trim().toLowerCase();
  const byId = useMemo(() => new Map(comparison.customers.map((c) => [c.recordId, c])), [comparison]);
  const root = useRef<HTMLDivElement>(null);
  // The chosen customer stays in view in the list (it may have been chosen by the address or the default).
  useEffect(() => { root.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }); }, [selected, comparison]);
  const total = comparison.evaluated;
  const changed = total - comparison.groups.same.length;

  return (
    <div className="cmp-who" data-testid="cmp-who" ref={root}>
      <p className="cmp-who-total" data-testid="cmp-who-total" data-changed={changed} data-total={total}>
        <strong>{changed} of {total} synthetic {total === 1 ? 'customer' : 'customers'}</strong> {changed === 1 ? 'sees' : 'see'} a visible difference.
      </p>
      <label className="field cmp-filter"><span className="label">Find a customer</span>
        <input className="input" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name or customer id" data-testid="cmp-filter" />
      </label>
      <div className="cmp-groups">
        {COMPARISON_OUTCOMES.map((o) => {
          const ids = comparison.groups[o];
          const rows = ids.map((id) => byId.get(id)!).filter((c): c is CustomerComparison => !!c && (!q || c.name.toLowerCase().includes(q) || c.recordId.toLowerCase().includes(q)));
          const shown = all[o] ? rows : rows.slice(0, SHOW_FIRST);
          // Groups with customers start open, except "No visible change". A search opens every group that has a match.
          const open = q ? rows.length > 0 : o !== 'same' && ids.length > 0;
          return (
            <details key={`${o}-${q ? 'q' : 'n'}`} className="cmp-group" data-testid={`cmp-group-${o}`} data-count={ids.length} open={open}>
              <summary>
                <span className="cmp-group-name">{COMPARISON_OUTCOME_LABEL[o]}</span>
                <span className="chip count" data-testid={`cmp-count-${o}`}>{ids.length} of {total} synthetic</span>
              </summary>
              {ids.length === 0 ? <p className="muted cmp-group-empty">Nobody.</p>
                : rows.length === 0 ? <p className="muted cmp-group-empty">No match in this group.</p>
                : (
                  <ul className="list-rows cmp-rows">
                    {shown.map((c) => (
                      <li key={c.recordId}>
                        <button type="button" className="cmp-row" data-testid="cmp-customer" data-record={c.recordId} aria-current={selected === c.recordId ? 'true' : undefined} onClick={() => onSelect(c.recordId)}>
                          <Named name={c.name} code={c.recordId} />
                          {c.changes.length > 0 && <span className="muted cmp-row-n">{c.changes.length} {c.changes.length === 1 ? 'difference' : 'differences'}</span>}
                        </button>
                      </li>
                    ))}
                    {shown.length < rows.length && <li><button type="button" className="btn sm" onClick={() => setAll((a) => ({ ...a, [o]: true }))}>Show all {rows.length}</button></li>}
                  </ul>
                )}
            </details>
          );
        })}
      </div>
    </div>
  );
}
