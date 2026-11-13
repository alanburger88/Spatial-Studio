import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Persona, SyntheticRecord } from '@iss/model';
import { Icon } from '../ui/icons';
import './RecordPicker.css';

/** A customer that was supplied (imported or added) for one document, as opposed to a sample or a generated one. */
export const isSupplied = (r: SyntheticRecord) => !!r.projectId && !r.generated;

/** Human label for a record: name plus persona (card) or claim status (EOB). */
export function recordSummary(r: SyntheticRecord, personas: Persona[]) {
  const name = `${r.customer.givenName} ${r.customer.familyName}`;
  const persona = r.personaId ? personas.find((p) => p.id === r.personaId)?.name ?? r.personaId : null;
  const claim = (r.claims?.[0] as { status?: string } | undefined)?.status ?? null;
  // A document with its own data has no persona or claim status: a generated customer is described by why it exists (shown beside it), a supplied one by its name.
  return { name, tag: persona ?? (claim ? claim.replace(/-/g, ' ') : null), locale: r.customer.locale };
}

/**
 * Searchable record/persona combobox (WAI-ARIA combobox + listbox pattern).
 * Search matches record ID, customer name, persona, claim status and locale.
 * The trigger keeps data-testid="record-selector" and exposes the current value via data-value.
 */
export function RecordPicker({ records, personas, value, onChange }: { records: SyntheticRecord[]; personas: Persona[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const current = records.find((r) => r.recordId === value);
  const cur = current ? recordSummary(current, personas) : null;

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = records.filter((r) => {
      if (!needle) return true;
      const s = recordSummary(r, personas);
      return `${r.recordId} ${s.name} ${s.tag ?? ''} ${s.locale ?? ''} ${r.generated?.label ?? ''}`.toLowerCase().includes(needle);
    });
    // Samples, imported and supplied customers first, then the ones generated for this document (own group).
    return [...hit.filter((r) => !r.generated), ...hit.filter((r) => r.generated)];
  }, [records, personas, q]);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, items.findIndex((r) => r.recordId === value)));
    input.current?.focus();
    const onDoc = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const choose = (id: string) => { onChange(id); setOpen(false); setQ(''); root.current?.querySelector<HTMLButtonElement>('button.rp-trigger')?.focus(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = items[active]; if (r) choose(r.recordId); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  return (
    <div className="rp" ref={root}>
      <button type="button" className="rp-trigger select" data-testid="record-selector" data-value={value} aria-haspopup="listbox" aria-expanded={open}
        aria-label={`Synthetic customer: ${cur ? `${cur.name}${cur.tag ? `, ${cur.tag}` : ''}${current?.generated ? ', generated test customer' : current && isSupplied(current) ? ', supplied customer' : ''} (${value})` : value}. Change customer`}
        onClick={() => setOpen((o) => !o)} onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}>
        <span className="rp-name">{cur?.name ?? (value || 'No customer')}</span>
        {cur?.tag && <span className="rp-tag">{cur.tag}</span>}
        <span className="rp-id mono">{value}</span>
      </button>
      {open && (
        <div className="rp-pop" role="dialog" aria-label="Choose a synthetic customer">
          <label className="rp-search"><Icon.search />
            <input ref={input} role="combobox" aria-expanded="true" aria-controls="rp-list" aria-activedescendant={items[active] ? `rp-${items[active].recordId}` : undefined}
              aria-autocomplete="list" placeholder="Search name, persona, ID or language…" value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onKey} data-testid="record-search" />
          </label>
          <ul id="rp-list" role="listbox" aria-label="Synthetic customers" ref={list}>
            {items.map((r, i) => {
              const s = recordSummary(r, personas);
              const firstGenerated = !!r.generated && !items[i - 1]?.generated;
              return (
                <Fragment key={r.recordId}>
                {firstGenerated && <li className="rp-group" role="presentation" data-testid="record-group-generated">Generated for this document</li>}
                <li id={`rp-${r.recordId}`} role="option" aria-selected={r.recordId === value} data-idx={i} data-testid={`record-option-${r.recordId}`}
                  className={`${i === active ? 'active' : ''}${r.recordId === value ? ' current' : ''}${r.generated ? ' gen' : ''}`} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); choose(r.recordId); }}>
                  <span className="rp-name">{s.name}</span>
                  {s.tag && <span className="rp-tag">{s.tag}</span>}
                  {s.locale && s.locale !== 'en-US' && <span className="rp-tag lang">{s.locale}</span>}
                  {r.generated && <span className="rp-tag gen" data-testid="record-generated-chip">Generated</span>}
                  {isSupplied(r) && <span className="rp-tag" data-testid="record-supplied-chip">Supplied</span>}
                  {r.generated ? <span className="rp-why" title={r.generated.label}>{r.generated.label}</span> : null}
                  <span className="rp-id mono">{r.recordId}</span>
                </li>
                </Fragment>
              );
            })}
            {!items.length && <li className="rp-empty" role="presentation">No customer matches “{q}”.</li>}
          </ul>
          <div className="rp-foot">{items.length} of {records.length} synthetic customers</div>
        </div>
      )}
    </div>
  );
}
