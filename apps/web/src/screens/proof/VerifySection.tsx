import { useEffect, useMemo, useState } from 'react';
import type { Project, ReleaseInfo } from '@iss/model';
import { ApiFailure, api } from '../../api/client';
import { useStudio } from '../../state/store';
import { recordSummary } from '../../shell/RecordPicker';
import { Named, Tech } from '../../ui/common';
import { proofApi, type ProofDetailDto, type VerifyResultDto } from './api';
import { channelsWords } from './format';

type Source = 'customer' | 'json';
const MAX_JSON = 1024 * 1024;

/**
 * Re-create and verify: the data is supplied again (a test customer the studio has, or JSON), the server re-creates
 * the document from the frozen release and says whether it is the same. The data and the re-created outputs live in
 * this component's state for this check only.
 */
export function VerifySection({ detail, project }: { detail: ProofDetailDto; project: Project }) {
  const { proof, release } = detail;
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  const customers = useMemo(() => records.filter((r) => r.documentType === project.documentType), [records, project.documentType]);
  const [source, setSource] = useState<Source>(customers.some((r) => r.recordId === proof.customerRef) ? 'customer' : 'json');
  const [recordId, setRecordId] = useState(customers.find((r) => r.recordId === proof.customerRef)?.recordId ?? customers[0]?.recordId ?? '');
  const [jsonText, setJsonText] = useState('');
  const [releaseId, setReleaseId] = useState('');
  const [others, setOthers] = useState<ReleaseInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; problems: string[] } | null>(null);
  const [result, setResult] = useState<VerifyResultDto | null>(null);
  const [view, setView] = useState<'html' | 'email' | 'sms'>('html');

  useEffect(() => {
    let live = true;
    api.projectReleases(proof.documentId).then((d) => { if (live) setOthers(d.releases.filter((r) => r.id !== proof.releaseId)); }).catch(() => { if (live) setOthers([]); });
    return () => { live = false; };
  }, [proof.documentId, proof.releaseId]);

  const canCheck = release.status === 'known' || !!releaseId;
  const readFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_JSON) { setError({ message: 'The file is larger than 1 MB. Supply one customer’s data.', problems: [] }); return; }
    setJsonText(await f.text());
  };
  const run = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      let body;
      if (source === 'customer') body = { recordId, ...(releaseId ? { releaseId } : {}) };
      else {
        let data: unknown;
        try { data = JSON.parse(jsonText); } catch { setError({ message: 'That is not JSON. Supply one customer’s data as a JSON object.', problems: [] }); setBusy(false); return; }
        body = { record: data, ...(releaseId ? { releaseId } : {}) };
      }
      const r = await proofApi.verify(proof.proofId, body);
      setResult(r);
      setView(r.recreated?.html ? 'html' : r.recreated?.email ? 'email' : 'sms');
    } catch (e) {
      setError({ message: e instanceof ApiFailure ? e.message : 'The check could not be made.', problems: e instanceof ApiFailure && Array.isArray(e.body?.error?.problems) ? e.body.error.problems : [] });
    } finally { setBusy(false); }
  };

  return (
    <section className="prf-section prf-verify" aria-labelledby="prf-verify-h" data-testid="proof-verify">
      <h3 className="section-title" id="prf-verify-h">Re-create and verify</h3>
      <p className="muted prf-hint">Supply the data again and the studio re-creates the document from the frozen release, then compares it with this record. The data is used for this check only: it is not stored and not logged.</p>
      <fieldset className="prf-sources">
        <legend className="sr-only">Where the data comes from</legend>
        <label className="prf-radio"><input type="radio" name="prf-source" value="customer" checked={source === 'customer'} onChange={() => setSource('customer')} data-testid="proof-source-customer" disabled={!customers.length} /> A test customer of this document</label>
        <label className="prf-radio"><input type="radio" name="prf-source" value="json" checked={source === 'json'} onChange={() => setSource('json')} data-testid="proof-source-json" /> The customer’s data as JSON</label>
      </fieldset>
      {source === 'customer' ? (
        <label className="field"><span className="label">Test customer</span>
          <select className="select" value={recordId} onChange={(e) => setRecordId(e.target.value)} data-testid="proof-verify-customer">
            {customers.map((r) => { const s = recordSummary(r, personas); return <option key={r.recordId} value={r.recordId}>{s.name}{r.recordId === proof.customerRef ? ' (same reference)' : ''} · {r.recordId}</option>; })}
          </select>
          {!customers.some((r) => r.recordId === proof.customerRef) && <span className="hint">This studio has no test customer with the reference {proof.customerRef}: supply the data as JSON, or pick a customer to see what differs.</span>}
        </label>
      ) : (
        <div className="prf-json">
          <label className="field"><span className="label">JSON file</span>
            <input type="file" accept=".json,application/json" onChange={(e) => { void readFile(e.target.files?.[0]); e.target.value = ''; }} data-testid="proof-verify-file" />
          </label>
          <label className="field"><span className="label">or paste the data (one customer, as a JSON object, with its recordId)</span>
            <textarea className="textarea mono" rows={5} value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} data-testid="proof-verify-json" />
          </label>
        </div>
      )}
      <label className="field prf-against"><span className="label">Re-create with</span>
        <select className="select" value={releaseId} onChange={(e) => setReleaseId(e.target.value)} data-testid="proof-verify-release">
          <option value="">{release.status === 'known' ? `Release ${proof.releaseNumber}, the release it names` : 'Release not known here — pick one'}</option>
          {others.map((r) => <option key={r.id} value={r.id}>Release {r.number} (another release, to see what differs)</option>)}
        </select>
      </label>
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || !canCheck || (source === 'customer' ? !recordId : !jsonText.trim())} onClick={run} data-testid="proof-verify-go">
          {busy ? <><span className="spinner" aria-hidden="true" /> Re-creating…</> : 'Re-create and verify'}
        </button>
        {!canCheck && <span className="muted">The release this record names is not known here, so it can only be re-created with another release.</span>}
      </div>

      {error && (
        <div className="callout error" role="alert" data-testid="proof-verify-error">
          {error.message}
          {error.problems.length > 0 && <ul>{error.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        </div>
      )}
      {result && (
        <div className="prf-verdict-wrap" data-testid="proof-verdict" data-same={result.same ? 'true' : 'false'}>
          <div className={`callout ${result.same ? 'accent' : 'warning'} prf-verdict`} role="status">
            <strong data-testid="proof-verdict-text">{result.verdict}</strong>
            <span className="muted"> Checked with release {result.checked.release?.number ?? '?'} and {result.checked.dataFrom === 'supplied' ? 'the data supplied' : 'a test customer'}{result.checked.outputs.length ? `, comparing the ${channelsWords(result.checked.outputs)}` : ''}. Nothing was stored.</span>
            {!result.same && (
              <ul className="prf-diffs" data-testid="proof-differences">
                {result.differences.map((d, i) => <li key={i} data-kind={d.kind}>{d.plain}<Tech> <span className="chip code">{d.kind}</span></Tech></li>)}
              </ul>
            )}
          </div>
          {result.same && result.explanation && (
            <div className="prf-explained" data-testid="proof-explained">
              <h4 className="prf-sub">Why, with the values (for this check only)</h4>
              <ul className="prf-explain-list">
                {result.explanation.map((x) => (
                  <li key={x.nodeId}><Named name={x.part} code={x.nodeId} strong />: {x.headline}{x.steps.length > 0 && <ul>{x.steps.map((s, i) => <li key={i}>{s}</li>)}</ul>}</li>
                ))}
              </ul>
            </div>
          )}
          {result.same && result.recreated && (result.recreated.html || result.recreated.email || result.recreated.sms) && (
            <div className="prf-recreated" data-testid="proof-recreated">
              <h4 className="prf-sub">The re-created document (for this check only, not kept)</h4>
              <div className="segmented" role="group" aria-label="Output to show">
                {result.recreated.html && <button type="button" aria-pressed={view === 'html'} onClick={() => setView('html')}>Web page</button>}
                {result.recreated.email && <button type="button" aria-pressed={view === 'email'} onClick={() => setView('email')}>Email</button>}
                {result.recreated.sms && <button type="button" aria-pressed={view === 'sms'} onClick={() => setView('sms')}>Text message</button>}
              </div>
              {view === 'html' && result.recreated.html && <iframe className="prf-frame" title="Re-created web page" sandbox="" srcDoc={result.recreated.html} data-testid="proof-recreated-html" />}
              {view === 'email' && result.recreated.email && (<>
                <p className="prf-subject"><span className="muted">Subject:</span> {result.recreated.email.subject}</p>
                <iframe className="prf-frame" title="Re-created email" sandbox="" srcDoc={result.recreated.email.html} data-testid="proof-recreated-email" />
              </>)}
              {view === 'sms' && result.recreated.sms && <pre className="prf-sms" data-testid="proof-recreated-sms">{result.recreated.sms}</pre>}
              {result.recreated.pdf && <p className="muted prf-hint">PDF: {result.recreated.pdf.pages ?? '?'} pages. {result.recreated.pdf.note}</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
