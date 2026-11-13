import type { Persona, SyntheticRecord } from '@iss/model';
import type { BlockerLink, BlockerWithStatus, FixImpact, FixProposal, KnownDataProblem } from '@iss/scenarios';
import { Named, Tech } from '../../ui/common';
import { Icon } from '../../ui/icons';
import { ProposalCard } from '../../assist/common';
import { recordSummary } from '../../shell/RecordPicker';
import { whenText } from './knownData';
import { KIND_LABEL, KIND_NEXT, plural } from './labels';

/** What the detail (and the guided pass) can do with a customer's data problem. */
export interface DataActions {
  /** Opens the customer in Data Explorer on the fields this blocker is about. */
  onOpenData: (recordId: string, blockerId?: string) => void;
  /** Asks for a reason and sets this blocker aside for one customer. */
  onMarkKnown: (blocker: BlockerWithStatus, recordId: string) => void;
  onRemoveKnown: (entry: KnownDataProblem) => void;
  /** Why this person cannot set a problem aside (not an approver), or null. */
  knownBlockedReason: string | null;
}

const nameOf = (records: SyntheticRecord[], personas: Persona[], id: string) => { const r = records.find((x) => x.recordId === id); return r ? recordSummary(r, personas) : null; };

/** One known data problem: what was set aside, why, by whom and when, and "Remove". */
export function KnownEntry({ entry, name, actions }: { entry: KnownDataProblem; name: string; actions: DataActions }) {
  return (
    <div className="bl-known-entry" data-testid={`bl-known-${entry.recordId}`}>
      <span className="chip warning">Known data problem</span>
      <span className="bl-known-reason"><span className="muted">Reason:</span> {entry.reason}</span>
      <span className="muted bl-known-who">Set aside for {name} by {entry.markedBy?.name ?? 'someone'} on {whenText(entry.markedAt)}</span>
      <button type="button" className="btn ghost sm" onClick={() => actions.onRemoveKnown(entry)} disabled={!!actions.knownBlockedReason} title={actions.knownBlockedReason ?? 'Count this customer as stopped again'} data-testid={`bl-known-remove-${entry.recordId}`}>Remove</button>
    </div>
  );
}

/** Who is affected: each customer by name, a link that shows what that customer gets; for a data problem, what can be done per customer. */
export function Customers({ blocker, records, personas, onPreview, data }: { blocker: BlockerWithStatus; records: SyntheticRecord[]; personas: Persona[]; onPreview: (recordId: string) => void; data?: DataActions }) {
  if (!blocker.recordIds.length) {
    return <p className="muted bl-nobody" data-testid="bl-nobody">No synthetic customer reaches this today, so nobody is stopped yet. It is listed because it would stop any customer who does. Generate test customers to see who.</p>;
  }
  const isData = blocker.kind === 'customer-data' && !!data;
  return (
    <ul className="list-rows bl-customers" data-testid="bl-customers" aria-label="Customers this stops">
      {blocker.recordIds.map((id) => {
        const sum = nameOf(records, personas, id);
        const name = sum?.name ?? id;
        const known = blocker.known.find((k) => k.recordId === id);
        return (
          <li key={id} className={`bl-customer${known ? ' known' : ''}`} data-record={id} data-known={known ? 'yes' : undefined}>
            <button type="button" className="linkbtn bl-customer-name" onClick={() => onPreview(id)} data-testid={`bl-customer-${id}`} title={`Show what this customer gets (${id})`} aria-label={`Preview ${name}`}>{name}</button>
            {sum?.tag && <span className="muted bl-customer-tag">{sum.tag}</span>}
            <Tech><span className="chip code">{id}</span></Tech>
            {isData && (
              <span className="bl-customer-actions">
                {known ? <span className="chip warning" title={`Set aside: ${known.reason}`}>Known data problem</span>
                  : <button type="button" className="btn sm ghost" onClick={() => data!.onMarkKnown(blocker, id)} disabled={!!data!.knownBlockedReason} title={data!.knownBlockedReason ?? undefined} data-testid={`bl-customer-known-${id}`} aria-label={`Mark as a known data problem for ${name}`}>Mark as known</button>}
                <button type="button" className="btn sm ghost bl-customer-data" onClick={() => data!.onOpenData(id, blocker.id)} data-testid={`bl-customer-data-${id}`} aria-label={`Open ${name} in Data Explorer`}>Data Explorer</button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function About({ blocker }: { blocker: BlockerWithStatus }) {
  const a = blocker.about;
  if (!a.component && !a.rules && !a.message && !a.field && !a.language) return null;
  return (
    <dl className="kv bl-kv">
      {a.component && <><dt>Part of the document</dt><dd><Named name={a.component.name} code={a.component.id} /></dd></>}
      {a.message && <><dt>Wording</dt><dd><Named name={a.message.name} code={a.message.id} /></dd></>}
      {a.rules && <><dt>{a.rules.length === 1 ? 'Rule' : 'Rules'}</dt><dd>{a.rules.map((r) => <span key={r.id} className="bl-rule">{r.name} <Tech><span className="chip code">{r.id}</span></Tech></span>)}</dd></>}
      {a.field && <><dt>Field</dt><dd><Named name={a.field.name} code={a.field.path} /></dd></>}
      {a.language && <><dt>Language</dt><dd><Named name={a.language.name} code={a.language.code} /></dd></>}
    </dl>
  );
}

/** "3 customers stopped", "1 set aside", or "no customer stopped yet": counts that leave the customers set aside out of "stopped". */
export function CountChips({ blocker }: { blocker: BlockerWithStatus }) {
  const open = blocker.openRecordIds.length;
  const aside = blocker.customerCount - open;
  return (
    <>
      {blocker.customerCount === 0 ? <span className="chip bl-count" data-testid="bl-count" data-n={0}>no customer stopped yet</span>
        : open > 0 ? <span className="chip bl-count error" data-testid="bl-count" data-n={open}>{plural(open, 'customer')} stopped</span> : null}
      {aside > 0 && <span className="chip warning bl-count" data-testid="bl-count-aside" data-n={aside}>{aside} set aside</span>}
    </>
  );
}

export function BlockerDetail({ blocker, records, personas, impactFor, readOnlyReason, appliedFixId, onApply, onOpen, onPreview, data, stale, children }: {
  blocker: BlockerWithStatus; records: SyntheticRecord[]; personas: Persona[];
  impactFor: (blockerId: string, fixId: string) => FixImpact | null;
  readOnlyReason: string | null; appliedFixId: string | null;
  onApply: (fix: FixProposal) => void; onOpen: (link?: BlockerLink | null) => void; onPreview: (recordId: string) => void;
  data: DataActions;
  /** The blocker came from a full check made before the last change to the document. */
  stale: boolean;
  children?: React.ReactNode;
}) {
  const isData = blocker.kind === 'customer-data';
  const canApply = blocker.fixes.some((f) => f.kind === 'change');
  const firstOpen = blocker.openRecordIds[0] ?? null;
  const firstName = firstOpen ? nameOf(records, personas, firstOpen)?.name ?? firstOpen : null;
  return (
    <div className="bl-detail-body" data-testid="bl-detail" data-blocker={blocker.id} data-kind={blocker.kind} data-status={blocker.status}>
      {children}
      <div className="bl-detail-head">
        <h2 className="bl-detail-title">{blocker.title}</h2>
        <div className="bl-chips">
          <span className={`chip${isData ? ' warning' : ''}`} data-testid="bl-detail-kind">{KIND_LABEL[blocker.kind]}</span>
          {blocker.status === 'known-data-problem' && <span className="chip warning" data-testid="bl-detail-status">Status: Known data problem</span>}
          <CountChips blocker={blocker} />
          {blocker.speed === 'full-check' ? <span className="chip info" data-testid="bl-detail-speed" title="Found by the last full check, which composes the pages.">from the full check</span> : <span className="chip" data-testid="bl-detail-speed" title="Worked out just now for every customer.">checked just now</span>}
          <Tech><span className="chip code">{blocker.code}</span><span className="chip code" title="Stable id of this cause">{blocker.id}</span></Tech>
        </div>
      </div>
      {stale && blocker.speed === 'full-check' && <p className="bl-note warn" role="status">This comes from a full check made before your last change. It may already be fixed; run the full check again to confirm.</p>}
      <p className="bl-why">{blocker.explanation}</p>
      <About blocker={blocker} />

      {isData && (
        <div className="callout warning bl-datanote" data-testid="bl-datanote">
          <strong>The document is fine; the customer’s data is wrong.</strong> Nothing in the document needs to change. Data Explorer shows the customer’s values with the wrong ones highlighted; sample and imported customers stay read-only there, so make an editable copy to correct one. If the data cannot be corrected before approval, an approver can mark it as a known data problem for that one customer, with a reason.
          <div className="row wrap bl-datanote-actions">
            <button type="button" className="btn primary" onClick={() => data.onOpenData(firstOpen ?? blocker.recordIds[0], blocker.id)} disabled={!blocker.recordIds.length} data-testid="bl-open-data"><Icon.external /> Open in Data Explorer</button>
            {firstOpen && <button type="button" className="btn" onClick={() => data.onMarkKnown(blocker, firstOpen)} disabled={!!data.knownBlockedReason} title={data.knownBlockedReason ?? `Set this problem aside for ${firstName}`} data-testid="bl-mark-known">Mark as a known data problem{blocker.openRecordIds.length > 1 ? ` for ${firstName}` : ''}</button>}
          </div>
          {data.knownBlockedReason && firstOpen && <p className="hint bl-readonly" data-testid="bl-known-readonly">{data.knownBlockedReason}.</p>}
        </div>
      )}

      {isData && blocker.known.length > 0 && (
        <>
          <h3 className="section-title">Set aside as known data problems</h3>
          <div className="bl-known-list" data-testid="bl-known-list">
            {blocker.known.map((k) => <KnownEntry key={k.recordId} entry={k} name={nameOf(records, personas, k.recordId)?.name ?? k.recordId} actions={data} />)}
          </div>
        </>
      )}

      <h3 className="section-title">Who is affected</h3>
      <Customers blocker={blocker} records={records} personas={personas} onPreview={onPreview} data={data} />

      <h3 className="section-title">{isData ? 'What can be done' : blocker.fixes.length > 1 ? 'Ways to fix it, side by side' : 'How to fix it'}</h3>
      {readOnlyReason && canApply && <p className="hint bl-readonly" data-testid="bl-readonly">You can see the fixes but not apply them: {readOnlyReason.charAt(0).toLowerCase() + readOnlyReason.slice(1)}.</p>}
      <FixCards blocker={blocker} impactFor={impactFor} readOnlyReason={readOnlyReason} appliedFixId={appliedFixId} onApply={onApply} onOpen={onOpen} />

      <h3 className="section-title">Where it is fixed by hand</h3>
      <p className="hint bl-next">{KIND_NEXT[blocker.kind]}</p>
      <div className="row wrap">
        {!isData && <button type="button" className="btn" onClick={() => onOpen()} data-testid="bl-open"><Icon.external /> {blocker.link?.label ?? 'Open where this is fixed'}</button>}
        {isData && <button type="button" className="btn" onClick={() => data.onOpenData(firstOpen ?? blocker.recordIds[0], blocker.id)} disabled={!blocker.recordIds.length} data-testid="bl-open"><Icon.external /> Open where this is fixed</button>}
      </div>
    </div>
  );
}

/** The fixes to choose from, side by side, each with its effect on every customer. Shared by the detail and the guided pass. */
export function FixCards({ blocker, impactFor, readOnlyReason, appliedFixId, onApply, onOpen }: {
  blocker: BlockerWithStatus; impactFor: (blockerId: string, fixId: string) => FixImpact | null; readOnlyReason: string | null; appliedFixId: string | null;
  onApply: (fix: FixProposal) => void; onOpen: (link?: BlockerLink | null) => void;
}) {
  if (!blocker.fixes.length) return <p className="muted">No automatic fix for this. Open where it is fixed.</p>;
  return (
    <div className="bl-fixes" data-count={blocker.fixes.length}>
      {blocker.fixes.map((f, i) => {
        const impact = f.kind === 'change' ? impactFor(blocker.id, f.id) : null;
        const was = appliedFixId === f.id;
        return (
          <div key={f.id} className="bl-fix" data-testid="bl-fix" data-fix={f.id} data-kind={f.kind}>
            <ProposalCard proposal={f} impact={impact} applied={was} busy={!!readOnlyReason || (f.kind === 'change' && !impact)} onApply={() => onApply(f)} onOpen={() => onOpen(f.link)}>
              {blocker.fixes.length > 1 && i === 0 && <span className="chip accent bl-best" data-testid="bl-best">Best first</span>}
              {f.kind === 'change' && !impact && !was && <p className="muted bl-wait" role="status"><span className="spinner" /> Working out the effect on every customer…</p>}
              {f.kind === 'change' && impact && !impact.resolves && !impact.newlyBlocked.length && <p className="bl-warn">Not shown to fully resolve this; read the effect before applying.</p>}
            </ProposalCard>
          </div>
        );
      })}
    </div>
  );
}
