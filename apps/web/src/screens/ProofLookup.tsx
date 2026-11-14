import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { roleCan, type ReleaseInfo, type Role } from '@iss/model';
import { ApiFailure, api } from '../api/client';
import { useStudio } from '../state/store';
import { Empty, ErrorState, Loading, ScreenHeader } from '../ui/common';
import { proofApi, type ProofDetailDto, type ProofListDto } from './proof/api';
import { SearchPanel, type Filters } from './proof/SearchPanel';
import { ProofDetail } from './proof/ProofDetail';
import { AddRecordsDialog } from './proof/AddRecordsDialog';
import { PROOF_LIMIT_LINES } from './proof/format';
import './ProofLookup.css';

const PAGE = 25;

/**
 * Proof (S21): what a customer was given, from which release, and why — from proof records that keep fingerprints
 * and decisions, never the customer's data (docs/design/BEFORE_AFTER_AND_PROOF.md, "Proof for any customer").
 * Records come from producing from a release (Releases screen) or from a runnable package's proof.jsonl ("Add proof
 * records"). Everything shown is read from the proofs API (docs/api/PROOFS.md).
 */
export function ProofLookup() {
  const project = useStudio((s) => s.project)!;
  const session = useStudio((s) => s.session);
  const role: Role | null = session?.authEnabled ? session.user?.role ?? null : 'admin';
  const mayAdd = !!role && roleCan(role, 'approve');
  const [params, setParams] = useSearchParams();

  const filters: Filters = useMemo(() => ({
    releaseId: params.get('release') ?? '', customerRef: params.get('customer') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '',
    q: params.get('q') ?? '', everyDocument: params.get('scope') === 'all',
  }), [params]);
  const setFilters = (f: Filters) => setParams((p) => {
    const next = new URLSearchParams(p);
    const set = (k: string, v: string) => (v ? next.set(k, v) : next.delete(k));
    set('release', f.releaseId); set('customer', f.customerRef.trim()); set('from', f.from); set('to', f.to); set('q', f.q.trim()); set('scope', f.everyDocument ? 'all' : '');
    next.delete('proof');
    return next;
  }, { replace: true });

  // This document's releases, for the release filter and links.
  const [releases, setReleases] = useState<ReleaseInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    api.projectReleases(project.projectId).then((d) => { if (live) setReleases(d.releases); }).catch(() => { if (live) setReleases([]); });
    return () => { live = false; };
  }, [project.projectId]);

  const [rev, setRev] = useState(0);
  const reload = useCallback(() => setRev((r) => r + 1), []);
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [filters.releaseId, filters.customerRef, filters.from, filters.to, filters.q, filters.everyDocument]);
  const [list, setList] = useState<ProofListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    proofApi.list({ documentId: filters.everyDocument ? undefined : project.projectId, releaseId: filters.releaseId || undefined, customerRef: filters.customerRef || undefined, from: filters.from || undefined, to: filters.to || undefined, q: filters.q || undefined, limit: PAGE, offset: page * PAGE })
      .then((d) => { if (live) { setList(d); setError(null); } })
      .catch((e) => { if (live) setError(e instanceof ApiFailure ? e.message : 'The proof records could not be loaded.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [project.projectId, filters, page, rev]);

  // The selected record: the one in the address, else the newest found (never an empty detail panel).
  const asked = params.get('proof');
  const selectedId = asked ?? list?.records[0]?.proof.proofId ?? null;
  const select = (id: string) => setParams((p) => { const next = new URLSearchParams(p); next.set('proof', id); return next; }, { replace: true });
  const [detail, setDetail] = useState<ProofDetailDto | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  useEffect(() => {
    setDetail(null); setDetailError(null);
    if (!selectedId) return;
    let live = true;
    proofApi.get(selectedId)
      .then((d) => { if (live) setDetail(d); })
      .catch((e) => { if (live) setDetailError(e instanceof ApiFailure ? e.message : 'This proof record could not be loaded.'); });
    return () => { live = false; };
  }, [selectedId, rev]);

  const [adding, setAdding] = useState(false);
  const filtered = !!(filters.releaseId || filters.customerRef || filters.from || filters.to || filters.q);

  return (
    <section className="screen" data-testid="proof-lookup">
      <ScreenHeader id="S21" title="Proof" subtitle="What a customer was given, from which release, and why. A proof record keeps fingerprints and decisions, never the customer’s data: to see the document again, supply the data and the studio re-creates and verifies it."
        actions={<button type="button" className="btn" data-testid="proof-add-open" disabled={!mayAdd} title={mayAdd ? 'Add the proof records a runnable package wrote (proof.jsonl)' : 'Only approvers and admins can add proof records.'} onClick={() => setAdding(true)}>Add proof records</button>} />
      <div className="screen-body prf-body">
        <aside className="panel prf-side" aria-label="Find proof records">
          <SearchPanel project={project} releases={releases ?? []} filters={filters} onChange={setFilters} list={list} loading={loading} error={error} onRetry={reload}
            selectedId={selectedId} onSelect={select} page={page} pageSize={PAGE} onPage={setPage} />
          <div className="prf-limits" data-testid="proof-limits">
            <h2 className="section-title">What a proof record is not</h2>
            <ul>{PROOF_LIMIT_LINES.map((l) => <li key={l}>{l}</li>)}</ul>
            {list && <p className="muted">Producing: at most {list.limits.customers} customers at a time, {list.limits.customersWithPdf} with the PDF. Files: at most {list.limits.fileBytes / 1024 / 1024} MB and {list.limits.fileLines.toLocaleString()} records.</p>}
          </div>
        </aside>
        <div className="panel prf-main" aria-label="Proof record" aria-live="polite">
          <div className="panel-body">
            {error && !list ? <ErrorState title="Proof records could not be loaded" message={error} onRetry={reload} />
              : !list ? <Loading label="Loading proof records…" />
              : !selectedId ? (
                <Empty title={filtered ? 'No proof record matches' : 'No proof records yet'}
                  message={filtered
                    ? 'Nothing matches these filters. Clear them or search for another customer reference, proof number or run number.'
                    : 'Records appear here when documents are produced from a release of this document (Releases → Produce from this release), or when the proof.jsonl a runnable package wrote is added with “Add proof records”.'}>
                  {filtered && <button type="button" className="btn" onClick={() => setFilters({ releaseId: '', customerRef: '', from: '', to: '', q: '', everyDocument: filters.everyDocument })}>Clear the filters</button>}
                </Empty>
              ) : detailError ? <ErrorState title="This proof record could not be loaded" message={detailError} onRetry={reload} />
              : !detail ? <Loading label="Loading the proof record…" />
              : <ProofDetail key={detail.proof.proofId} detail={detail} project={project} />}
          </div>
        </div>
      </div>
      {adding && <AddRecordsDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); setParams((p) => { const n = new URLSearchParams(p); n.delete('proof'); return n; }, { replace: true }); reload(); }} />}
    </section>
  );
}
export default ProofLookup;
