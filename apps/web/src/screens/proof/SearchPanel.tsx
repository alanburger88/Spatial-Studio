import { useEffect, useState } from 'react';
import type { Project, ReleaseInfo } from '@iss/model';
import { useStudio } from '../../state/store';
import { ErrorState, Tech } from '../../ui/common';
import { fmtAbs } from '../../shell/History';
import type { ProofListDto } from './api';
import { PRODUCER_CHIP, plural, short } from './format';

export interface Filters { releaseId: string; customerRef: string; from: string; to: string; q: string; everyDocument: boolean }

interface Props {
  project: Project; releases: ReleaseInfo[]; filters: Filters; onChange: (f: Filters) => void;
  list: ProofListDto | null; loading: boolean; error: string | null; onRetry: () => void;
  selectedId: string | null; onSelect: (id: string) => void;
  page: number; pageSize: number; onPage: (n: number) => void;
}

/** Search box, filters and the results, newest first. Text boxes apply on Enter or "Search"; the lists and dates at once. */
export function SearchPanel({ project, releases, filters, onChange, list, loading, error, onRetry, selectedId, onSelect, page, pageSize, onPage }: Props) {
  const records = useStudio((s) => s.records);
  const [q, setQ] = useState(filters.q);
  const [customer, setCustomer] = useState(filters.customerRef);
  useEffect(() => { setQ(filters.q); setCustomer(filters.customerRef); }, [filters.q, filters.customerRef]);
  const [moreOpen, setMoreOpen] = useState(() => !!(filters.releaseId || filters.from || filters.to || filters.everyDocument));
  useEffect(() => { if (filters.releaseId || filters.from || filters.to || filters.everyDocument) setMoreOpen(true); }, [filters.releaseId, filters.from, filters.to, filters.everyDocument]);
  const apply = (patch: Partial<Filters>) => onChange({ ...filters, q, customerRef: customer, ...patch });
  const total = list?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="prf-search">
      <form className="prf-form" role="search" aria-label="Find proof records" onSubmit={(e) => { e.preventDefault(); apply({}); }}>
        <label className="field"><span className="label">Proof number or run number</span>
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Part of a proof or run number" data-testid="proof-search" maxLength={100} />
        </label>
        <label className="field"><span className="label">Customer reference</span>
          <input className="input" type="search" value={customer} onChange={(e) => setCustomer(e.target.value)} list="proof-customer-refs" placeholder="The producing system’s reference" data-testid="proof-filter-customer" maxLength={200} aria-describedby="proof-ref-hint" />
          <datalist id="proof-customer-refs">{records.slice(0, 300).map((r) => <option key={r.recordId} value={r.recordId} />)}</datalist>
          <span className="hint" id="proof-ref-hint">An identifier chosen by the system that produced the document, not customer data.</span>
        </label>
        <details className="prf-more" open={moreOpen} onToggle={(e) => setMoreOpen((e.target as HTMLDetailsElement).open)}>
        <summary data-testid="proof-more-filters">Release, dates and documents{(filters.releaseId || filters.from || filters.to || filters.everyDocument) ? ' (in use)' : ''}</summary>
        <label className="field"><span className="label">Release</span>
          <select className="select" value={filters.releaseId} onChange={(e) => apply({ releaseId: e.target.value })} data-testid="proof-filter-release">
            <option value="">Any release</option>
            {releases.map((r) => <option key={r.id} value={r.id}>Release {r.number}</option>)}
            {filters.releaseId && !releases.some((r) => r.id === filters.releaseId) && <option value={filters.releaseId}>{filters.releaseId}</option>}
          </select>
        </label>
        <div className="prf-dates">
          <label className="field"><span className="label">Produced from</span>
            <input className="input" type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => apply({ from: e.target.value })} data-testid="proof-filter-from" />
          </label>
          <label className="field"><span className="label">to</span>
            <input className="input" type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => apply({ to: e.target.value })} data-testid="proof-filter-to" />
          </label>
        </div>
        <label className="prf-check"><input type="checkbox" checked={filters.everyDocument} onChange={(e) => apply({ everyDocument: e.target.checked, releaseId: '' })} data-testid="proof-filter-all" /> Every document, not only “{project.title}”</label>
        </details>
        <div className="row prf-form-actions">
          <button type="submit" className="btn primary sm" data-testid="proof-search-go">Search</button>
          <button type="button" className="btn ghost sm" onClick={() => { setQ(''); setCustomer(''); onChange({ releaseId: '', customerRef: '', from: '', to: '', q: '', everyDocument: filters.everyDocument }); }}>Clear</button>
        </div>
      </form>

      <div className="prf-results-head">
        <h2 className="section-title">Records <span className="chip count" data-testid="proof-count">{list ? total.toLocaleString() : '…'}</span></h2>
        {loading && list && <span className="spinner" role="status" aria-label="Updating" />}
      </div>
      {error ? <ErrorState title="Proof records could not be loaded" message={error} onRetry={onRetry} />
        : !list ? <p className="muted prf-pad" role="status">Loading…</p>
        : !list.records.length ? <p className="muted prf-pad" data-testid="proof-none">No proof records match.</p>
        : (
          <ul className="list-rows prf-list" data-testid="proof-results" aria-label="Proof records, newest first">
            {list.records.map(({ proof, release }) => (
              <li key={proof.proofId}>
                <button type="button" className="prf-row" aria-current={proof.proofId === selectedId ? 'true' : undefined} onClick={() => onSelect(proof.proofId)} data-testid="proof-row" data-proof={proof.proofId}>
                  <span className="prf-row-main">
                    <strong className="prf-ref" title={proof.customerRef}>{proof.customerRef}</strong>
                    <span className={`chip ${proof.produced ? 'accent' : 'warning'}`}>{proof.produced ? 'Produced' : 'Stopped'}</span>
                    <span className="chip">{PRODUCER_CHIP[proof.producer]}</span>
                  </span>
                  <span className="prf-row-sub muted">
                    Release {proof.releaseNumber}{filters.everyDocument ? ` of ${release.info?.title ?? proof.documentId}` : ''} · {fmtAbs(proof.producedAt)}
                  </span>
                  {release.status !== 'known' && <span className="prf-row-marks"><span className="chip warning" data-testid="proof-row-unknown">Release not known here</span></span>}
                  <Tech><span className="prf-row-marks"><span className="chip code" title={proof.proofId}>{short(proof.proofId, 22)}</span></span></Tech>
                </button>
              </li>
            ))}
          </ul>
        )}
      {list && total > pageSize && (
        <nav className="row prf-pager" aria-label="Pages of results">
          <button type="button" className="btn sm" disabled={page === 0} onClick={() => onPage(page - 1)}>Newer</button>
          <span className="muted">Page {page + 1} of {pages} · {plural(total, 'record')}</span>
          <button type="button" className="btn sm" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>Older</button>
        </nav>
      )}
    </div>
  );
}
