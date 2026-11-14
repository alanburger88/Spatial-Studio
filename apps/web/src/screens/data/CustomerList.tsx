import { useEffect, useMemo, useRef, useState } from 'react';
import type { Persona, SyntheticRecord } from '@iss/model';
import { recordSummary } from '../../shell/RecordPicker';
import { Tech } from '../../ui/common';
import { useStudio } from '../../state/store';
import { Icon } from '../../ui/icons';
import { isOwn, ORIGINS, ORIGIN_GROUP, ORIGIN_LABEL, originOf, type Origin } from './explorerModel';

export type OriginFilter = 'all' | Origin;

const CHIP: Record<Origin, string> = { yours: 'accent', generated: 'info', imported: 'variant', sample: '' };

/** The searchable, grouped list of customers. Up and down move through it; Enter opens the one you are on. */
export function CustomerList({ records, personas, selectedId, onSelect, broken, canEdit, onNewBlank, onNewCopy, disabledReason, only = null, onClearOnly }: {
  records: SyntheticRecord[]; personas: Persona[]; selectedId: string; onSelect: (id: string) => void; broken: Set<string>;
  canEdit: boolean; onNewBlank: () => void; onNewCopy: () => void; disabledReason: string | null;
  /** Only these customers (from "Ask about all customers"), until `onClearOnly`. */
  only?: Set<string> | null; onClearOnly?: () => void;
}) {
  const technical = useStudio((s) => s.viewMode) === 'technical';
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<OriginFilter>('all');
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = records.filter((r) => {
      if (only && !only.has(r.recordId)) return false;
      const o = originOf(r);
      if (filter !== 'all' && filter !== o) return false;
      if (!needle) return true;
      const s = recordSummary(r, personas);
      return `${s.name} ${s.tag ?? ''} ${r.generated?.label ?? ''} ${technical ? r.recordId : ''}`.toLowerCase().includes(needle);
    });
    return ORIGINS.map((o) => ({ origin: o, rows: hit.filter((r) => originOf(r) === o) })).filter((g) => g.rows.length);
  }, [records, personas, q, filter, technical, only]);
  const order = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.recordId)), [groups]);
  const total = order.length;
  const counts = useMemo(() => Object.fromEntries(ORIGINS.map((o) => [o, records.filter((r) => originOf(r) === o).length])) as Record<Origin, number>, [records]);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [menu]);
  useEffect(() => { box.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [selectedId]);

  const move = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const cur = (document.activeElement as HTMLElement | null)?.dataset.id;
    const i = order.indexOf(cur ?? selectedId);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : Math.max(0, Math.min(order.length - 1, (i < 0 ? 0 : i) + (e.key === 'ArrowDown' ? 1 : -1)));
    e.preventDefault();
    box.current?.querySelector<HTMLElement>(`[data-id="${order[next]}"]`)?.focus();
  };
  const tabbable = order.includes(selectedId) ? selectedId : order[0];

  return (
    <aside className="panel dx-left" data-side="left" data-side-title="Customers" aria-label="Customers">
      <div className="panel-head">Customers <span className="chip count" data-testid="dx-count">{records.length}</span></div>
      {only && (
        <div className="callout accent dx-only" role="status" data-testid="dx-only" data-n={records.filter((r) => only.has(r.recordId)).length}>
          <span>Only the {records.filter((r) => only.has(r.recordId)).length} customers from your question.</span>
          {onClearOnly && <button type="button" className="btn ghost sm" onClick={onClearOnly} data-testid="dx-only-clear">Show all</button>}
        </div>
      )}
      <div className="dx-tools">
        <label className="dx-search"><Icon.search aria-hidden="true" width={14} height={14} />
          <input className="input" type="search" data-testid="dx-search" aria-label="Search customers" placeholder={technical ? 'Search name, persona or ID…' : 'Search customers…'} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="dx-tools-row">
          <label className="dx-filter"><span className="dx-sr">Show</span>
            <select className="select" data-testid="dx-filter" aria-label="Show customers from" value={filter} onChange={(e) => setFilter(e.target.value as OriginFilter)}>
              <option value="all">All</option>
              {ORIGINS.map((o) => <option key={o} value={o}>{o === 'generated' ? 'Generated' : ORIGIN_GROUP[o]} ({counts[o]})</option>)}
            </select>
          </label>
          <div className="dx-new-wrap" ref={menuRef}>
            <button type="button" className="btn primary sm" data-testid="dx-new" aria-haspopup="menu" aria-expanded={menu} disabled={!canEdit} title={canEdit ? 'Add a customer to this document' : disabledReason ?? undefined} onClick={() => setMenu(!menu)}><Icon.plus width={14} height={14} /> New customer</button>
            {menu && (
              <div className="dx-menu" role="menu" aria-label="New customer">
                <button type="button" role="menuitem" data-testid="dx-new-blank" onClick={() => { setMenu(false); onNewBlank(); }}><strong>Blank</strong><span className="muted">Empty values built from the data fields</span></button>
                <button type="button" role="menuitem" data-testid="dx-new-copy" onClick={() => { setMenu(false); onNewCopy(); }}><strong>Copy of the selected customer</strong><span className="muted">Starts with the same values</span></button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="panel-body flush dx-listbox" ref={box} data-testid="dx-list" role="listbox" aria-label="Customers" onKeyDown={move}>
        {groups.map((g) => (
          <div key={g.origin} role="group" aria-labelledby={`dx-gh-${g.origin}`} data-testid={`dx-group-${g.origin}`}>
            <div className="dx-group-heading" id={`dx-gh-${g.origin}`}>{ORIGIN_GROUP[g.origin]} <span className="chip count">{g.rows.length}</span></div>
            <div className="list-rows">
              {g.rows.map((r) => {
                const s = recordSummary(r, personas);
                const sel = r.recordId === selectedId;
                const line = r.generated?.label ?? s.tag ?? (isOwn(g.origin) ? 'Your own customer' : 'No persona');
                return (
                  <button key={r.recordId} type="button" role="option" aria-selected={sel} tabIndex={r.recordId === tabbable ? 0 : -1} data-id={r.recordId} data-testid={`dx-row-${r.recordId}`}
                    className={`dx-row${sel ? ' selected' : ''}`} onClick={() => onSelect(r.recordId)}>
                    <span className="dx-row-main"><span className="dx-row-name">{s.name}</span>
                      {broken.has(r.recordId) && <span className="dx-row-warn" data-testid="dx-row-warn" title="Some values do not fit the data fields"><Icon.warning width={13} height={13} aria-hidden="true" /><span className="dx-sr">has values to fix</span></span>}
                      <span className={`chip ${CHIP[g.origin]}`}>{ORIGIN_LABEL[g.origin]}</span></span>
                    <span className="dx-row-line" title={line}>{line}</span>
                    <Tech><span className="chip code dx-row-id">{r.recordId}</span></Tech>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {total === 0 && <p className="muted dx-none">{q ? `No customer matches “${q}”.` : 'No customers in this group.'}</p>}
      </div>
    </aside>
  );
}
