import { Link } from 'react-router-dom';
import type { Project } from '@iss/model';
import { Named, Proof, Tech } from '../../ui/common';
import { localeLabel } from '../../ui/plain';
import { fmtAbs, When } from '../../ui/time';
import type { ProofDetailDto } from './api';
import { CHANNEL_LABEL, PRODUCER_CHIP, PRODUCER_LABEL, STANDING_WORD, channelsWords, listWords } from './format';
import { VerifySection } from './VerifySection';

/** One proof record in plain words: what was produced and when, by what, from which release, and why (part by part). */
export function ProofDetail({ detail, project }: { detail: ProofDetailDto; project: Project }) {
  const { proof, release, meta, explanation } = detail;
  const rel = release.info;
  const releaseLink = rel && release.status !== 'unknown' && !rel.documentRemoved ? `/studio/${rel.documentId}/releases?release=${rel.number}` : null;
  const channels = proof.outputs.map((o) => o.channel);
  return (
    <article className="prf-detail" data-testid="proof-detail" data-proof={proof.proofId}>
      <header className="prf-detail-head">
        <h2 className="prf-detail-title">Customer reference <span className="prf-ref" data-testid="proof-detail-ref">{proof.customerRef}</span></h2>
        <span className={`chip ${proof.produced ? 'accent' : 'warning'}`} data-testid="proof-detail-status">{proof.produced ? 'Produced' : 'Stopped, not produced'}</span>
        <span className="chip" data-testid="proof-detail-producer">{PRODUCER_CHIP[proof.producer]}</span>
      </header>

      <p className="prf-summary" data-testid="proof-summary">
        {proof.produced
          ? <>Produced <time dateTime={proof.producedAt}>{fmtAbs(proof.producedAt)}</time> by {PRODUCER_LABEL[proof.producer]} from <strong>release {proof.releaseNumber}</strong>{rel ? <> of “{rel.title}”</> : null}: {channels.length ? channelsWords(channels) : 'no outputs were recorded'}.</>
          : <>Stopped <time dateTime={proof.producedAt}>{fmtAbs(proof.producedAt)}</time> by {PRODUCER_LABEL[proof.producer]}: release {proof.releaseNumber}{rel ? <> of “{rel.title}”</> : null} was not produced for this customer because {listWords(explanation.blocked.map((b) => b.words)) || 'of a blocking issue'}.</>}
        {' '}<span className="muted">(<When iso={proof.producedAt} />)</span>
      </p>
      <p className="muted prf-hint">The customer reference was chosen by the system that produced the document. It identifies the customer there; it is not customer data.</p>

      {release.status !== 'known'
        ? <div className="callout warning" role="status" data-testid="proof-release-unknown"><strong>Release not known here.</strong> {release.message}</div>
        : (
          <p className="prf-release" data-testid="proof-release">
            From release {proof.releaseNumber}{rel ? <>, now <span className="chip">{STANDING_WORD[rel.standing]}</span></> : null}
            {releaseLink && <> · <Link to={releaseLink} data-testid="proof-release-link">Open release {proof.releaseNumber} in Releases</Link></>}
            {rel?.documentRemoved && <span className="muted"> · its document was deleted; the release is kept</span>}
          </p>
        )}

      <section className="prf-section" aria-labelledby="prf-why-h">
        <h3 className="section-title" id="prf-why-h">Why: what each part showed, and the rule that chose it</h3>
        <p className="muted prf-hint" data-testid="proof-no-values">
          No customer values are shown because none are held: a proof record keeps which message each part showed and which rules chose it, never the data the rules tested.
          {explanation.namedFrom === 'release' ? ' Names are read from the frozen release.' : ' This studio does not have the release, so only the codes the record carries can be shown.'}
          {' '}To see the values, supply the data again below.
        </p>
        {explanation.decisions.length === 0
          ? <p className="muted">The record lists no decided parts.</p>
          : (
            <div className="prf-table-wrap">
              <table className="table prf-why" data-testid="proof-why">
                <thead><tr><th scope="col">Part</th><th scope="col">Message shown</th><th scope="col">Chosen by</th></tr></thead>
                <tbody>
                  {explanation.decisions.map((d) => (
                    <tr key={d.nodeId} data-testid="proof-why-row" data-node={d.nodeId}>
                      <th scope="row"><Named name={d.part} code={d.nodeId} /></th>
                      <td>{d.variantId ? <Named name={d.message ?? d.variantId} code={d.variantId} /> : <span className="muted">Shown (this part has no alternative messages)</span>}</td>
                      <td>{d.rules.length ? (
                        <ul className="prf-rules">{d.rules.map((r) => <li key={r.id}><Named name={r.title} code={r.id} /></li>)}</ul>
                      ) : <span className="muted">{d.variantId ? 'Its fallback: no rule chose another message' : 'No rule'}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {explanation.blocked.length > 0 && (
          <div className="callout warning" data-testid="proof-blocked">
            <strong>Stopped by:</strong> {explanation.blocked.map((b) => b.words).join('; ')}.
            <Tech> <span className="mono">{explanation.blocked.map((b) => b.code).join(', ')}</span></Tech>
          </div>
        )}
      </section>

      <section className="prf-section" aria-labelledby="prf-out-h">
        <h3 className="section-title" id="prf-out-h">Outputs and their fingerprints</h3>
        {detail.outputs.length === 0 ? <p className="muted">Nothing was produced, so there are no output fingerprints.</p> : (
          <ul className="prf-outputs" data-testid="proof-outputs">
            {detail.outputs.map((o) => (
              <li key={o.channel} data-channel={o.channel}>
                <strong>{CHANNEL_LABEL[o.channel].replace(/^./, (c) => c.toUpperCase())}</strong>
                <span className="muted"> — {o.kind === 'bytes' ? 'fingerprint of the exact file' : `fingerprint of the content it was composed from${o.pages != null ? `, ${o.pages} page${o.pages === 1 ? '' : 's'}` : ''}`}</span>
                <Tech><span className="chip code prf-hash" title={o.sha256}>{o.sha256}</span></Tech>
              </li>
            ))}
          </ul>
        )}
        <p className="muted prf-hint">The files themselves are not kept. They can be re-created, and checked against these fingerprints, when the data is supplied again.</p>
      </section>

      <Proof label="Record details" testId="proof-tech">
        <dl className="kv prf-kv">
          <dt>Proof number</dt><dd className="mono" data-testid="proof-id">{proof.proofId}</dd>
          <dt>Run number</dt><dd className="mono" data-testid="proof-run">{proof.runId}</dd>
          <dt>Release</dt><dd className="mono">{proof.releaseId}</dd>
          <dt>Release fingerprint</dt><dd className="mono">{proof.releaseDigest}</dd>
          <dt>Data fingerprint</dt><dd className="mono">{proof.dataFingerprint}</dd>
          <dt>Content fingerprint</dt><dd className="mono">{proof.contentDigest}</dd>
          <dt>Engine</dt><dd className="mono">{proof.engineVersion}</dd>
          <dt>Language</dt><dd>{localeLabel(proof.locale)}</dd>
          <dt>Kept here since</dt><dd>{fmtAbs(meta.addedAt)} · {meta.source === 'studio' ? 'produced in this studio' : 'added from a file'}{meta.addedBy ? ` by ${meta.addedBy.name}` : ''}</dd>
        </dl>
      </Proof>

      <VerifySection detail={detail} project={project} />
    </article>
  );
}
