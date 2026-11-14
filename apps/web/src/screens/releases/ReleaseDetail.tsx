import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RELEASE_NOTE_MAX, RELEASE_STAGE_LABEL, RELEASE_STAGE_STATUS_LABEL, cleanReleaseNote, promoteProblem, releaseRoleProblem, supersededByPromotion, withdrawProblem, type ReleaseEvent, type ReleaseInfo, type ReleaseStage, type Role } from '@iss/model';
import { ApiFailure, api, type ReleaseDetailDto, type ReleasePdfRecordDto } from '../../api/client';
import { useStudio } from '../../state/store';
import { Dialog, Tech } from '../../ui/common';
import { localeLabel } from '../../ui/plain';
import { fmtAbs, When } from '../../ui/time';
import { PackageSection } from './PackageSection';
import { RuntimeSection } from './RuntimeSection';
import { HandoverSection } from './HandoverSection';
import { ProduceSection } from './ProduceSection';
import { STANDING_CHIP, personName } from './format';
import { ReleaseLibrarySection } from '../library/ReleaseLibrary';

export interface DetailProps {
  detail: ReleaseDetailDto;
  releases: ReleaseInfo[];
  role: Role | null;
  /** Something about this release (or any release) changed: reload the list and the detail. */
  onChanged: () => void;
}

export function ReleaseDetail({ detail, releases, role, onChanged }: DetailProps) {
  const r = detail.release;
  const st = STANDING_CHIP[r.standing];
  return (
    <div className="rel-detail-body" data-testid="rel-detail" data-release={r.number}>
      <header className="rel-detail-head">
        <h2 className="rel-detail-title">Release {r.number}</h2>
        <span className={`chip ${st.cls}`} data-testid="rel-detail-standing">{st.label}</span>
        <Tech><span className="chip code">{r.id}</span></Tech>
        <Link className="btn sm" style={{ marginLeft: 'auto' }} data-testid="rel-compare" to={`/studio/${r.documentId}/compare?before=r${r.number}`} title={`See what customers would see differently between release ${r.number} and another version`}>Compare with…</Link>
      </header>
      <StageStates r={r} />
      {r.documentRemoved && <div className="callout warning" role="status">The document this release came from was deleted{r.documentRemovedAt ? ` on ${fmtAbs(r.documentRemovedAt)}` : ''}. The release is kept as it was.</div>}
      <Facts r={r} />
      <ReleaseLibrarySection releaseId={r.id} />
      <ReleaseMappings detail={detail} />
      <StageHistory history={detail.history} />
      <Actions detail={detail} releases={releases} role={role} onChanged={onChanged} />
      <PackageSection release={r} onChanged={onChanged} />
      <RuntimeSection release={r} onChanged={onChanged} />
      <ProduceSection release={r} role={role} />
      <PdfAccessibilitySection releaseId={r.id} />
      <HandoverSection release={r} entries={detail.handover} role={role} onChanged={onChanged} />
    </div>
  );
}

/** Where the release stands at each stage (the one-word standing hides, for example, a release withdrawn from Production that is still the Test release). */
function StageStates({ r }: { r: ReleaseInfo }) {
  const word = (s: ReleaseInfo['stages']['test'] | null) => (s ? RELEASE_STAGE_STATUS_LABEL[s.status] : 'Never');
  const cls = (s: ReleaseInfo['stages']['test'] | null) => (s?.status === 'current' ? 'accent' : s?.status === 'withdrawn' ? 'warning' : '');
  return (
    <p className="rel-stage-states" data-testid="rel-stage-states">
      <span>Test <span className={`chip ${cls(r.stages.test)}`} data-testid="rel-stage-test">{word(r.stages.test)}</span></span>
      <span>Production <span className={`chip ${cls(r.stages.production)}`} data-testid="rel-stage-production">{word(r.stages.production)}</span></span>
    </p>
  );
}

/* ------------------------------------------------------------------ facts */

function Facts({ r }: { r: ReleaseInfo }) {
  return (
    <section className="rel-section" aria-labelledby="rel-facts-h" data-testid="rel-facts">
      <h3 className="section-title" id="rel-facts-h">About this release</h3>
      <dl className="kv rel-kv">
        <dt>Release number</dt><dd data-testid="rel-fact-number">{r.number}</dd>
        <dt>Title when approved</dt><dd data-testid="rel-fact-title">{r.title}</dd>
        <dt>Kind of document</dt><dd>{r.kind}</dd>
        <dt>Languages</dt><dd>{r.languages.map(localeLabel).join(', ')}</dd>
        <dt>Saved version</dt><dd data-testid="rel-fact-version">v{r.modelVersion}</dd>
        <dt>Approved by</dt><dd>{personName(r.approvedBy)}</dd>
        <dt>Approved</dt><dd><time dateTime={r.approvedAt}>{fmtAbs(r.approvedAt)}</time> <span className="muted">(<When iso={r.approvedAt} />)</span></dd>
        <dt>How it was made</dt><dd>{r.origin === 'approval' ? 'Made when the document was approved' : `Made later from the approved version${r.createdBy ? ` by ${r.createdBy.name}` : ''}`}</dd>
      </dl>
      <Tech>
        <dl className="kv rel-kv rel-tech" data-testid="rel-tech">
          <dt>Content digest</dt><dd className="mono" title={r.contentDigest}>{r.contentDigest}</dd>
          <dt>Engine</dt><dd className="mono">{r.versions.engine}</dd>
          <dt>Paged renderer</dt><dd className="mono">{r.versions.pagedRenderer}</dd>
          <dt>Web renderer</dt><dd className="mono">{r.versions.htmlRenderer}</dd>
          <dt>Email / SMS renderers</dt><dd className="mono">{r.versions.emailRenderer} · {r.versions.smsRenderer}</dd>
          <dt>Project format</dt><dd className="mono">{r.versions.schema}</dd>
          <dt>Package format</dt><dd className="mono">{r.versions.packageFormat}</dd>
        </dl>
      </Tech>
    </section>
  );
}

/* ------------------------------------------------------------------ stage history */

function eventWords(e: ReleaseEvent): { text: string; note: string | null } {
  const stage = e.stage ? RELEASE_STAGE_LABEL[e.stage] : '';
  switch (e.kind) {
    case 'created': return { text: 'Created and moved to Test', note: e.note };
    case 'reapproved': return { text: 'Approved again with no change', note: e.note };
    case 'promoted': return { text: 'Moved to Production', note: e.note };
    case 'superseded': return { text: `Replaced in ${stage || 'its stage'}`, note: e.note };
    case 'withdrawn': return { text: `Withdrawn from ${stage || 'its stage'}`, note: e.note ? `Reason: ${e.note}` : null };
    case 'document-removed': return { text: 'The document was deleted; the release is kept', note: e.note };
    default: return { text: 'Changed', note: e.note };
  }
}

function StageHistory({ history }: { history: ReleaseEvent[] }) {
  return (
    <section className="rel-section" aria-labelledby="rel-stages-h">
      <h3 className="section-title" id="rel-stages-h">Stage history</h3>
      <ol className="rel-timeline" data-testid="rel-stages">
        {history.map((e) => {
          const w = eventWords(e);
          return (
            <li key={e.id} data-testid="rel-stage-event" data-kind={e.kind} data-stage={e.stage ?? ''}>
              <span className="rel-dot" aria-hidden="true" />
              <span className="rel-ev-text"><strong>{w.text}</strong>{e.by ? <span className="muted"> by {e.by.name}</span> : null}{' '}<span className="muted"><When iso={e.at} /></span>{w.note && <span className="rel-ev-note">{w.note}</span>}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ actions */

function failMessage(e: unknown): string { return e instanceof ApiFailure ? e.message : e instanceof Error ? e.message : 'That did not work.'; }

function Actions({ detail, releases, role, onChanged }: { detail: ReleaseDetailDto; releases: ReleaseInfo[]; role: Role | null; onChanged: () => void }) {
  const r = detail.release;
  const [dialog, setDialog] = useState<null | 'promote' | 'withdraw'>(null);
  // The role is checked here with the shared rules, so the buttons match what the server will accept; the server's own answer fills in anything else.
  const serverReason = (action: string, stage?: string) => detail.actions.find((a) => a.action === action && (!stage || a.stage === stage) && !a.allowed)?.reason ?? null;
  const promoteWhy = releaseRoleProblem(role, 'promote') ?? promoteProblem(r) ?? serverReason('promote');
  const withdrawable = (['production', 'test'] as ReleaseStage[]).filter((s) => withdrawProblem(r, s) === null);
  const withdrawWhy = releaseRoleProblem(role, 'withdraw')
    ?? (withdrawable.length
      ? (withdrawable.every((s) => serverReason('withdraw', s)) ? serverReason('withdraw', withdrawable[0]) : null)
      : withdrawProblem(r, r.stages.production ? 'production' : 'test'));
  return (
    <section className="rel-section" aria-labelledby="rel-actions-h" data-testid="rel-actions">
      <h3 className="section-title" id="rel-actions-h">Actions</h3>
      <div className="rel-action-row">
        <div className="rel-action">
          <button type="button" className="btn primary" data-testid="rel-promote" disabled={!!promoteWhy} aria-describedby={promoteWhy ? 'rel-promote-why' : undefined} title={promoteWhy ?? undefined} onClick={() => setDialog('promote')}>Move to Production</button>
          {promoteWhy && <p className="muted rel-why" id="rel-promote-why" data-testid="rel-promote-why">{promoteWhy}</p>}
        </div>
        <div className="rel-action">
          <button type="button" className="btn danger" data-testid="rel-withdraw" disabled={!!withdrawWhy} aria-describedby={withdrawWhy ? 'rel-withdraw-why' : undefined} title={withdrawWhy ?? undefined} onClick={() => setDialog('withdraw')}>Withdraw</button>
          {withdrawWhy && <p className="muted rel-why" id="rel-withdraw-why" data-testid="rel-withdraw-why">{withdrawWhy}</p>}
        </div>
      </div>
      {dialog === 'promote' && <PromoteDialog r={r} releases={releases} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onChanged(); }} />}
      {dialog === 'withdraw' && <WithdrawDialog r={r} stages={withdrawable} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onChanged(); }} />}
    </section>
  );
}

function PromoteDialog({ r, releases, onClose, onDone }: { r: ReleaseInfo; releases: ReleaseInfo[]; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replaces = supersededByPromotion(releases, r.number);
  const go = async () => {
    setBusy(true); setError(null);
    try {
      const res = await api.promoteRelease(r.id, cleanReleaseNote(note) || undefined);
      useStudio.getState().toast({ kind: 'success', title: `Release ${r.number} is now in Production`, message: res.superseded.length ? `It replaces release ${res.superseded.map((x) => x.number).join(', ')}.` : 'Nothing was in Production before.' });
      onDone();
    } catch (e) { setError(failMessage(e)); setBusy(false); }
  };
  return (
    <Dialog title={`Move release ${r.number} to Production`} onClose={onClose} labelledBy="rel-promote-title"
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" data-testid="rel-promote-confirm" disabled={busy} onClick={go}>{busy ? 'Moving…' : 'Move to Production'}</button></>}>
      <div data-testid="rel-promote-dialog" className="rel-dialog">
        <p data-testid="rel-promote-replaces">
          {replaces.length
            ? <>Release {r.number} will become the Production release. It <strong>replaces release {replaces.join(', ')}</strong>, which stays on record as superseded.</>
            : <>Nothing is in Production yet, so release {r.number} replaces no other release.</>}
        </p>
        <p className="muted">The release itself does not change: this only records where it stands.</p>
        <label className="field"><span className="label">Note (optional)</span>
          <textarea className="textarea" rows={2} maxLength={RELEASE_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} data-testid="rel-promote-note" />
        </label>
        {error && <p className="callout error" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}

function WithdrawDialog({ r, stages, onClose, onDone }: { r: ReleaseInfo; stages: ReleaseStage[]; onClose: () => void; onDone: () => void }) {
  const [stage, setStage] = useState<ReleaseStage>(stages[0] ?? 'test');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = cleanReleaseNote(reason);
  const go = async () => {
    setBusy(true); setError(null);
    try {
      await api.withdrawRelease(r.id, stage, clean);
      useStudio.getState().toast({ kind: 'success', title: `Release ${r.number} withdrawn from ${RELEASE_STAGE_LABEL[stage]}`, message: 'It stays on record.' });
      onDone();
    } catch (e) { setError(failMessage(e)); setBusy(false); }
  };
  return (
    <Dialog title={`Withdraw release ${r.number}`} onClose={onClose} labelledBy="rel-withdraw-title"
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn danger" data-testid="rel-withdraw-confirm" disabled={busy || !clean} onClick={go}>{busy ? 'Withdrawing…' : 'Withdraw'}</button></>}>
      <div data-testid="rel-withdraw-dialog" className="rel-dialog">
        <p>A withdrawn release stays on record but is no longer the one in use. Nothing takes its place by itself, and it cannot be brought back: approve the document again to make a new release.</p>
        {stages.length > 1 && (
          <label className="field"><span className="label">Withdraw from</span>
            <select className="select" value={stage} onChange={(e) => setStage(e.target.value as ReleaseStage)} data-testid="rel-withdraw-stage">
              {stages.map((s) => <option key={s} value={s}>{RELEASE_STAGE_LABEL[s]}</option>)}
            </select>
          </label>
        )}
        {stages.length === 1 && <p><strong>Withdraw from {RELEASE_STAGE_LABEL[stages[0]]}.</strong></p>}
        <label className="field"><span className="label">Why is it being withdrawn? (required)</span>
          <textarea className="textarea" rows={3} maxLength={RELEASE_NOTE_MAX} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="rel-withdraw-reason" />
        </label>
        {error && <p className="callout error" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ accessible PDF (wave 2) */

/**
 * The level of PDF accessibility proof this release has reached, and when: made on demand (composing and checking a PDF
 * takes a moment), never claimed when it has not been run. "Checked by the studio" is not validation against PDF/UA.
 */
function PdfAccessibilitySection({ releaseId }: { releaseId: string }) {
  const [rec, setRec] = useState<ReleasePdfRecordDto | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setRec(undefined); setError(null);
    api.releasePdfAccessibility(releaseId).then((o) => { if (live) setRec(o.record); }, (e) => { if (live) { setRec(null); setError(failMessage(e)); } });
    return () => { live = false; };
  }, [releaseId]);
  const check = async () => {
    setBusy(true); setError(null);
    try { setRec((await api.checkReleasePdfAccessibility(releaseId)).record); } catch (e) { setError(failMessage(e)); } finally { setBusy(false); }
  };
  const v = rec?.verapdf;
  return (
    <section className="rel-section" aria-labelledby="rel-pdfa11y-h" data-testid="rel-pdf-a11y">
      <h3 className="section-title" id="rel-pdfa11y-h">PDF accessibility</h3>
      {rec === undefined ? <p className="muted">Loading…</p> : rec === null ? (
        <p className="muted" data-testid="rel-pdf-a11y-none">Not checked for this release yet. Checking composes the release’s PDF for a sample customer and records the level reached.</p>
      ) : (
        <div data-testid="rel-pdf-a11y-record" data-level={rec.level}>
          <p><strong data-testid="rel-pdf-a11y-level">{rec.levelLabel}</strong> <span className="muted"><When iso={rec.at} />{rec.by ? ` by ${rec.by}` : ''} · customer {rec.recordId}</span></p>
          <ul className="rel-pdf-a11y-list">
            <li>Checked by the studio: {rec.studio.summary.passed} of {rec.studio.checks.length} checks passed, {rec.studio.summary.failed} failed{rec.studio.summary.notChecked ? `, ${rec.studio.summary.notChecked} not checked` : ''}.</li>
            <li data-testid="rel-pdf-a11y-verapdf">veraPDF: {v?.status === 'ran' ? `${v.compliant ? 'meets' : 'does not meet'} the PDF/UA-1 profile${v.failedRules?.length ? ` (${v.failedRules.length} rule${v.failedRules.length === 1 ? '' : 's'} failed)` : ''}${v.version ? `, veraPDF ${v.version}` : ''}.` : v?.status === 'not-installed' ? 'not run, because veraPDF is not installed on this machine.' : `not run${v?.message ? ` (${v.message})` : ''}.`}</li>
          </ul>
        </div>
      )}
      {error && <p className="callout warning" role="alert">{error}</p>}
      <button type="button" className="btn sm" onClick={() => void check()} disabled={busy} aria-busy={busy} data-testid="rel-pdf-a11y-check">{busy ? 'Checking the PDF…' : rec ? 'Check the PDF again' : 'Check the PDF'}</button>
    </section>
  );
}

/** Mappings to production systems (wave 3): which ones this release carries, and which were left out because they were not complete. */
function ReleaseMappings({ detail }: { detail: ReleaseDetailDto }) {
  const list = detail.mappings ?? [];
  if (!list.length) return null;
  const r = detail.release;
  return (
    <section className="rel-section" aria-labelledby="rel-mappings-h" data-testid="rel-mappings">
      <h3 className="section-title" id="rel-mappings-h">Mappings to production systems</h3>
      <ul className="rel-mapping-list">
        {list.map((m) => (
          <li key={m.id} data-testid="rel-mapping" data-complete={m.complete ? 'yes' : 'no'}>
            <strong>{m.name}</strong> <span className="muted">for {m.system}</span>{' '}
            {m.complete
              ? <><span className="chip accent">In the package</span> <Tech><span className="chip code">{m.file}</span></Tech></>
              : <><span className="chip warning">Left out</span> <span className="muted">Not complete when the release was made ({m.counts.unmapped} not mapped{m.counts.clashes ? `, ${m.counts.clashes} type clashes` : ''}{m.counts.mappedTwice ? `, ${m.counts.mappedTwice} mapped twice` : ''}).</span></>}
          </li>
        ))}
      </ul>
      <p className="muted"><Link to={`/studio/${r.documentId}/mapping`} data-testid="rel-mappings-open">Open Mapping</Link> to see or change the working version’s mappings. A change goes into the next release.</p>
    </section>
  );
}
