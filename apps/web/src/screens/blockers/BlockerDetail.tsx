import type { Persona, SyntheticRecord } from '@iss/model';
import type { Blocker, BlockerLink, FixImpact, FixProposal } from '@iss/scenarios';
import { Named, Tech } from '../../ui/common';
import { Icon } from '../../ui/icons';
import { ProposalCard } from '../../assist/common';
import { recordSummary } from '../../shell/RecordPicker';
import { KIND_LABEL, KIND_NEXT, plural } from './labels';

/** Who is affected: each customer by name, a link that shows what that customer gets. */
function Customers({ blocker, records, personas, onPreview, onOpenData }: { blocker: Blocker; records: SyntheticRecord[]; personas: Persona[]; onPreview: (recordId: string) => void; onOpenData: (recordId: string) => void }) {
  if (!blocker.recordIds.length) {
    return <p className="muted bl-nobody" data-testid="bl-nobody">No synthetic customer reaches this today, so nobody is stopped yet. It is listed because it would stop any customer who does. Generate test customers to see who.</p>;
  }
  const data = blocker.kind === 'customer-data';
  return (
    <ul className="list-rows bl-customers" data-testid="bl-customers" aria-label="Customers this stops">
      {blocker.recordIds.map((id) => {
        const r = records.find((x) => x.recordId === id);
        const sum = r ? recordSummary(r, personas) : null;
        const name = sum?.name ?? id;
        return (
          <li key={id} className="bl-customer" data-record={id}>
            <button type="button" className="linkbtn bl-customer-name" onClick={() => onPreview(id)} data-testid={`bl-customer-${id}`} title={`Show what this customer gets (${id})`} aria-label={`Preview ${name}`}>{name}</button>
            {sum?.tag && <span className="muted bl-customer-tag">{sum.tag}</span>}
            <Tech><span className="chip code">{id}</span></Tech>
            {data && <button type="button" className="btn sm ghost bl-customer-data" onClick={() => onOpenData(id)} data-testid={`bl-customer-data-${id}`} aria-label={`Open ${name} in Data Explorer`}>Data Explorer</button>}
          </li>
        );
      })}
    </ul>
  );
}

function About({ blocker }: { blocker: Blocker }) {
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

export function BlockerDetail({ blocker, records, personas, impactFor, readOnlyReason, appliedFixId, onApply, onOpen, onOpenData, onPreview, stale, children }: {
  blocker: Blocker; records: SyntheticRecord[]; personas: Persona[];
  impactFor: (blockerId: string, fixId: string) => FixImpact | null;
  readOnlyReason: string | null; appliedFixId: string | null;
  onApply: (fix: FixProposal) => void; onOpen: (link?: BlockerLink | null) => void; onOpenData: (recordId: string) => void; onPreview: (recordId: string) => void;
  /** The blocker came from a full check made before the last change to the document. */
  stale: boolean;
  children?: React.ReactNode;
}) {
  const data = blocker.kind === 'customer-data';
  const canApply = blocker.fixes.some((f) => f.kind === 'change');
  return (
    <div className="bl-detail-body" data-testid="bl-detail" data-blocker={blocker.id} data-kind={blocker.kind}>
      {children}
      <div className="bl-detail-head">
        <h2 className="bl-detail-title">{blocker.title}</h2>
        <div className="bl-chips">
          <span className={`chip${data ? ' warning' : ''}`} data-testid="bl-detail-kind">{KIND_LABEL[blocker.kind]}</span>
          <span className={`chip bl-count${blocker.customerCount ? ' error' : ''}`}>{blocker.customerCount ? `${plural(blocker.customerCount, 'customer')} stopped` : 'no customer stopped yet'}</span>
          {blocker.speed === 'full-check' ? <span className="chip info" data-testid="bl-detail-speed" title="Found by the last full check, which composes the pages.">from the full check</span> : <span className="chip" data-testid="bl-detail-speed" title="Worked out just now for every customer.">checked just now</span>}
          <Tech><span className="chip code">{blocker.code}</span><span className="chip code" title="Stable id of this cause">{blocker.id}</span></Tech>
        </div>
      </div>
      {stale && blocker.speed === 'full-check' && <p className="bl-note warn" role="status">This comes from a full check made before your last change. It may already be fixed; run the full check again to confirm.</p>}
      <p className="bl-why">{blocker.explanation}</p>
      <About blocker={blocker} />

      {data && (
        <div className="callout warning bl-datanote" data-testid="bl-datanote">
          <strong>The document is fine; the customer’s data is wrong.</strong> Nothing in the document needs to change. Data Explorer shows the customer’s values; sample customers stay read-only there, so make an editable copy to correct it.
          <div className="row wrap bl-datanote-actions">
            <button type="button" className="btn primary" onClick={() => onOpenData(blocker.recordIds[0])} disabled={!blocker.recordIds.length} data-testid="bl-open-data"><Icon.external /> Open in Data Explorer</button>
          </div>
        </div>
      )}

      <h3 className="section-title">Who is affected</h3>
      <Customers blocker={blocker} records={records} personas={personas} onPreview={onPreview} onOpenData={onOpenData} />

      <h3 className="section-title">{data ? 'What can be done' : blocker.fixes.length > 1 ? 'Ways to fix it, side by side' : 'How to fix it'}</h3>
      {readOnlyReason && canApply && <p className="hint bl-readonly" data-testid="bl-readonly">You can see the fixes but not apply them: {readOnlyReason.charAt(0).toLowerCase() + readOnlyReason.slice(1)}.</p>}
      {blocker.fixes.length ? (
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
      ) : <p className="muted">No automatic fix for this. Open where it is fixed.</p>}

      <h3 className="section-title">Where it is fixed by hand</h3>
      <p className="hint bl-next">{KIND_NEXT[blocker.kind]}</p>
      <div className="row wrap">
        {!data && <button type="button" className="btn" onClick={() => onOpen()} data-testid="bl-open"><Icon.external /> {blocker.link?.label ?? 'Open where this is fixed'}</button>}
        {data && <button type="button" className="btn" onClick={() => onOpenData(blocker.recordIds[0])} disabled={!blocker.recordIds.length} data-testid="bl-open"><Icon.external /> Open where this is fixed</button>}
      </div>
    </div>
  );
}
