import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { roleCan, type ReleaseInfo, type Role } from '@iss/model';
import type { ProofChannel } from '@iss/resolver';
import { ApiFailure } from '../../api/client';
import { useStudio } from '../../state/store';
import { proofApi, type ProduceResultDto } from '../proof/api';
import { CHANNEL_LABEL } from '../proof/format';

const CHOICES: ProofChannel[] = ['email', 'sms', 'html', 'pdf'];
const PDF_MAX = 20;

/** Why documents cannot be produced from this release now (null when they can). The server applies the same rule. */
function produceWhy(r: ReleaseInfo, role: Role | null): string | null {
  if (!role || !roleCan(role, 'approve')) return 'Only approvers and admins can produce documents from a release.';
  if (r.documentRemoved) return 'The document of this release was deleted.';
  if (r.stages.production?.status === 'current' || r.stages.test.status === 'current') return null;
  return r.standing === 'withdrawn' ? 'This release was withdrawn: produce from the release that is current in Test or Production.' : 'A later release has replaced this one: produce from the release that is current in Test or Production.';
}

/**
 * "Produce from this release": the studio produces documents from the FROZEN release for one test customer or all of
 * them and keeps one proof record per customer (fingerprints and decisions, no data, no files).
 */
export function ProduceSection({ release, role }: { release: ReleaseInfo; role: Role | null }) {
  const records = useStudio((s) => s.records);
  const customers = useMemo(() => records.filter((r) => r.documentType === release.documentType && (!r.projectId || r.projectId === release.documentId)), [records, release.documentType, release.documentId]);
  const [who, setWho] = useState('all');
  const [outputs, setOutputs] = useState<ProofChannel[]>(['email', 'sms', 'html']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ProduceResultDto | null>(null);
  const why = produceWhy(release, role);
  const count = who === 'all' ? customers.length : 1;
  const pdfTooMany = outputs.includes('pdf') && count > PDF_MAX;
  const toggle = (c: ProofChannel) => setOutputs((o) => (o.includes(c) ? o.filter((x) => x !== c) : [...o, c]));
  const go = async () => {
    setBusy(true); setError(null); setDone(null);
    try { setDone(await proofApi.produce(release.id, { ...(who === 'all' ? { all: true as const } : { recordId: who }), outputs })); }
    catch (e) { setError(e instanceof ApiFailure ? e.message : 'Nothing was produced.'); }
    finally { setBusy(false); }
  };
  const proofLink = `/studio/${release.documentId}/proof?release=${encodeURIComponent(release.id)}`;
  return (
    <section className="rel-section" aria-labelledby="rel-produce-h" data-testid="rel-produce">
      <h3 className="section-title" id="rel-produce-h">Produce from this release</h3>
      <p className="muted rel-hint">Produces documents from the frozen release (never the working version) for test customers, and keeps a proof record for each: what was produced and why, without the customer’s data. The produced files are not kept.</p>
      <div className="rel-produce-form">
        <label className="field"><span className="label">For</span>
          <select className="select" value={who} onChange={(e) => setWho(e.target.value)} disabled={!!why} data-testid="rel-produce-who">
            <option value="all">All {customers.length} test customers</option>
            {customers.map((r) => <option key={r.recordId} value={r.recordId}>{r.customer.givenName} {r.customer.familyName} · {r.recordId}</option>)}
          </select>
        </label>
        <fieldset className="rel-produce-outputs" disabled={!!why} style={{ border: 0, margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 13 }}>
          <legend className="label" style={{ fontSize: 11.5, fontWeight: 600, color: "var(--iss-text-muted)", padding: 0, marginBottom: 4 }}>Outputs</legend>
          {CHOICES.map((c) => (
            <label key={c}><input type="checkbox" checked={outputs.includes(c)} onChange={() => toggle(c)} data-testid={`rel-produce-${c}`} /> {CHANNEL_LABEL[c].replace(/^./, (x) => x.toUpperCase())}{c === 'pdf' ? ' (slow)' : ''}</label>
          ))}
        </fieldset>
        {pdfTooMany && <p className="muted rel-why">With the PDF, at most {PDF_MAX} customers at a time: choose one customer or leave the PDF out.</p>}
      </div>
      <div className="rel-action-row">
        <button type="button" className="btn primary" disabled={!!why || busy || !outputs.length || pdfTooMany || !customers.length} onClick={go} data-testid="rel-produce-go" aria-describedby={why ? 'rel-produce-why' : undefined}>
          {busy ? <><span className="spinner" aria-hidden="true" /> Producing…</> : 'Produce'}
        </button>
        <Link className="btn" to={proofLink} data-testid="rel-produce-proofs">Proof records of this release</Link>
      </div>
      {why && <p className="muted rel-why" id="rel-produce-why" data-testid="rel-produce-why">{why}</p>}
      {error && <p className="callout error" role="alert">{error}</p>}
      {done && (
        <p className="callout accent" role="status" data-testid="rel-produce-done">
          {done.message} <Link to={proofLink}>See the proof records</Link>
        </p>
      )}
    </section>
  );
}
