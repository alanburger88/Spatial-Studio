import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project, SyntheticRecord } from '@iss/model';
import { customerBlockers } from '@iss/scenarios';
import { Icon } from '../../ui/icons';
import { fieldLabel } from '../../ui/plain';
import { KnownDialog, useKnownBlockedReason } from '../blockers/KnownDialog';
import { useKnownDataProblems, whenText } from '../blockers/knownData';
import { blockerPath } from '../blockers/link';
import { recordName } from './explorerModel';

/** "Billed amount, claim 1" for `claims[0].billedCents`; the field's own label otherwise. */
export function highlightLabel(project: Project, path: string): string {
  const row = /^claims\[(\d+)\]\.(.+)$/.exec(path);
  if (row) return `${fieldLabel(project, `claim.${row[2]}`)}, claim ${Number(row[1]) + 1}`;
  return fieldLabel(project, path);
}

/**
 * Shown when Data Explorer was opened from a "the customer's data is wrong" blocker: what is wrong in a few words, the
 * values that disagree (highlighted in the form), a link back to the blocker, and what can be done. A shared (sample or
 * imported) customer is read-only, so the choices are an editable copy or a known data problem.
 */
export function BlockerBanner({ project, saved, draft, blockerId, own, canEdit, onMakeCopy }: {
  project: Project; saved: SyntheticRecord; draft: SyntheticRecord; blockerId: string; own: boolean; canEdit: boolean; onMakeCopy: () => void;
}) {
  const known = useKnownDataProblems();
  const knownBlocked = useKnownBlockedReason();
  const [marking, setMarking] = useState(false);
  const now = useMemo(() => customerBlockers(project, saved).find((b) => b.id === blockerId) ?? null, [project, saved, blockerId]);
  const inDraft = useMemo(() => { try { return customerBlockers(project, draft).some((b) => b.id === blockerId); } catch { return true; } }, [project, draft, blockerId]);
  const entry = known.list.find((k) => k.blockerId === blockerId && k.recordId === saved.recordId);
  const name = recordName(saved);
  const back = <Link to={blockerPath(project.projectId, blockerId)} className="linkbtn" data-testid="dx-blocker-back">Back to the blocker</Link>;

  if (!now) {
    return (
      <div className="callout accent dx-blocker" role="status" data-testid="dx-blocker-banner" data-state="gone">
        <p data-testid="dx-blocker-gone"><strong>This problem no longer stops {name}.</strong> {back}</p>
      </div>
    );
  }
  return (
    <div className="callout warning dx-blocker" role="region" aria-label="Why this customer is stopped" data-testid="dx-blocker-banner" data-state={entry ? 'known' : 'open'}>
      <p><strong>{now.title}.</strong> {now.kind === 'customer-data' ? 'The document is fine; this customer’s data is wrong.' : now.explanation} {back}</p>
      {now.fields.length > 0 && <p className="dx-blocker-fields" data-testid="dx-blocker-fields">Highlighted below: {now.fields.map((p) => highlightLabel(project, p)).join(', ')}.</p>}
      {own && !inDraft && <p data-testid="dx-blocker-fixed-draft">Your changes correct this. Save to keep them.</p>}
      {entry ? (
        <p data-testid="dx-blocker-known-status">Set aside as a known data problem by {entry.markedBy?.name ?? 'someone'} on {whenText(entry.markedAt)}. Reason: {entry.reason}</p>
      ) : now.kind === 'customer-data' ? (
        <div className="row wrap dx-blocker-actions">
          {!own && <span>Shared customers cannot be changed here.</span>}
          {own && <span>Correct the highlighted values and save.</span>}
          {!own && <button type="button" className="btn primary sm" onClick={onMakeCopy} disabled={!canEdit} data-testid="dx-blocker-copy"><Icon.copy width={14} height={14} /> Make an editable copy</button>}
          <button type="button" className="btn sm" onClick={() => setMarking(true)} disabled={!!knownBlocked} title={knownBlocked ?? 'Set this problem aside for this customer, with a reason'} data-testid="dx-blocker-known">Mark as a known data problem</button>
        </div>
      ) : null}
      {marking && <KnownDialog blockerId={blockerId} blockerTitle={now.title} recordId={saved.recordId} customerName={name} onClose={() => setMarking(false)} />}
    </div>
  );
}
